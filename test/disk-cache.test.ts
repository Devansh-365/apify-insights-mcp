import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/main.js';
import { breakdown, profitMargin } from '../src/core/console-data.js';
import { createDiskCache } from '../src/core/disk-cache.js';
import { isSettledMonth } from '../src/core/money.js';
import { call, connect, fakeApi, fakeConsole, myActor, storeActor, testConfig, type FakeActorMonth } from './helpers.js';

// Phase 2: finished months on disk for up to 24 h, plus the one-time background prefetch.

const MONTHS: Record<string, Record<string, FakeActorMonth>> = {
    '2026-11': { alpha: { revenue: 10, cost: 2, runs: 5 } },
    '2026-10': { alpha: { revenue: 30, cost: 6, runs: 15 } },
    '2026-09': { alpha: { revenue: 20, cost: 4, runs: 10 } },
};
const at = (iso: string) => Date.parse(iso);
const portfolio = () => fakeApi([myActor('alpha')], [storeActor('alpha', 10, { TOTAL: 10, SUCCEEDED: 10 })]);

async function setup(nowIso: string, extra: { diskCache?: boolean; prefetch?: boolean } = { diskCache: true }, homeDir?: string) {
    const home = homeDir ?? (await mkdtemp(join(tmpdir(), 'aim-disk-')));
    let clock = at(nowIso);
    const consoleApi = fakeConsole(MONTHS, clock);
    const { ctx, client } = await connect(portfolio(), { ...testConfig(home), ...extra }, () => clock, { consoleApi });
    return { home, ctx, client, consoleApi, advance: (ms: number) => (clock += ms) };
}

describe('settled months (AC11)', () => {
    it('counts only months that ended more than 3 days ago', () => {
        expect(isSettledMonth('2026-11', at('2026-11-20T00:00:00Z'))).toBe(false);
        expect(isSettledMonth('2026-10', at('2026-11-03T12:00:00Z'))).toBe(false);
        expect(isSettledMonth('2026-10', at('2026-11-04T00:00:00Z'))).toBe(true);
        expect(isSettledMonth('2026-09', at('2026-11-01T00:00:00Z'))).toBe(true);
    });
});

describe('disk cache (AC11)', () => {
    it('stores a settled month and serves it to a new session without asking the Console', async () => {
        const first = await setup('2026-11-08T03:00:00Z');
        await breakdown(first.ctx, first.consoleApi, '2026-10');
        expect(first.consoleApi.calls).toEqual(['breakdown:2026-10']);

        const second = await setup('2026-11-08T09:00:00Z', { diskCache: true }, first.home);
        const rows = await breakdown(second.ctx, second.consoleApi, '2026-10');
        expect(rows.map((row) => row.revenueUsd)).toEqual([30]);
        expect(second.consoleApi.calls).toEqual([]);
    });
    it('never writes the current month or one that ended 3 days ago or less', async () => {
        const { home, ctx, consoleApi } = await setup('2026-11-02T03:00:00Z');
        await breakdown(ctx, consoleApi, '2026-11');
        await breakdown(ctx, consoleApi, '2026-10');
        await profitMargin(ctx, consoleApi, '2026-10');
        const dir = join(home, 'cache');
        await expect(readdir(dir)).rejects.toThrow();
    });
    it('refetches an entry older than 24 hours', async () => {
        const first = await setup('2026-11-08T03:00:00Z');
        await breakdown(first.ctx, first.consoleApi, '2026-09');
        const later = await setup('2026-11-09T03:00:01Z', { diskCache: true }, first.home);
        await breakdown(later.ctx, later.consoleApi, '2026-09');
        expect(later.consoleApi.calls).toEqual(['breakdown:2026-09']);
    });
    it('keeps per-actor ranges off disk and the account-wide totals on it', async () => {
        const { home, ctx, consoleApi } = await setup('2026-11-08T03:00:00Z');
        await profitMargin(ctx, consoleApi, '2026-10');
        await profitMargin(ctx, consoleApi, '2026-10', ['id-alpha']);
        const files = await readdir(join(home, 'cache', 'v1', 'user123'));
        expect(files).toEqual(['pm-2026-10.json']);
    });
    it('writes 0600 files in a 0700 folder with numbers only, never a token', async () => {
        const { home, ctx, consoleApi } = await setup('2026-11-08T03:00:00Z');
        await mkdir(join(home, 'sessions'), { recursive: true });
        await writeFile(join(home, 'sessions', 'p.json'), JSON.stringify({ uiToken: 'secret-ui-token-xyz', userId: 'user123', receivedAt: new Date().toISOString() }));
        await breakdown(ctx, consoleApi, '2026-10');
        const dir = join(home, 'cache', 'v1', 'user123');
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        const file = join(dir, 'breakdown-2026-10.json');
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        const text = await readFile(file, 'utf8');
        expect(text).not.toContain('secret-ui-token-xyz');
        expect(JSON.parse(text)).toMatchObject({ version: 1, month: '2026-10' });
    });
    it('keeps the newest 24 months per kind', async () => {
        const home = await mkdtemp(join(tmpdir(), 'aim-disk-'));
        const disk = createDiskCache(home, 'user123', () => at('2026-11-08T00:00:00Z'))!;
        for (let i = 0; i < 26; i++) {
            const month = new Date(Date.UTC(2024, i, 1)).toISOString().slice(0, 7);
            await disk.write('pm', month, { i });
        }
        const files = (await readdir(join(home, 'cache', 'v1', 'user123'))).sort();
        expect(files).toHaveLength(24);
        expect(files[0]).toBe('pm-2024-03.json');
        expect(createDiskCache(home, '../evil')).toBeNull();
    });
    it('says in the answer when money came from the local cache', async () => {
        const first = await setup('2026-11-08T03:00:00Z');
        await call(first.client, 'actor_profitability', { period: 'lastMonth' });
        const second = await setup('2026-11-08T05:00:00Z', { diskCache: true }, first.home);
        const { data } = await call(second.client, 'actor_profitability', { period: 'lastMonth' });
        expect(data.notes.join(' ')).toMatch(/Money for 2026-09, 2026-10 came from the local cache \(fetched 2026-11-08 03:00 UTC\)/);
        // Numbers are the same whether they came from the Console or the disk.
        const fresh = await setup('2026-11-08T05:00:00Z', { diskCache: false });
        const { data: live } = await call(fresh.client, 'actor_profitability', { period: 'lastMonth' });
        expect(data.rows).toEqual(live.rows);
        expect(data.totals).toEqual(live.totals);
    });
    it('is off with APIFY_INSIGHTS_CACHE=0 (AC12)', async () => {
        const { home, ctx, consoleApi } = await setup('2026-11-08T03:00:00Z', { diskCache: false });
        await breakdown(ctx, consoleApi, '2026-10');
        await expect(readdir(join(home, 'cache'))).rejects.toThrow();
    });
});

describe('prefetch (AC12)', () => {
    it('starts after the first money tool and loads this and last month once', async () => {
        const { client, consoleApi } = await setup('2026-11-08T03:00:00Z', { prefetch: true });
        await call(client, 'list_actors');
        expect(consoleApi.calls).toEqual([]);
        await call(client, 'revenue_summary');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(consoleApi.calls).toEqual(expect.arrayContaining(['breakdown:2026-11', 'breakdown:2026-10', 'profitMargin:2026-10:*']));
        const before = consoleApi.calls.length;
        await call(client, 'daily_brief');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(consoleApi.calls.filter((c) => c.startsWith('breakdown:'))).toHaveLength(2);
        expect(consoleApi.calls.length).toBe(before);
    });
    it('makes no Console request with APIFY_INSIGHTS_PREFETCH=0', async () => {
        const { client, consoleApi } = await setup('2026-11-08T03:00:00Z', { prefetch: false });
        await call(client, 'revenue_summary');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(consoleApi.calls).toEqual(['profitMargin:2026-11:*']);
    });
});

describe('cache clear command', () => {
    it('deletes the cache folder and says so', async () => {
        const { home, ctx, consoleApi } = await setup('2026-11-08T03:00:00Z');
        await breakdown(ctx, consoleApi, '2026-10');
        const lines: string[] = [];
        expect(await runCli(['cache', 'clear'], { home, log: (line) => lines.push(line) })).toBe(0);
        await expect(readdir(join(home, 'cache'))).rejects.toThrow();
        expect(await runCli(['cache', 'clear'], { home, log: (line) => lines.push(line) })).toBe(0);
        expect(await runCli(['cache'], { home, log: (line) => lines.push(line) })).toBe(1);
        expect(lines[0]).toContain('Cleared the local cache');
        expect(lines[1]).toContain('already empty');
    });
});
