import { describe, expect, it } from 'vitest';
import { ALLOWED_PATHS, consoleUrl, createConsoleApi } from '../src/clients/console.js';
import { ToolError } from '../src/core/envelope.js';
import { daysElapsed, moneyForPeriod, normalizeBreakdown } from '../src/core/money.js';
import { moneyFlags, thresholds, unitEconomics } from '../src/core/money-flags.js';
import { comparisonPeriod, resolvePeriod } from '../src/core/period.js';
import { breakdownRow, fakeConsole } from './helpers.js';

const NOW = Date.parse('2026-11-08T03:00:00.000Z');

describe('periods', () => {
    it.each([
        ['today', '2026-11-08', '2026-11-08', null, true],
        ['yesterday', '2026-11-07', '2026-11-07', null, false],
        ['last7d', '2026-11-01', '2026-11-07', null, false],
        ['last30d', '2026-10-09', '2026-11-07', null, false],
        ['thisMonth', '2026-11-01', '2026-11-08', '2026-11', true],
        ['lastMonth', '2026-10-01', '2026-10-31', '2026-10', false],
        ['2026-02', '2026-02-01', '2026-02-28', '2026-02', false],
    ] as const)('%s', (input, from, to, wholeMonth, partial) => {
        expect(resolvePeriod(input, NOW)).toMatchObject({ from, to, wholeMonth, partial });
    });
    it('clips ranges at today and rejects bad ones', () => {
        expect(resolvePeriod({ from: '2026-11-01', to: '2026-12-31' }, NOW)).toMatchObject({ to: '2026-11-08', wholeMonth: '2026-11' });
        expect(() => resolvePeriod({ from: '2026-11-05', to: '2026-11-01' }, NOW)).toThrow(ToolError);
        expect(() => resolvePeriod({ from: '2026-02-30', to: '2026-03-01' }, NOW)).toThrow(/not a valid date/);
        expect(() => resolvePeriod({ from: '2025-01-01', to: '2026-11-01' }, NOW)).toThrow(/12 months/);
        expect(() => resolvePeriod('2026-12', NOW)).toThrow(/future/);
    });
    it('compares a finished month with the previous month and a partial one with the same days', () => {
        expect(comparisonPeriod(resolvePeriod('lastMonth', NOW), 'previousPeriod', NOW)).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
        expect(comparisonPeriod(resolvePeriod('last7d', NOW), 'previousPeriod', NOW)).toMatchObject({ from: '2026-10-25', to: '2026-10-31' });
        expect(comparisonPeriod(resolvePeriod('thisMonth', NOW), 'sameDaysLastMonth', NOW)).toMatchObject({ from: '2026-10-01', to: '2026-10-08' });
        // March 31 has no Feb 31: clipped to the last day of February.
        const march = Date.parse('2026-03-31T12:00:00Z');
        expect(comparisonPeriod(resolvePeriod('today', march), 'sameDaysLastMonth', march)).toMatchObject({ from: '2026-02-28', to: '2026-02-28' });
    });
    it('counts elapsed days', () => {
        expect(daysElapsed('2026-11', NOW)).toBe(8);
        expect(daysElapsed('2026-10', NOW)).toBe(31);
    });
});

describe('money', () => {
    it('sums daily figures for day ranges and uses month totals for a whole month', async () => {
        const api = fakeConsole({ '2026-11': { a: { revenue: 80, cost: 16, runs: 10 } } });
        const margins = new Map([['2026-11', await api.profitMargin('2026-11')]]);
        expect(moneyForPeriod(resolvePeriod('thisMonth', NOW), margins, 'paying')).toMatchObject({ money: { revenueUsd: 80, costUsd: 16 }, daysWithData: 8 });
        const week = moneyForPeriod(resolvePeriod('last7d', NOW), margins, 'all');
        expect(week.daysWithData).toBe(7);
        expect(week.money.revenueUsd).toBeCloseTo(7 * 10 * 1.5);
    });
    it('dedupes repeated breakdown rows, keeping the larger figures', () => {
        const rows = normalizeBreakdown([breakdownRow('a', { revenue: 5, cost: 1, runs: 10 }), breakdownRow('a', { revenue: 7, cost: 0.5, runs: 4 })]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ revenueUsd: 7, costUsd: 1, profitUsd: 6, runs: 10 });
    });
});

describe('money rules (ported thresholds)', () => {
    const row = (m: Parameters<typeof breakdownRow>[1]) => normalizeBreakdown([breakdownRow('x', m)])[0]!;
    it('scales materiality with the profit pace, with floors', () => {
        expect(thresholds([row({ revenue: 10, cost: 9, runs: 1 })], 10)).toEqual({ materialityUsd: 1, lossFloorUsd: 0.25 });
        const big = thresholds([row({ revenue: 1100, cost: 100, runs: 1 })], 10);
        expect(big.materialityUsd).toBeCloseTo(30);
        expect(big.lossFloorUsd).toBeCloseTo(7.5);
    });
    const t = { materialityUsd: 4, lossFloorUsd: 1 };
    it.each([
        ['losing at the floor', { revenue: 1, cost: 2, runs: 5 }, ['losing']],
        ['not losing under the floor', { revenue: 1, cost: 1.9, runs: 5 }, []],
        ['thin margin', { revenue: 10, cost: 8, runs: 5 }, ['thin_margin']],
        ['thin margin ignored below materiality', { revenue: 3, cost: 2.5, runs: 5 }, []],
        ['below cost per 1K', { revenue: 10, cost: 5, runs: 5, results: 1000, charged: 100 }, []],
        ['below cost per 1K (cost/1K > revenue/1K)', { revenue: 10, cost: 9.5, runs: 5, results: 100, charged: 1000 }, ['thin_margin', 'below_cost']],
        ['no revenue on a charging actor', { revenue: 0, cost: 0.1, runs: 10, paying: 1, charged: 0 }, ['no_revenue']],
        ['no revenue ignored on a free actor', { revenue: 0, cost: 0.1, runs: 10, paying: 1, charged: 0, pricing: { pricingModel: 'FREE' } }, []],
        ['no revenue needs 10 runs', { revenue: 0, cost: 0.1, runs: 9, paying: 1, charged: 0 }, []],
        ['failing with money at stake', { revenue: 20, cost: 2, runs: 40, failed: 2, timedOut: 1, paying: 3 }, ['failing']],
        ['failing ignored under 5%', { revenue: 20, cost: 2, runs: 100, failed: 4, paying: 3 }, []],
    ] as const)('%s', (_name, m, expected) => {
        expect(moneyFlags(row(m), t).map((flag) => flag.flag)).toEqual(expected);
    });
    it('paces revenue per day against the month before', () => {
        const previous = row({ revenue: 31, cost: 0, runs: 10 });
        const declining = moneyFlags(row({ revenue: 2, cost: 0, runs: 10 }), t, { previous, latestDays: 8, previousDays: 31 });
        expect(declining.map((flag) => flag.flag)).toEqual(['declining']);
        expect(declining[0]!.evidence).toMatchObject({ revenuePerDayUsd: 0.25, previousRevenuePerDayUsd: 1, monthlyChangeUsd: -22.5 });
        expect(moneyFlags(row({ revenue: 80, cost: 0, runs: 10 }), t, { previous, latestDays: 8, previousDays: 31 }).map((f) => f.flag)).toEqual(['growing']);
        // Under 7 days of the month there is no pace verdict.
        expect(moneyFlags(row({ revenue: 0.1, cost: 0, runs: 10 }), t, { previous, latestDays: 6, previousDays: 31 })).toEqual([]);
    });
    it('computes unit economics and break-even price', () => {
        expect(unitEconomics(row({ revenue: 2, cost: 12, runs: 100, results: 5000, charged: 1000 }))).toEqual({
            costPer1kResultsUsd: 2.4,
            revenuePer1kChargedUsd: 2,
            breakEvenPriceUsd: 0.012,
            priceMultiplierToBreakEven: 6,
        });
        expect(unitEconomics(row({ revenue: 0, cost: 1, runs: 1, results: 0, charged: 0 }))).toEqual({
            costPer1kResultsUsd: null,
            revenuePer1kChargedUsd: null,
            breakEvenPriceUsd: null,
            priceMultiplierToBreakEven: null,
        });
    });
});

describe('console client', () => {
    const TOKEN = 'fake-ui-token-0123456789abcdefghijklmnopqrstu';
    const shape = { totalProfitMarginStats: { payingUsersUsd: { revenueUsd: 1, costUsd: 0, profitUsd: 1 }, allUsersUsd: { revenueUsd: 1, costUsd: 0, profitUsd: 1 } }, dailyProfitMarginStats: {} };

    it('only builds URLs for allowlisted read endpoints', () => {
        expect(ALLOWED_PATHS.every((path) => path.startsWith('actor-analytics/'))).toBe(true);
        expect(() => consoleUrl('users/me/delete', {})).toThrow(/not allowed/);
        expect(consoleUrl('actor-analytics/profit-margin', { month: '2026-10-01', actorIds: undefined })).toBe('https://console-backend.apify.com/actor-analytics/profit-margin?month=2026-10-01');
    });
    it('sends GET with the token and a month start date', async () => {
        const seen: Array<{ url: string; init: RequestInit }> = [];
        const api = createConsoleApi(async () => TOKEN, (async (url: string, init: RequestInit) => {
            seen.push({ url, init });
            return new Response(JSON.stringify(shape), { status: 200 });
        }) as typeof fetch);
        await api.profitMargin('2026-10', ['a', 'b']);
        expect(seen[0]!.url).toBe('https://console-backend.apify.com/actor-analytics/profit-margin?month=2026-10-01&actorIds=a%2Cb');
        expect(seen[0]!.init.method).toBe('GET');
        expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    });
    it('accepts an actor with no runs this month (runsStats: {}) as zero runs', async () => {
        const row = { ...breakdownRow('idle', { revenue: 0, cost: 0, runs: 0 }), runsStats: {} };
        const api = createConsoleApi(async () => TOKEN, (async () => new Response(JSON.stringify({ monetizationPerActor: [row] }), { status: 200 })) as typeof fetch);
        const [idle] = normalizeBreakdown((await api.actorBreakdown('2026-11')).monetizationPerActor);
        expect(idle).toMatchObject({ runs: 0, succeeded: 0, failed: 0, timedOut: 0, results: 0 });
    });
    it('names the changed field and never puts the token in errors', async () => {
        const changed = createConsoleApi(async () => TOKEN, (async () => new Response(JSON.stringify({ totalProfitMarginStats: {} }), { status: 200 })) as typeof fetch);
        const error = await changed.profitMargin('2026-10').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ToolError);
        expect(error).toMatchObject({ code: 'endpoint_changed' });
        expect((error as ToolError).message).toContain('totalProfitMarginStats.payingUsersUsd');
        const rejected = createConsoleApi(async () => TOKEN, (async () => new Response('{}', { status: 401 })) as typeof fetch);
        const denied = await rejected.actorBreakdown('2026-10').catch((e: unknown) => e);
        expect(denied).toMatchObject({ code: 'logged_out' });
        for (const e of [error, denied]) expect(JSON.stringify({ ...(e as object), message: (e as Error).message })).not.toContain(TOKEN);
    });
});
