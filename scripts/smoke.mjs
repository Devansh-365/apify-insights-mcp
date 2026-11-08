// Live smoke test: starts the built server over stdio and calls each tool once against the
// configured account. Prints summaries and sizes only; writes nothing.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: { ...process.env }, stderr: 'inherit' });
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);
const actor = process.argv[2];
const calls = [
    ['auth_status', {}],
    ['list_actors', {}],
    ['run_health', {}],
    ...(actor ? [['actor_report', { actor }]] : []),
];
for (const [name, args] of calls) {
    const started = Date.now();
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    const json = JSON.stringify(result.structuredContent);
    console.log(`\n## ${name} ${result.isError ? '(ERROR)' : ''} ${Date.now() - started} ms, ${json.length} B`);
    console.log(text.split('\n\n')[0]);
}
await client.close();
