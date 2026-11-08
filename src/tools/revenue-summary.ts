import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { profitMargins } from '../core/console-data.js';
import { ok, round } from '../core/envelope.js';
import { moneyForPeriod, type Audience, type Money } from '../core/money.js';
import { comparisonPeriod, daysInRange, periodInput, resolvePeriod, type Period } from '../core/period.js';

export const revenueSummaryInput = {
    period: periodInput.default('thisMonth'),
    compareTo: z.enum(['previousPeriod', 'sameDaysLastMonth']).optional().describe('Adds the same figures for the comparison period and the change.'),
    audience: z.enum(['paying', 'all']).default('paying').describe('paying = money from paying users (what you earn); all = includes free-plan users.'),
    includeDaily: z.boolean().default(false).describe('Add one revenue/profit row per day (periods up to 62 days).'),
};

type Args = z.infer<z.ZodObject<typeof revenueSummaryInput>>;

function shape(money: Money) {
    return {
        revenueUsd: round(money.revenueUsd),
        costUsd: round(money.costUsd),
        profitUsd: round(money.profitUsd),
        marginPct: money.revenueUsd > 0 ? round((money.profitUsd / money.revenueUsd) * 100, 1) : null,
    };
}

function delta(current: Money, previous: Money) {
    const pct = (a: number, b: number) => (b !== 0 ? round(((a - b) / Math.abs(b)) * 100, 1) : null);
    return {
        revenueUsd: round(current.revenueUsd - previous.revenueUsd),
        profitUsd: round(current.profitUsd - previous.profitUsd),
        revenuePct: pct(current.revenueUsd, previous.revenueUsd),
        profitPct: pct(current.profitUsd, previous.profitUsd),
    };
}

async function moneyOf(ctx: Context, period: Period, audience: Audience) {
    const api = await ctx.console();
    return moneyForPeriod(period, await profitMargins(ctx, api, period.months), audience);
}

export async function revenueSummary(ctx: Context, args: Args): Promise<CallToolResult> {
    const now = ctx.now();
    const period = resolvePeriod(args.period, now);
    const current = await moneyOf(ctx, period, args.audience);
    const notes = [`Money as the Apify Console shows it (${args.audience === 'paying' ? 'paying users only' : 'paying and free-plan users'}).`];
    if (period.partial) notes.push('The period includes today, so it is incomplete; late usage can still land.');
    const expectedDays = daysInRange(period.from, period.to).length;
    if (current.daysWithData < expectedDays && !period.wholeMonth) notes.push(`Daily data covers ${current.daysWithData} of ${expectedDays} days.`);

    let comparison: Record<string, unknown> | undefined;
    let compareLine = '';
    if (args.compareTo) {
        const other = comparisonPeriod(period, args.compareTo, now);
        const previous = await moneyOf(ctx, other, args.audience);
        comparison = { period: { label: other.label, from: other.from, to: other.to }, totals: shape(previous.money), change: delta(current.money, previous.money) };
        const change = delta(current.money, previous.money);
        compareLine = ` vs $${round(previous.money.revenueUsd)} (${other.from}..${other.to}): ${change.revenuePct == null ? 'n/a' : `${change.revenuePct > 0 ? '+' : ''}${change.revenuePct}%`} revenue.`;
    }

    let daily: unknown[] | undefined;
    if (args.includeDaily) {
        const days = daysInRange(period.from, period.to);
        if (days.length > 62) notes.push('includeDaily is limited to 62 days; daily rows omitted.');
        else {
            const monthly = await profitMargins(ctx, await ctx.console(), period.months);
            const byDay = new Map<string, unknown>();
            for (const data of monthly.values()) {
                for (const [day, stats] of Object.entries(data.dailyProfitMarginStats)) {
                    const side = args.audience === 'paying' ? stats.payingUsersUsd : stats.allUsersUsd;
                    byDay.set(day.slice(0, 10), { day: day.slice(0, 10), revenueUsd: round(side.revenueUsd), profitUsd: round(side.profitUsd) });
                }
            }
            daily = days.map((day) => byDay.get(day) ?? { day, revenueUsd: null, profitUsd: null });
        }
    }

    const totals = shape(current.money);
    const summary = `${period.label} (${period.from}..${period.to}${period.partial ? ', partial' : ''}): revenue $${totals.revenueUsd}, cost $${totals.costUsd}, profit $${totals.profitUsd}${totals.marginPct != null ? ` (${totals.marginPct}% margin)` : ''}, ${args.audience} users.${compareLine}`;
    return ok(summary, {
        asOf: new Date(now).toISOString(),
        source: ['console (unofficial)'],
        period: { label: period.label, from: period.from, to: period.to, partial: period.partial },
        audience: args.audience,
        currency: 'USD',
        totals,
        ...(comparison ? { comparison } : {}),
        ...(daily ? { daily } : {}),
        notes,
    });
}
