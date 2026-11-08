import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from './context.js';
import { fail, ToolError } from './core/envelope.js';
import { GLOSSARY } from './glossary.js';
import { actorProfitability, actorProfitabilityInput } from './tools/actor-profitability.js';
import { actorReport, actorReportInput } from './tools/actor-report.js';
import { authStatus } from './tools/auth-status.js';
import { competitorBenchmarkInput, competitorBenchmarkTool } from './tools/competitor-benchmark.js';
import { dailyBrief } from './tools/daily-brief.js';
import { growth, growthInput } from './tools/growth.js';
import { listActors, listActorsInput } from './tools/list-actors.js';
import { revenueSummary, revenueSummaryInput } from './tools/revenue-summary.js';
import { runHealthInput, runHealthTool } from './tools/run-health.js';
import { storeRankInput, storeRankTool } from './tools/store-rank.js';

export const VERSION = '0.2.0';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Tool name + timestamp only, for the dogfood trial (plan §9). Off unless APIFY_INSIGHTS_USAGE_LOG=1. */
async function logUsage(ctx: Context, tool: string): Promise<void> {
    if (!ctx.config.usageLog) return;
    try {
        await mkdir(ctx.config.home, { recursive: true, mode: 0o700 });
        await appendFile(join(ctx.config.home, 'usage.jsonl'), `${JSON.stringify({ t: new Date(ctx.now()).toISOString(), tool })}\n`, { mode: 0o600 });
    } catch {
        // Logging must never break a tool.
    }
}

function guarded(ctx: Context, tool: string, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
    return (async () => {
        await logUsage(ctx, tool);
        try {
            return await run();
        } catch (error) {
            if (error instanceof ToolError) return fail(error);
            return fail(new ToolError('public_api_error', error instanceof Error ? error.message : String(error), 'Try again in a minute.'));
        }
    })();
}

export function createServer(ctx: Context): McpServer {
    const server = new McpServer(
        { name: 'apify-insights', version: VERSION },
        {
            instructions:
                'Answers questions about the Apify actors owned by the connected account: money, users, run health, notices, pricing, Store rank. ' +
                '"How am I doing" → daily_brief. "Is anything broken" → run_health. "Which actors lose money / should I reprice" → actor_profitability(view: losers) then actor_report. ' +
                'Read apify-insights://glossary before explaining a metric. Repeat numbers exactly as returned; null means "not available", never zero; never estimate. ' +
                'Per-actor money is paying-users money by calendar month; day ranges per actor cover only named actors or the top 10 earners.',
        },
    );

    server.registerTool(
        'auth_status',
        {
            title: 'Connection status',
            description: 'Whether the Apify API token works (and for which account) and the state of the Console session used for money data. Call this when another tool returns an auth error.',
            annotations: READ_ONLY,
        },
        () => guarded(ctx, 'auth_status', () => authStatus(ctx)),
    );

    server.registerTool(
        'daily_brief',
        {
            title: 'Morning check',
            description:
                'Yesterday and month-to-date money (paying users) vs the same days last month, plus up to three actors to look at, each with the rule that flagged it and the next call to make. Falls back to health only without a Console session.',
            annotations: READ_ONLY,
        },
        () => guarded(ctx, 'daily_brief', () => dailyBrief(ctx)),
    );

    server.registerTool(
        'revenue_summary',
        {
            title: 'Revenue summary',
            description: 'Account revenue, cost, profit and margin for any period (yesterday, last7d, a month, a date range), optionally compared with the previous period or the same days last month.',
            inputSchema: revenueSummaryInput,
            annotations: READ_ONLY,
        },
        (args) => guarded(ctx, 'revenue_summary', () => revenueSummary(ctx, args)),
    );

    server.registerTool(
        'actor_profitability',
        {
            title: 'Money per actor',
            description:
                'Per-actor revenue, cost, profit, runs, paying/free users, cost and revenue per 1,000 results, price and break-even price for a calendar month. ' +
                'Views: top, losers, movers (change in revenue per day vs the month before), no_revenue, below_cost.',
            inputSchema: actorProfitabilityInput,
            annotations: READ_ONLY,
        },
        (args) => guarded(ctx, 'actor_profitability', () => actorProfitability(ctx, args)),
    );

    server.registerTool(
        'run_health',
        {
            title: 'Run health',
            description:
                "Finds actors that need attention: `flagged` (Apify notice such as under maintenance, hidden from Store search), `failing` (3+ failed or timed-out users' runs and 5%+ failure rate in 30 days, aborts excluded) and, with a Console session, `no_revenue` plus revenue at risk. " +
                'Returns only problems by default, worst first. Pass `actor` to check one actor.',
            inputSchema: runHealthInput,
            annotations: READ_ONLY,
        },
        (args) => guarded(ctx, 'run_health', () => runHealthTool(ctx, args)),
    );

    server.registerTool(
        'actor_report',
        {
            title: 'Actor report',
            description:
                'Everything known about one actor: users, 30-day run results, flags, current price, default memory and timeout, latest build, reviews, local source folder, and (with a Console session) the last three months of money with unit costs and break-even price.',
            inputSchema: actorReportInput,
            annotations: READ_ONLY,
        },
        (args) => guarded(ctx, 'actor_report', () => actorReport(ctx, args)),
    );

    server.registerTool(
        'list_actors',
        {
            title: 'List my actors',
            description:
                "The connected account's actors with users (7/30 days), users' runs and failure rate (30 days), last run and any Apify notice. Default: top 25 by 30-day users. Use `query` to find an actor by name.",
            inputSchema: listActorsInput,
            annotations: READ_ONLY,
        },
        (args) => guarded(ctx, 'list_actors', () => listActors(ctx, args)),
    );

    server.registerTool(
        'growth',
        {
            title: 'Views to runs to paying users',
            description: 'For a calendar month: how many users viewed your actors, ran them and paid, per actor (most paying users, most used, or worst view-to-run conversion). One actor adds top referrers and countries.',
            inputSchema: growthInput,
            annotations: READ_ONLY,
        },
        (args) => guarded(ctx, 'growth', () => growth(ctx, args)),
    );

    server.registerTool(
        'store_rank',
        {
            title: 'Store rank by keyword',
            description:
                "Your actors' positions in Apify Store search for up to 10 keywords, in the order a Store visitor sees, with the actors ranked above your best one.",
            inputSchema: storeRankInput,
            annotations: READ_ONLY,
        },
        (args) => guarded(ctx, 'store_rank', () => storeRankTool(ctx, args)),
    );

    server.registerTool(
        'competitor_benchmark',
        {
            title: 'Compare with another creator',
            description: "Your public portfolio vs another creator's: actors, users (30 days), median users per actor, actors with 10+ and 100+ users, total runs, and each side's top 5 actors.",
            inputSchema: competitorBenchmarkInput,
            annotations: READ_ONLY,
        },
        (args) => guarded(ctx, 'competitor_benchmark', () => competitorBenchmarkTool(ctx, args)),
    );

    server.registerResource(
        'glossary',
        'apify-insights://glossary',
        { title: 'Metric definitions', description: 'What each number returned by this server means.', mimeType: 'text/markdown' },
        (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GLOSSARY }] }),
    );

    const prompt = (name: string, title: string, description: string, text: string) =>
        server.registerPrompt(name, { title, description }, () => ({ messages: [{ role: 'user', content: { type: 'text', text } }] }));

    prompt(
        'morning-brief',
        'Morning check',
        'How the Apify portfolio is doing today and what to look at.',
        'Call daily_brief. Report the money lines exactly as returned, then each item with its rule and numbers. For the first item, call the suggested next tool and say what it shows. Do not estimate or forecast.',
    );
    prompt(
        'loss-hunt',
        'Find money leaks',
        'Which actors lose money or charge nothing, and why.',
        'Call actor_profitability with view "losers", then with view "no_revenue". For the two biggest problems call actor_report and explain the cause from its numbers: cost per 1K results vs revenue per 1K, price vs break-even price, default memory, paying vs free users. If the report has a localPath, name the files to check (for example .actor/actor.json for memory). Do not change anything.',
    );
    prompt(
        'health-check',
        'Health sweep',
        'Which actors are flagged, failing or charging nothing.',
        'Call run_health. List each problem with its flag, rule and numbers, worst first. For the top two call actor_report and say what to fix first. Do not change anything.',
    );

    return server;
}
