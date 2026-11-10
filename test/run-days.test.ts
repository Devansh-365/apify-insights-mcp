import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApifyApi, tailOf } from '../src/clients/apify-api.js';
import { createConsoleApi, type SharedRun } from '../src/clients/console.js';
import { cacheRoot } from '../src/core/disk-cache.js';
import { resolvePeriod } from '../src/core/period.js';
import { dayWindow, statusCounts, totalsOf, worstDay } from '../src/core/run-days.js';
import { DAY_SOURCE_NOTE } from '../src/tools/run-health-days.js';
import { call, connect, fakeApi, fakeConsole, fakeTokens, myActor, spread, storeActor, testConfig, type FakeActorMonth } from './helpers.js';

// Made-up account. "now" is 2026-11-08 03:00 UTC, so November has 8 days of data (the 8th partial).
const NOW = Date.parse('2026-11-08T03:00:00.000Z');
const now = () => NOW;

const MONTHS: Record<string, Record<string, FakeActorMonth>> = {
    '2026-11': {
        healthy: { revenue: 80, cost: 20, runs: 800 },
        broken: { revenue: 2, cost: 12, runs: 80, failed: 16, timedOut: 8, aborted: 8 },
        flaky: { revenue: 1, cost: 1, runs: 40, aborted: 16 },
        steady: { revenue: 20, cost: 5, runs: 160, failed: 8 },
    },
    '2026-10': {
        healthy: { revenue: 150, cost: 40, runs: 3100 },
        broken: { revenue: 30, cost: 8, runs: 310, failed: 31 },
        steady: { revenue: 60, cost: 15, runs: 310 },
    },
};

const RUN = (id: string, status: string, finishedAt: string, buildNumber = '0.2.1'): SharedRun => ({
    _id: id,
    actId: 'id-broken',
    status,
    startedAt: finishedAt,
    finishedAt,
    buildNumber,
    exitCode: status === 'FAILED' ? 1 : 0,
    isRunOfPayingUser: true,
});

const SHARED = [
    RUN('runAAAAAAAAAAAAA1', 'FAILED', '2026-11-07T10:00:00.000Z'),
    RUN('runAAAAAAAAAAAAA2', 'SUCCEEDED', '2026-11-06T10:00:00.000Z'),
    RUN('runAAAAAAAAAAAAA3', 'TIMED-OUT', '2026-11-05T10:00:00.000Z'),
    RUN('runAAAAAAAAAAAAA4', 'FAILED', '2026-11-03T10:00:00.000Z'),
    RUN('runAAAAAAAAAAAAA5', 'FAILED', '2026-11-02T10:00:00.000Z'),
    RUN('runAAAAAAAAAAAAA6', 'FAILED', '2026-10-20T10:00:00.000Z', '0.1.9'),
];

const BUILDS = {
    'id-broken': [
        { id: 'b3', status: 'SUCCEEDED', buildNumber: '0.2.1', finishedAt: '2026-11-04T00:00:00.000Z' },
        { id: 'b2', status: 'FAILED', buildNumber: '0.2.0', finishedAt: '2026-10-30T00:00:00.000Z' },
        { id: 'b1', status: 'SUCCEEDED', buildNumber: '0.1.9', finishedAt: '2026-10-28T00:00:00.000Z' },
    ],
};

const LOGS = {
    runAAAAAAAAAAAAA1: ['INFO start', 'ERROR boom: selector not found'],
    runAAAAAAAAAAAAA3: ['INFO start', 'WARN still waiting'],
};

function api() {
    const names = ['healthy', 'broken', 'flaky', 'steady'];
    return fakeApi(
        names.map((name) => myActor(name)),
        names.map((name) => storeActor(name, 10, { TOTAL: 100, SUCCEEDED: 100, FAILED: 0, ABORTED: 0, 'TIMED-OUT': 0 })),
        {},
        new Map(),
        new Map(),
        { builds: BUILDS, logs: LOGS },
    );
}

async function setup(consoleApi = fakeConsole(MONTHS, NOW, undefined, undefined, SHARED)) {
    const home = await mkdtemp(join(tmpdir(), 'aim-days-'));
    const publicApi = api();
    const { client } = await connect(publicApi, testConfig(home), now, { consoleApi });
    return { client, home, publicApi, consoleApi };
}

describe('run-days helpers', () => {
    it('reads a missing FAILED as the remainder, like the extension', () => {
        expect(statusCounts('2026-11-01', { TOTAL: 10, SUCCEEDED: 6, ABORTED: 1, 'TIMED-OUT': 1 })).toMatchObject({ failed: 2, timedOut: 1, aborted: 1 });
        expect(statusCounts('2026-11-01', undefined)).toMatchObject({ runs: 0, failed: 0 });
    });
    it('leaves aborted runs out of the failure rate and picks the later worst day on a tie', () => {
        const days = [statusCounts('a', { TOTAL: 10, SUCCEEDED: 0, FAILED: 1, ABORTED: 9 }), statusCounts('b', { TOTAL: 10, SUCCEEDED: 9, FAILED: 1 })];
        expect(totalsOf(days).failureRatePct).toBe(10);
        expect(worstDay(days)!.date).toBe('b');
    });
    it.each([
        ['today', ['2026-11-08', '2026-11-08'], true, ['2026-11']],
        ['thisMonth', ['2026-11-01', '2026-11-08'], true, ['2026-11']],
        ['yesterday', ['2026-11-07', '2026-11-07'], false, ['2026-11']],
        ['last7d', ['2026-11-01', '2026-11-07'], false, ['2026-11']],
        ['lastMonth', ['2026-10-01', '2026-10-31'], false, ['2026-10', '2026-11']],
        [{ from: '2026-10-25', to: '2026-11-03' }, ['2026-10-25', '2026-11-03'], false, ['2026-10', '2026-11']],
    ] as const)('today rules for %j', (input, [from, to], todayInPeriod, months) => {
        const window = dayWindow(resolvePeriod(input as never, NOW), '2026-11-08');
        expect([window.days[0], window.days[window.days.length - 1]]).toEqual([from, to]);
        expect(window.todayInPeriod).toBe(todayInPeriod);
        expect(window.months).toEqual(months);
    });
});

describe('run_health with period, all actors', () => {
    it('adds per-day counts, today on its own, and leaves the 30-day rows alone', async () => {
        const { client, consoleApi } = await setup();
        const plain = await call(client, 'run_health');
        const { data, text } = await call(client, 'run_health', { period: 'last7d' });
        expect(data.rows).toEqual(plain.data.rows);
        const day = data.byDay;
        expect(day.period).toEqual({ label: 'last7d', from: '2026-11-01', to: '2026-11-07', timezone: 'UTC', source: 'console-run-statistics' });
        // 7 of 8 days: (800 + 80 + 40 + 160) × 7/8 runs; broken 2 failed/day + steady 1/day.
        expect(day.account.totals).toMatchObject({ runs: 945, failed: 21, timedOut: 7, aborted: 21 });
        expect(day.account.days).toHaveLength(7);
        expect(day.today).toMatchObject({ date: '2026-11-08', failed: 3, timedOut: 1, partial: true });
        expect(day.actors.map((a: { ref: string }) => a.ref)).toEqual(['acme/broken', 'acme/steady']);
        expect(day.actors[0]).toMatchObject({ failed: 14, timedOut: 7, aborted: 7, runs: 70, failureRatePct: 30, todayFailed: 2, todayTimedOut: 1, problemDays: 7, firstProblemDay: '2026-11-01', lastProblemDay: '2026-11-07' });
        expect(day.actors[0].days.every((d: { partial?: boolean }) => !d.partial)).toBe(true);
        // flaky only has aborted runs: never a candidate, never listed.
        expect(day.coverage).toEqual({ actorsWithProblemRuns: 2, checked: 2 });
        expect(data.notes).toContain(DAY_SOURCE_NOTE);
        expect(text).toContain('By day (last7d, UTC): 21 failed, 7 timed out, 21 aborted of 945 runs; today so far 3 failed, 1 timed out');
        const consoleCalls = consoleApi.calls.filter((c) => c.startsWith('runStatistics') || c.startsWith('breakdown'));
        expect(consoleCalls.length).toBeLessThanOrEqual(24);
    });
    it('ends with today (partial, in the totals) when the period reaches today', async () => {
        const { client } = await setup();
        const { data } = await call(client, 'run_health', { period: 'thisMonth' });
        expect(data.byDay.today).toBeUndefined();
        const last = data.byDay.account.days.at(-1);
        expect(last).toMatchObject({ date: '2026-11-08', partial: true });
        expect(data.byDay.actors[0]).toMatchObject({ ref: 'acme/broken', failed: 16, timedOut: 8, problemDays: 8 });
    });
    it('sums per-actor days to the monthly breakdown for a past month', async () => {
        const { client } = await setup();
        const { data } = await call(client, 'run_health', { period: '2026-10' });
        expect(data.byDay.account.days).toHaveLength(31);
        // steady had no problem in October but fails today, so it is listed after broken with zeros for the month.
        expect(data.byDay.actors.map((a: { ref: string }) => a.ref)).toEqual(['acme/broken', 'acme/steady']);
        expect(data.byDay.actors[0]).toMatchObject({ ref: 'acme/broken', failed: 31, runs: 310, todayFailed: 2 });
        expect(data.byDay.actors[1]).toMatchObject({ failed: 0, problemDays: 0, todayFailed: 1, worstDay: null });
        expect(data.byDay.today).toMatchObject({ date: '2026-11-08', partial: true });
        expect(spread(31, 31).reduce((a, b) => a + b, 0)).toBe(31);
    });
    it('checks only `top` actors and says how many were left out', async () => {
        const { client } = await setup();
        const { data } = await call(client, 'run_health', { period: 'last7d', top: 1 });
        expect(data.byDay.coverage).toEqual({ actorsWithProblemRuns: 2, checked: 1 });
        expect(data.notes.join(' ')).toContain('1 more actors had failed or timed-out runs in 2026-11 and were not checked; raise `top` (up to 25) or pass `actor` for one of them.');
    });
    it('without a Console session keeps the 30-day answer and adds a note', async () => {
        const home = await mkdtemp(join(tmpdir(), 'aim-days-'));
        const { client } = await connect(api(), testConfig(home), now, { consoleApi: null });
        const { result, data } = await call(client, 'run_health', { period: 'last7d' });
        expect(result.isError).toBeFalsy();
        expect(data.byDay).toBeUndefined();
        expect(data.notes.join(' ')).toContain('need the Console session');
    });
});

describe('run_health with period and actor', () => {
    it('lists failed shared runs in the period with log tails, builds and the build before the first problem', async () => {
        const { client, publicApi } = await setup();
        const { data, text } = await call(client, 'run_health', { actor: 'broken', period: 'last7d' });
        expect(data.byDay.days).toHaveLength(7);
        expect(data.byDay).toMatchObject({ problemDays: 7, firstProblemDay: '2026-11-01', totals: { failed: 14, timedOut: 7, aborted: 7 } });
        expect(data.byDay.today).toMatchObject({ date: '2026-11-08', failed: 2, partial: true });
        const shared = data.sharedRuns;
        expect(shared.failedInPeriod).toBe(4);
        expect(shared.failed.map((r: { runId: string }) => r.runId)).toEqual(['runAAAAAAAAAAAAA1', 'runAAAAAAAAAAAAA3', 'runAAAAAAAAAAAAA4', 'runAAAAAAAAAAAAA5']);
        expect(shared.failed[0]).toMatchObject({
            status: 'FAILED',
            buildNumber: '0.2.1',
            exitCode: 1,
            payingUser: true,
            consoleUrl: 'https://console.apify.com/view/runs/runAAAAAAAAAAAAA1',
            logTail: ['INFO start', 'ERROR boom: selector not found'],
        });
        expect(shared.failed[2].logTail).toBeNull();
        expect('logTail' in shared.failed[3]).toBe(false);
        expect(publicApi.calls.filter((c) => c.startsWith('runLog'))).toHaveLength(3);
        expect(data.builds).toHaveLength(3);
        expect(data.buildBeforeFirstProblem).toEqual({ buildNumber: '0.1.9', finishedAt: '2026-10-28T00:00:00.000Z' });
        expect(text).toContain('4 failed shared runs in the period');
    });
    it('tries shared runs once more after a dropped connection', async () => {
        const consoleApi = fakeConsole(MONTHS, NOW, undefined, undefined, SHARED);
        const real = consoleApi.sharedRuns.bind(consoleApi);
        let failures = 1;
        consoleApi.sharedRuns = async (...args) => {
            if (failures-- > 0) throw new TypeError('fetch failed');
            return real(...args);
        };
        const { client } = await setup(consoleApi);
        const { data } = await call(client, 'run_health', { actor: 'broken', period: 'last7d' });
        expect(data.sharedRuns.failedInPeriod).toBe(4);
        expect(data.notes.join(' ')).not.toContain('could not be loaded');
    });
    it('skips logs when asked and never writes them to disk', async () => {
        const { client, home, publicApi } = await setup();
        const quiet = await call(client, 'run_health', { actor: 'broken', period: 'last7d', logs: false });
        expect(quiet.data.sharedRuns.failed[0].logTail).toBeUndefined();
        expect(publicApi.calls.some((c) => c.startsWith('runLog'))).toBe(false);
        // A settled month goes through the disk cache; nothing from a log may end up there.
        await call(client, 'run_health', { actor: 'broken', period: { from: '2026-10-01', to: '2026-11-07' } });
        await call(client, 'run_health', { period: 'lastMonth' });
        const root = cacheRoot(home);
        const files = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
        for (const file of files.filter((f) => f.isFile())) {
            const body = await readFile(join(file.parentPath, file.name), 'utf8');
            expect(body).not.toContain('boom');
            expect(body).not.toContain('runAAAA');
        }
    });
});

describe('clients', () => {
    afterEach(() => vi.unstubAllGlobals());

    const stream = (text: string, chunk = 7) =>
        new ReadableStream<Uint8Array>({
            start(controller) {
                const bytes = new TextEncoder().encode(text);
                for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
                controller.close();
            },
        });

    it('tailOf keeps the last lines, cuts long ones and stops at the byte cap', async () => {
        const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n';
        expect(await tailOf(stream(text), 1_000_000, 3, 300)).toEqual({ lines: ['line 47', 'line 48', 'line 49'], truncatedAtBytes: false });
        expect((await tailOf(stream(`${'x'.repeat(400)}\nend`), 1_000_000, 30, 300)).lines[0]).toHaveLength(301);
        const capped = await tailOf(stream(text), 20, 30, 300);
        expect(capped.truncatedAtBytes).toBe(true);
        expect(capped.lines.join('\n').length).toBeLessThanOrEqual(20);
    });

    it('runLog returns available: false on 403/404 and lines on 200', async () => {
        const fetchMock = vi.fn(async (url: string) =>
            url.includes('missing') || url.includes('forbidden') ? new Response('nope', { status: url.includes('missing') ? 404 : 403 }) : new Response('a\nb\n', { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const client = createApifyApi('t', 'http://api.test/v2');
        expect(await client.runLog('missing')).toEqual({ available: false, lines: [], truncatedAtBytes: false });
        expect(await client.runLog('forbidden')).toMatchObject({ available: false });
        expect(await client.runLog('runok')).toEqual({ available: true, lines: ['a', 'b'], truncatedAtBytes: false });
        expect(await client.runLog('../etc')).toMatchObject({ available: false });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('sharedRuns sends the bracket sort key and validates actor IDs', async () => {
        const urls: string[] = [];
        const fetchImpl = (async (url: string) => {
            urls.push(url);
            return new Response(JSON.stringify({ data: [], sequencePagination: { nextPageToken: null, totalCount: 0 } }), { status: 200 });
        }) as typeof fetch;
        const consoleApi = createConsoleApi(fakeTokens('t'), fetchImpl);
        await consoleApi.sharedRuns(['abcABC123', 'def456'], { limit: 100 });
        expect(urls[0]).toContain('actor-analytics/shared-runs?actorIds=abcABC123%2Cdef456&limit=100&sort%5BfinishedAt%5D=-1');
        await expect(consoleApi.sharedRuns(['../x'], { limit: 1 })).rejects.toThrow('Not an actor ID');
    });
});
