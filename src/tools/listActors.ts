import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import type { ActorSummary } from '../core/actors.js';
import { ok, round, topN } from '../core/envelope.js';

export const listActorsInput = {
    query: z.string().optional().describe('Only actors whose name or title contains this text.'),
    visibility: z.enum(['all', 'public', 'private']).default('all'),
    onlyWithNotice: z.boolean().default(false).describe('Only actors Apify has put a notice on (e.g. under maintenance).'),
    sort: z.enum(['users30d', 'users7d', 'users90d', 'runs30d', 'lastRun', 'name']).default('users30d'),
    top: z.number().int().min(1).max(100).default(25),
};

type Args = z.infer<z.ZodObject<typeof listActorsInput>>;

const SORTERS: Record<Args['sort'], (a: ActorSummary, b: ActorSummary) => number> = {
    users30d: (a, b) => (b.users30d ?? -1) - (a.users30d ?? -1),
    users7d: (a, b) => (b.users7d ?? -1) - (a.users7d ?? -1),
    users90d: (a, b) => (b.users90d ?? -1) - (a.users90d ?? -1),
    runs30d: (a, b) => (b.runs30d?.runs ?? -1) - (a.runs30d?.runs ?? -1),
    lastRun: (a, b) => (b.lastRunStartedAt ?? '').localeCompare(a.lastRunStartedAt ?? ''),
    name: (a, b) => a.name.localeCompare(b.name),
};

function row(actor: ActorSummary) {
    return {
        name: actor.name,
        ...(actor.isPublic ? {} : { private: true }),
        users7d: actor.users7d,
        users30d: actor.users30d,
        runs30d: actor.runs30d?.runs ?? null,
        failureRate30dPct: actor.runs30d?.failureRate == null ? null : round(actor.runs30d.failureRate * 100, 1),
        lastRun: actor.lastRunStartedAt?.slice(0, 10) ?? null,
        ...(actor.notice && actor.notice !== 'NONE' ? { notice: actor.notice } : {}),
    };
}

export async function listActors(ctx: Context, args: Args): Promise<CallToolResult> {
    const catalog = await ctx.catalog();
    const q = args.query?.trim().toLowerCase();
    const matches = catalog
        .filter((actor) => args.visibility === 'all' || (args.visibility === 'public') === actor.isPublic)
        .filter((actor) => !args.onlyWithNotice || (actor.notice != null && actor.notice !== 'NONE'))
        .filter((actor) => !q || actor.name.includes(q) || actor.title?.toLowerCase().includes(q))
        .sort(SORTERS[args.sort]);
    const page = topN(matches.map(row), args.top, 'raise `top`, or narrow with `query` / `visibility`');
    const publicCount = catalog.filter((actor) => actor.isPublic).length;
    const withNotice = catalog.filter((actor) => actor.notice && actor.notice !== 'NONE').length;
    const summary = [
        `${matches.length} of ${catalog.length} actors match (${publicCount} public, ${catalog.length - publicCount} private, ${withNotice} with a notice).`,
        page.rows.length ? `Top by ${args.sort}: ${page.rows.slice(0, 3).map((r) => `${r.name} (${r.users30d ?? 'n/a'} users/30d)`).join(', ')}.` : '',
    ].filter(Boolean);
    return ok(summary.join('\n'), {
        asOf: new Date(ctx.now()).toISOString(),
        source: ['apify-api'],
        totals: { username: catalog[0]?.ref.split('/')[0] ?? null, actors: catalog.length, public: publicCount, private: catalog.length - publicCount, withNotice, matching: matches.length },
        rows: page.rows,
        ...(page.omitted ? { omitted: page.omitted } : {}),
        notes: [
            'users7d/30d and runs30d come from public Store stats and are null for private actors. users90d and more: actor_report.',
            'runs30d and failureRate30dPct count your users\' runs only (failed + timed-out; aborted excluded).',
        ],
    });
}
