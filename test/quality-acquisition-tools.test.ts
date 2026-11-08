import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Marketing } from '../src/clients/console.js';
import { ToolError } from '../src/core/envelope.js';
import { call, connect, DEFAULT_QUALITY, fakeApi, fakeConsole, myActor, storeActor, testConfig, type FakeActorMonth, type FakeQuality } from './helpers.js';

// Made-up portfolio. "Today" is 2026-11-20 unless a test says otherwise.
const DAY_20 = () => Date.parse('2026-11-20T03:00:00.000Z');
const DAY_3 = () => Date.parse('2026-11-03T03:00:00.000Z');

// [viewers, input-page viewers, users with a run] this month and last month (at the same point).
type Row = { now: [number, number, number]; before: [number, number, number] };
const FUNNELS: Record<string, Row> = {
    leaky: { now: [200, 20, 1], before: [180, 20, 1] },
    riser: { now: [80, 40, 16], before: [30, 15, 6] },
    fader: { now: [30, 15, 6], before: [90, 40, 18] },
    converter: { now: [60, 40, 40], before: [60, 40, 40] },
    steady: { now: [50, 25, 8], before: [50, 25, 8] },
    tiny: { now: [2, 1, 0], before: [2, 1, 0] },
};
const USERS: Record<string, number> = { leaky: 60, riser: 50, fader: 40, converter: 30, steady: 20, tiny: 10 };
const NAMES = Object.keys(FUNNELS);

const shape = ([viewers, input, runs]: [number, number, number]): Marketing => ({
    numUniqueWebPageViews: viewers * 2,
    numUniqueConsolePageViews: input,
    numUniqueUsersWithRun: runs,
    numUniqueViewingUsers: viewers,
});

const scale = ([v, i, r]: [number, number, number], by: number): [number, number, number] => [Math.round(v * by), Math.round(i * by), Math.round(r * by)];

/**
 * Like the real Console, `portionOfMonthElapsed` multiplies a month's counts. `before` is last month
 * scaled to the comparison point; read in full, last month is `before` / portion (here at day 20: x 30/19).
 */
function marketingFrom(funnels: Record<string, Row>, fail: (name: string) => Error | null = () => null, seen: string[] = []) {
    return (actorIds?: string[], month?: string, portion?: number): Marketing => {
        seen.push(`${month}:${actorIds?.join(',') ?? '*'}:${portion ?? 'none'}`);
        if (!actorIds?.length) return shape(scale([1000, 400, 150], portion ?? 1));
        const name = actorIds[0]!.replace(/^id-/, '');
        const error = fail(name);
        if (error) throw error;
        const row = funnels[name] ?? { now: [0, 0, 0], before: [0, 0, 0] };
        if (month === '2026-11') return shape(scale(row.now, portion ?? 1));
        return shape(portion == null ? scale(row.before, 30 / 19) : row.before);
    };
}

const MONTHS: Record<string, Record<string, FakeActorMonth>> = {
    '2026-11': { leaky: { revenue: 30, cost: 5, runs: 300, paying: 5 }, riser: { revenue: 2, cost: 1, runs: 40, paying: 1 } },
    '2026-10': { leaky: { revenue: 40, cost: 6, runs: 400, paying: 6 }, riser: { revenue: 1, cost: 1, runs: 20, paying: 1 } },
};

const QUALITY: Record<string, FakeQuality> = {
    leaky: {
        scores: { actorQuality: 0.6, actorQualityPercentile: 0.4, hasInputSchema: 1, hasOutputSchema: 0, hasReadme: 1 },
        improvements: {
            praises: [{ title: 'Has input schema' }],
            improvements: [
                { id: 'RELIABILITY', title: 'Fix Actor health issues', description: 'Raise the run success rate.' },
                { id: 'HAS_OUTPUT_SCHEMA', title: 'Add an output schema', description: 'Describe the dataset fields.' },
                { id: 'TOTAL_USERS', title: 'Get more users', description: 'Promote it.' },
            ],
        },
        businessValue: [{ id: 'HAS_OUTPUT_SCHEMA', title: 'Add an output schema', descriptionDetail: 'An output schema helps integrations.' }],
    },
    riser: { ...DEFAULT_QUALITY, scores: { ...DEFAULT_QUALITY.scores, actorQuality: 0.9, actorQualityPercentile: 0.95 } },
    tiny: { ...DEFAULT_QUALITY, scores: { hasReadme: 1 } },
};

function portfolio(names = NAMES, users = USERS) {
    return fakeApi(
        [...names.map((name) => myActor(name)), myActor('private-one')],
        names.map((name) => storeActor(name, users[name] ?? 1, { TOTAL: 100, SUCCEEDED: 100, FAILED: 0, ABORTED: 0, 'TIMED-OUT': 0 })),
    );
}

async function setup({
    now = DAY_20,
    funnels = FUNNELS,
    failMarketing,
    quality = (id: string) => QUALITY[id.replace(/^id-/, '')] ?? DEFAULT_QUALITY,
    api = portfolio(),
}: { now?: () => number; funnels?: Record<string, Row>; failMarketing?: (name: string) => Error | null; quality?: (id: string) => FakeQuality; api?: ReturnType<typeof fakeApi> } = {}) {
    const home = await mkdtemp(join(tmpdir(), 'aim-qa-'));
    const seen: string[] = [];
    const consoleApi = fakeConsole(MONTHS, now(), marketingFrom(funnels, failMarketing, seen), quality);
    const { client } = await connect(api, testConfig(home), now, { consoleApi });
    return { client, consoleApi, seen };
}

const bucketOf = (data: Record<string, any>, key: string) => data.buckets.find((bucket: { key: string }) => bucket.key === key);
const changed = () => new ToolError('endpoint_changed', 'Apify Console returned 500 for actor-analytics/monthly-marketing.', 'Try again later.');

describe('acquisition_score', () => {
    it('puts each scanned actor in exactly one bucket (AC1) and names the worst leaking one', async () => {
        const { client } = await setup();
        const { data, text } = await call(client, 'acquisition_score');
        const counts = Object.fromEntries(data.buckets.map((bucket: { key: string; count: number }) => [bucket.key, bucket.count]));
        expect(counts).toEqual({ leaking: 1, rising: 1, fading: 1, converting: 1, steady: 1, quiet: 1 });
        expect(data.totals).toEqual({ scanned: 6, viewingUsers: 422 });
        expect(bucketOf(data, 'leaking').actors[0]).toMatchObject({ name: 'leaky', viewingUsers: 200, usersWithRun: 1, viewToRunPct: 0.5 });
        expect(bucketOf(data, 'rising').actors[0]).toMatchObject({ name: 'riser', viewerChangePct: 166.7 });
        expect(bucketOf(data, 'steady').actors).toEqual([]); // counted, not listed
        expect(data.omitted.rows).toBe(2);
        expect(data.thresholds).toEqual({ viewerFloor: 30, leakFloor: 60, conversionLowPct: 16, conversionHighPct: 20 });
        expect(text).toContain('Worst leaking: leaky (200 viewers, 1 with a run, 0.5%)');
    });

    it('always notes that thresholds are relative to the top N scanned (AC18)', async () => {
        const { client } = await setup();
        const { data } = await call(client, 'acquisition_score', { top: 4 });
        expect(data.totals.scanned).toBe(4);
        expect(data.notes[0]).toContain('relative to the top 4 actors by 30-day users, not the whole portfolio');
    });

    it('judges one actor against the top actors and points to growth for referrers (AC2, AC24)', async () => {
        const { client } = await setup();
        const { data, text } = await call(client, 'acquisition_score', { actor: 'leaky' });
        expect(data.bucket).toEqual({ key: 'leaking', label: 'Leaking', action: 'Fix the listing' });
        expect(data.reason).toContain('few reach the input page');
        expect(data.previous).toEqual({ viewingUsers: 180, usersWithRun: 1 });
        expect(data).not.toHaveProperty('topReferrers');
        expect(data).not.toHaveProperty('topCountries');
        expect(data.notes).toContain('For referrers, countries and paying users, call growth with this actor and month.');
        expect(text).toMatch(/^leaky \(2026-11 \(in progress\)\): Leaking/);
    });

    it('does not judge Rising or Fading before day 8 (AC3)', async () => {
        const { client } = await setup({ now: DAY_3 });
        const { data, text } = await call(client, 'acquisition_score');
        expect(bucketOf(data, 'rising').count).toBe(0);
        expect(bucketOf(data, 'fading').count).toBe(0);
        expect(data.notes.join(' ')).toContain('Before day 8');
        expect(text).toContain('Before day 8');
    });

    it('reads this month as it stands and scales only last month to the days that have passed', async () => {
        const { client, seen } = await setup();
        await call(client, 'acquisition_score', { actor: 'riser' });
        expect(seen).toContain('2026-11:id-riser:none');
        // Day 20: 19 of November's 30 days have fully passed.
        expect(seen).toContain(`2026-10:id-riser:${19 / 30}`);
        expect(seen.some((line) => line.startsWith('2026-11:') && !line.endsWith(':none'))).toBe(false);
    });

    it('compares a past month with the whole month before it', async () => {
        const { client, seen } = await setup();
        await call(client, 'acquisition_score', { actor: 'riser', month: 'lastMonth' });
        expect(seen).toEqual(expect.arrayContaining(['2026-10:id-riser:none', '2026-09:id-riser:none']));
    });

    it('does not reuse scaled last-month numbers for growth (cache key)', async () => {
        const { client, consoleApi } = await setup();
        await call(client, 'acquisition_score', { actor: 'riser' });
        const growth = await call(client, 'growth', { actor: 'riser', month: 'lastMonth' });
        // Scaled to day 20, last month is 30 viewers; in full it is 47. growth must get the full month.
        expect(growth.data.rows[0]).toMatchObject({ viewingUsers: 47 });
        expect(consoleApi.calls.filter((c) => c === 'marketing:2026-10:id-riser')).toHaveLength(2);
    });

    it('growth reads the current month unscaled', async () => {
        const { client, seen } = await setup();
        const growth = await call(client, 'growth', { actor: 'riser', month: 'thisMonth' });
        expect(growth.data.rows[0]).toMatchObject({ viewingUsers: 80 });
        expect(seen.every((line) => line.endsWith(':none'))).toBe(true);
    });

    it('leaves out an actor that fails to load and names it (AC16)', async () => {
        const { client } = await setup({ failMarketing: (name) => (name === 'fader' ? changed() : null) });
        const { result, data } = await call(client, 'acquisition_score');
        expect(result.isError).toBeFalsy();
        expect(data.totals.scanned).toBe(5);
        expect(bucketOf(data, 'fading').count).toBe(0);
        expect(JSON.stringify(data.buckets)).not.toContain('fader');
        expect(data.notes).toContain('1 of 6 actors could not be loaded and were left out: fader.');
    });

    it('fails instead of answering empty when every actor fails, and stops on a session error (AC17)', async () => {
        const all = await setup({ failMarketing: () => changed() });
        const failed = await call(all.client, 'acquisition_score');
        expect(failed.result.isError).toBe(true);
        expect(failed.data).toMatchObject({ ok: false, code: 'endpoint_changed' });

        const loggedOut = await setup({ failMarketing: () => new ToolError('logged_out', 'The Apify Console session was rejected.', 'Log in.') });
        const denied = await call(loggedOut.client, 'acquisition_score');
        expect(denied.data).toMatchObject({ ok: false, code: 'logged_out' });
    });

    it('returns the same shared numbers as growth for the same actor and month (AC23)', async () => {
        const { client } = await setup();
        const growth = await call(client, 'growth', { actor: 'riser', month: 'thisMonth' });
        const score = await call(client, 'acquisition_score', { actor: 'riser', month: 'thisMonth' });
        const pick = (row: Record<string, unknown>) => ({ viewingUsers: row.viewingUsers, consolePageViews: row.consolePageViews, usersWithRun: row.usersWithRun, viewToRunPct: row.viewToRunPct });
        expect(pick(score.data.funnel)).toEqual(pick(growth.data.rows[0]));
    });

    it('shows view-to-run uncapped in both tools, capping only for buckets (AC25)', async () => {
        const funnels: Record<string, Row> = { ...FUNNELS, apiheavy: { now: [10, 5, 14], before: [10, 5, 14] } };
        const { client } = await setup({ funnels, api: portfolio([...NAMES, 'apiheavy'], { ...USERS, apiheavy: 5 }) });
        const score = await call(client, 'acquisition_score', { actor: 'apiheavy' });
        const growth = await call(client, 'growth', { actor: 'apiheavy', month: 'thisMonth' });
        expect(score.data.funnel.viewToRunPct).toBe(140);
        expect(growth.data.rows[0].viewToRunPct).toBe(140);
        // For the bucket, 14 of 10 counts as 100%: top-quarter conversion.
        expect(score.data.bucket.key).toBe('converting');
        expect(score.data.reason).toContain('100% of viewers start it (14 of 10)');
    });

    it('errors for an unknown actor or without a Console session (AC7, AC8)', async () => {
        const { client } = await setup();
        const missing = await call(client, 'acquisition_score', { actor: 'nope' });
        expect(missing.data).toMatchObject({ ok: false, code: 'actor_not_found' });
        const home = await mkdtemp(join(tmpdir(), 'aim-qa-'));
        const bare = await connect(portfolio(), testConfig(home), DAY_20, { consoleApi: null });
        const noBridge = await call(bare.client, 'acquisition_score');
        expect(noBridge.data).toMatchObject({ ok: false, code: 'bridge_missing' });
    });
});

describe('actor_quality', () => {
    it('lists issues across actors by impact, without the market group (AC4)', async () => {
        const { client } = await setup();
        const { data, text } = await call(client, 'actor_quality');
        expect(data.issues.map((issue: { id: string }) => issue.id)).toEqual(['RELIABILITY', 'HAS_OUTPUT_SCHEMA']);
        const [reliability, schema] = data.issues;
        expect(reliability).toMatchObject({ group: 'ops', groupLabel: 'Operations', actorCount: 5, impact: 'high' });
        expect(reliability.actors).toHaveLength(3);
        expect(reliability.actors[0]).toEqual({ name: 'leaky', qualityPct: 60 });
        expect(schema).toMatchObject({ description: 'An output schema helps integrations.', actorCount: 1 });
        expect(data.totals).toEqual({ scanned: 6, pending: 1, actorsWithSuggestions: 5, openSuggestions: 6 });
        expect(data.scores).toEqual({ medianQualityPct: 80, medianPercentilePct: 90 });
        expect(text).toContain('RELIABILITY on 5 actors (Operations, high)');
    });

    it('always notes that impact levels are relative to the top N scanned (AC19)', async () => {
        const { client } = await setup();
        const { data } = await call(client, 'actor_quality', { top: 3 });
        expect(data.totals.scanned).toBe(3);
        expect(data.notes[0]).toContain('Impact levels are relative to the top 3 actors by 30-day users, not the whole portfolio');
    });

    it('shows one actor’s score, sub-scores, praises and suggestions (AC5)', async () => {
        const { client, consoleApi } = await setup();
        const { data, text } = await call(client, 'actor_quality', { actor: 'leaky' });
        expect(data.score).toEqual({ qualityPct: 60, percentilePct: 40 });
        expect(data.subScores).toEqual({ hasInputSchema: 1, hasOutputSchema: 0, hasReadme: 1 });
        expect(data.praises).toEqual(['Has input schema']);
        expect(data.improvements.map((item: { id: string; group: string }) => [item.id, item.group])).toEqual([
            ['RELIABILITY', 'ops'],
            ['HAS_OUTPUT_SCHEMA', 'schema'],
            ['TOTAL_USERS', 'market'],
        ]);
        expect(data.improvements[0].impact).toBe('high');
        expect(text).toContain('leaky: quality 60% (percentile 40).');
        expect(consoleApi.calls).toEqual(expect.arrayContaining(['qualityScores:id-leaky', 'qualityImprovements:id-leaky', 'qualityBusinessValue:id-leaky']));
    });

    it('marks a private actor as pending with no suggestions (AC6)', async () => {
        const { client } = await setup();
        const { data } = await call(client, 'actor_quality', { actor: 'private-one' });
        expect(data).toMatchObject({ pending: 'unpublished', improvements: [], score: { qualityPct: null } });
    });

    it('leaves out an actor that fails to load, and fails when all do (AC16, AC17)', async () => {
        const quality = (id: string) => {
            if (id === 'id-riser') throw new Error('socket hang up');
            return QUALITY[id.replace(/^id-/, '')] ?? DEFAULT_QUALITY;
        };
        const { client } = await setup({ quality });
        const { result, data } = await call(client, 'actor_quality');
        expect(result.isError).toBeFalsy();
        expect(data.totals.scanned).toBe(5);
        expect(data.notes).toContain('1 of 6 actors could not be loaded and were left out: riser.');
        expect(JSON.stringify(data.issues)).not.toContain('riser');

        const broken = await setup({
            quality: () => {
                throw changed();
            },
        });
        const failed = await call(broken.client, 'actor_quality');
        expect(failed.data).toMatchObject({ ok: false, code: 'endpoint_changed' });
    });

    it('errors for an unknown actor (AC8)', async () => {
        const { client } = await setup();
        expect((await call(client, 'actor_quality', { actor: 'nope' })).data).toMatchObject({ ok: false, code: 'actor_not_found' });
    });
});

describe('output size', () => {
    it('keeps default outputs under 4 KB for a 486-actor account (AC9)', async () => {
        const many = Array.from({ length: 486 }, (_, i) => `some-long-actor-name-scraper-${i}`);
        const funnels = Object.fromEntries(many.map((name, i) => [name, { now: [50 + i, 10 + (i % 30), i % 7], before: [40 + ((i * 7) % 90), 10, 3] } as Row]));
        const users = Object.fromEntries(many.map((name, i) => [name, 500 - i]));
        const long = 'A long suggestion description that goes on and on about what to change in the actor and why it matters for users. '.repeat(3);
        const quality = (id: string): FakeQuality => ({
            scores: { actorQuality: 0.5 + (id.length % 5) / 10, actorQualityPercentile: 0.5 },
            improvements: { praises: [], improvements: ['RELIABILITY', 'HAS_OUTPUT_SCHEMA', 'README_QUALITY', 'TITLE_QUALITY', 'ACTOR_START_PRICE', 'PERMISSION_LEVEL', 'NEW_THING_A', 'NEW_THING_B', 'TIERED_PRICING', 'HAS_AVATAR_IMAGE', 'NO_README'].map((sid) => ({ id: sid, title: `${sid} title text`, description: long })) },
            businessValue: [],
        });
        const { client } = await setup({ funnels, quality, api: portfolio(many, users) });
        for (const tool of ['acquisition_score', 'actor_quality']) {
            const { result, data } = await call(client, tool);
            expect(result.isError, tool).toBeFalsy();
            expect(JSON.stringify(data).length, tool).toBeLessThanOrEqual(4096);
        }
    });
});
