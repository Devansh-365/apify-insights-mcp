import { createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionStatus } from '../src/auth/session.js';
import { BRIDGE_EXTENSION_ID, encodeMessage, readMessage, runNativeHost, sessionFileName } from '../src/native/host.js';

// A made-up token: the host only checks its length.
const TOKEN = 'tok_' + 'x'.repeat(41);
const NOW = Date.parse('2026-11-08T03:00:00.000Z');
const PROFILE = '0f8c2a6e-1b2c-4d5e-8f90-123456789abc';

let home: string;
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'aim-native-'));
});
afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

function collect(stream: PassThrough): () => Buffer {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    return () => Buffer.concat(chunks);
}

function decode(buffer: Buffer): any {
    const length = buffer.readUInt32LE(0);
    expect(buffer.length).toBe(4 + length);
    return JSON.parse(buffer.subarray(4).toString('utf8'));
}

async function exchange(message: unknown, now = NOW) {
    const input = new PassThrough();
    const output = new PassThrough();
    const read = collect(output);
    const done = runNativeHost(input, output, home, () => now);
    input.write(encodeMessage(message));
    const code = await done;
    return { code, reply: decode(read()), raw: read().toString('utf8') };
}

describe('framing', () => {
    it('round-trips a message split across chunks, with unicode', async () => {
        const message = { op: 'wanted?', note: 'grüße ✓' };
        const framed = encodeMessage(message);
        expect(framed.readUInt32LE(0)).toBe(Buffer.byteLength(JSON.stringify(message)));
        const input = new PassThrough();
        const pending = readMessage(input);
        input.write(framed.subarray(0, 2));
        input.write(framed.subarray(2, 9));
        input.write(framed.subarray(9));
        const raw = await pending;
        expect(JSON.parse(raw!.toString('utf8'))).toEqual(message);
    });
    it('resolves null on a truncated stream and exits non-zero without a reply', async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        const read = collect(output);
        const done = runNativeHost(input, output, home, () => NOW);
        input.end(encodeMessage({ op: 'wanted?' }).subarray(0, 6));
        expect(await done).toBe(1);
        expect(read().length).toBe(0);
    });
    it('rejects oversized frames', async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        const read = collect(output);
        const done = runNativeHost(input, output, home, () => NOW);
        const header = Buffer.alloc(4);
        header.writeUInt32LE(10 * 1024 * 1024, 0);
        input.write(header);
        expect(await done).toBe(1);
        expect(decode(read()).ok).toBe(false);
    });
});

describe('wanted?', () => {
    it('is false without a wanted file', async () => {
        expect((await exchange({ op: 'wanted?' })).reply).toEqual({ ok: true, wanted: false });
    });
    it('is true when the wanted file was touched less than 10 minutes ago', async () => {
        const path = join(home, 'wanted');
        await writeFile(path, '');
        await utimes(path, new Date(NOW - 9 * 60 * 1000), new Date(NOW - 9 * 60 * 1000));
        expect((await exchange({ op: 'wanted?' })).reply.wanted).toBe(true);
    });
    it('is false when the wanted file is older than 10 minutes', async () => {
        const path = join(home, 'wanted');
        await writeFile(path, '');
        await utimes(path, new Date(NOW - 11 * 60 * 1000), new Date(NOW - 11 * 60 * 1000));
        expect((await exchange({ op: 'wanted?' })).reply.wanted).toBe(false);
    });
});

describe('write', () => {
    it('writes a 0600 session file in a 0700 dir that session.ts reads as ok', async () => {
        const { code, reply } = await exchange({ op: 'write', uiToken: TOKEN, userId: 'user123', profileId: PROFILE });
        expect(code).toBe(0);
        expect(reply).toEqual({ ok: true });

        const dir = join(home, 'sessions');
        const name = createHash('sha256').update(BRIDGE_EXTENSION_ID + PROFILE).digest('hex').slice(0, 16) + '.json';
        expect(sessionFileName(BRIDGE_EXTENSION_ID, PROFILE)).toBe(name);
        expect(await readdir(dir)).toEqual([name]); // no tmp file left behind
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);

        const file = JSON.parse(await readFile(join(dir, name), 'utf8'));
        expect(file).toEqual({ uiToken: TOKEN, userId: 'user123', receivedAt: '2026-11-08T03:00:00.000Z', producer: 'bridge', profileId: PROFILE });
        expect(await sessionStatus(home, 'user123', NOW + 60_000)).toMatchObject({ state: 'ok', producer: 'bridge', ageMinutes: 1 });
    });
    it('overwrites the same profile file and keeps profiles apart', async () => {
        await exchange({ op: 'write', uiToken: TOKEN, userId: 'user123', profileId: PROFILE });
        await exchange({ op: 'write', uiToken: TOKEN + 'b', userId: 'user123', profileId: PROFILE }, NOW + 60_000);
        await exchange({ op: 'write', uiToken: TOKEN, userId: 'other456', profileId: 'second-profile' });
        expect((await readdir(join(home, 'sessions'))).sort()).toEqual(
            [sessionFileName(BRIDGE_EXTENSION_ID, PROFILE), sessionFileName(BRIDGE_EXTENSION_ID, 'second-profile')].sort(),
        );
        const file = JSON.parse(await readFile(join(home, 'sessions', sessionFileName(BRIDGE_EXTENSION_ID, PROFILE)), 'utf8'));
        expect(file.uiToken).toBe(TOKEN + 'b');
    });

    const bad: Array<[string, Record<string, unknown>]> = [
        ['short token', { uiToken: 'x'.repeat(19), userId: 'user123', profileId: PROFILE }],
        ['long token', { uiToken: 'x'.repeat(201), userId: 'user123', profileId: PROFILE }],
        ['non-string token', { uiToken: 12345678901234567890, userId: 'user123', profileId: PROFILE }],
        ['missing userId', { uiToken: TOKEN, profileId: PROFILE }],
        ['long userId', { uiToken: TOKEN, userId: 'u'.repeat(65), profileId: PROFILE }],
        ['short profileId', { uiToken: TOKEN, userId: 'user123', profileId: 'abc' }],
        ['path in profileId', { uiToken: TOKEN, userId: 'user123', profileId: '../../etc/passwd' }],
        ['uppercase profileId', { uiToken: TOKEN, userId: 'user123', profileId: 'ABCDEFGHIJ' }],
    ];
    it.each(bad)('rejects %s without writing or echoing the token', async (_label, fields) => {
        const { code, reply, raw } = await exchange({ op: 'write', ...fields });
        expect(code).not.toBe(0);
        expect(reply.ok).toBe(false);
        expect(typeof reply.error).toBe('string');
        expect(raw).not.toContain(TOKEN);
        await expect(readdir(join(home, 'sessions'))).rejects.toThrow();
    });
});

describe('other messages', () => {
    it('rejects unknown ops', async () => {
        const { code, reply } = await exchange({ op: 'report', uiToken: TOKEN });
        expect(code).not.toBe(0);
        expect(reply).toEqual({ ok: false, error: 'unknown op: report' });
    });
    it('rejects non-object JSON', async () => {
        expect((await exchange(['op', 'wanted?'])).reply.ok).toBe(false);
    });
});

describe('bridge extension', () => {
    it('manifest key derives to the recorded extension ID', async () => {
        const root = join(import.meta.dirname, '..', 'bridge');
        const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
        const der = createPublicKey({ key: Buffer.from(manifest.key, 'base64'), format: 'der', type: 'spki' }).export({ format: 'der', type: 'spki' });
        const id = createHash('sha256').update(der).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
        expect(id).toBe(BRIDGE_EXTENSION_ID);
        expect((await readFile(join(root, 'EXTENSION_ID'), 'utf8')).trim()).toBe(BRIDGE_EXTENSION_ID);
        expect(manifest.permissions.sort()).toEqual(['alarms', 'nativeMessaging', 'storage']);
        expect(manifest.host_permissions).toEqual(['https://console-backend.apify.com/*']);
    });
    it('service worker never logs or stores the token and sends the personal-context body', async () => {
        const sw = await readFile(join(import.meta.dirname, '..', 'bridge', 'sw.js'), 'utf8');
        expect(sw).toContain("JSON.stringify({ viewedUserId: '', forceAdminToken: false })");
        expect(sw).toContain('sendNativeMessage');
        expect(sw).not.toContain('connectNative(');
        for (const line of sw.split('\n').filter((l) => /console\.|chrome\.storage/.test(l))) {
            expect(line).not.toMatch(/uiToken|body\b/);
        }
    });
});
