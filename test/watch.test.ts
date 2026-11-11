import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApifyApi } from '../src/clients/apify-api.js';
import { createConsoleApi, type ConsoleApi, type TokenProvider } from '../src/clients/console.js';
import { runCli } from '../src/cli/main.js';
import { DAY_MS } from '../src/core/watch/constants.js';
import { renderDigest, notificationText } from '../src/core/watch/digest.js';
import { evaluateAll, ownerCoverageStart, prepare, type WatchData } from '../src/core/watch/engine.js';
import { deriveMonthFacts, sumWindow, toSlices, zero } from '../src/core/watch/facts.js';
import { createLog, DEFAULT_CONFIG, redact, registerSecret } from '../src/core/watch/files.js';
import { launchAgentPlist, notificationScript, parseTimes } from '../src/core/watch/launchd.js';
import { aggregateOwnerRuns, ownerRunExclusion } from '../src/core/watch/owner-runs.js';
import { briefLine, readWatchSummary } from '../src/core/watch/reader.js';
import { classify, median } from '../src/core/watch/rules.js';
import { replay, watchRun, watchStatus, type WatchDeps } from '../src/core/watch/run.js';
import { buildItems, transition } from '../src/core/watch/state.js';
import type { ActorSignals, BackfillMonth, Reading, Signal, SlimRow, Values, WatchState } from '../src/core/watch/types.js';
import { call, connect, fakeApi, ME, myActor, storeActor, testConfig } from './helpers.js';

// Synthetic actors and numbers only. The four replay scenarios mirror the shapes of the cases the
// rules were calibrated on (a steady slide with a yield drop, a burst that ends, a one-day cost leak,
// a failure spike on a small earner) without any real account data.

const T = (iso: string) => Date.parse(iso);
const DAYS = (from: string, to: string) => {
    const out: string[] = [];
    for (let t = T(`${from}T00:00:00Z`); t <= T(`${to}T00:00:00Z`); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
};

function values(v: Partial<Values>): Values {
    const runs = v.runs ?? 0;
    const failed = v.failed ?? 0;
    const timedOut = v.timedOut ?? 0;
    const aborted = v.aborted ?? 0;
    return { ...zero(), ...v, succeeded: v.succeeded ?? runs - failed - timedOut - aborted, runs, failed, timedOut, aborted };
}

function row(id: string, v: Values, extra: Partial<SlimRow> = {}): SlimRow {
    return { id, name: id, notice: null, charged: v.results, payingUsers: 1, freeUsers: 0, model: 'PAY_PER_EVENT', ...v, ...extra };
}

type Series = Record<string, { days: Record<string, Values>; paying?: number }>;

/** Backfill months (exact days through the day before `through`) with month rows that add up to them. */
function backfillOf(series: Series, months: string[], through: string, fetchedAt: string): BackfillMonth[] {
    return months.map((month) => {
        const actors: BackfillMonth['actors'] = {};
        const rows: SlimRow[] = [];
        for (const [id, s] of Object.entries(series)) {
            const days: Record<string, Values> = {};
            const sum = zero();
            for (const [day, v] of Object.entries(s.days)) {
                if (!day.startsWith(month) || day >= through) continue;
                days[day] = v;
                for (const k of Object.keys(sum) as (keyof Values)[]) sum[k] += v[k];
            }
            actors[id] = { name: id, days };
            rows.push(row(id, sum, { payingUsers: s.paying ?? 1, charged: sum.results }));
        }
        const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1)).toISOString().slice(0, 10);
        return { version: 1, month, fetchedAt, from: `${month}-01`, through: end < through ? end : through, actors, rows };
    });
}

function scenarioData(): WatchData {
    const series: Series = {};
    const all = DAYS('2026-09-01', '2026-11-10');
    // Steady slide: flat runs, results per run and revenue fall from Oct 22.
    series['steady-slide'] = { paying: 6, days: {} };
    for (const day of all) {
        const late = day >= '2026-10-22';
        series['steady-slide'].days[day] = values({ rev: late ? 4.6 : 7.4, cost: 0.07, runs: 255, results: Math.round(255 * (late ? 24.3 : 34.5)) });
    }
    // Burst: about $1.15 a day, plus two weeks of a batch buyer.
    series['burst-ends'] = { paying: 15, days: {} };
    for (const day of all) {
        const burst = day >= '2026-10-22' && day <= '2026-11-04';
        series['burst-ends'].days[day] = values({ rev: 1.15 + (burst ? 6.7 : 0), cost: 0.08, runs: burst ? 110 : 30, results: (burst ? 110 : 30) * 15 });
    }
    // One-day leak: almost no revenue, then a day of timed-out runs.
    series['cost-leak'] = { paying: 2, days: {} };
    for (const day of all) series['cost-leak'].days[day] = day === '2026-11-10' ? values({ rev: 0, cost: 4.86, runs: 52, timedOut: 18, results: 20 }) : values({ rev: 0.002, cost: 0.001, runs: 1, results: 20 });
    // Failure spike on a small earner with several paying users.
    series['failure-spike'] = { paying: 6, days: {} };
    for (const day of all) {
        const bad = day >= '2026-10-02' && day <= '2026-10-12';
        series['failure-spike'].days[day] = values({ rev: day < '2026-10-01' ? 0.05 : day <= '2026-10-14' ? 0.75 : 0, cost: 0.01, runs: day <= '2026-10-14' ? 7 : 1, failed: bad ? 2 : 0, results: 30 });
    }
    return { snapshots: [], backfill: backfillOf(series, ['2026-09', '2026-10', '2026-11'], '2026-11-11', '2026-11-11T04:00:00.000Z'), users: {}, owner: {} };
}

describe('facts', () => {
    const r = (id: string, v: Partial<Values>, extra: Partial<SlimRow> = {}) => row(id, values(v), extra);
    it('differences consecutive readings with exact spans, keeps a gap as one span and closes the month', () => {
        const readings: Reading[] = [
            { month: '2026-10', takenAt: T('2026-10-05T03:00:00Z'), close: false, rows: [r('a', { rev: 10, runs: 5 })] },
            { month: '2026-10', takenAt: T('2026-10-06T03:00:00Z'), close: false, rows: [r('a', { rev: 12, runs: 6 })] },
            { month: '2026-10', takenAt: T('2026-10-09T03:00:00Z'), close: false, rows: [r('a', { rev: 11, runs: 9 })] },
            { month: '2026-10', takenAt: T('2026-11-01T03:00:00Z'), close: true, rows: [r('a', { rev: 30, runs: 20 })] },
        ];
        const facts = deriveMonthFacts('2026-10', readings, null);
        expect(facts.map((f) => [f.t0.slice(0, 13), f.t1.slice(0, 13), f.days, f.rev, f.src])).toEqual([
            ['2026-10-01T00', '2026-10-05T03', 4.125, 10, 'delta'],
            ['2026-10-05T03', '2026-10-06T03', 1, 2, 'delta'],
            ['2026-10-06T03', '2026-10-09T03', 3, -1, 'delta'], // a reversal is kept, never clipped
            ['2026-10-09T03', '2026-11-01T00', 22.875, 19, 'close'],
        ]);
    });

    it('uses backfilled days up to the first reading, then the reading minus their sum', () => {
        const backfill: BackfillMonth = {
            version: 1,
            month: '2026-11',
            fetchedAt: '2026-11-03T05:00:00.000Z',
            from: '2026-11-01',
            through: '2026-11-03',
            actors: { a: { name: 'a', days: { '2026-11-01': values({ rev: 1, runs: 2 }), '2026-11-02': values({ rev: 2, runs: 3 }) } } },
            rows: [],
        };
        const readings: Reading[] = [{ month: '2026-11', takenAt: T('2026-11-03T05:00:00Z'), close: false, rows: [r('a', { rev: 3.5, runs: 6 })] }];
        const facts = deriveMonthFacts('2026-11', readings, backfill);
        expect(facts.map((f) => [f.src, f.t1.slice(0, 13), f.rev, f.runs])).toEqual([
            ['backfill', '2026-11-02T00', 1, 2],
            ['backfill', '2026-11-03T00', 2, 3],
            ['delta', '2026-11-03T05', 0.5, 1],
        ]);
        expect(facts[2]!.charged).toBeNull();
    });

    it('counts short facts whole in the window holding their end and spreads long ones', () => {
        const facts = deriveMonthFacts('2026-10', [
            { month: '2026-10', takenAt: T('2026-10-11T00:00:00Z'), close: false, rows: [r('a', { rev: 10 })] },
            { month: '2026-10', takenAt: T('2026-10-12T03:00:00Z'), close: false, rows: [r('a', { rev: 11 })] },
        ], null);
        const slices = toSlices(facts);
        const early = sumWindow(slices, T('2026-10-01T00:00:00Z'), T('2026-10-06T00:00:00Z'));
        expect(early.v.rev).toBeCloseTo(5);
        expect(early.approximate).toBe(true);
        const late = sumWindow(slices, T('2026-10-11T00:00:00Z'), T('2026-10-12T03:00:00Z'));
        expect(late.v.rev).toBeCloseTo(1);
        expect(late.approximate).toBe(false);
    });
});

describe('rule helpers', () => {
    it('median ignores up to 3 burst weeks in 8', () => {
        expect(median([8, 8, 8, 8, 8, 47, 47, 47])).toBe(8);
    });
    it('classifies by revenue days and peak share', () => {
        expect(classify(56, 0.2, true)).toBe('steady');
        expect(classify(10, 0.3, true)).toBe('bursty');
        expect(classify(40, 0.7, true)).toBe('bursty');
        expect(classify(20, 0.5, true)).toBe('intermittent');
        expect(classify(56, 0.2, false)).toBe('new');
    });
    it('owner-run exclusion matches only a month whose only paying user looks like the owner', () => {
        expect(ownerRunExclusion({ payingUsers: 1, freeUsers: 0, revenueUsd: 0, runs: 20 }, 20)).toBe('exact');
        expect(ownerRunExclusion({ payingUsers: 1, freeUsers: 0, revenueUsd: 0, runs: 21 }, 20)).toBeNull();
        expect(ownerRunExclusion({ payingUsers: 1, freeUsers: 3, revenueUsd: 0, runs: 30 }, 20)).toBe('probable');
        expect(ownerRunExclusion({ payingUsers: 2, freeUsers: 0, revenueUsd: 0, runs: 20 }, 20)).toBeNull();
        expect(ownerRunExclusion({ payingUsers: 1, freeUsers: 0, revenueUsd: 0.5, runs: 20 }, 20)).toBeNull();
        expect(ownerRunExclusion({ payingUsers: 1, freeUsers: 0, revenueUsd: 0, runs: 20 }, 0)).toBeNull();
    });
    it('aggregates the owner run list by actor and start day, own actors only', () => {
        const runs = aggregateOwnerRuns(
            [
                { actId: 'a', status: 'SUCCEEDED', startedAt: '2026-11-02T10:00:00Z' },
                { actId: 'a', status: 'TIMED-OUT', startedAt: '2026-11-02T11:00:00Z' },
                { actId: 'other', status: 'FAILED', startedAt: '2026-11-02T11:00:00Z' },
            ],
            new Set(['a']),
        );
        expect(runs).toEqual({ a: { '2026-11-02': { runs: 2, failed: 0, timedOut: 1 } } });
    });
});

describe('replay on synthetic cases', () => {
    const prepared = prepare(scenarioData());
    const result = replay(prepared, DEFAULT_CONFIG, '2026-09-08', '2026-11-11');
    const first = (id: string) => result.actors.get(id)?.firstPage ?? null;

    it('a steady slide with flat runs and fewer results per run pages by Nov 5', () => {
        const page = first('steady-slide');
        expect(page).not.toBeNull();
        expect(page!.day <= '2026-11-05').toBe(true);
        expect(page!.rules.some((r) => r === 'R3' || r === 'R1')).toBe(true);
    });
    it('a burst that ends never pages', () => {
        expect(first('burst-ends')).toBeNull();
    });
    it('a one-day cost leak pages the next morning', () => {
        expect(first('cost-leak')).toEqual({ day: '2026-11-11', rules: ['R7'] });
    });
    it('a failure spike on a small earner pages in early October', () => {
        const page = first('failure-spike');
        expect(page?.rules).toContain('R4');
        expect(page!.day >= '2026-10-03' && page!.day <= '2026-10-12').toBe(true);
    });
});

describe('owner-run history', () => {
    it('starts on the first whole day after the earliest stored day', () => {
        expect(ownerCoverageStart({})).toBeNull();
        expect(ownerCoverageStart({ a: { '2026-10-10': { runs: 1, failed: 0, timedOut: 0 } }, b: { '2026-10-12': { runs: 1, failed: 0, timedOut: 0 } } })).toBe(Date.parse('2026-10-11T00:00:00Z'));
    });
    it('subtracts the owner own failing runs, so a debugging spike does not page', () => {
        const data = scenarioData();
        const days: Record<string, { runs: number; failed: number; timedOut: number }> = { '2026-09-20': { runs: 0, failed: 0, timedOut: 0 } };
        for (const day of DAYS('2026-10-02', '2026-10-12')) days[day] = { runs: 2, failed: 2, timedOut: 0 };
        data.owner = { 'failure-spike': days };
        const result = replay(prepare(data), DEFAULT_CONFIG, '2026-09-08', '2026-11-11');
        expect(result.actors.get('failure-spike')?.firstPage ?? null).toBeNull();
    });
    it('says "not subtracted" rather than 0 before the owner-run history starts', () => {
        const data = scenarioData();
        data.owner = { 'steady-slide': { '2026-11-01': { runs: 1, failed: 0, timedOut: 0 } } };
        const out = evaluateAll(prepare(data), { asOf: Date.parse('2026-10-10T00:00:00Z'), weekly: false, money: true, config: DEFAULT_CONFIG });
        const r4 = out.actors.find((a) => a.id === 'failure-spike')?.signals.find((x) => x.rule === 'R4');
        expect(r4?.evidence).toContain('your own runs not subtracted (no owner-run history before 2026-11-02)');
        expect(r4?.numbers?.ownerRuns7d).toBeNull();
    });
});

describe('state', () => {
    const sig = (rule: Signal['rule'], tier: Signal['tier'], atStakeUsd: number, extra: Partial<Signal> = {}): Signal => ({ rule, tier, atStakeUsd, title: rule, evidence: 'e', numbers: {}, source: 's', next: 'n', ...extra });
    const actor = (signals: Signal[], id = 'a'): ActorSignals => ({ id, name: id, signals, class: 'steady', exclusions: [] });
    const all = new Set(['R1', 'R4', 'R5', 'R7'] as const);
    const day = (n: number) => T('2026-11-01T03:00:00Z') + n * DAY_MS;

    it('lists the first run as a silent backlog, then notifies new, worse and once after 14 days', () => {
        const t0 = transition(null, [actor([sig('R1', 'PAGE', 10)])], day(0), all);
        expect(t0.notify).toEqual([]);
        expect(Object.values(t0.state.open)[0]!.backlog).toBe(true);
        const t1 = transition(t0.state, [actor([sig('R1', 'PAGE', 10)]), actor([sig('R7', 'PAGE', 5)], 'b')], day(1), all);
        expect(t1.notify.map((n) => [n.alert.name, n.reason])).toEqual([['b', 'new']]);
        const t2 = transition(t1.state, [actor([sig('R1', 'PAGE', 16)]), actor([sig('R7', 'PAGE', 5.5)], 'b')], day(2), all);
        expect(t2.notify.map((n) => [n.alert.name, n.reason])).toEqual([['a', 'worse']]);
        const t3 = transition(t2.state, [actor([sig('R1', 'PAGE', 16)]), actor([sig('R7', 'PAGE', 5.5)], 'b')], day(16), all);
        expect(t3.notify.map((n) => [n.alert.name, n.reason])).toEqual([['b', 'remind']]);
    });

    it('keeps a held alert open, resolves it once its rule stops firing, and never resolves unevaluated rules', () => {
        const s0 = transition({ ...transition(null, [], day(0), all).state }, [actor([sig('R1', 'PAGE', 10)])], day(1), all).state;
        const held = transition(s0, [actor([sig('R1', 'PAGE', 3, { hold: true })])], day(2), all);
        expect(Object.keys(held.state.open)).toEqual(['a:R1']);
        const degraded = transition(held.state, [], day(3), new Set(['R5'] as const));
        expect(Object.keys(degraded.state.open)).toEqual(['a:R1']);
        const resolved = transition(degraded.state, [], day(4), all);
        expect(resolved.state.open).toEqual({});
        expect(resolved.events.map((e) => e.event)).toEqual(['resolve']);
        expect(resolved.pageChanged).toBe(true);
    });

    it('does not notify a snoozed actor but still tracks it', () => {
        const s0: WatchState = { ...transition(null, [], day(0), all).state, snoozes: [{ actorId: 'a', name: 'a', rule: null, until: new Date(day(5)).toISOString() }] };
        const t = transition(s0, [actor([sig('R4', 'PAGE', 3)])], day(1), all);
        expect(t.notify).toEqual([]);
        expect(t.state.open['a:R4']).toBeDefined();
        const items = buildItems([actor([sig('R4', 'PAGE', 3)])], t.state, t.opened, day(1));
        expect(items[0]!.snoozed).toBe(true);
    });
});

describe('delivery', () => {
    it('builds a LaunchAgent with the flag baked in and four daily times', () => {
        const plist = launchAgentPlist({ nodePath: '/opt/node', entryPath: "/Users/x/it's & <home>/app/index.js", home: '/Users/x/.apify-insights', times: parseTimes(undefined) });
        expect(plist).toContain('<string>--experimental</string>');
        expect(plist).toContain('<key>APIFY_INSIGHTS_WATCH</key>');
        expect(plist).toContain('it\'s &amp; &lt;home&gt;');
        expect(plist.match(/<key>Hour<\/key>/g)).toHaveLength(4);
        expect(() => parseTimes('25:00')).toThrow();
    });
    it('escapes notification text for AppleScript and keeps it to names and dollars', () => {
        expect(notificationScript('T "x"', 'a\\b\nc')).toBe('display notification "a\\\\b c" with title "T \\"x\\""');
        const text = notificationText([{ name: 'scraper-a', rule: 'R7', atStakeUsd: 4.861 }]);
        expect(text.message).toBe('scraper-a (R7, $4.86/wk). Run decline_watch or read the digest.');
    });
    it('redacts bearer headers and registered secrets', () => {
        registerSecret('TEST-SENTINEL-REDACT-1234');
        expect(redact('Authorization: Bearer abc.def x TEST-SENTINEL-REDACT-1234')).toBe('Authorization: Bearer [redacted] x [redacted]');
    });
});

describe('watch run end to end', () => {
    let home: string;
    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'aim-watch-'));
    });
    afterEach(async () => {
        await rm(home, { recursive: true, force: true });
    });

    const SENTINEL = 'TEST-SENTINEL-9f3a7c1e5b';
    const store = [storeActor('scraper-a', 12, { TOTAL: 40, SUCCEEDED: 38, FAILED: 2 }), storeActor('scraper-b', 2, { TOTAL: 5, SUCCEEDED: 5 }, { notice: 'UNDER_MAINTENANCE' })];
    const api = (): ApifyApi => ({ ...fakeApi([myActor('scraper-a'), myActor('scraper-b')], store), myRuns: async () => [{ actId: 'id-scraper-a', status: 'SUCCEEDED', startedAt: '2026-11-10T10:00:00Z' }] });

    /** A real Console client over a fake fetch, so the token goes through the same header path as live. */
    function consoleWith(token: string, month: Record<string, unknown>[]): ConsoleApi {
        const tokens: TokenProvider = { current: async () => ({ value: token, receivedAt: '2026-11-11T00:00:00Z' }), refresh: async () => ({ value: token, receivedAt: '2026-11-11T00:00:00Z' }) };
        const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
            expect(String((init?.headers as Record<string, string>).Authorization)).toBe(`Bearer ${token}`);
            const u = new URL(String(url));
            if (u.pathname.endsWith('actor-breakdown')) return new Response(JSON.stringify({ monetizationPerActor: month }), { status: 200 });
            if (u.pathname.endsWith('user-count-statistics')) return new Response(JSON.stringify({ '2026-11-10': { freeUsers: 1, payingUsers: 2 } }), { status: 200 });
            return new Response(JSON.stringify({ numUniqueWebPageViews: 10, numUniqueConsolePageViews: 5, numUniqueUsersWithRun: 2, numUniqueViewingUsers: 8 }), { status: 200 });
        }) as typeof fetch;
        return createConsoleApi(tokens, fetchImpl, { jitter: () => 0, retryDelayMs: 1 });
    }

    const breakdownRow = (name: string, revenue: number, cost: number, runs: number, timedOut = 0) => ({
        actor: { _id: `id-${name}`, name, title: name, username: ME.username, isPublic: true, notice: 'NONE' },
        runsStats: { TOTAL: runs, SUCCEEDED: runs - timedOut, FAILED: 0, 'TIMED-OUT': timedOut, ABORTED: 0, RESULTS: runs * 10 },
        earningsStats: { totalRevenueUsd: revenue, totalCostUsd: cost, totalProfitUsd: revenue - cost },
        usersStats: { payingUsers: 2, freeUsers: 1 },
        chargedResults: runs * 10,
        currentPricingInfo: { pricingModel: 'PAY_PER_EVENT' },
    });

    function deps(now: number, consoleApi: ConsoleApi | null, notes: string[]): WatchDeps {
        return {
            home,
            api: api(),
            console: async () => ({ api: consoleApi, outcome: consoleApi ? 'ok' : 'bridge_missing' }),
            now: () => now,
            log: createLog(home, () => {}, () => now),
            notifier: async (title, message) => {
                notes.push(`${title}: ${message}`);
                return true;
            },
        };
    }

    it('takes snapshots, pages a new cost leak on the second day, and never writes the token anywhere', async () => {
        const notes: string[] = [];
        const d1 = T('2026-11-10T03:30:00Z');
        const d2 = T('2026-11-11T03:30:00Z');
        const first = await watchRun(deps(d1, consoleWith(SENTINEL, [breakdownRow('scraper-a', 5, 0.5, 100)]), notes));
        expect(first.summary).toContain('first run');
        expect(notes).toEqual([]);
        const second = await watchRun(deps(d2, consoleWith(SENTINEL, [breakdownRow('scraper-a', 5.1, 6, 140, 20)]), notes));
        expect(second.code).toBe(0);
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain('scraper-a (R7');
        // A third run the same UTC day exits at once.
        expect((await watchRun(deps(d2 + 3600_000, consoleWith(SENTINEL, []), notes))).summary).toBe('already done');

        const summary = await readWatchSummary(home);
        expect(summary.pages.map((p) => `${p.name}:${p.rule}`)).toContain('scraper-a:R7');
        expect(briefLine(summary, d2)).toMatch(/^Early warning \(experimental\): 1 actor with open PAGE alerts, oldest since 2026-11-11/);
        expect(summary.digest).toContain('[PAGE] scraper-a - R7 cost above revenue');

        // ADR-7: no file under the watch folder holds the token; folders 0700, files 0600.
        const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])))).flat();
        const files = await walk(join(home, 'watch'));
        expect(files.length).toBeGreaterThan(5);
        for (const file of files) {
            const raw = await readFile(file);
            const text = file.endsWith('.gz') ? (await import('node:zlib')).gunzipSync(raw).toString('utf8') : raw.toString('utf8');
            expect(text.includes(SENTINEL), file).toBe(false);
            expect((await stat(file)).mode & 0o777, file).toBe(0o600);
        }
        expect((await stat(join(home, 'watch'))).mode & 0o777).toBe(0o700);
        expect((await stat(join(home, 'watch', 'snapshots'))).mode & 0o777).toBe(0o700);
        const status = await watchStatus(home, d2, { flagOn: true, launchAgentInstalled: false });
        expect(status.code).toBe(0);
        expect(status.lines.join('\n')).toContain('0 errors');
    });

    it('runs on public data only without a session and notifies once after 48 h blind', async () => {
        const notes: string[] = [];
        await watchRun(deps(T('2026-11-08T03:00:00Z'), consoleWith(SENTINEL, [breakdownRow('scraper-a', 1, 0.1, 10)]), notes));
        await watchRun(deps(T('2026-11-09T03:00:00Z'), null, notes));
        expect(notes).toEqual([]);
        await watchRun(deps(T('2026-11-10T04:00:00Z'), null, notes));
        expect(notes).toEqual(['Early warning paused: Money signals paused since 2026-11-08: open Chrome and check you are logged in to console.apify.com.']);
        await watchRun(deps(T('2026-11-11T04:00:00Z'), null, notes));
        expect(notes).toHaveLength(1);
        const summary = await readWatchSummary(home);
        expect(summary.digest ?? '').not.toContain(SENTINEL);
        // The notice on scraper-b is public data: it is tracked even without money (install backlog).
        expect(Object.keys(summary.state!.open)).toContain('id-scraper-b:R5');
    });
});

describe('cli and server wiring', () => {
    it('is off without the flag', async () => {
        const lines: string[] = [];
        const code = await runCli(['watch', 'status'], { env: {}, home: '/nonexistent', log: (l) => lines.push(l) });
        expect(code).toBe(2);
        expect(lines[0]).toContain('experimental and off by default');
    });
    it('prints the LaunchAgent without installing it', async () => {
        const lines: string[] = [];
        const ran: string[] = [];
        const code = await runCli(['watch', 'install', '--print', '--experimental'], {
            env: {},
            home: '/tmp/aim-home',
            homeDir: '/tmp/aim-user',
            platform: 'darwin',
            nodePath: '/opt/node',
            log: (l) => lines.push(l),
            run: async (cmd, args) => {
                ran.push(`${cmd} ${args.join(' ')}`);
                return { ok: true, output: '' };
            },
        });
        expect(code).toBe(0);
        expect(ran).toEqual([]);
        expect(lines.join('\n')).toContain('<string>com.apify-insights.watch</string>');
    });
    it('registers decline_watch and the daily_brief line only with the flag', async () => {
        const off = await connect(fakeApi([], []), testConfig('/tmp/aim-none'));
        expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain('decline_watch');
        const brief = await call(off.client, 'daily_brief');
        expect(brief.text).not.toContain('Early warning');
        const on = await connect(fakeApi([], []), { ...testConfig('/tmp/aim-none'), watch: true });
        expect((await on.client.listTools()).tools.map((t) => t.name)).toContain('decline_watch');
        const briefOn = await call(on.client, 'daily_brief');
        expect(briefOn.text).toContain('Early warning (experimental): not run yet');
        const tool = await call(on.client, 'decline_watch');
        expect(tool.data.code).toBe('disabled');
    });
});

describe('digest', () => {
    it('renders verdict, sections and the rules version', () => {
        const state = transition(null, [], T('2026-11-11T03:00:00Z'), new Set()).state;
        const text = renderDigest({
            day: '2026-11-11',
            asOf: '2026-11-11T03:00:00.000Z',
            items: [],
            actors: [],
            facts: new Map(),
            state,
            resolved: [],
            firstRun: false,
            weekly: true,
            consoleLine: 'Console snapshot fresh',
            storeLine: 'Store stats fresh',
            dataLine: 'Facts from 2026-09-01',
            notes: [],
        });
        expect(text).toContain('# Early warning 2026-11-11');
        expect(text).toContain('**Nothing to page on. 0 WATCH item(s).**');
        expect(text).toContain('Rules w1 (experimental)');
        expect(text).toContain('## Concentration (0)');
    });
    it('evaluates nothing for an ignored actor', () => {
        const data = scenarioData();
        const evaluation = evaluateAll(prepare(data), { asOf: T('2026-11-11T00:00:00Z'), weekly: false, money: true, config: { ...DEFAULT_CONFIG, ignore: ['cost-leak'] } });
        expect(evaluation.actors.map((a) => a.id)).not.toContain('cost-leak');
    });
});
