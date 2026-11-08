#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runCli } from './cli/main.js';
import { loadConfig } from './config.js';
import { createDefaultContext } from './context.js';
import { tuneKeepAlive } from './core/keepalive.js';
import { installTiming } from './core/timing.js';
import { createServer } from './server.js';

async function main() {
    // `install`, `uninstall` and `native-host` are commands; no arguments starts the MCP server.
    const code = await runCli(process.argv.slice(2));
    // Exit explicitly: Chrome keeps the native host's stdin open.
    if (code !== null) process.exit(code);
    installTiming();
    const ctx = await createDefaultContext(loadConfig());
    const server = createServer(ctx);
    await server.connect(new StdioServerTransport());
    // Start the account lookup now: the first tool needs it, and it opens the connection to Apify early.
    // Once that first request has created fetch's connection pool, lengthen its keep-alive (Node < 26).
    if (ctx.tokenSource) void ctx.account().then(() => tuneKeepAlive(), () => {});
    // stdout carries the protocol; diagnostics go to stderr.
    console.error(`apify-insights-mcp ready (API token: ${ctx.tokenSource ?? 'missing'})`);
}

main().catch((error) => {
    console.error('apify-insights-mcp failed to start:', error instanceof Error ? error.message : error);
    process.exit(1);
});
