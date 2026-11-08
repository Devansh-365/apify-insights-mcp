import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConsoleApi } from '../src/clients/console.js';
import { call, connect, fakeApi, fakeConsole, myActor, storeActor, testConfig, type FakeActorMonth } from './helpers.js';

// Made-up portfolio. Today is 2026-11-08 (8 days of November), October is complete.
const NOW = () => Date.parse('2026-11-08T03:00:00.000Z');
const PPE = { pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { result: { eventTitle: 'Result', eventPriceUsd: 0.003, isPrimaryEvent: true } } } };

const MONTHS: Record<string, Record<string, FakeActorMonth>> = {
    '2026-11': {
        healthy: { revenue: 80, cost: 20, runs: 500, results: 100_000, charged: 40_000, paying: 10, free: 30 },
        broken: { revenue: 2, cost: 12, runs: 100, failed: 15, timedOut: 5, results: 5000, charged: 1000, paying: 3 },
        maintenance: { revenue: 0, cost: 1, runs: 20, paying: 2, charged: 0, pricing: PPE },
    },
    '2026-10': {
        healthy: { revenue: 155, cost: 40, runs: 1500, paying: 12 },
        broken: { revenue: 31, cost: 8, runs: 300, paying: 4 },
        maintenance: { revenue: 0, cost: 0.5, runs: 10, paying: 1, charged: 0, pricing: PPE },
    },
};

function portfolio() {
    return fakeApi(
        [myActor('healthy'), myActor('broken'), myActor('maintenance'), myActor('private-one')],
        [
            storeActor('healthy', 40, { TOTAL: 500, SUCCEEDED: 499, FAILED: 1, ABORTED: 0, 'TIMED-OUT': 0 }),
            storeActor('broken', 12, { TOTAL: 100, SUCCEEDED: 80, FAILED: 15, ABORTED: 0, 'TIMED-OUT': 5 }),
            storeActor('maintenance', 2, { TOTAL: 10, SUCCEEDED: 10, FAILED: 0, ABORTED: 0, 'TIMED-OUT': 0 }, { notice: 'UNDER_MAINTENANCE' }),
        ],
    );
}

async function setup(consoleApi: ConsoleApi | null = fakeConsole(MONTHS), usageLog = false) {
    const home = await mkdtemp(join(tmpdir(), 'aim-money-'));
    const { client } = await connect(portfolio(), testConfig(home, [], usageLog), NOW, { consoleApi });
    return { client, home, consoleApi };
}

const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name);

describe('revenue_summary', () => {
    it('reports this month so far, paying users, marked partial', async () => {
        const { client } = await setup();
        const { data, text } = await call(client, 'revenue_summary');
        expect(data.totals).toEqual({ revenueUsd: 82, costUsd: 33, profitUsd: 49, marginPct: 59.8 });
        expect(data.period).toMatchObject({ from: '2026-11-01', to: '2026-11-08', partial: true });
        expect(data.notes.join(' ')).toContain('incomplete');
        expect(text).toContain('revenue $82');
    });
    it('compares last 7 days with the same days last month, and switches audience', async () => {
        const { client } = await setup();
        const { data } = await call(client, 'revenue_summary', { period: 'last7d', compareTo: 'sameDaysLastMonth', includeDaily: true });
        expect(data.totals.revenueUsd).toBe(71.75);
        expect(data.comparison.period).toMatchObject({ from: '2026-10-01', to: '2026-10-07' });
        expect(data.comparison.totals.revenueUsd).toBe(42);
        expect(data.comparison.change).toMatchObject({ revenueUsd: 29.75, revenuePct: 70.8 });
        expect(data.daily).toHaveLength(7);
        const all = await call(client, 'revenue_summary', { period: 'lastMonth', audience: 'all' });
        expect(all.data.totals.revenueUsd).toBe(279);
    });
    it('a range across two months is the sum of its days; a whole-month range equals the month (AC5b)', async () => {
        const { client } = await setup();
        const span = await call(client, 'revenue_summary', { period: { from: '2026-10-25', to: '2026-11-03' } });
        expect(span.data.totals.revenueUsd).toBe(72.75);
        const range = await call(client, 'revenue_summary', { period: { from: '2026-10-01', to: '2026-10-31' } });
        const month = await call(client, 'revenue_summary', { period: '2026-10' });
        expect(range.data.totals).toEqual(month.data.totals);
    });
    it('serves repeat calls from cache (AC9)', async () => {
        const { client, consoleApi } = await setup();
        await call(client, 'revenue_summary', { period: 'lastMonth' });
        const before = (consoleApi as ReturnType<typeof fakeConsole>).calls.length;
        const started = performance.now();
        await call(client, 'revenue_summary', { period: 'lastMonth' });
        expect(performance.now() - started).toBeLessThan(100);
        expect((consoleApi as ReturnType<typeof fakeConsole>).calls.length).toBe(before);
    });
    it('returns bridge_missing with a fix when there is no Console session', async () => {
        const { client } = await setup(null);
        const { result, data } = await call(client, 'revenue_summary');
        expect(result.isError).toBe(true);
        expect(data).toMatchObject({ ok: false, code: 'bridge_missing' });
        expect(data.fix).toContain('apify-insights-mcp install');
    });
});

describe('actor_profitability', () => {
    it('per-actor rows add up to the paying-users account total (AC2)', async () => {
        const { client } = await setup();
        const summary = await call(client, 'revenue_summary', { period: 'lastMonth' });
        const top = await call(client, 'actor_profitability', { period: 'lastMonth', top: 50 });
        const sum = top.data.rows.reduce((total: number, row: { revenueUsd: number }) => total + row.revenueUsd, 0);
        expect(sum).toBeCloseTo(summary.data.totals.revenueUsd, 6);
        expect(top.data.totals.revenueUsd).toBe(summary.data.totals.revenueUsd);
        expect(names(top.data.rows)).toEqual(['healthy', 'broken', 'maintenance']);
    });
    it('losers carry the break-even price and the rule that matched', async () => {
        const { client } = await setup();
        const { data } = await call(client, 'actor_profitability', { view: 'losers' });
        expect(names(data.rows)).toEqual(['broken', 'maintenance']);
        expect(data.rows[0]).toMatchObject({ profitUsd: -10, priceUsd: 0.002, breakEvenPriceUsd: 0.012, costPer1kUsd: 2.4, revenuePer1kUsd: 2 });
        expect(data.rows[0].flags).toEqual(expect.arrayContaining(['losing', 'below_cost', 'failing', 'declining']));
        expect(data.rules.losing).toContain('Loses at least');
    });
    it('finds actors that charge nothing and ranks movers by change per month', async () => {
        const { client } = await setup();
        const none = await call(client, 'actor_profitability', { view: 'no_revenue' });
        expect(names(none.data.rows)).toEqual(['maintenance']);
        const movers = await call(client, 'actor_profitability', { view: 'movers' });
        expect(names(movers.data.rows)).toEqual(['healthy', 'broken']);
        expect(movers.data.rows[0].monthlyChangeUsd).toBe(150);
        expect(movers.data.rows[1].monthlyChangeUsd).toBe(-22.5);
        expect(movers.data.notes.join(' ')).toContain('revenue per day');
    });
    it('day ranges cover only named actors or the top earners, and say so (AC10)', async () => {
        const { client, consoleApi } = await setup();
        const week = await call(client, 'actor_profitability', { period: 'last7d' });
        expect(week.data.notes[0]).toContain('granularity_unavailable');
        expect(names(week.data.rows)).toEqual(['healthy', 'broken', 'maintenance']);
        expect(week.data.rows[0].revenueUsd).toBe(70);
        const named = await call(client, 'actor_profitability', { period: 'last7d', actors: ['broken'] });
        expect(names(named.data.rows)).toEqual(['broken']);
        expect((consoleApi as ReturnType<typeof fakeConsole>).calls).toContain('profitMargin:2026-11:id-broken');
    });
});

describe('daily_brief', () => {
    it('names at most three items, one per actor, each with its rule and next call (AC11)', async () => {
        const { client } = await setup();
        const { data, text } = await call(client, 'daily_brief');
        expect(data.money.yesterday).toMatchObject({ day: '2026-11-07', revenueUsd: 10.25 });
        expect(data.money.monthToDate).toMatchObject({ from: '2026-11-01', to: '2026-11-07', revenueUsd: 71.75 });
        expect(data.money.sameDaysLastMonth).toMatchObject({ from: '2026-10-01', to: '2026-10-07', revenueUsd: 42 });
        expect(data.items.map((item: { actor: string; flag: string }) => `${item.actor}:${item.flag}`)).toEqual(['maintenance:flagged', 'broken:losing']);
        for (const item of data.items) {
            expect(item.why.length).toBeGreaterThan(10);
            expect(item.next).toBe(`actor_report("${item.actor}")`);
        }
        expect(data.growing.map((item: { actor: string }) => item.actor)).toEqual(['healthy']);
        expect(data.counts).toMatchObject({ flagged: 1, failing: 1, losing: 2, no_revenue: 1, declining: 1 });
        expect(text).toContain('+70.8% revenue vs the same days last month');
    });
    it('falls back to health only without a Console session', async () => {
        const { client } = await setup(null);
        const { result, data, text } = await call(client, 'daily_brief');
        expect(result.isError).toBeFalsy();
        expect(data.money).toBeNull();
        expect(data.items.map((item: { flag: string }) => item.flag)).toEqual(['flagged', 'failing']);
        expect(text).toContain('no money');
    });
});

describe('money in run_health and actor_report', () => {
    it('run_health adds revenue at risk and the no_revenue check', async () => {
        const { client } = await setup();
        const { data } = await call(client, 'run_health');
        const byName = Object.fromEntries(data.rows.map((row: { ref: string }) => [row.ref, row]));
        expect(byName['acme/broken']).toMatchObject({ revenueThisMonthUsd: 2, revenueAtRiskUsd: 0.4, payingUsersThisMonth: 3 });
        expect(byName['acme/maintenance'].flags).toEqual(expect.arrayContaining(['flagged', 'no_revenue']));
    });
    it('actor_report shows three months of money with unit economics', async () => {
        const { client } = await setup();
        const { data } = await call(client, 'actor_report', { actor: 'broken' });
        expect(data.money.months.map((m: { month: string }) => m.month)).toEqual(['2026-11', '2026-10', '2026-09']);
        expect(data.money.months[0]).toMatchObject({ revenueUsd: 2, costUsd: 12, profitUsd: -10 });
        expect(data.money.months[2].revenueUsd).toBeNull();
        expect(data.flags.map((flag: { flag: string }) => flag.flag)).toEqual(expect.arrayContaining(['failing', 'losing', 'below_cost']));
        const noSession = await setup(null);
        const plain = await call(noSession.client, 'actor_report', { actor: 'broken' });
        expect(plain.data.money).toBeNull();
        expect(plain.data.notes.join(' ')).toContain('bridge_missing');
    });
});

describe('growth', () => {
    it('shows views to runs to paying users for a month', async () => {
        const { client } = await setup();
        const { data } = await call(client, 'growth');
        expect(data.period).toMatchObject({ from: '2026-10-01', to: '2026-10-31', partial: false });
        expect(data.totals).toMatchObject({ viewingUsers: 600, usersWithRun: 120, viewToRunPct: 20 });
        expect(names(data.rows)).toEqual(['healthy', 'broken', 'maintenance']);
        expect(data.rows[0]).toMatchObject({ payingUsers: 12 });
        const one = await call(client, 'growth', { actor: 'healthy' });
        expect(one.data.rows[0]).toHaveProperty('topReferrers');
    });
});

describe('usage log and output size', () => {
    it('logs only tool name and time when enabled', async () => {
        const { client, home } = await setup(fakeConsole(MONTHS), true);
        await call(client, 'auth_status');
        await call(client, 'revenue_summary', { period: 'lastMonth' });
        const lines = (await readFile(join(home, 'usage.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(lines.map((line) => line.tool)).toEqual(['auth_status', 'revenue_summary']);
        for (const line of lines) expect(Object.keys(line).sort()).toEqual(['t', 'tool']);
    });
    it('does not write a usage log by default', async () => {
        const { client, home } = await setup();
        await call(client, 'auth_status');
        await expect(readFile(join(home, 'usage.jsonl'), 'utf8')).rejects.toThrow();
    });
    it('keeps default outputs under 4 KB for a 486-actor account (AC6)', async () => {
        const many = Array.from({ length: 486 }, (_, i) => `some-long-actor-name-scraper-${i}`);
        const month = (scale: number) =>
            Object.fromEntries(many.slice(0, 464).map((name, i) => [name, { revenue: (i % 7) * scale, cost: (i % 5) * 0.8, runs: 10 + i, failed: i % 9, paying: i % 4 }]));
        const api = fakeApi(
            many.map((name) => myActor(name)),
            many.slice(0, 464).map((name, i) => storeActor(name, i % 50, { TOTAL: 1000 + i, SUCCEEDED: 990, FAILED: 10 + i }, i % 40 === 0 ? { notice: 'UNDER_MAINTENANCE' } : {})),
        );
        const home = await mkdtemp(join(tmpdir(), 'aim-big-'));
        const { client } = await connect(api, testConfig(home), NOW, { consoleApi: fakeConsole({ '2026-11': month(1), '2026-10': month(3), '2026-09': month(2) }) });
        for (const tool of ['daily_brief', 'revenue_summary', 'actor_profitability', 'run_health', 'growth']) {
            const { result, data } = await call(client, tool);
            expect(result.isError, tool).toBeFalsy();
            expect(JSON.stringify(data).length, tool).toBeLessThanOrEqual(4096);
        }
    });
});
