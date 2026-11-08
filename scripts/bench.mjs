// Live speed check against the configured account (manual; not part of `npm test`). Starts the built
// server over stdio and times a fixed list of tool calls. Prints only tool names and milliseconds.
//
//   node scripts/bench.mjs                # one server process, tools in order, 3 runs
//   node scripts/bench.mjs --cold         # a new server process for every tool call (first-question cost)
//   node scripts/bench.mjs --runs 5 --actor <name>
//   APIFY_INSIGHTS_DEBUG=timing node scripts/bench.mjs --runs 1   # per-request lines on stderr
//
// Keep runs low: the Apify Console rate-limits bursts of ~150-200 requests.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const cold = flag('--cold');
const runs = Number(option('--runs', '3'));

async function start() {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: { ...process.env }, stderr: 'inherit' });
    const client = new Client({ name: 'bench', version: '0.0.0' });
    await client.connect(transport);
    return client;
}

async function timed(client, name, args) {
    const started = Date.now();
    const result = await client.callTool({ name, arguments: args });
    return { ms: Date.now() - started, error: result.isError ? result.structuredContent?.error?.code ?? 'error' : null };
}

// The top actor by 30-day users, unless one is named.
let actor = option('--actor', null);
if (!actor) {
    const client = await start();
    const list = await client.callTool({ name: 'list_actors', arguments: { sort: 'users30d', visibility: 'public', top: 1 } });
    actor = list.structuredContent?.rows?.[0]?.name ?? null;
    await client.close();
}

const CALLS = [
    ['auth_status', {}],
    ['daily_brief', {}],
    ['revenue_summary', { period: 'lastMonth', compareTo: 'previousPeriod' }],
    ['actor_profitability', { period: 'lastMonth', view: 'losers' }],
    ...(actor ? [['actor_report', { actor }]] : []),
    ['growth', {}],
    ['acquisition_score', {}],
    ['actor_quality', {}],
];

const times = new Map(CALLS.map(([name]) => [name, []]));
const errors = new Map();
for (let run = 0; run < runs; run++) {
    let shared = cold ? null : await start();
    for (const [name, args] of CALLS) {
        const client = shared ?? (await start());
        const { ms, error } = await timed(client, name, args);
        times.get(name).push(ms);
        if (error) errors.set(name, error);
        if (!shared) await client.close();
    }
    if (shared) await shared.close();
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(`\n${cold ? 'cold (new process per tool)' : 'warm (one process)'}, ${runs} run(s)${actor ? `, actor_report on the top actor` : ''}\n`);
console.log('tool                  median ms   runs');
for (const [name, values] of times) {
    console.log(`${name.padEnd(22)}${String(median(values)).padStart(9)}   ${values.join(' ')}${errors.has(name) ? `   (error: ${errors.get(name)})` : ''}`);
}
