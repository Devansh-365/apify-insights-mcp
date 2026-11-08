import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentConsoleToken, refreshedConsoleToken } from '../src/auth/console-session.js';
import { createConsoleApi, isNetworkError, retryAfterMs } from '../src/clients/console.js';
import { ToolError } from '../src/core/envelope.js';
import { breakdown, breakdownFor } from '../src/core/console-data.js';
import { tuneKeepAlive } from '../src/core/keepalive.js';
import { createReporter } from '../src/core/progress.js';
import { installTiming } from '../src/core/timing.js';
import { breakdownRow, connect, fakeApi, fakeConsole, fakeTokens, myActor, storeActor, testConfig } from './helpers.js';

// Speed and robustness of the Console client and session (plan .omc/plans/tool-latency.md).

const TOKEN = 'fake-ui-token-0123456789abcdefghijklmnopqrstu';
const NEW_TOKEN = 'fake-ui-token-NEW-0123456789abcdefghijklmnop';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const socketError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });

async function home(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'aim-latency-'));
    await mkdir(join(dir, 'sessions'), { recursive: true });
    return dir;
}

const writeSession = (dir: string, uiToken: string, receivedAt: string, userId = 'user123') =>
    writeFile(join(dir, 'sessions', 'p1.json'), JSON.stringify({ uiToken, userId, receivedAt, producer: 'bridge' }));

afterEach(() => {
    vi.useRealTimers();
});

describe('session tokens (AC2)', () => {
    it('returns a token older than 2 hours without waiting', async () => {
        const dir = await home();
        await writeSession(dir, TOKEN, '2026-11-08T00:00:00.000Z');
        const now = Date.parse('2026-11-08T05:00:00.000Z');
        await expect(currentConsoleToken(dir, 'user123', now)).resolves.toEqual({ value: TOKEN, receivedAt: '2026-11-08T00:00:00.000Z' });
    });
    it('still fails fast without a bridge or for another account', async () => {
        const empty = await mkdtemp(join(tmpdir(), 'aim-latency-'));
        await expect(currentConsoleToken(empty, 'user123')).rejects.toMatchObject({ code: 'bridge_missing' });
        const other = await home();
        await writeSession(other, TOKEN, '2026-11-08T00:00:00.000Z', 'someone-else');
        await expect(currentConsoleToken(other, 'user123')).rejects.toMatchObject({ code: 'other_account' });
    });
    it('waits for a token newer than the rejected one, else reports warming_up', async () => {
        const dir = await home();
        await writeSession(dir, TOKEN, '2026-11-08T00:00:00.000Z');
        const rejected = { value: TOKEN, receivedAt: '2026-11-08T00:00:00.000Z' };
        let clock = Date.parse('2026-11-08T05:00:00.000Z');
        let sleeps = 0;
        const sleep = async (ms: number) => {
            sleeps++;
            clock += ms;
            if (sleeps === 2) await writeSession(dir, NEW_TOKEN, '2026-11-08T05:00:06.000Z');
        };
        await expect(refreshedConsoleToken(dir, 'user123', rejected, { now: () => clock, sleep })).resolves.toEqual({ value: NEW_TOKEN, receivedAt: '2026-11-08T05:00:06.000Z' });

        const stuck = await home();
        await writeSession(stuck, TOKEN, '2026-11-08T00:00:00.000Z');
        let t = 0;
        await expect(refreshedConsoleToken(stuck, 'user123', rejected, { now: () => t, sleep: async (ms) => void (t += ms), timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'warming_up' });
    });
});

describe('console client: one shared refresh on 401 (AC3)', () => {
    it('refreshes once for six concurrent 401s and retries each with the new token', async () => {
        const tokens = fakeTokens(TOKEN, [NEW_TOKEN]);
        const auth: string[] = [];
        const api = createConsoleApi(tokens, (async (_url: string, init: RequestInit) => {
            const header = (init.headers as Record<string, string>).Authorization!;
            auth.push(header);
            await new Promise((resolve) => setTimeout(resolve, 2));
            return header.endsWith(NEW_TOKEN) ? json({ actorQuality: 0.5 }) : new Response('{}', { status: 401 });
        }) as typeof fetch);
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) => api.qualityScores(`a${i}`)));
        expect(results.every((r) => r.actorQuality === 0.5)).toBe(true);
        expect(tokens.refreshes).toHaveLength(1);
        expect(auth.filter((h) => h.endsWith(NEW_TOKEN))).toHaveLength(6);
    });
    it('reports logged_out when the new token is rejected too', async () => {
        const api = createConsoleApi(fakeTokens(TOKEN, [NEW_TOKEN]), (async () => new Response('{}', { status: 401 })) as typeof fetch);
        const error = await api.qualityScores('a1').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ToolError);
        expect(error).toMatchObject({ code: 'logged_out' });
    });
});

describe('console client: dropped connections (AC4)', () => {
    it('detects socket errors but not timeouts', () => {
        expect(isNetworkError(socketError())).toBe(true);
        expect(isNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
        expect(isNetworkError(new DOMException('timed out', 'TimeoutError'))).toBe(false);
        expect(isNetworkError(new TypeError('x is not a function'))).toBe(false);
    });
    it('retries a dropped connection, including one that drops while reading the body', async () => {
        let calls = 0;
        const api = createConsoleApi(fakeTokens(TOKEN), (async () => {
            calls++;
            if (calls === 1) throw socketError();
            if (calls === 2) return { ok: true, status: 200, headers: new Headers(), json: async () => Promise.reject(socketError()) } as unknown as Response;
            return json({ actorQuality: 0.7 });
        }) as typeof fetch, { retryDelayMs: 0, jitter: () => 0 });
        await expect(api.qualityScores('a1')).resolves.toEqual({ actorQuality: 0.7 });
        expect(calls).toBe(3);
    });
    it('does not retry a timeout', async () => {
        let calls = 0;
        const api = createConsoleApi(fakeTokens(TOKEN), (async () => {
            calls++;
            throw new DOMException('timed out', 'TimeoutError');
        }) as typeof fetch, { retryDelayMs: 0, jitter: () => 0 });
        await expect(api.qualityScores('a1')).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(calls).toBe(1);
    });
});

describe('console client: rate limit (AC9b)', () => {
    it('reads Retry-After as seconds or a date, capped at 30 s', () => {
        expect(retryAfterMs('3')).toBe(3000);
        expect(retryAfterMs('120')).toBe(30_000);
        expect(retryAfterMs(new Date(Date.parse('2026-11-08T00:00:05Z')).toUTCString(), Date.parse('2026-11-08T00:00:00Z'))).toBe(5000);
        expect(retryAfterMs(null)).toBeNull();
        expect(retryAfterMs('soon')).toBeNull();
    });
    it('pauses the whole queue for Retry-After before any request starts again', async () => {
        vi.useFakeTimers();
        const starts: number[] = [];
        let limited = false;
        const api = createConsoleApi(fakeTokens(TOKEN), (async () => {
            starts.push(Date.now());
            if (!limited) {
                limited = true;
                return json({}, 429, { 'Retry-After': '3' });
            }
            return json({ actorQuality: 0.1 });
        }) as typeof fetch, { jitter: () => 0 });
        const t0 = Date.now();
        const first = api.qualityScores('a1');
        await vi.advanceTimersByTimeAsync(0);
        const second = api.qualityScores('a2');
        await vi.advanceTimersByTimeAsync(2999);
        expect(starts).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
        expect(starts.slice(1).every((t) => t - t0 >= 3000)).toBe(true);
    });
});

describe('console client: actor breakdown for named actors (Step 5)', () => {
    it('passes validated actorIds and splits more than 50 into several calls', async () => {
        const urls: string[] = [];
        const api = createConsoleApi(fakeTokens(TOKEN), (async (url: string) => {
            urls.push(url);
            const ids = new URL(url).searchParams.get('actorIds')!.split(',');
            return json({ monetizationPerActor: ids.map((id) => ({ ...breakdownRow(id, { revenue: 1, cost: 0, runs: 1 }), actor: { _id: id, name: id } })) });
        }) as typeof fetch);
        const ids = Array.from({ length: 51 }, (_, i) => `actor${i}`);
        const result = await api.actorBreakdown('2026-10', ids);
        expect(urls).toHaveLength(2);
        expect(urls[0]).toContain('month=2026-10-01&actorIds=actor0%2Cactor1');
        expect(result.monetizationPerActor.map((row) => row.actor._id)).toEqual(ids);
        await expect(api.actorBreakdown('2026-10', ['../users/me'])).rejects.toThrow(/Not an actor ID/);
    });
});

describe('breakdownFor (AC5)', () => {
    const MONTHS = { '2026-10': { alpha: { revenue: 10, cost: 2, runs: 5 }, beta: { revenue: 20, cost: 4, runs: 9 } } };
    async function ctxWith(consoleApi = fakeConsole(MONTHS)) {
        const homeDir = await mkdtemp(join(tmpdir(), 'aim-latency-'));
        const { ctx } = await connect(fakeApi([], []), testConfig(homeDir), () => Date.parse('2026-11-08T03:00:00.000Z'), { consoleApi });
        return { ctx, consoleApi };
    }
    it('joins a full breakdown that is already loading instead of asking again', async () => {
        const { ctx, consoleApi } = await ctxWith();
        const full = breakdown(ctx, consoleApi, '2026-10');
        const rows = await breakdownFor(ctx, consoleApi, '2026-10', ['id-beta']);
        await full;
        expect(rows.map((row) => row.id)).toEqual(['id-beta']);
        expect(consoleApi.calls).toEqual(['breakdown:2026-10']);
    });
    it('asks for just the named actors otherwise, with sorted IDs, and gives the same row as the full list', async () => {
        const { ctx, consoleApi } = await ctxWith();
        const [beta] = await breakdownFor(ctx, consoleApi, '2026-10', ['id-beta']);
        expect(consoleApi.calls).toEqual(['breakdown:2026-10:id-beta']);
        const fullRow = (await breakdown(ctx, consoleApi, '2026-10')).find((row) => row.id === 'id-beta');
        expect(beta).toEqual(fullRow);
    });
    it('falls back to the full month when the filtered response changes shape', async () => {
        const base = fakeConsole(MONTHS);
        const flaky = { ...base, actorBreakdown: async (month: string, ids?: string[]) => {
            if (ids) throw new ToolError('endpoint_changed', 'changed', 'x');
            return base.actorBreakdown(month);
        } };
        const { ctx } = await ctxWith(flaky as typeof base);
        const rows = await breakdownFor(ctx, flaky, '2026-10', ['id-alpha']);
        expect(rows.map((row) => row.id)).toEqual(['id-alpha']);
    });
});

describe('catalog loads /users/me and /acts together (AC6)', () => {
    it('starts both before either finishes', async () => {
        const started: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const api = {
            ...fakeApi([], []),
            async me() {
                started.push('me');
                await gate;
                return { id: 'user123', username: 'acme' };
            },
            async myActors() {
                started.push('myActors');
                return [];
            },
        };
        const homeDir = await mkdtemp(join(tmpdir(), 'aim-latency-'));
        const { ctx } = await connect(api, testConfig(homeDir));
        const catalog = ctx.catalog();
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(started).toEqual(['me', 'myActors']);
        release();
        await expect(catalog).resolves.toEqual([]);
    });
});

describe('keep-alive (AC7)', () => {
    const KEY = Symbol.for('undici.globalDispatcher.1');
    class Agent {
        constructor(readonly options: Record<string, number> = {}) {}
    }
    it('swaps an undici 6 Agent for one with a 60 s keep-alive, once', () => {
        const holder: Record<symbol, unknown> = { [KEY]: new Agent() };
        expect(tuneKeepAlive(holder, '6.24.1')).toBe(true);
        expect((holder[KEY] as Agent).options).toEqual({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 });
        expect(tuneKeepAlive(holder, '6.24.1')).toBe(false);
    });
    it('leaves undici 7+, a missing dispatcher, a different class or a throwing constructor alone', () => {
        expect(tuneKeepAlive({ [KEY]: new Agent() }, '8.0.2')).toBe(false);
        expect(tuneKeepAlive({}, '6.24.1')).toBe(false);
        class Dispatcher1Wrapper {}
        expect(tuneKeepAlive({ [KEY]: new Dispatcher1Wrapper() }, '6.24.1')).toBe(false);
        class Throwing {
            constructor(options?: unknown) {
                if (options) throw new Error('bad option');
            }
        }
        Object.defineProperty(Throwing, 'name', { value: 'Agent' });
        expect(tuneKeepAlive({ [KEY]: new Throwing() }, '6.24.1')).toBe(false);
    });
});

describe('progress notifications (AC8)', () => {
    it('reports strictly increasing progress for a scan when the client asks', async () => {
        const MONTHS = { '2026-11': { a: { revenue: 1, cost: 0, runs: 1 } } };
        const homeDir = await mkdtemp(join(tmpdir(), 'aim-latency-'));
        const actors = ['a', 'b', 'c', 'd'];
        const { client } = await connect(fakeApi(actors.map((n) => myActor(n)), actors.map((n, i) => storeActor(n, 10 + i, { TOTAL: 10, SUCCEEDED: 10 }))), testConfig(homeDir), () => Date.parse('2026-11-20T03:00:00.000Z'), {
            consoleApi: fakeConsole(MONTHS, Date.parse('2026-11-20T03:00:00.000Z')),
        });
        const seen: Array<{ progress: number; total?: number }> = [];
        await client.callTool({ name: 'actor_quality', arguments: {} }, undefined, { onprogress: (p) => seen.push(p) });
        expect(seen.length).toBeGreaterThan(0);
        for (let i = 1; i < seen.length; i++) expect(seen[i]!.progress).toBeGreaterThan(seen[i - 1]!.progress);
        expect(seen.at(-1)).toMatchObject({ progress: 4, total: 4 });
    });
    it('sends nothing without a progress token', () => {
        expect(createReporter({ sendNotification: async () => {} })).toBeNull();
        expect(createReporter(undefined)).toBeNull();
    });
    it('throttles to one message per 250 ms but always sends the last step', () => {
        const sent: number[] = [];
        let t = 0;
        const reporter = createReporter({ _meta: { progressToken: 1 }, sendNotification: async (n) => void sent.push(n.params.progress) }, () => t)!;
        reporter.report(1, 3);
        reporter.report(2, 3);
        reporter.report(3, 3);
        reporter.ping('waiting');
        expect(sent).toEqual([1, 3, 3.01]);
    });
});

describe('timing log (AC9)', () => {
    it('never writes the token, masks actor IDs and keeps only the month', async () => {
        const lines: string[] = [];
        const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => (lines.push(String(chunk)), true));
        const target = { fetch: (async () => new Response('{}', { status: 200, headers: { 'content-length': '2' } })) as typeof fetch };
        try {
            expect(installTiming({ APIFY_INSIGHTS_DEBUG: 'timing' }, target)).toBe(true);
            await target.fetch('https://console-backend.apify.com/actor-quality/scores/AbCdEfGhIjKlMnOpQ', { headers: { Authorization: `Bearer ${TOKEN}` } });
            await target.fetch(`https://console-backend.apify.com/actor-analytics/actor-breakdown?month=2026-10-01&actorIds=AbCdEfGhIjKlMnOpQ&token=${TOKEN}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        } finally {
            write.mockRestore();
        }
        const out = lines.join('');
        expect(out).not.toContain(TOKEN);
        expect(out).not.toContain('AbCdEfGhIjKlMnOpQ');
        expect(out).toContain('actor-quality/scores/:id');
        expect(out).toContain('actor-breakdown month=2026-10');
        expect(installTiming({}, { fetch: target.fetch })).toBe(false);
    });
});
