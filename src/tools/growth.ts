import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Marketing } from '../clients/console.js';
import type { Context } from '../context.js';
import { resolveActor } from '../core/actors.js';
import { breakdown, marketing } from '../core/console-data.js';
import { ok, round, ToolError } from '../core/envelope.js';
import { daysElapsed } from '../core/money.js';
import { isoDay, monthEnd, monthOf, resolvePeriod } from '../core/period.js';

export const growthInput = {
    month: z
        .union([z.enum(['thisMonth', 'lastMonth']), z.string().regex(/^\d{4}-\d{2}$/)])
        .default('lastMonth')
        .describe('Calendar month. lastMonth (default) is complete; thisMonth is in progress.'),
    actor: z.string().optional().describe('One actor: adds its top referrers and countries.'),
    by: z
        .enum(['payingUsers', 'users30d', 'worstConversion'])
        .default('payingUsers')
        .describe('Which actors to show when no `actor` is given: most paying users, most 30-day users, or lowest view-to-run conversion among your 10 most-used actors.'),
    top: z.number().int().min(1).max(10).default(5),
};

type Args = z.infer<z.ZodObject<typeof growthInput>>;

function funnel(data: Marketing) {
    const viewers = data.numUniqueViewingUsers;
    return {
        storePageViews: data.numUniqueWebPageViews,
        consolePageViews: data.numUniqueConsolePageViews,
        viewingUsers: viewers,
        usersWithRun: data.numUniqueUsersWithRun,
        viewToRunPct: viewers > 0 ? round((data.numUniqueUsersWithRun / viewers) * 100, 1) : null,
    };
}

export async function growth(ctx: Context, args: Args): Promise<CallToolResult> {
    const api = await ctx.console();
    const now = ctx.now();
    const period = resolvePeriod(args.month, now);
    const month = period.wholeMonth ?? monthOf(period.from);
    const current = month === monthOf(isoDay(now));
    const portion = current ? daysElapsed(month, now) / Number(monthEnd(month).slice(8)) : undefined;
    const [catalog, money] = await Promise.all([ctx.catalog(), breakdown(ctx, api, month)]);
    const paying = new Map(money.map((row) => [row.id, row]));

    let chosen: typeof catalog;
    if (args.actor) {
        const found = resolveActor(catalog, args.actor);
        if (found.kind === 'not_found') throw new ToolError('actor_not_found', `No actor of yours matches "${args.actor}".`, 'Call list_actors with a `query` to find the name.');
        if (found.kind === 'ambiguous') {
            throw new ToolError('actor_ambiguous', `"${args.actor}" matches several actors.`, 'Repeat with one of the candidates.', { candidates: found.candidates.map((actor) => actor.ref) });
        }
        chosen = [found.actor];
    } else {
        const publicActors = catalog.filter((actor) => actor.isPublic);
        const key = args.by === 'payingUsers' ? (actor: (typeof catalog)[number]) => paying.get(actor.id)?.payingUsers ?? 0 : (actor: (typeof catalog)[number]) => actor.users30d ?? 0;
        // Each actor's funnel is one request, so worstConversion looks at the 10 most-used actors only.
        chosen = [...publicActors].sort((a, b) => key(b) - key(a)).slice(0, args.by === 'worstConversion' ? 10 : args.top);
    }

    const [account, ...perActor] = await Promise.all([
        marketing(ctx, api, month, undefined, portion),
        ...chosen.map((actor) => marketing(ctx, api, month, [actor.id], portion)),
    ]);
    let rows = chosen.map((actor, i) => {
        const data = perActor[i]!;
        const earned = paying.get(actor.id);
        return {
            name: actor.name,
            ...funnel(data),
            payingUsers: earned?.payingUsers ?? null,
            freeUsers: earned?.freeUsers ?? null,
            ...(args.actor
                ? { topReferrers: (data.topReferrers ?? []).slice(0, 5), topCountries: (data.topCountryCodes ?? []).slice(0, 5) }
                : {}),
        };
    });
    if (args.by === 'worstConversion' && !args.actor) {
        rows = rows.filter((row) => row.viewToRunPct != null).sort((a, b) => a.viewToRunPct! - b.viewToRunPct!).slice(0, args.top);
    }

    const total = funnel(account);
    const summary = [
        `${month}${current ? ' (in progress)' : ''}: ${total.viewingUsers} users viewed your actors, ${total.usersWithRun} ran one (${total.viewToRunPct ?? 'n/a'}%).`,
        ...rows.slice(0, 3).map((row) => `${row.name}: ${row.viewingUsers} viewers → ${row.usersWithRun} with a run (${row.viewToRunPct ?? 'n/a'}%), ${row.payingUsers ?? 'n/a'} paying.`),
    ];
    return ok(summary.join('\n'), {
        asOf: new Date(now).toISOString(),
        source: ['console (unofficial)'],
        period: { label: String(args.month), from: period.from, to: period.to, partial: current },
        totals: total,
        rows,
        notes: [
            'Views and users come from Console analytics (unique counts per month). payingUsers/freeUsers are users with a run that month.',
            'Paying users are not a subset of viewers: users can run an actor without viewing its page that month (API, schedules).',
        ],
    });
}
