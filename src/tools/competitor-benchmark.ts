import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { wrapApi } from '../context.js';
import type { Context } from '../context.js';
import type { StoreActor } from '../clients/apify-api.js';
import { ok } from '../core/envelope.js';

export const competitorBenchmarkInput = {
    username: z.string().min(1).describe("Another Apify creator's username to compare against the connected account."),
};

type Args = z.infer<z.ZodObject<typeof competitorBenchmarkInput>>;

interface PortfolioStats {
    totalActors: number;
    /** Sum of users30d across all actors. A user running two actors is counted twice. */
    totalUsers30d: number;
    medianUsers30d: number | null;
    actorsGe10Users30d: number;
    actorsGe100Users30d: number;
    totalRuns: number;
    top5ByUsers30d: Array<{ name: string; title: string | null; users30d: number | null }>;
}

function portfolioStats(actors: StoreActor[]): PortfolioStats {
    const sorted = [...actors].sort((a, b) => (b.stats?.totalUsers30Days ?? 0) - (a.stats?.totalUsers30Days ?? 0));

    const vals = actors.map((a) => a.stats?.totalUsers30Days ?? 0).sort((a, b) => a - b);
    let medianUsers30d: number | null = null;
    if (vals.length > 0) {
        const mid = Math.floor(vals.length / 2);
        medianUsers30d =
            vals.length % 2 === 0
                ? ((vals[mid - 1] ?? 0) + (vals[mid] ?? 0)) / 2
                : (vals[mid] ?? 0);
    }

    return {
        totalActors: actors.length,
        totalUsers30d: actors.reduce((sum, a) => sum + (a.stats?.totalUsers30Days ?? 0), 0),
        medianUsers30d,
        actorsGe10Users30d: actors.filter((a) => (a.stats?.totalUsers30Days ?? 0) >= 10).length,
        actorsGe100Users30d: actors.filter((a) => (a.stats?.totalUsers30Days ?? 0) >= 100).length,
        totalRuns: actors.reduce((sum, a) => sum + (a.stats?.totalRuns ?? 0), 0),
        top5ByUsers30d: sorted.slice(0, 5).map((a) => ({
            name: a.name,
            title: a.title ?? null,
            users30d: a.stats?.totalUsers30Days ?? null,
        })),
    };
}

export async function competitorBenchmarkTool(ctx: Context, args: Args): Promise<CallToolResult> {
    const me = await ctx.account();
    const asOf = new Date(ctx.now()).toISOString();

    const [ownerStore, competitorStore] = await wrapApi(() =>
        Promise.all([
            ctx.api().storeActors(me.username),
            ctx.api().storeActors(args.username),
        ]),
    );

    const ownerStats = portfolioStats(ownerStore);
    const competitorStats = portfolioStats(competitorStore);

    const ownerAhead =
        ownerStats.totalUsers30d > competitorStats.totalUsers30d
            ? `${me.username} leads on total users/30d.`
            : ownerStats.totalUsers30d < competitorStats.totalUsers30d
              ? `${args.username} leads on total users/30d.`
              : 'Tied on total users/30d.';

    const summary = [
        `${me.username}: ${ownerStats.totalActors} public actors, ${ownerStats.totalUsers30d} users/30d (sum), median ${ownerStats.medianUsers30d ?? 'n/a'}.`,
        `${args.username}: ${competitorStats.totalActors} public actors, ${competitorStats.totalUsers30d} users/30d (sum), median ${competitorStats.medianUsers30d ?? 'n/a'}.`,
        ownerAhead,
    ].join(' ');

    return ok(summary, {
        asOf,
        source: ['apify-api'],
        notes: [
            'users30d totals are sums: a user who runs two actors is counted twice.',
            'Only public actors are included; private actors are not visible via the Store API.',
            'totalRuns is the all-time count across all public actors.',
        ],
        totals: {
            owner: { username: me.username, ...ownerStats },
            competitor: { username: args.username, ...competitorStats },
        },
    });
}
