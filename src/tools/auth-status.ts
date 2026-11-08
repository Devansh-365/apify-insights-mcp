import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sessionStatus, type ConsoleState } from '../auth/session.js';
import type { Context } from '../context.js';
import { ok, ToolError } from '../core/envelope.js';

const CONSOLE_FIX: Record<ConsoleState, string> = {
    ok: 'Nothing to do.',
    bridge_missing: 'Money tools need the Apify Insights Bridge: run `apify-insights-mcp install`, then load the bridge folder it prints in chrome://extensions. Public tools work without it.',
    warming_up: 'The Console session is stale. Keep Chrome open and logged in to console.apify.com; it refreshes on its own.',
    other_account: 'The Console session belongs to a different Apify account than the API token. Log in to Console with the same account.',
};

export async function authStatus(ctx: Context): Promise<CallToolResult> {
    let publicPart: Record<string, unknown>;
    let userId: string | null = null;
    try {
        const me = await ctx.account();
        userId = me.id;
        publicPart = { ok: true, username: me.username, tokenSource: ctx.tokenSource };
    } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        publicPart = { ok: false, code: error.code, fix: error.fix };
    }
    const session = await sessionStatus(ctx.config.home, userId, ctx.now());
    const consolePart = { ...session, fix: CONSOLE_FIX[session.state] };

    const lines = [
        publicPart.ok ? `Apify API: connected as ${publicPart.username} (token from ${ctx.tokenSource}).` : `Apify API: not connected. ${publicPart.fix}`,
        session.state === 'ok'
            ? `Console session: ok (${session.ageMinutes ?? '?'} min old).`
            : `Console session: ${session.state}. ${consolePart.fix}`,
    ];
    return ok(lines.join('\n'), {
        asOf: new Date(ctx.now()).toISOString(),
        source: ['apify-api'],
        public: publicPart,
        console: consolePart,
        notes: ['list_actors, run_health, actor_report, store_rank and competitor_benchmark need only the API token. revenue_summary, actor_profitability, growth and the money parts of daily_brief, run_health and actor_report need the Console session.'],
    });
}
