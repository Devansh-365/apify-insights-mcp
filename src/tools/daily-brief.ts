import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ConsoleApi } from '../clients/console.js';
import type { Context } from '../context.js';
import type { ActorSummary } from '../core/actors.js';
import { breakdown, profitMargins } from '../core/console-data.js';
import { ok, round, ToolError } from '../core/envelope.js';
import { failingFlag, noticeFlag, type Flag } from '../core/flags.js';
import { daysElapsed, moneyForPeriod, type ActorMoney, type Money } from '../core/money.js';
import { moneyFlags, thresholds } from '../core/money-flags.js';
import { addMonths, comparisonPeriod, isoDay, monthOf, monthStart, resolvePeriod, type Period } from '../core/period.js';

// The morning check (plan W1). Deterministic: every item names the rule that produced it, at most three
// items, ordered by what costs the most if ignored. No forecasts.

const MAX_ITEMS = 3;

interface Item {
    priority: number;
    weight: number;
    actor: string;
    flag: string;
    why: string;
    evidence: Record<string, number | string>;
    next: string;
}

const PRIORITY: Record<string, number> = { flagged: 1, no_revenue: 2, losing: 3, failing: 4, declining: 5 };

function why(flag: Flag): string {
    return flag.rule;
}

function moneyText(m: Money): string {
    return `$${round(m.revenueUsd)} revenue, $${round(m.profitUsd)} profit`;
}

function changeText(current: Money, previous: Money): string {
    if (previous.revenueUsd === 0) return 'no revenue in the comparison days';
    const pct = round(((current.revenueUsd - previous.revenueUsd) / previous.revenueUsd) * 100, 1)!;
    return `${pct > 0 ? '+' : ''}${pct}% revenue vs the same days last month ($${round(previous.revenueUsd)})`;
}

function healthItems(catalog: ActorSummary[], earned: Map<string, ActorMoney> | null): Item[] {
    const items: Item[] = [];
    for (const actor of catalog) {
        if (!actor.isPublic) continue;
        const notice = noticeFlag(actor.notice);
        if (notice) {
            items.push({ priority: PRIORITY.flagged!, weight: actor.users30d ?? 0, actor: actor.name, flag: 'flagged', why: why(notice), evidence: notice.evidence, next: `actor_report("${actor.name}")` });
        }
        const failing = failingFlag(actor.runs30d, "last 30 days, users' runs");
        if (failing) {
            const revenue = earned?.get(actor.id)?.revenueUsd ?? 0;
            const atRisk = revenue * (actor.runs30d?.failureRate ?? 0);
            // Without money, weigh by users hit; with money, revenue at risk dominates.
            const weight = atRisk * 1000 + (actor.runs30d?.failureRate ?? 0) * (actor.users30d ?? 0);
            const evidence = earned ? { ...failing.evidence, revenueAtRiskUsd: round(atRisk)! } : failing.evidence;
            items.push({ priority: PRIORITY.failing!, weight, actor: actor.name, flag: 'failing', why: why(failing), evidence, next: `actor_report("${actor.name}")` });
        }
    }
    return items;
}

function moneyItems(rows: ActorMoney[], previous: Map<string, ActorMoney>, latestDays: number, previousDays: number, t: ReturnType<typeof thresholds>) {
    const items: Item[] = [];
    const growing: Item[] = [];
    for (const row of rows) {
        for (const flag of moneyFlags(row, t, { previous: previous.get(row.id) ?? null, latestDays, previousDays })) {
            const base = { actor: row.name, flag: flag.flag, why: why(flag), evidence: flag.evidence, next: `actor_report("${row.name}")` };
            if (flag.flag === 'no_revenue') items.push({ ...base, priority: PRIORITY.no_revenue!, weight: row.runs });
            if (flag.flag === 'losing') items.push({ ...base, priority: PRIORITY.losing!, weight: -row.profitUsd });
            if (flag.flag === 'declining') items.push({ ...base, priority: PRIORITY.declining!, weight: -Number(flag.evidence.monthlyChangeUsd ?? 0) });
            if (flag.flag === 'growing') growing.push({ ...base, priority: 9, weight: Number(flag.evidence.monthlyChangeUsd ?? 0) });
        }
    }
    return { items, growing: growing.sort((a, b) => b.weight - a.weight).slice(0, 2) };
}

function pickItems(items: Item[]): Item[] {
    const seen = new Set<string>();
    const picked: Item[] = [];
    for (const item of [...items].sort((a, b) => a.priority - b.priority || b.weight - a.weight)) {
        if (seen.has(item.actor)) continue;
        seen.add(item.actor);
        picked.push(item);
        if (picked.length === MAX_ITEMS) break;
    }
    return picked;
}

function itemOut(item: Item) {
    return { actor: item.actor, flag: item.flag, why: item.why, evidence: item.evidence, next: item.next };
}

async function tryConsole(ctx: Context): Promise<{ api: ConsoleApi | null; reason: string | null }> {
    try {
        return { api: await ctx.console(), reason: null };
    } catch (error) {
        if (error instanceof ToolError && ['bridge_missing', 'warming_up', 'other_account', 'logged_out'].includes(error.code)) return { api: null, reason: error.message };
        throw error;
    }
}

export async function dailyBrief(ctx: Context): Promise<CallToolResult> {
    const now = ctx.now();
    const today = isoDay(now);
    const month = monthOf(today);
    const catalog = await ctx.catalog();
    const { api, reason } = await tryConsole(ctx);

    if (!api) {
        const items = pickItems(healthItems(catalog, null));
        const lines = [`Morning check ${today} (no money: ${reason})`, ...items.map((item, i) => `${i + 1}. ${item.actor}: ${item.flag}`)];
        if (!items.length) lines.push('No flagged or failing actors.');
        return ok(lines.join('\n'), {
            asOf: new Date(now).toISOString(),
            source: ['apify-api'],
            money: null,
            items: items.map(itemOut),
            notes: [`Money sections need the Console session: ${reason}`],
        });
    }

    // Money: yesterday, and month to date over complete days vs the same days last month.
    const yesterday = resolvePeriod('yesterday', now);
    const mtd: Period | null = today.endsWith('-01') ? null : resolvePeriod({ from: monthStart(month), to: yesterday.to }, now);
    const mtdCompare = mtd ? comparisonPeriod(mtd, 'sameDaysLastMonth', now) : null;
    const months = [...new Set([...yesterday.months, ...(mtd?.months ?? []), ...(mtdCompare?.months ?? [])])];
    const margins = await profitMargins(ctx, api, months);
    const y = moneyForPeriod(yesterday, margins, 'paying').money;
    const m = mtd ? moneyForPeriod(mtd, margins, 'paying').money : null;
    const mc = mtdCompare ? moneyForPeriod(mtdCompare, margins, 'paying').money : null;

    // Per-actor rules on this month so far against the month before.
    const previousMonth = addMonths(month, -1);
    const [rows, previousRows] = await Promise.all([breakdown(ctx, api, month), breakdown(ctx, api, previousMonth)]);
    const latestDays = daysElapsed(month, now);
    const previousDays = daysElapsed(previousMonth, now);
    const t = thresholds(rows, latestDays);
    const earned = new Map(rows.map((row) => [row.id, row]));
    const money = moneyItems(rows, new Map(previousRows.map((row) => [row.id, row])), latestDays, previousDays, t);
    const all = [...healthItems(catalog, earned), ...money.items];
    const items = pickItems(all);

    const counts: Record<string, number> = {};
    for (const item of all) counts[item.flag] = (counts[item.flag] ?? 0) + 1;

    const lines = [
        `Morning check ${today} (paying users)`,
        `Yesterday: ${moneyText(y)}.`,
        m && mc && mtd ? `Month to date (${mtd.from}..${mtd.to}): ${moneyText(m)}; ${changeText(m, mc)}.` : 'Month to date: the month started today.',
        items.length ? 'Look at:' : 'Nothing needs attention by the rules.',
        ...items.map((item, i) => `${i + 1}. ${item.actor}: ${item.flag}. Next: ${item.next}`),
        ...(money.growing.length ? [`Growing: ${money.growing.map((item) => `${item.actor} (+$${item.evidence.monthlyChangeUsd}/month pace)`).join(', ')}.`] : []),
        `All flags: ${Object.entries(counts).map(([flag, count]) => `${flag} ${count}`).join(', ') || 'none'}.`,
    ];
    return ok(lines.join('\n'), {
        asOf: new Date(now).toISOString(),
        source: ['apify-api', 'console (unofficial)'],
        audience: 'paying',
        currency: 'USD',
        money: {
            yesterday: { day: yesterday.from, revenueUsd: round(y.revenueUsd), costUsd: round(y.costUsd), profitUsd: round(y.profitUsd) },
            monthToDate: m && mtd ? { from: mtd.from, to: mtd.to, revenueUsd: round(m.revenueUsd), costUsd: round(m.costUsd), profitUsd: round(m.profitUsd) } : null,
            sameDaysLastMonth: mc && mtdCompare ? { from: mtdCompare.from, to: mtdCompare.to, revenueUsd: round(mc.revenueUsd), profitUsd: round(mc.profitUsd) } : null,
        },
        items: items.map(itemOut),
        growing: money.growing.map(itemOut),
        counts,
        notes: [
            'Items are ordered: Apify notice (hidden from search) > paying users but $0 charged > losing money > failing > declining; one item per actor, at most three.',
            'Per-actor rules use this month so far against the month before (revenue per day, so a partial month compares fairly).',
        ],
    });
}
