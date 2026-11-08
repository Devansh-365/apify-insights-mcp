import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { resolveActor, type ActorSummary } from '../core/actors.js';
import { ok, round, ToolError, topN } from '../core/envelope.js';
import { failingFlag, FAILURE_RATE, MIN_FAILURES, noticeFlag, type Flag } from '../core/flags.js';

export const runHealthInput = {
    actor: z.string().optional().describe('One actor (id, name, username/name or title). Omit to check every actor.'),
    onlyProblems: z.boolean().default(true).describe('Return only actors with a flag. Ignored when `actor` is given.'),
    top: z.number().int().min(1).max(50).default(10),
};

type Args = z.infer<z.ZodObject<typeof runHealthInput>>;

const RULES = {
    flagged: 'Apify has set a notice on the actor (e.g. UNDER_MAINTENANCE); it is pulled from Store search while set.',
    failing: `At least ${MIN_FAILURES} failed or timed-out runs and a ${FAILURE_RATE * 100}%+ failure rate in users' runs over 30 days (aborted runs excluded).`,
};

function flagsFor(actor: ActorSummary): Flag[] {
    return [noticeFlag(actor.notice), failingFlag(actor.runs30d, 'last 30 days, users\' runs')].filter((flag): flag is Flag => !!flag);
}

function row(actor: ActorSummary, flags: Flag[]) {
    const health = actor.runs30d;
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
    };
}

/** Flagged actors first (they are hidden from search), then by users hit by failures. */
function severity(actor: ActorSummary, flags: Flag[]): number {
    const flagged = flags.some((flag) => flag.flag === 'flagged') ? 1e9 : 0;
    const hit = (actor.runs30d?.failureRate ?? 0) * Math.max(1, actor.users30d ?? 0);
    return flagged + hit * 1000 + (actor.runs30d?.failures ?? 0);
}

export async function runHealthTool(ctx: Context, args: Args): Promise<CallToolResult> {
    const catalog = await ctx.catalog();
    const asOf = new Date(ctx.now()).toISOString();
    const notes = [
        "Run results are your users' runs in the last 30 days (public Store stats); your own test runs are not included.",
        'Private actors have no public run stats and are not checked here.',
        'Revenue at risk and paying-user filtering need the Console session (not available in this version).',
    ];

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
        const flags = flagsFor(found.actor);
        const summary = flags.length
            ? `${found.actor.ref}: ${flags.map((flag) => flag.flag).join(', ')}.`
            : `${found.actor.ref}: no problems found.`;
        return ok(summary, { asOf, source: ['apify-api'], rows: [row(found.actor, flags)], flags, rules: RULES, notes });
    }

    const checked = catalog.filter((actor) => actor.isPublic);
    const assessed = checked.map((actor) => ({ actor, flags: flagsFor(actor) }));
    const problems = assessed.filter((item) => item.flags.length);
    const pool = args.onlyProblems ? problems : assessed;
    pool.sort((a, b) => severity(b.actor, b.flags) - severity(a.actor, a.flags));
    const page = topN(pool.map((item) => row(item.actor, item.flags)), args.top, 'raise `top`, or pass `actor` for one actor');
    const flaggedCount = problems.filter((item) => item.flags.some((flag) => flag.flag === 'flagged')).length;
    const failingCount = problems.filter((item) => item.flags.some((flag) => flag.flag === 'failing')).length;

    const summary = problems.length
        ? `${problems.length} of ${checked.length} public actors need attention: ${flaggedCount} with an Apify notice, ${failingCount} failing. Worst: ${page.rows
              .slice(0, 3)
              .map((r) => `${r.ref} (${r.flags.join('+')}${r.failureRatePct != null ? `, ${r.failureRatePct}% failed` : ''})`)
              .join('; ')}.`
        : `No problems found across ${checked.length} public actors.`;
    return ok(summary, {
        asOf,
        source: ['apify-api'],
        period: { label: 'last30d' },
        totals: { checked: checked.length, notCheckedPrivate: catalog.length - checked.length, problems: problems.length, flagged: flaggedCount, failing: failingCount },
        rows: page.rows,
        ...(page.omitted ? { omitted: page.omitted } : {}),
        rules: RULES,
        notes,
    });
}
