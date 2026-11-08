#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createDefaultContext } from './context.js';
import { createServer } from './server.js';

async function main() {
    const ctx = await createDefaultContext(loadConfig());
    const server = createServer(ctx);
    await server.connect(new StdioServerTransport());
    // stdout carries the protocol; diagnostics go to stderr.
    console.error(`apify-insights-mcp ready (API token: ${ctx.tokenSource ?? 'missing'})`);
}

main().catch((error) => {
    console.error('apify-insights-mcp failed to start:', error instanceof Error ? error.message : error);
    process.exit(1);
});
