import { access, chmod, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { BRIDGE_EXTENSION_ID, NATIVE_HOST_NAME, runNativeHost } from '../native/host.js';

// Command-line entry: `native-host` (started by Chrome), `install` and `uninstall`. Anything else
// returns null so index.ts starts the MCP server as usual.

export interface CliOptions {
    env?: NodeJS.ProcessEnv;
    /** The OS home folder; browser config dirs are found under it. */
    homeDir?: string;
    /** apify-insights home (sessions, wanted, bin). Defaults to loadConfig's. */
    home?: string;
    platform?: NodeJS.Platform;
    stdin?: Readable;
    stdout?: Writable;
    /** Node binary and script the launcher execs. */
    nodePath?: string;
    entryPath?: string;
    /** Unpacked extension folder printed by install. */
    extensionDir?: string;
    log?: (line: string) => void;
}

const MANIFEST_FILE = `${NATIVE_HOST_NAME}.json`;
// Both src/cli and dist/cli sit two levels below the package root.
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface BrowserDir {
    browser: string;
    /** The browser's own config dir: we install only where this already exists. */
    configDir: string;
    hostsDir: string;
}

// NativeMessagingHosts locations per Chrome's docs and each vendor's layout. Arc has no Linux build.
export function browserDirs(homeDir: string, platform: NodeJS.Platform): BrowserDir[] {
    const entry = (browser: string, configDir: string) => ({ browser, configDir, hostsDir: join(configDir, 'NativeMessagingHosts') });
    if (platform === 'darwin') {
        const base = join(homeDir, 'Library', 'Application Support');
        return [
            entry('Chrome', join(base, 'Google', 'Chrome')),
            entry('Chromium', join(base, 'Chromium')),
            entry('Brave', join(base, 'BraveSoftware', 'Brave-Browser')),
            entry('Edge', join(base, 'Microsoft Edge')),
            entry('Arc', join(base, 'Arc', 'User Data')),
        ];
    }
    if (platform === 'linux') {
        const base = join(homeDir, '.config');
        return [
            entry('Chrome', join(base, 'google-chrome')),
            entry('Chromium', join(base, 'chromium')),
            entry('Brave', join(base, 'BraveSoftware', 'Brave-Browser')),
            entry('Edge', join(base, 'microsoft-edge')),
        ];
    }
    return [];
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

interface Resolved {
    env: NodeJS.ProcessEnv;
    homeDir: string;
    home: string;
    platform: NodeJS.Platform;
    log: (line: string) => void;
}

function resolve(options: CliOptions): Resolved {
    const env = options.env ?? process.env;
    return {
        env,
        homeDir: options.homeDir ?? homedir(),
        home: options.home ?? loadConfig(env).home,
        platform: options.platform ?? process.platform,
        log: options.log ?? ((line) => console.log(line)),
    };
}

async function install(options: CliOptions): Promise<number> {
    const { homeDir, home, platform, log } = resolve(options);
    const dirs = browserDirs(homeDir, platform);
    if (dirs.length === 0) {
        log(`install supports macOS and Linux only (this is ${platform}).`);
        return 1;
    }
    const nodePath = options.nodePath ?? process.execPath;
    const entryPath = options.entryPath ?? join(PACKAGE_ROOT, 'dist', 'index.js');
    const extensionDir = options.extensionDir ?? join(PACKAGE_ROOT, 'bridge');

    // Chrome starts the host with its own environment, so the home folder is baked into the launcher:
    // otherwise a custom APIFY_INSIGHTS_HOME would make the host write where the MCP never looks.
    const binDir = join(home, 'bin');
    await mkdir(binDir, { recursive: true, mode: 0o700 });
    const launcher = join(binDir, 'native-host');
    const script = [
        '#!/bin/sh',
        '# Written by `apify-insights-mcp install`. Chrome starts this once per Apify Insights Bridge message.',
        `APIFY_INSIGHTS_HOME=${shellQuote(home)} exec ${shellQuote(nodePath)} ${shellQuote(entryPath)} native-host "$@"`,
        '',
    ].join('\n');
    await writeFile(launcher, script, { mode: 0o700 });
    await chmod(launcher, 0o700);
    log(`Launcher: ${launcher}`);

    const manifest = {
        name: NATIVE_HOST_NAME,
        description: 'apify-insights-mcp native host for the Apify Insights Bridge extension',
        path: launcher,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${BRIDGE_EXTENSION_ID}/`],
    };
    let installed = 0;
    for (const dir of dirs) {
        if (!(await exists(dir.configDir))) continue;
        await mkdir(dir.hostsDir, { recursive: true });
        await writeFile(join(dir.hostsDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 4)}\n`);
        log(`Native host registered for ${dir.browser}: ${join(dir.hostsDir, MANIFEST_FILE)}`);
        installed++;
    }
    if (installed === 0) log('No supported browser profile folder found (Chrome, Chromium, Brave, Edge, Arc). Nothing registered.');

    log('');
    log('Next:');
    log(`1. In your browser open chrome://extensions, turn on Developer mode, click "Load unpacked" and pick:\n   ${extensionDir}`);
    log(`   The extension ID must be ${BRIDGE_EXTENSION_ID}.`);
    log(`2. Add the MCP server to Claude Code:\n   claude mcp add apify-insights -- ${shellQuote(nodePath)} ${shellQuote(entryPath)}`);
    return installed > 0 ? 0 : 1;
}

async function uninstall(options: CliOptions): Promise<number> {
    const { homeDir, home, platform, log } = resolve(options);
    // Remove from every known location, not only where the browser still exists.
    for (const platformDirs of new Set([platform, 'darwin', 'linux'] as NodeJS.Platform[])) {
        for (const dir of browserDirs(homeDir, platformDirs)) {
            const path = join(dir.hostsDir, MANIFEST_FILE);
            if (await exists(path)) {
                await rm(path, { force: true });
                log(`Removed ${path}`);
            }
        }
    }
    const binDir = join(home, 'bin');
    for (const path of [join(binDir, 'native-host'), join(home, 'sessions'), join(home, 'wanted')]) {
        if (await exists(path)) {
            await rm(path, { recursive: true, force: true });
            log(`Removed ${path}`);
        }
    }
    // Drop bin/ only if we emptied it; leave anything else the user put there.
    await rmdir(binDir).catch(() => undefined);
    log('Remove the Apify Insights Bridge extension from chrome://extensions yourself.');
    return 0;
}

/** Returns null when `argv` (process.argv.slice(2)) is not a CLI command, else the exit code. */
export async function runCli(argv: string[], options: CliOptions = {}): Promise<number | null> {
    const [command, ...rest] = argv;
    // Chrome passes the caller's origin (`chrome-extension://<id>/`) as the first argument to the host.
    if (command === 'native-host' || command?.startsWith('chrome-extension://')) {
        const args = command === 'native-host' ? rest : argv;
        const origin = args.map((arg) => /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(arg)?.[1]).find(Boolean);
        const { home } = resolve(options);
        // stdout is the protocol channel here: nothing else may be written to it.
        return runNativeHost(options.stdin ?? process.stdin, options.stdout ?? process.stdout, home, Date.now, origin ?? BRIDGE_EXTENSION_ID);
    }
    if (command === 'install') return install(options);
    if (command === 'uninstall') return uninstall(options);
    return null;
}
