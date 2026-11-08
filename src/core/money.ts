import type { BreakdownRow, ProfitMargin } from '../clients/console.js';
import { addMonths, daysInRange, isoDay, monthEnd, monthOf, type Period } from './period.js';
import { readPricing, type Pricing } from './pricing.js';

// Money as the Apify Console shows it. Per-actor money is paying-users money (the breakdown rows add up
// to the profit-margin `payingUsersUsd` totals exactly; verified live 2026-11-08). Private actors have
// no breakdown row.

export type Audience = 'paying' | 'all';

export interface Money {
    revenueUsd: number;
    costUsd: number;
    profitUsd: number;
}

export interface ActorMoney extends Money {
    id: string;
    name: string;
    title: string | null;
    notice: string | null;
    runs: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    aborted: number;
    results: number;
    chargedResults: number | null;
    payingUsers: number | null;
    freeUsers: number | null;
    pricing: Pricing | null;
}

const MINUTE = 60_000;

function n(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Cache lifetime for a month's data: the current month and a month that ended < 3 days ago still change. */
export function monthTtl(month: string, now: number): number {
    const today = isoDay(now);
    const current = monthOf(today);
    if (month >= current) return 5 * MINUTE;
    if (month === addMonths(current, -1) && Number(today.slice(8)) <= 3) return 5 * MINUTE;
    return 60 * MINUTE;
}

/** One row per actor. A few backend versions returned duplicates: keep the larger value per field (as the extension does). */
export function normalizeBreakdown(rows: BreakdownRow[]): ActorMoney[] {
    const byId = new Map<string, ActorMoney>();
    for (const row of rows) {
        const runs = row.runsStats ?? { TOTAL: 0 };
        const succeeded = n(runs.SUCCEEDED);
        const aborted = n(runs.ABORTED);
        const timedOut = n(runs['TIMED-OUT']);
        const total = n(runs.TOTAL);
        const next: ActorMoney = {
            id: row.actor._id,
            name: row.actor.name,
            title: row.actor.title ?? null,
            notice: row.actor.notice && row.actor.notice !== 'NONE' ? row.actor.notice : null,
            revenueUsd: n(row.earningsStats.totalRevenueUsd),
            costUsd: n(row.earningsStats.totalCostUsd),
            profitUsd: row.earningsStats.totalProfitUsd != null ? n(row.earningsStats.totalProfitUsd) : n(row.earningsStats.totalRevenueUsd) - n(row.earningsStats.totalCostUsd),
            runs: total,
            succeeded,
            failed: runs.FAILED == null ? Math.max(0, total - succeeded - aborted - timedOut) : n(runs.FAILED),
            timedOut,
            aborted,
            results: n(runs.RESULTS),
            chargedResults: row.chargedResults ?? null,
            payingUsers: row.usersStats ? n(row.usersStats.payingUsers) : null,
            freeUsers: row.usersStats ? n(row.usersStats.freeUsers) : null,
            pricing: readPricing(row.currentPricingInfo),
        };
        const seen = byId.get(next.id);
        if (!seen) {
            byId.set(next.id, next);
            continue;
        }
        for (const key of ['revenueUsd', 'costUsd', 'runs', 'succeeded', 'failed', 'timedOut', 'aborted', 'results'] as const) {
            seen[key] = Math.max(seen[key], next[key]);
        }
        seen.profitUsd = seen.revenueUsd - seen.costUsd;
    }
    return [...byId.values()];
}

export function sumMoney(rows: Money[]): Money {
    const total = { revenueUsd: 0, costUsd: 0, profitUsd: 0 };
    for (const row of rows) {
        total.revenueUsd += row.revenueUsd;
        total.costUsd += row.costUsd;
        total.profitUsd += row.profitUsd;
    }
    return total;
}

function pick(stats: ProfitMargin['totalProfitMarginStats'], audience: Audience): Money {
    const side = audience === 'paying' ? stats.payingUsersUsd : stats.allUsersUsd;
    return { revenueUsd: side.revenueUsd, costUsd: side.costUsd, profitUsd: side.profitUsd };
}

/**
 * Money for a period from profit-margin responses (one per month, keyed YYYY-MM). A whole month uses the
 * month total; anything else adds up the daily figures for the period's days.
 */
export function moneyForPeriod(period: Period, monthly: Map<string, ProfitMargin>, audience: Audience): { money: Money; daysWithData: number } {
    if (period.wholeMonth) {
        const data = monthly.get(period.wholeMonth);
        if (!data) throw new Error(`missing month ${period.wholeMonth}`);
        return { money: pick(data.totalProfitMarginStats, audience), daysWithData: Object.keys(data.dailyProfitMarginStats).length };
    }
    const days = new Set(daysInRange(period.from, period.to));
    const parts: Money[] = [];
    for (const data of monthly.values()) {
        for (const [day, stats] of Object.entries(data.dailyProfitMarginStats)) {
            if (days.has(day.slice(0, 10))) parts.push(pick(stats, audience));
        }
    }
    return { money: sumMoney(parts), daysWithData: parts.length };
}

/** Days of `month` covered so far: the whole month if it ended, else up to and including today. */
export function daysElapsed(month: string, now: number): number {
    const today = isoDay(now);
    if (monthOf(today) > month) return Number(monthEnd(month).slice(8));
    return Number(today.slice(8));
}
