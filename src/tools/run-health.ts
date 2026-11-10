import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { resolveActor, type ActorSummary } from '../core/actors.js';
import { ok, round, ToolError, topN } from '../core/envelope.js';
import { breakdown } from '../core/console-data.js';
import { failingFlag, FAILURE_RATE, MIN_FAILURES, noticeFlag, type Flag } from '../core/flags.js';
import { daysElapsed, type ActorMoney } from '../core/money.js';
import { MONEY_RULES, moneyFlags, thresholds } from '../core/money-flags.js';
import { isoDay, monthOf, periodInput, resolvePeriod } from '../core/period.js';
import type { ConsoleApi } from '../clients/console.js';
import { actorDays, portfolioDays } from './run-health-days.js';

export const runHealthInput = {
    actor: z.string().optional().describe('One actor (id, name, username/name or title). Omit to check every actor.'),
    onlyProblems: z.boolean().default(true).describe('Return only actors with a flag. Ignored when `actor` is given.'),
    top: z.number().int().min(1).max(50).default(10),
    period: periodInput
        .optional()
        .describe(
            'Add `byDay`: failed / timed-out / aborted runs per UTC day for this period, today included (partial). With `actor`, also the failed runs users shared with you, their log tails and recent builds. Needs the Console session. ' +
                periodInput.description,
        ),
    logs: z.boolean().default(true).describe('With `actor` and `period`: include the last 30 log lines of up to 3 newest failed shared runs.'),
};

type Args = z.infer<z.ZodObject<typeof runHealthInput>>;

const RULES: Record<string, string> = {
    flagged: 'Apify has set a notice on the actor (e.g. UNDER_MAINTENANCE); it is pulled from Store search while set.',
    failing: `At least ${MIN_FAILURES} failed or timed-out runs and a ${FAILURE_RATE * 100}%+ failure rate in users' runs over 30 days (aborted runs excluded).`,
};

/** This month's money per actor, when a Console session is available right now. */
interface MoneyContext {
    byId: Map<string, ActorMoney>;
    noRevenueRule: string;
    month: string;
}

function flagsFor(actor: ActorSummary, money: MoneyContext | null, t: ReturnType<typeof thresholds> | null): Flag[] {
    const flags = [noticeFlag(actor.notice), failingFlag(actor.runs30d, "last 30 days, users' runs")].filter((flag): flag is Flag => !!flag);
    const row = money?.byId.get(actor.id);
    if (row && t) flags.push(...moneyFlags(row, t).filter((flag) => flag.flag === 'no_revenue'));
    return flags;
}

function row(actor: ActorSummary, flags: Flag[], money: MoneyContext | null) {
    const health = actor.runs30d;
    const earned = money?.byId.get(actor.id);
    return {
        ref: actor.ref,
        flags: flags.map((flag) => flag.flag),
        ...(actor.notice && actor.notice !== 'NONE' ? { notice: actor.notice } : {}),
        users30d: actor.users30d,
        runs30d: health?.runs ?? null,
        failed: health?.failed ?? null,
        timedOut: health?.timedOut ?? null,
        aborted: health?.aborted ?? null,
        failureRatePct: health?.failureRate == null ? null : round(health.failureRate * 100, 1),
        lastRun: actor.lastRunStartedAt?.slice(0, 10) ?? null,
        ...(money
            ? {
                  payingUsersThisMonth: earned?.payingUsers ?? null,
                  revenueThisMonthUsd: earned ? round(earned.revenueUsd) : null,
                  revenueAtRiskUsd: earned && health?.failureRate != null ? round(earned.revenueUsd * health.failureRate) : null,
              }
            : {}),
    };
}

/** Flagged actors first (hidden from search), then money at risk (when known), then users hit by failures. */
function severity(actor: ActorSummary, flags: Flag[], money: MoneyContext | null): number {
    const flagged = flags.some((flag) => flag.flag === 'flagged') ? 1e12 : 0;
    const earned = money?.byId.get(actor.id);
    const atRisk = earned ? earned.revenueUsd * (actor.runs30d?.failureRate ?? 0) : 0;
    const noRevenue = flags.some((flag) => flag.flag === 'no_revenue') ? 1e9 : 0;
    const hit = (actor.runs30d?.failureRate ?? 0) * Math.max(1, actor.users30d ?? 0);
    return flagged + noRevenue + atRisk * 1e6 + hit * 1000 + (actor.runs30d?.failures ?? 0);
}

async function loadMoney(ctx: Context): Promise<{ money: MoneyContext | null; t: ReturnType<typeof thresholds> | null; state: string; api: ConsoleApi | null }> {
    const { api, state } = await ctx.optionalConsole();
    if (!api) return { money: null, t: null, state, api };
    const month = monthOf(isoDay(ctx.now()));
    const rows = await breakdown(ctx, api, month);
    const t = thresholds(rows, daysElapsed(month, ctx.now()));
    return { money: { byId: new Map(rows.map((r) => [r.id, r])), noRevenueRule: MONEY_RULES(t).no_revenue, month }, t, state, api };
}

export async function runHealthTool(ctx: Context, args: Args): Promise<CallToolResult> {
    const catalog = await ctx.catalog();
    const asOf = new Date(ctx.now()).toISOString();
    // Resolve the period first so a bad one fails before any request.
    const period = args.period === undefined ? null : resolvePeriod(args.period, ctx.now());
    const { money, t, state, api } = await loadMoney(ctx);
    const withDays = period && api ? { period, api } : null;
    const rules = money ? { ...RULES, no_revenue: money.noRevenueRule } : RULES;
    const notes = [
        "Run results are your users' runs in the last 30 days (public Store stats); your own test runs are not included.",
        'Private actors have no public run stats and are not checked here.',
        money
            ? `Money columns are ${money.month} so far, paying users (Console). revenueAtRiskUsd = revenue × 30-day failure rate.`
            : `No Console session (${state}), so money columns and the no_revenue check are skipped.`,
    ];
    if (period && !api) notes.push(`Per-day counts (\`period\`) need the Console session (${state}); this answer has the 30-day numbers only.`);

    if (args.actor) {
        const found = resolveActor(catalog, args.actor);
        if (found.kind === 'not_found') {
            throw new ToolError('actor_not_found', `No actor of yours matches "${args.actor}".`, 'Call list_actors with a `query` to find the name.');
        }
        if (found.kind === 'ambiguous') {
            throw new ToolError('actor_ambiguous', `"${args.actor}" matches several actors.`, 'Repeat with one of the candidates.', {
                candidates: found.candidates.map((actor) => actor.ref),
            });
        }
        const flags = flagsFor(found.actor, money, t);
        const summary = flags.length
            ? `${found.actor.ref}: ${flags.map((flag) => flag.flag).join(', ')}.`
            : `${found.actor.ref}: no problems found.`;
        if (!withDays) return ok(summary, { asOf, source: ['apify-api'], rows: [row(found.actor, flags, money)], flags, rules, notes });
        const days = await actorDays(ctx, withDays.api, found.actor, withDays.period, args.logs);
        const localPath = (await ctx.localActorPaths()).get(found.actor.name) ?? null;
        return ok(`${summary} ${days.summary}`, {
            asOf,
            source: ['apify-api', 'console (unofficial)'],
            rows: [row(found.actor, flags, money)],
            flags,
            byDay: days.byDay,
            sharedRuns: days.sharedRuns,
            builds: days.builds,
            buildBeforeFirstProblem: days.buildBeforeFirstProblem,
            ...(localPath ? { localPath } : {}),
            rules,
            notes: [...notes, ...days.notes],
        });
    }

    const checked = catalog.filter((actor) => actor.isPublic);
    const assessed = checked.map((actor) => ({ actor, flags: flagsFor(actor, money, t) }));
    const problems = assessed.filter((item) => item.flags.length);
    const pool = args.onlyProblems ? problems : assessed;
    pool.sort((a, b) => severity(b.actor, b.flags, money) - severity(a.actor, a.flags, money));
    const page = topN(pool.map((item) => row(item.actor, item.flags, money)), args.top, 'raise `top`, or pass `actor` for one actor');
    const flaggedCount = problems.filter((item) => item.flags.some((flag) => flag.flag === 'flagged')).length;
    const failingCount = problems.filter((item) => item.flags.some((flag) => flag.flag === 'failing')).length;

    const summary = problems.length
        ? `${problems.length} of ${checked.length} public actors need attention: ${flaggedCount} with an Apify notice, ${failingCount} failing. Worst: ${page.rows
              .slice(0, 3)
              .map((r) => `${r.ref} (${r.flags.join('+')}${r.failureRatePct != null ? `, ${r.failureRatePct}% failed` : ''})`)
              .join('; ')}.`
        : `No problems found across ${checked.length} public actors.`;
    const days = withDays ? await portfolioDays(ctx, withDays.api, catalog, withDays.period, args.top) : null;
    return ok(days ? `${summary} ${days.summary}` : summary, {
        asOf,
        source: days ? ['apify-api', 'console (unofficial)'] : ['apify-api'],
        period: { label: 'last30d' },
        totals: { checked: checked.length, notCheckedPrivate: catalog.length - checked.length, problems: problems.length, flagged: flaggedCount, failing: failingCount },
        rows: page.rows,
        ...(page.omitted ? { omitted: page.omitted } : {}),
        ...(days ? { byDay: days.byDay } : {}),
        rules,
        notes: days ? [...notes, ...days.notes] : notes,
    });
}
