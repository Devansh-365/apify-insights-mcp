import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

// `setup`: copy the server to <home>/app/index.js, then register it with every AI client found on this
// computer. Clients then start it with plain `node` (no npx, no network: ~0.1s instead of 4-15s from git).
// Re-running setup updates the copy in place, so client configs never change.

export const SERVER_NAME = 'apify-insights';

export type Runner = (command: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

export interface SetupOptions {
    env: NodeJS.ProcessEnv;
    homeDir: string;
    home: string;
    platform: NodeJS.Platform;
    sourceEntry: string;
    log: (line: string) => void;
    /** Runs a client CLI; injectable for tests. */
    run?: Runner;
    /** Finds a command on PATH; injectable for tests. */
    which?: (command: string) => boolean;
}

const defaultRunner: Runner = (command, args) =>
    new Promise((resolve) => {
        // Windows client CLIs are .cmd shims, which need a shell.
        execFile(command, args, { timeout: 30_000, shell: process.platform === 'win32' }, (error, stdout, stderr) =>
            resolve({ ok: !error, output: `${stdout}${stderr}`.trim() }),
        );
    });

function onPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
    const exts = platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
    return (command: string) => (env.PATH ?? '').split(delimiter).some((dir) => dir && exts.some((ext) => existsSync(join(dir, command + ext))));
}

/** Copies the bundled server to <home>/app/index.js and returns that path. */
export async function copyServer(sourceEntry: string, home: string): Promise<string> {
    const entry = join(home, 'app', 'index.js');
    await mkdir(dirname(entry), { recursive: true, mode: 0o700 });
    await copyFile(sourceEntry, entry);
    return entry;
}

interface CliClient {
    name: string;
    bin: string;
    remove: string[];
    add: (entry: string) => string[];
}

// Each client's own `mcp add`, at user scope so the server works in every project.
const CLI_CLIENTS: CliClient[] = [
    { name: 'Claude Code', bin: 'claude', remove: ['mcp', 'remove', '-s', 'user', SERVER_NAME], add: (e) => ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', 'node', e] },
    { name: 'Codex', bin: 'codex', remove: ['mcp', 'remove', SERVER_NAME], add: (e) => ['mcp', 'add', SERVER_NAME, '--', 'node', e] },
    { name: 'Gemini CLI', bin: 'gemini', remove: ['mcp', 'remove', '-s', 'user', SERVER_NAME], add: (e) => ['mcp', 'add', '-s', 'user', SERVER_NAME, 'node', e] },
    { name: 'Grok Build', bin: 'grok', remove: ['mcp', 'remove', SERVER_NAME], add: (e) => ['mcp', 'add', SERVER_NAME, '--', 'node', e] },
];

// The most telling line of a failed CLI call: an error line if there is one (an old CLI without
// `mcp add` prints its usage text first), else the first line.
function reason(output: string): string {
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    return (lines.find((line) => /error|unknown|not found|invalid/i.test(line)) ?? lines[0] ?? 'unknown error').slice(0, 160);
}

function quoteArg(value: string): string {
    return /^[\w./:@=-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

type Json = Record<string, unknown>;

/**
 * Adds the server to a JSON config file, keeping everything else. A file that is not plain JSON
 * (comments, JSONC) is never rewritten: the snippet is printed instead.
 */
async function mergeJsonConfig(client: string, file: string, snippet: string, add: (config: Json) => void, log: (line: string) => void): Promise<void> {
    let config: Json = {};
    if (existsSync(file)) {
        try {
            config = JSON.parse(await readFile(file, 'utf8')) as Json;
        } catch {
            log(`- ${client}: ${file} is not plain JSON, left unchanged. Add:\n    ${snippet}`);
            return;
        }
    }
    add(config);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
    log(`- ${client}: added to ${file}`);
}

function object(value: unknown): Json {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

export async function setup(options: SetupOptions): Promise<number> {
    const { homeDir, home, log } = options;
    const run = options.run ?? defaultRunner;
    const which = options.which ?? onPath(options.env, options.platform);

    const entry = await copyServer(options.sourceEntry, home);
    log(`Server installed at ${entry}`);
    log('');
    log('AI clients:');
    let found = 0;
    for (const client of CLI_CLIENTS) {
        if (!which(client.bin)) continue;
        found++;
        // Remove first so re-running setup (or moving the home folder) replaces an older entry.
        await run(client.bin, client.remove);
        const result = await run(client.bin, client.add(entry));
        const command = [client.bin, ...client.add(entry)].map(quoteArg).join(' ');
        log(result.ok ? `- ${client.name}: added` : `- ${client.name}: could not add (${reason(result.output)}). Run:\n    ${command}`);
    }
    const cursorDir = join(homeDir, '.cursor');
    if (existsSync(cursorDir)) {
        found++;
        const server = { command: 'node', args: [entry] };
        await mergeJsonConfig('Cursor', join(cursorDir, 'mcp.json'), `"mcpServers": { "${SERVER_NAME}": ${JSON.stringify(server)} }`, (config) => {
            config.mcpServers = { ...object(config.mcpServers), [SERVER_NAME]: server };
        }, log);
    }
    const openCodeDir = join(options.env.XDG_CONFIG_HOME || join(homeDir, '.config'), 'opencode');
    if (which('opencode') || existsSync(openCodeDir)) {
        found++;
        // `mcp.<name>` works on every OpenCode release; newer ones also accept `mcp.servers.<name>`,
        // so a config that already uses that layout gets the entry there.
        const server = { type: 'local', command: ['node', entry], enabled: true };
        const jsonc = join(openCodeDir, 'opencode.jsonc');
        const file = existsSync(jsonc) ? jsonc : join(openCodeDir, 'opencode.json');
        await mergeJsonConfig('OpenCode', file, `"mcp": { "${SERVER_NAME}": ${JSON.stringify(server)} }`, (config) => {
            const mcp = object(config.mcp);
            if (mcp.servers && typeof mcp.servers === 'object') {
                const { enabled: _enabled, ...v2 } = server;
                mcp.servers = { ...object(mcp.servers), [SERVER_NAME]: v2 };
            } else mcp[SERVER_NAME] = server;
            config.mcp = mcp;
            config.$schema ??= 'https://opencode.ai/config.json';
        }, log);
    }
    if (found === 0) log('  (No Claude Code, Codex, Gemini CLI, Grok Build, Cursor or OpenCode found. See the README for other clients.)');
    log('');
    log('Restart your AI client, then ask: "How are my Apify actors doing?"');
    log('API token: run `apify login` once, or set APIFY_TOKEN. Money tools also need the bridge: npx -y github:Devansh-365/apify-insights-mcp install');
    return 0;
}
