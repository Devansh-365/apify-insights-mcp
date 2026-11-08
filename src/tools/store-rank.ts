import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { wrapApi } from '../context.js';
import type { Context } from '../context.js';
import { ok, topN } from '../core/envelope.js';

export const storeRankInput = {
    keywords: z.array(z.string().min(1)).min(1).max(10).describe('1–10 keywords to look up in the Apify Store.'),
    depth: z.number().int().min(1).max(100).default(50).describe('How many Store results to scan per keyword (1–100, default 50).'),
};

type Args = z.infer<z.ZodObject<typeof storeRankInput>>;

interface AboveEntry {
    position: number;
    username: string;
    name: string;
    users30d: number | null;
}

interface KeywordRow {
    keyword: string;
    scanned: number;
    ownerPresent: boolean;
    bestPosition: number | null;
    ownerActors?: Array<{ name: string; position: number }>;
    aboveOwnerBest?: AboveEntry[];
    aboveOmitted?: number;
}

export async function storeRankTool(ctx: Context, args: Args): Promise<CallToolResult> {
    const me = await ctx.account();
    const ownerUsername = me.username;
    const asOf = new Date(ctx.now()).toISOString();

    const keywordRows = await wrapApi(() =>
        Promise.all(
            args.keywords.map(async (keyword): Promise<KeywordRow> => {
                const items = await ctx.api().storeSearch(keyword, args.depth);

                const ownerActors: Array<{ name: string; position: number }> = [];
                const aboveOwnerBestFull: AboveEntry[] = [];
                let bestPosition: number | null = null;

                items.forEach((item, i) => {
                    const pos = i + 1;
                    if (item.username === ownerUsername) {
                        ownerActors.push({ name: item.name, position: pos });
                        if (bestPosition === null || pos < bestPosition) {
                            bestPosition = pos;
                        }
                    }
                });

                if (bestPosition !== null) {
                    items.slice(0, bestPosition - 1).forEach((item, i) => {
                        aboveOwnerBestFull.push({
                            position: i + 1,
                            username: item.username,
                            name: item.name,
                            users30d: item.stats?.totalUsers30Days ?? null,
                        });
                    });
                }

                if (!ownerActors.length) {
                    return { keyword, scanned: items.length, ownerPresent: false, bestPosition: null };
                }

                // Cap above-list to keep output small.
                const { rows: above, omitted } = topN(aboveOwnerBestFull, 10, 'raise `depth` or use actor_report to drill into specific competitors');
                return {
                    keyword,
                    scanned: items.length,
                    ownerPresent: true,
                    bestPosition,
                    ownerActors,
                    aboveOwnerBest: above,
                    ...(omitted ? { aboveOmitted: omitted.rows } : {}),
                };
            }),
        ),
    );

    const foundCount = keywordRows.filter((r) => r.ownerPresent).length;
    const summary =
        foundCount === 0
            ? `${ownerUsername} not found in the top ${args.depth} results for any of the ${args.keywords.length} keyword(s).`
            : `${ownerUsername} found in ${foundCount} of ${args.keywords.length} keyword(s). Best positions: ${keywordRows
                  .filter((r) => r.ownerPresent && r.bestPosition != null)
                  .map((r) => `"${r.keyword}" #${r.bestPosition}`)
                  .join(', ')}.`;

    return ok(summary, {
        asOf,
        source: ['apify-api'],
        notes: [
            'Rank order comes from apify.com/api/store-search — the Recombee-backed endpoint the real Store website search box calls, NOT the documented /v2/store?search= API (which uses a different ranking algorithm and disagrees sharply with what visitors see). Verified stable for anonymous callers. Hard-capped at 100 results per keyword; "absent" means outside the top `depth`.',
            'users30d for actors above the owner is null: the Store search endpoint does not carry 30-day user counts. Use competitor_benchmark or actor_report for user counts.',
            'The apify.com/api/store-search endpoint is undocumented and could change without notice. If results look wrong, this is the first thing to check.',
        ],
        rows: keywordRows,
    });
}
