import type { Flag } from './flags.js';
import { FAILURE_RATE, MIN_FAILURES } from './flags.js';
import { round } from './envelope.js';
import type { ActorMoney } from './money.js';

// Money rules, ported from apify-insights-plus lib/portfolio.js (same constants) so the extension and this
// server tag the same actors. The extension's "keep" hysteresis needs remembered state and is not ported:
// each call judges the numbers it sees.
export const MATERIALITY_SHARE = 0.01;
export const MIN_MATERIALITY_USD = 1;
export const MIN_LOSS_USD = 0.25;
export const MIN_PACE_DAYS = 7;
export const PACE_CHANGE = 0.25;
export const THIN_MARGIN = 0.3;
export const NO_REVENUE_MIN_RUNS = 10;
const CHARGING_MODELS = new Set(['PAY_PER_EVENT', 'PRICE_PER_DATASET_ITEM']);

export type MoneyFlagName = 'losing' | 'thin_margin' | 'below_cost' | 'no_revenue' | 'failing' | 'declining' | 'growing';

export interface Thresholds {
    materialityUsd: number;
    lossFloorUsd: number;
}

/** Materiality scales with the portfolio: 1% of the monthly profit pace (min $1). */
export function thresholds(rows: ActorMoney[], daysElapsed: number): Thresholds {
    const profit = rows.reduce((sum, row) => sum + row.profitUsd, 0);
    const pace = daysElapsed ? (profit / Math.max(1, daysElapsed)) * 30 : 0;
    const materialityUsd = Math.max(MIN_MATERIALITY_USD, MATERIALITY_SHARE * Math.max(0, pace));
    return { materialityUsd, lossFloorUsd: Math.max(MIN_LOSS_USD, materialityUsd / 4) };
}

export const MONEY_RULES = (t: Thresholds): Record<MoneyFlagName, string> => ({
    losing: `Loses at least $${round(t.lossFloorUsd)} in the period (cost above paying-users revenue).`,
    thin_margin: `Earns $${round(t.materialityUsd)}+ at under ${THIN_MARGIN * 100}% margin.`,
    below_cost: 'Cost per 1,000 results is above revenue per 1,000 charged results.',
    no_revenue: `${NO_REVENUE_MIN_RUNS}+ runs and 1+ paying user but $0 revenue on a pay-per-event or pay-per-result actor: possibly an event that is never charged.`,
    failing: `At least ${MIN_FAILURES} failed or timed-out runs and a ${FAILURE_RATE * 100}%+ failure rate (aborts excluded), on an actor with 2+ paying users or $${round(t.materialityUsd / 2)}+ revenue.`,
    declining: `Revenue per day down ${PACE_CHANGE * 100}%+ on the month before, losing $${round(t.materialityUsd)}+/month, or stopped earning. Needs ${MIN_PACE_DAYS}+ days of the month.`,
    growing: `Revenue per day up ${PACE_CHANGE * 100}%+ on the month before, adding $${round(t.materialityUsd)}+/month. Needs ${MIN_PACE_DAYS}+ days of the month.`,
});

export interface UnitEconomics {
    costPer1kResultsUsd: number | null;
    revenuePer1kChargedUsd: number | null;
    /** Price at which paying-users revenue would equal cost: current price × cost ÷ revenue. */
    breakEvenPriceUsd: number | null;
    priceMultiplierToBreakEven: number | null;
}

export function unitEconomics(row: ActorMoney): UnitEconomics {
    const costPer1k = row.results > 0 ? (row.costUsd / row.results) * 1000 : null;
    const revenuePer1k = row.chargedResults ? (row.revenueUsd / row.chargedResults) * 1000 : null;
    const multiplier = row.revenueUsd > 0 ? row.costUsd / row.revenueUsd : null;
    const price = row.pricing?.priceUsd ?? null;
    return {
        costPer1kResultsUsd: round(costPer1k, 4),
        revenuePer1kChargedUsd: round(revenuePer1k, 4),
        breakEvenPriceUsd: multiplier != null && price != null ? round(price * multiplier, 6) : null,
        priceMultiplierToBreakEven: round(multiplier, 3),
    };
}

export interface Pace {
    latestPerDay: number;
    previousPerDay: number;
}

/**
 * Flags for one actor in one month. `previous` is the same actor's row for the month before (or null),
 * used for the pace rules together with the day counts of both months.
 */
export function moneyFlags(
    row: ActorMoney,
    t: Thresholds,
    pace?: { previous: ActorMoney | null; latestDays: number; previousDays: number },
): Flag[] {
    const flags: Flag[] = [];
    const rules = MONEY_RULES(t);
    const push = (flag: MoneyFlagName, evidence: Record<string, number | string>) => flags.push({ flag, rule: rules[flag], evidence });
    const margin = row.revenueUsd > 0 ? row.profitUsd / row.revenueUsd : null;

    const losing = row.profitUsd <= -t.lossFloorUsd;
    if (losing) push('losing', { profitUsd: round(row.profitUsd)!, revenueUsd: round(row.revenueUsd)!, costUsd: round(row.costUsd)! });
    if (!losing && row.revenueUsd >= t.materialityUsd && margin != null && margin < THIN_MARGIN) {
        push('thin_margin', { revenueUsd: round(row.revenueUsd)!, marginPct: round(margin * 100, 1)! });
    }
    const economics = unitEconomics(row);
    if (economics.costPer1kResultsUsd != null && economics.revenuePer1kChargedUsd != null && economics.costPer1kResultsUsd > economics.revenuePer1kChargedUsd) {
        push('below_cost', { costPer1kResultsUsd: economics.costPer1kResultsUsd, revenuePer1kChargedUsd: economics.revenuePer1kChargedUsd });
    }
    if (
        row.runs >= NO_REVENUE_MIN_RUNS &&
        (row.payingUsers ?? 0) >= 1 &&
        row.revenueUsd === 0 &&
        row.pricing?.model != null &&
        CHARGING_MODELS.has(row.pricing.model)
    ) {
        push('no_revenue', { runs: row.runs, payingUsers: row.payingUsers ?? 0, pricingModel: row.pricing.model });
    }
    const failures = row.failed + row.timedOut;
    const failureRate = row.runs ? failures / row.runs : 0;
    if (failures >= MIN_FAILURES && failureRate >= FAILURE_RATE && ((row.payingUsers ?? 0) >= 2 || row.revenueUsd >= t.materialityUsd / 2)) {
        push('failing', { runs: row.runs, failures, failureRatePct: round(failureRate * 100, 1)!, revenueAtRiskUsd: round(row.revenueUsd * failureRate)! });
    }

    if (pace && pace.latestDays >= MIN_PACE_DAYS) {
        const latestPerDay = row.revenueUsd / pace.latestDays;
        const previousPerDay = pace.previous ? pace.previous.revenueUsd / Math.max(1, pace.previousDays) : 0;
        const monthlyChange = (latestPerDay - previousPerDay) * 30;
        const evidence = { revenuePerDayUsd: round(latestPerDay, 3)!, previousRevenuePerDayUsd: round(previousPerDay, 3)!, monthlyChangeUsd: round(monthlyChange)! };
        const stopped = previousPerDay * 30 >= t.materialityUsd && latestPerDay === 0;
        if (stopped || (previousPerDay > 0 && (previousPerDay - latestPerDay) / previousPerDay >= PACE_CHANGE && -monthlyChange >= t.materialityUsd)) {
            push('declining', evidence);
        } else if (monthlyChange >= t.materialityUsd && (previousPerDay === 0 || (latestPerDay - previousPerDay) / previousPerDay >= PACE_CHANGE)) {
            push('growing', evidence);
        }
    }
    return flags;
}
