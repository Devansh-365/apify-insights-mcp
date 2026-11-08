import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoreSearchItem } from '../src/clients/apify-api.js';
import { createContext } from '../src/context.js';
import { competitorBenchmarkTool } from '../src/tools/competitor-benchmark.js';
import { storeRankTool } from '../src/tools/store-rank.js';
import { call, connect, fakeApi, ME, myActor, storeActor, testConfig } from './helpers.js';

const NOW = Date.parse('2026-11-08T03:00:00.000Z');

function portfolio() {
    const mine = [myActor('healthy'), myActor('broken'), myActor('maintenance'), myActor('private-one')];
    const store = [
        storeActor('healthy', 40, { TOTAL: 500, SUCCEEDED: 499, FAILED: 1, ABORTED: 0, 'TIMED-OUT': 0 }),
        storeActor('broken', 12, { TOTAL: 100, SUCCEEDED: 80, FAILED: 15, ABORTED: 0, 'TIMED-OUT': 5 }),
        storeActor('maintenance', 2, { TOTAL: 10, SUCCEEDED: 10, FAILED: 0, ABORTED: 0, 'TIMED-OUT': 0 }, { notice: 'UNDER_MAINTENANCE' }),
    ];
    return fakeApi(mine, store, {
        'id-broken': {
            defaultRunOptions: { build: 'latest', timeoutSecs: 3600, memoryMbytes: 4096 },
            pricingInfos: [{ pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 0.003, unitName: 'result', startedAt: '2026-10-01T00:00:00Z' }],
            taggedBuilds: { latest: { buildNumber: '0.3.1', finishedAt: '2026-11-01T00:00:00Z' } },
        },
    });
}

async function tempHome() {
    return mkdtemp(join(tmpdir(), 'aim-'));
}

describe('server surface', () => {
    it('lists all twelve tools, read-only, the five prompts and the glossary', async () => {
        const { client } = await connect(portfolio(), testConfig(await tempHome()));
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
            'acquisition_score',
            'actor_profitability',
            'actor_quality',
            'actor_report',
            'auth_status',
            'competitor_benchmark',
            'daily_brief',
            'growth',
            'list_actors',
            'revenue_summary',
            'run_health',
            'store_rank',
        ]);
        const { prompts } = await client.listPrompts();
        expect(prompts.map((prompt) => prompt.name).sort()).toEqual(['funnel-check', 'health-check', 'loss-hunt', 'morning-brief', 'quality-review']);
        const brief = await client.getPrompt({ name: 'morning-brief' });
        expect((brief.messages[0]!.content as { text: string }).text).toContain('daily_brief');
        expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
        const glossary = await client.readResource({ uri: 'apify-insights://glossary' });
        expect((glossary.contents[0] as { text: string }).text).toContain('Aborted runs are excluded');
    });
});

describe('run_health', () => {
    it('returns only problems, flagged first, with rules and evidence', async () => {
        const { client } = await connect(portfolio(), testConfig(await tempHome()));
        const { data, text } = await call(client, 'run_health');
        expect(data.rows.map((r: { ref: string }) => r.ref)).toEqual(['acme/maintenance', 'acme/broken']);
        expect(data.rows[1]).toMatchObject({ flags: ['failing'], failed: 15, timedOut: 5, failureRatePct: 20 });
        expect(data.totals).toMatchObject({ checked: 3, notCheckedPrivate: 1, problems: 2, flagged: 1, failing: 1 });
        expect(data.rules.failing).toContain('aborted runs excluded');
        expect(text).toContain('2 of 3 public actors need attention');
    });
    it('checks one actor by fragment and reports ambiguity as a structured error', async () => {
        const { client } = await connect(portfolio(), testConfig(await tempHome()));
        const single = await call(client, 'run_health', { actor: 'healthy' });
        expect(single.text).toContain('no problems found');
        const missing = await call(client, 'run_health', { actor: 'zzz' });
        expect(missing.result.isError).toBe(true);
        expect(missing.data).toMatchObject({ ok: false, code: 'actor_not_found' });
    });
});

describe('list_actors', () => {
    it('sorts by 30-day users, keeps private actors with null public stats', async () => {
        const { client } = await connect(portfolio(), testConfig(await tempHome()));
        const { data } = await call(client, 'list_actors');
        expect(data.rows.map((r: { name: string }) => r.name)).toEqual(['healthy', 'broken', 'maintenance', 'private-one']);
        expect(data.rows[3]).toMatchObject({ private: true, users30d: null, runs30d: null });
        expect(data.rows[0].private).toBeUndefined();
        expect(data.totals).toMatchObject({ username: 'acme', actors: 4, public: 3, private: 1, withNotice: 1 });
    });
    it('stays under 4 KB by default for a 486-actor account', async () => {
        const names = Array.from({ length: 486 }, (_, i) => `some-long-actor-name-scraper-${i}`);
        const api = fakeApi(
            names.map((name) => myActor(name)),
            names.slice(0, 464).map((name, i) => storeActor(name, i % 50, { TOTAL: 1000 + i, SUCCEEDED: 990, FAILED: 10 + i })),
        );
        const { client } = await connect(api, testConfig(await tempHome()));
        for (const tool of ['list_actors', 'run_health']) {
            const { data } = await call(client, tool);
            expect(JSON.stringify(data).length, tool).toBeLessThanOrEqual(4096);
            expect(data.omitted.rows).toBeGreaterThan(0);
        }
    });
    it('caches the catalog between calls', async () => {
        const api = portfolio();
        const { client } = await connect(api, testConfig(await tempHome()));
        await call(client, 'list_actors');
        await call(client, 'run_health');
        expect(api.calls.filter((name) => name === 'myActors')).toHaveLength(1);
    });
});

describe('actor_report', () => {
    it('joins public detail, pricing in force, memory and the local source folder', async () => {
        const home = await tempHome();
        const actorsDir = join(home, 'actors');
        await mkdir(join(actorsDir, 'broken-folder', '.actor'), { recursive: true });
        await writeFile(join(actorsDir, 'broken-folder', '.actor', 'actor.json'), JSON.stringify({ name: 'broken' }));
        const { client } = await connect(portfolio(), testConfig(home, [actorsDir]));
        const { data, text } = await call(client, 'actor_report', { actor: 'acme/broken' });
        expect(data.runOptions.memoryMbytes).toBe(4096);
        expect(data.pricing).toEqual({ model: 'PRICE_PER_DATASET_ITEM', unit: 'result', priceUsd: 0.003 });
        expect(data.latestBuild.buildNumber).toBe('0.3.1');
        expect(data.flags.map((flag: { flag: string }) => flag.flag)).toEqual(['failing']);
        expect(data.localPath).toBe(join(actorsDir, 'broken-folder'));
        expect(data.money).toBeNull();
        expect(text).toContain('Default memory: 4096 MB');
    });
});

describe('auth_status and errors', () => {
    it('without an API token, public tools return public_auth_missing with a fix', async () => {
        const { client } = await connect(null, testConfig(await tempHome()));
        const { result, data } = await call(client, 'list_actors');
        expect(result.isError).toBe(true);
        expect(data).toMatchObject({ code: 'public_auth_missing' });
        expect(data.fix).toContain('apify login');
        const status = await call(client, 'auth_status');
        expect(status.data.public).toMatchObject({ ok: false, code: 'public_auth_missing' });
        expect(status.data.console.state).toBe('bridge_missing');
    });
    it('reports session states and never returns the UI token', async () => {
        const home = await tempHome();
        await mkdir(join(home, 'sessions'));
        const token = 'SECRET-UI-TOKEN-should-never-appear-anywhere';
        const write = (receivedAt: string, userId = ME.id) =>
            writeFile(join(home, 'sessions', 'p1.json'), JSON.stringify({ uiToken: token, userId, receivedAt, producer: 'bridge' }));

        await write(new Date(NOW - 10 * 60_000).toISOString());
        let status = await call((await connect(portfolio(), testConfig(home))).client, 'auth_status');
        expect(status.data.console).toMatchObject({ state: 'ok', ageMinutes: 10, producer: 'bridge' });
        expect(JSON.stringify(status.result)).not.toContain(token);

        await write(new Date(NOW - 3 * 60 * 60_000).toISOString());
        status = await call((await connect(portfolio(), testConfig(home))).client, 'auth_status');
        expect(status.data.console.state).toBe('warming_up');

        await write(new Date(NOW).toISOString(), 'someone-else');
        status = await call((await connect(portfolio(), testConfig(home))).client, 'auth_status');
        expect(status.data.console.state).toBe('other_account');
        expect(JSON.stringify(status.result)).not.toContain(token);
    });
});

// ---------------------------------------------------------------------------
// store_rank — direct handler tests (not registered in server.ts yet)
// ---------------------------------------------------------------------------

function searchItem(username: string, name: string, users30d?: number): StoreSearchItem {
    return { username, name, title: `${name} title`, ...(users30d != null ? { stats: { totalUsers30Days: users30d } } : {}) };
}

describe('storeRankTool', () => {
    async function ctx(searchData: Map<string, StoreSearchItem[]>) {
        const api = fakeApi(
            [myActor('our-widget'), myActor('our-extractor')],
            [storeActor('our-widget', 30, { TOTAL: 100, SUCCEEDED: 95, FAILED: 5 })],
            {},
            searchData,
        );
        const home = await mkdtemp(join(tmpdir(), 'aim-'));
        return createContext(testConfig(home), api, 'env', () => NOW);
    }

    it('returns best position and actors above when owner is present', async () => {
        const data = new Map<string, StoreSearchItem[]>([
            [
                'widget scraper',
                [
                    searchItem('rival-co', 'their-widget', 500),
                    searchItem('another', 'another-widget'),
                    searchItem(ME.username, 'our-widget'),
                    searchItem('trailing', 'trailing-widget'),
                ],
            ],
        ]);
        const c = await ctx(data);
        const result = await storeRankTool(c, { keywords: ['widget scraper'], depth: 50 });
        const envelope = result.structuredContent as Record<string, unknown>;
        const rows = envelope.rows as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.ownerPresent).toBe(true);
        expect(row.bestPosition).toBe(3);
        expect(row.ownerActors).toEqual([{ name: 'our-widget', position: 3 }]);
        // two items are above position 3
        const above = row.aboveOwnerBest as Array<Record<string, unknown>>;
        expect(above).toHaveLength(2);
        expect(above[0]).toMatchObject({ position: 1, username: 'rival-co', name: 'their-widget' });
        expect(above[1]).toMatchObject({ position: 2, username: 'another', name: 'another-widget' });
        // users30d null for item without stats, non-null for the one with stats
        expect(above[0]!.users30d).toBe(500);
        expect(above[1]!.users30d).toBeNull();
    });

    it('reports absent when owner is not in results', async () => {
        const data = new Map<string, StoreSearchItem[]>([
            ['data pipeline', [searchItem('big-player', 'their-pipeline'), searchItem('big-player', 'their-pipeline-pro')]],
        ]);
        const c = await ctx(data);
        const result = await storeRankTool(c, { keywords: ['data pipeline'], depth: 50 });
        const envelope = result.structuredContent as Record<string, unknown>;
        const rows = envelope.rows as Array<Record<string, unknown>>;
        expect(rows[0]).toMatchObject({ ownerPresent: false, bestPosition: null });
        expect((result.content as Array<{ text: string }>)[0]!.text).toContain('not found');
    });

    it('handles multiple keywords and caps aboveOwnerBest at 10', async () => {
        // Build a keyword where owner is at position 12 (11 actors above)
        const manyAbove: StoreSearchItem[] = Array.from({ length: 11 }, (_, i) => searchItem(`rival-${i}`, `rival-actor-${i}`));
        manyAbove.push(searchItem(ME.username, 'our-widget'));
        const data = new Map<string, StoreSearchItem[]>([
            ['crowded niche', manyAbove],
            ['easy niche', [searchItem(ME.username, 'our-extractor')]],
        ]);
        const c = await ctx(data);
        const result = await storeRankTool(c, { keywords: ['crowded niche', 'easy niche'], depth: 50 });
        const envelope = result.structuredContent as Record<string, unknown>;
        const rows = envelope.rows as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(2);
        const crowded = rows[0]!;
        expect((crowded.aboveOwnerBest as unknown[]).length).toBe(10);
        expect(crowded.aboveOmitted).toBe(1);
        const easy = rows[1]!;
        expect(easy.bestPosition).toBe(1);
        expect((easy.aboveOwnerBest as unknown[]).length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// competitor_benchmark — direct handler tests
// ---------------------------------------------------------------------------

describe('competitorBenchmarkTool', () => {
    async function ctx(competitorActors: Array<{ name: string; users30d: number }>) {
        const ownerStore = [
            storeActor('alpha-scraper', 120, { TOTAL: 2000, SUCCEEDED: 1900, FAILED: 100 }),
            storeActor('beta-scraper', 30, { TOTAL: 500, SUCCEEDED: 490, FAILED: 10 }),
            storeActor('gamma-scraper', 5, { TOTAL: 100, SUCCEEDED: 95, FAILED: 5 }),
        ];
        const rivalStore = competitorActors.map(({ name, users30d }) =>
            storeActor(name, users30d, { TOTAL: users30d * 10, SUCCEEDED: users30d * 9, FAILED: users30d }, { username: 'rival-corp' }),
        );
        const storeByUsername = new Map([
            [ME.username, ownerStore],
            ['rival-corp', rivalStore],
        ]);
        const api = fakeApi(
            ownerStore.map((a) => myActor(a.name)),
            ownerStore,
            {},
            new Map(),
            storeByUsername,
        );
        const home = await mkdtemp(join(tmpdir(), 'aim-'));
        return createContext(testConfig(home), api, 'env', () => NOW);
    }

    it('computes totals and top-5 for both sides', async () => {
        const c = await ctx([
            { name: 'rival-a', users30d: 200 },
            { name: 'rival-b', users30d: 50 },
        ]);
        const result = await competitorBenchmarkTool(c, { username: 'rival-corp' });
        const envelope = result.structuredContent as Record<string, unknown>;
        const totals = envelope.totals as Record<string, Record<string, unknown>>;

        // owner: 120 + 30 + 5 = 155 users30d
        expect(totals.owner.username).toBe(ME.username);
        expect(totals.owner.totalActors).toBe(3);
        expect(totals.owner.totalUsers30d).toBe(155);
        expect(totals.owner.actorsGe10Users30d).toBe(2);
        expect(totals.owner.actorsGe100Users30d).toBe(1);

        // competitor: 200 + 50 = 250 users30d
        expect(totals.competitor.username).toBe('rival-corp');
        expect(totals.competitor.totalActors).toBe(2);
        expect(totals.competitor.totalUsers30d).toBe(250);

        // top5 entries present for owner
        const top5 = totals.owner.top5ByUsers30d as Array<Record<string, unknown>>;
        expect(top5[0]!.name).toBe('alpha-scraper');
        expect(top5[0]!.users30d).toBe(120);
    });

    it('reports zero actors gracefully when competitor has no public actors', async () => {
        const c = await ctx([]);
        const result = await competitorBenchmarkTool(c, { username: 'rival-corp' });
        const envelope = result.structuredContent as Record<string, unknown>;
        const totals = envelope.totals as Record<string, Record<string, unknown>>;
        expect(totals.competitor.totalActors).toBe(0);
        expect(totals.competitor.totalUsers30d).toBe(0);
        expect(totals.competitor.medianUsers30d).toBeNull();
    });

    it('computes correct median for even and odd actor counts', async () => {
        // 3 owner actors: users30d = [5, 30, 120] → sorted [5, 30, 120] → median = 30
        const c = await ctx([{ name: 'rival-a', users30d: 10 }, { name: 'rival-b', users30d: 20 }]);
        const result = await competitorBenchmarkTool(c, { username: 'rival-corp' });
        const envelope = result.structuredContent as Record<string, unknown>;
        const totals = envelope.totals as Record<string, Record<string, unknown>>;
        expect(totals.owner.medianUsers30d).toBe(30);
        // 2 competitor actors: [10, 20] → median = 15
        expect(totals.competitor.medianUsers30d).toBe(15);
    });
});
