import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { resolveActor } from '../core/actors.js';
import { breakdown, profitMargins } from '../core/console-data.js';
import { reportProgress } from '../core/progress.js';
import { ok, round, ToolError, topN } from '../core/envelope.js';
import type { Flag } from '../core/flags.js';
import { daysElapsed, moneyForPeriod, sumMoney, type ActorMoney } from '../core/money.js';
import { MONEY_RULES, moneyFlags, thresholds, unitEconomics, type Thresholds } from '../core/money-flags.js';
import { addMonths, periodInput, resolvePeriod, type Period } from '../core/period.js';

export const actorProfitabilityInput = {
    period: periodInput.default('thisMonth').describe('A calendar month (thisMonth, lastMonth, "YYYY-MM") gives every actor. Other ranges cover only named actors or your top 10 earners.'),
    view: z
        .enum(['top', 'losers', 'movers', 'no_revenue', 'below_cost'])
        .default('top')
        .describe('top = most revenue; losers = actors losing money; movers = biggest change in revenue per day vs the month before; no_revenue = paying users ran it but nothing was charged; below_cost = cost per 1K results above revenue per 1K.'),
    actors: z.array(z.string()).max(10).optional().describe('Limit to these actors (names, ids or username/name), max 10.'),
    minRuns: z.number().int().min(0).default(0),
    top: z.number().int().min(1).max(50).default(10),
};

type Args = z.infer<z.ZodObject<typeof actorProfitabilityInput>>;

interface Assessed {
    row: ActorMoney;
    flags: Flag[];
}

function moneyRow(item: Assessed, view: Args['view']) {
    const { row, flags } = item;
    const economics = unitEconomics(row);
    const pace = flags.find((flag) => flag.flag === 'declining' || flag.flag === 'growing');
    const priced = flags.some((flag) => flag.flag === 'losing' || flag.flag === 'below_cost' || flag.flag === 'thin_margin');
    return {
        name: row.name,
        revenueUsd: round(row.revenueUsd),
        costUsd: round(row.costUsd),
        profitUsd: round(row.profitUsd),
        marginPct: row.revenueUsd > 0 ? round((row.profitUsd / row.revenueUsd) * 100, 1) : null,
        runs: row.runs,
        failureRatePct: row.runs ? round(((row.failed + row.timedOut) / row.runs) * 100, 1) : null,
        payingUsers: row.payingUsers,
        freeUsers: row.freeUsers,
        costPer1kUsd: economics.costPer1kResultsUsd,
        revenuePer1kUsd: economics.revenuePer1kChargedUsd,
        priceUsd: row.pricing?.priceUsd ?? null,
        ...(priced || view === 'losers' || view === 'below_cost' ? { breakEvenPriceUsd: economics.breakEvenPriceUsd } : {}),
        ...(view === 'movers' && pace ? pace.evidence : {}),
        flags: flags.map((flag) => flag.flag),
    };
}

function moverChange(item: Assessed, previous: Map<string, ActorMoney>, latestDays: number, previousDays: number): number {
    const before = previous.get(item.row.id);
    return (item.row.revenueUsd / latestDays - (before ? before.revenueUsd / previousDays : 0)) * 30;
}

async function resolveIds(ctx: Context, names: string[] | undefined): Promise<Set<string> | null> {
    if (!names?.length) return null;
    const catalog = await ctx.catalog();
    const ids = new Set<string>();
    for (const name of names) {
        const found = resolveActor(catalog, name);
        if (found.kind === 'not_found') throw new ToolError('actor_not_found', `No actor of yours matches "${name}".`, 'Call list_actors with a `query` to find the name.');
        if (found.kind === 'ambiguous') {
            throw new ToolError('actor_ambiguous', `"${name}" matches several actors.`, 'Repeat with one of the candidates.', { candidates: found.candidates.map((actor) => actor.ref) });
        }
        ids.add(found.actor.id);
    }
    return ids;
}

async function monthView(ctx: Context, args: Args, period: Period, month: string, only: Set<string> | null): Promise<CallToolResult> {
    const api = await ctx.console();
    const now = ctx.now();
    const previousMonth = addMonths(month, -1);
    const [rows, previousRows] = await Promise.all([breakdown(ctx, api, month), breakdown(ctx, api, previousMonth)]);
    const latestDays = daysElapsed(month, now);
    const previousDays = daysElapsed(previousMonth, now);
    const t: Thresholds = thresholds(rows, latestDays);
    const previous = new Map(previousRows.map((row) => [row.id, row]));
    const assessed: Assessed[] = rows.map((row) => ({
        row,
        flags: moneyFlags(row, t, { previous: previous.get(row.id) ?? null, latestDays, previousDays }),
    }));

    let pool = assessed.filter((item) => item.row.runs >= args.minRuns && (!only || only.has(item.row.id)));
    const has = (item: Assessed, flag: string) => item.flags.some((f) => f.flag === flag);
    switch (args.view) {
        case 'top':
            pool.sort((a, b) => b.row.revenueUsd - a.row.revenueUsd);
            break;
        case 'losers':
            pool = pool.filter((item) => has(item, 'losing')).sort((a, b) => a.row.profitUsd - b.row.profitUsd);
            break;
        case 'movers':
            pool = pool
                .filter((item) => Math.abs(moverChange(item, previous, latestDays, previousDays)) >= 1)
                .sort((a, b) => Math.abs(moverChange(b, previous, latestDays, previousDays)) - Math.abs(moverChange(a, previous, latestDays, previousDays)));
            break;
        case 'no_revenue':
            pool = pool.filter((item) => has(item, 'no_revenue')).sort((a, b) => b.row.runs - a.row.runs);
            break;
        case 'below_cost':
            pool = pool.filter((item) => has(item, 'below_cost')).sort((a, b) => a.row.profitUsd - b.row.profitUsd);
            break;
    }
    const page = topN(
        pool.map((item) => {
            const r = moneyRow(item, args.view);
            if (args.view === 'movers' && !('monthlyChangeUsd' in r)) {
                return { ...r, monthlyChangeUsd: round(moverChange(item, previous, latestDays, previousDays)) };
            }
            return r;
        }),
        args.top,
        'raise `top`, or use `actors` / `minRuns`',
    );
    const total = sumMoney(rows);
    const usedFlags = new Set(pool.flatMap((item) => item.flags.map((flag) => flag.flag)));
    const rules = Object.fromEntries(Object.entries(MONEY_RULES(t)).filter(([flag]) => usedFlags.has(flag as never)));
    const catalog = await ctx.catalog();
    const withMoney = new Set(rows.map((row) => row.id));
    const withoutRow = catalog.filter((actor) => !withMoney.has(actor.id)).length;

    const notes = [
        'Per-actor money is paying-users money as the Apify Console shows it; it adds up to revenue_summary(audience: paying).',
        'movers compare revenue per day with the month before (×30 = change per month), so a partial month compares fairly.',
    ];
    if (period.partial) notes.push(`${month} is in progress (${latestDays} days so far).`);
    if (withoutRow) notes.push(`${withoutRow} actors have no money row (private actors are not in Console analytics).`);

    const viewText: Record<Args['view'], string> = {
        top: 'by revenue',
        losers: 'losing money',
        movers: 'with the biggest change',
        no_revenue: 'with paying users but $0 revenue',
        below_cost: 'below cost per 1K results',
    };
    const head = page.rows.slice(0, 3).map((r) => `${r.name} ($${r.profitUsd} profit)`).join(', ');
    const summary = `${month}: ${pool.length} actors ${viewText[args.view]}${head ? `. Top: ${head}` : ''}. Portfolio: revenue $${round(total.revenueUsd)}, profit $${round(total.profitUsd)} (paying users).`;
    return ok(summary, {
        asOf: new Date(now).toISOString(),
        source: ['console (unofficial)'],
        period: { label: period.label, from: period.from, to: period.to, partial: period.partial },
        audience: 'paying',
        currency: 'USD',
        totals: {
            revenueUsd: round(total.revenueUsd),
            costUsd: round(total.costUsd),
            profitUsd: round(total.profitUsd),
            actorsWithMoney: rows.length,
            matching: pool.length,
            materialityUsd: round(t.materialityUsd),
            lossFloorUsd: round(t.lossFloorUsd),
        },
        rows: page.rows,
        ...(page.omitted ? { omitted: page.omitted } : {}),
        rules,
        notes,
    });
}

/** Day ranges: per-actor daily money exists only one actor per request, so cover named actors or the top 10 earners. */
async function rangeView(ctx: Context, args: Args, period: Period, only: Set<string> | null): Promise<CallToolResult> {
    const api = await ctx.console();
    let ids: string[];
    let names = new Map<string, string>();
    let label: string;
    if (only) {
        ids = [...only];
        const catalog = await ctx.catalog();
        names = new Map(catalog.filter((actor) => only.has(actor.id)).map((actor) => [actor.id, actor.name]));
        label = 'the actors you named';
    } else {
        const perMonth = await Promise.all(period.months.map((month) => breakdown(ctx, api, month)));
        const revenue = new Map<string, number>();
        for (const rows of perMonth) {
            for (const row of rows) {
                revenue.set(row.id, (revenue.get(row.id) ?? 0) + row.revenueUsd);
                names.set(row.id, row.name);
            }
        }
        ids = [...revenue.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id);
        label = `your top ${ids.length} earners in ${period.months.join(', ')}`;
    }
    let done = 0;
    const rows = await Promise.all(
        ids.map(async (id) => {
            const { money } = moneyForPeriod(period, await profitMargins(ctx, api, period.months, [id]), 'paying');
            done++;
            reportProgress(done, ids.length, `${done} of ${ids.length} actors`);
            return { name: names.get(id) ?? id, revenueUsd: round(money.revenueUsd), costUsd: round(money.costUsd), profitUsd: round(money.profitUsd) };
        }),
    );
    rows.sort((a, b) => (args.view === 'losers' ? (a.profitUsd ?? 0) - (b.profitUsd ?? 0) : (b.revenueUsd ?? 0) - (a.revenueUsd ?? 0)));
    const filtered = args.view === 'losers' ? rows.filter((row) => (row.profitUsd ?? 0) < 0) : rows;
    const summary = `${period.from}..${period.to}, ${label}: ${filtered
        .slice(0, 3)
        .map((r) => `${r.name} $${r.revenueUsd}`)
        .join(', ')}.`;
    return ok(summary, {
        asOf: new Date(ctx.now()).toISOString(),
        source: ['console (unofficial)'],
        period: { label: period.label, from: period.from, to: period.to, partial: period.partial },
        audience: 'paying',
        currency: 'USD',
        totals: { actorsCovered: rows.length },
        rows: filtered.slice(0, args.top),
        notes: [
            `granularity_unavailable: per-actor money for day ranges covers only ${label}. For every actor, use a calendar month.`,
            ...(args.view !== 'top' && args.view !== 'losers' ? [`view "${args.view}" needs a calendar month; showing revenue instead.`] : []),
        ],
    });
}

export async function actorProfitability(ctx: Context, args: Args): Promise<CallToolResult> {
    const period = resolvePeriod(args.period, ctx.now());
    const only = await resolveIds(ctx, args.actors);
    if (period.wholeMonth) return monthView(ctx, args, period, period.wholeMonth, only);
    return rangeView(ctx, args, period, only);
}
