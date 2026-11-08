import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from './context.js';
import { fail, ToolError } from './core/envelope.js';
import { GLOSSARY } from './glossary.js';
import { actorReport, actorReportInput } from './tools/actorReport.js';
import { authStatus } from './tools/authStatus.js';
import { listActors, listActorsInput } from './tools/listActors.js';
import { runHealthInput, runHealthTool } from './tools/runHealth.js';

export const VERSION = '0.1.0';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof ToolError) return fail(error);
        return fail(new ToolError('public_api_error', error instanceof Error ? error.message : String(error), 'Try again in a minute.'));
    }
}

export function createServer(ctx: Context): McpServer {
    const server = new McpServer(
        { name: 'apify-insights', version: VERSION },
        {
            instructions:
                'Answers questions about the Apify actors owned by the connected account: users, run health, notices, pricing. ' +
                'Start with run_health for "is anything broken", list_actors to find actors, actor_report for one actor in depth. ' +
                'Read the glossary resource (apify-insights://glossary) before explaining a metric. ' +
                'Null means "not available", never zero. Revenue and profit are not available in this version.',
        },
    );

    server.registerTool(
        'auth_status',
        {
            title: 'Connection status',
            description: 'Whether the Apify API token works (and for which account) and the state of the Console session used for revenue data. Call this when another tool returns an auth error.',
            annotations: READ_ONLY,
        },
        () => guarded(() => authStatus(ctx)),
    );

    server.registerTool(
        'list_actors',
        {
            title: 'List my actors',
            description:
                "The connected account's actors with users (7/30/90 days), users' runs and failure rate (30 days), last run and any Apify notice. " +
                'Default: top 25 by 30-day users. Use `query` to find an actor by name.',
            inputSchema: listActorsInput,
            annotations: READ_ONLY,
        },
        (args) => guarded(() => listActors(ctx, args)),
    );

    server.registerTool(
        'run_health',
        {
            title: 'Run health',
            description:
                "Finds actors that need attention: `flagged` (Apify notice such as under maintenance, hidden from Store search) and `failing` (3+ failed or timed-out users' runs and 5%+ failure rate in 30 days, aborts excluded). " +
                'Returns only problems by default, worst first. Pass `actor` to check one actor.',
            inputSchema: runHealthInput,
            annotations: READ_ONLY,
        },
        (args) => guarded(() => runHealthTool(ctx, args)),
    );

    server.registerTool(
        'actor_report',
        {
            title: 'Actor report',
            description:
                'Everything known about one actor: users, 30-day run results, flags, current price, default memory and timeout, latest build, reviews, and its local source folder when configured.',
            inputSchema: actorReportInput,
            annotations: READ_ONLY,
        },
        (args) => guarded(() => actorReport(ctx, args)),
    );

    server.registerResource(
        'glossary',
        'apify-insights://glossary',
        { title: 'Metric definitions', description: 'What each number returned by this server means.', mimeType: 'text/markdown' },
        (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GLOSSARY }] }),
    );

    return server;
}
