import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliOptions } from '../src/cli/main.js';
import { BRIDGE_EXTENSION_ID, encodeMessage } from '../src/native/host.js';

let fakeHome: string;
let home: string;
let pkg: string;
let lines: string[];
beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'aim-cli-'));
    // An installed apify-insights-mcp: a quote in the path checks shell quoting, keys/ must never be copied.
    home = join(fakeHome, "it's home");
    pkg = join(fakeHome, 'npx-cache', 'apify-insights-mcp');
    await mkdir(join(pkg, 'dist'), { recursive: true });
    await mkdir(join(pkg, 'bridge', 'keys'), { recursive: true });
    await writeFile(join(pkg, 'dist', 'index.js'), '// bundle\n');
    await writeFile(join(pkg, 'bridge', 'manifest.json'), '{}\n');
    await writeFile(join(pkg, 'bridge', 'sw.js'), '// sw\n');
    await writeFile(join(pkg, 'bridge', 'keys', 'key.pem'), 'secret');
    lines = [];
});
afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
});

function options(platform: NodeJS.Platform, extra: CliOptions = {}): CliOptions {
    return {
        env: {},
        homeDir: fakeHome,
        home,
        platform,
        nodePath: '/opt/node/bin/node',
        entryPath: join(pkg, 'dist', 'index.js'),
        extensionDir: join(pkg, 'bridge'),
        log: (line) => lines.push(line),
        ...extra,
    };
}

const MAC = 'Library/Application Support';
const MANIFEST = 'com.apify_insights.bridge.json';

describe('runCli', () => {
    it('returns null for non-CLI argv so the MCP server starts', async () => {
        expect(await runCli([], options('darwin'))).toBeNull();
        expect(await runCli(['--verbose'], options('darwin'))).toBeNull();
    });

    it('install on macOS registers only browsers whose config dir exists, then uninstall cleans up', async () => {
        await mkdir(join(fakeHome, MAC, 'Google', 'Chrome'), { recursive: true });
        await mkdir(join(fakeHome, MAC, 'Arc', 'User Data'), { recursive: true });

        expect(await runCli(['install'], options('darwin'))).toBe(0);

        const launcher = join(home, 'bin', 'native-host');
        const script = await readFile(launcher, 'utf8');
        expect(script.startsWith('#!/bin/sh\n')).toBe(true);
        const quotedHome = home.replace(/'/g, `'\\''`);
        expect(script).toContain(`APIFY_INSIGHTS_HOME='${quotedHome}' exec '/opt/node/bin/node' '${quotedHome}/app/index.js' native-host "$@"`);
        // The server and the extension now live in the home folder, independent of the npx cache.
        expect(await readFile(join(home, 'app', 'index.js'), 'utf8')).toBe('// bundle\n');
        expect((await readdir(join(home, 'bridge'))).sort()).toEqual(['manifest.json', 'sw.js']);
        expect((await stat(launcher)).mode & 0o777).toBe(0o700);

        for (const dir of [join(fakeHome, MAC, 'Google', 'Chrome'), join(fakeHome, MAC, 'Arc', 'User Data')]) {
            const manifest = JSON.parse(await readFile(join(dir, 'NativeMessagingHosts', MANIFEST), 'utf8'));
            expect(manifest).toEqual({
                name: 'com.apify_insights.bridge',
                description: expect.any(String),
                path: launcher,
                type: 'stdio',
                allowed_origins: [`chrome-extension://${BRIDGE_EXTENSION_ID}/`],
            });
        }
        // Brave, Chromium, Edge are not installed: nothing created for them.
        expect((await readdir(join(fakeHome, MAC))).sort()).toEqual(['Arc', 'Google']);
        expect(lines.join('\n')).toContain(join(home, 'bridge'));
        expect(lines.join('\n')).toContain('claude mcp add apify-insights -- npx -y github:Devansh-365/apify-insights-mcp');

        // Simulate a bridge session and a wanted marker, then uninstall.
        await mkdir(join(home, 'sessions'), { recursive: true });
        await writeFile(join(home, 'sessions', 'abc.json'), '{}');
        await writeFile(join(home, 'wanted'), '');
        expect(await runCli(['uninstall'], options('darwin'))).toBe(0);
        for (const path of [
            join(fakeHome, MAC, 'Google', 'Chrome', 'NativeMessagingHosts', MANIFEST),
            join(fakeHome, MAC, 'Arc', 'User Data', 'NativeMessagingHosts', MANIFEST),
            launcher,
            join(home, 'app'),
            join(home, 'bridge'),
            join(home, 'sessions'),
            join(home, 'wanted'),
        ]) {
            await expect(stat(path)).rejects.toThrow();
        }
        // The browsers' own folders stay.
        expect((await stat(join(fakeHome, MAC, 'Google', 'Chrome'))).isDirectory()).toBe(true);
    });

    it('install on Linux uses ~/.config and fails when no browser is present', async () => {
        expect(await runCli(['install'], options('linux'))).toBe(1);
        await mkdir(join(fakeHome, '.config', 'BraveSoftware', 'Brave-Browser'), { recursive: true });
        expect(await runCli(['install'], options('linux'))).toBe(0);
        const manifest = JSON.parse(await readFile(join(fakeHome, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts', MANIFEST), 'utf8'));
        expect(manifest.allowed_origins).toEqual([`chrome-extension://${BRIDGE_EXTENSION_ID}/`]);
        await expect(stat(join(fakeHome, '.config', 'google-chrome'))).rejects.toThrow();
    });

    it('install refuses unsupported platforms', async () => {
        expect(await runCli(['install'], options('win32'))).toBe(1);
    });

    it('native-host answers one message on the given streams, with the Chrome origin argument', async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const chunks: Buffer[] = [];
        stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        const done = runCli(['native-host', `chrome-extension://${BRIDGE_EXTENSION_ID}/`], options('darwin', { stdin, stdout }));
        stdin.write(encodeMessage({ op: 'wanted?' }));
        expect(await done).toBe(0);
        const reply = Buffer.concat(chunks);
        expect(JSON.parse(reply.subarray(4).toString('utf8'))).toEqual({ ok: true, wanted: false });
    });
});
