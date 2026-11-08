import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

// Native messaging host for the Apify Insights Bridge extension (design: actorstack
// .omc/plans/apify-insights-mcp.md §4). Chrome starts it once per message, it answers one
// message and exits. The token passes through `write` straight into a 0600 file; nothing in
// this module logs it or echoes it back.

export const NATIVE_HOST_NAME = 'com.apify_insights.bridge';
/** Derived from the fixed `key` in bridge/manifest.json; a test keeps the two in step. */
export const BRIDGE_EXTENSION_ID = 'anbbmeclegmfflfnjlcegimmjeepkaoe';

// The MCP touches <home>/wanted when a private tool runs; the bridge refreshes only within this window.
export const WANTED_FOR_MS = 10 * 60 * 1000;
// Our two messages are tiny; anything bigger is not from the bridge.
const MAX_MESSAGE_BYTES = 64 * 1024;
const PROFILE_ID = /^[a-z0-9-]{8,64}$/;

/** Chrome's framing: 4-byte little-endian length, then that many bytes of UTF-8 JSON. */
export function encodeMessage(message: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    return Buffer.concat([header, body]);
}

/** Reads exactly one framed message. Resolves null when the stream ends before a full message. */
export function readMessage(input: Readable): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        const finish = (error: Error | null, value: Buffer | null) => {
            input.off('data', onData);
            input.off('end', onEnd);
            input.off('error', onError);
            // Stop reading: Chrome may keep stdin open, and the rest is not ours to consume.
            input.pause();
            if (error) reject(error);
            else resolve(value);
        };
        const onData = (chunk: Buffer | string) => {
            buffered = Buffer.concat([buffered, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
            if (buffered.length < 4) return;
            const length = buffered.readUInt32LE(0);
            if (length > MAX_MESSAGE_BYTES) return finish(new Error('message too large'), null);
            if (buffered.length >= 4 + length) finish(null, buffered.subarray(4, 4 + length));
        };
        const onEnd = () => finish(null, null);
        const onError = (error: Error) => finish(error, null);
        input.on('data', onData);
        input.on('end', onEnd);
        input.on('error', onError);
        input.resume();
    });
}

function writeMessage(output: Writable, message: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        output.write(encodeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
}

/** First 16 hex of sha256(extension id + profile id): stable per Chrome profile, reveals neither. */
export function sessionFileName(extensionId: string, profileId: string): string {
    return `${createHash('sha256').update(extensionId + profileId).digest('hex').slice(0, 16)}.json`;
}

export async function isWanted(home: string, now: number): Promise<boolean> {
    try {
        const info = await stat(join(home, 'wanted'));
        return now - info.mtimeMs < WANTED_FOR_MS;
    } catch {
        return false;
    }
}

interface WriteInput {
    uiToken: string;
    userId: string;
    profileId: string;
}

// Error strings name the field only, never its value, so a bad token is not echoed back.
function validateWrite(message: Record<string, unknown>): WriteInput | string {
    const { uiToken, userId, profileId } = message;
    if (typeof uiToken !== 'string' || uiToken.length < 20 || uiToken.length > 200) return 'invalid uiToken';
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 64) return 'invalid userId';
    if (typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) return 'invalid profileId';
    return { uiToken, userId, profileId };
}

async function writeSession(home: string, fileName: string, input: WriteInput, now: number): Promise<void> {
    const dir = join(home, 'sessions');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask and ignored for an existing dir, so set it explicitly.
    await chmod(dir, 0o700);
    const file = { uiToken: input.uiToken, userId: input.userId, receivedAt: new Date(now).toISOString(), producer: 'bridge', profileId: input.profileId };
    // tmp + rename in the same dir so the MCP never reads a half-written file. The `.tmp` suffix
    // keeps session.ts (which reads only `*.json`) away from it.
    const tmp = join(dir, `${fileName}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
        const handle = await open(tmp, 'wx', 0o600);
        try {
            await handle.writeFile(JSON.stringify(file), 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await chmod(tmp, 0o600);
        await rename(tmp, join(dir, fileName));
    } catch (error) {
        await rm(tmp, { force: true });
        throw error;
    }
}

/**
 * Answers one bridge message on `input`/`output` and resolves with the process exit code
 * (0 = handled, non-zero = refused or failed; Chrome reports the latter to the extension).
 */
export async function runNativeHost(
    input: Readable,
    output: Writable,
    home: string,
    now: () => number = Date.now,
    extensionId: string = BRIDGE_EXTENSION_ID,
): Promise<number> {
    let raw: Buffer | null;
    try {
        raw = await readMessage(input);
    } catch {
        await writeMessage(output, { ok: false, error: 'unreadable message' });
        return 1;
    }
    if (!raw) return 1;

    let message: unknown;
    try {
        message = JSON.parse(raw.toString('utf8'));
    } catch {
        await writeMessage(output, { ok: false, error: 'message is not JSON' });
        return 1;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        await writeMessage(output, { ok: false, error: 'message is not an object' });
        return 1;
    }
    const record = message as Record<string, unknown>;

    if (record.op === 'wanted?') {
        await writeMessage(output, { ok: true, wanted: await isWanted(home, now()) });
        return 0;
    }
    if (record.op === 'write') {
        const valid = validateWrite(record);
        if (typeof valid === 'string') {
            await writeMessage(output, { ok: false, error: valid });
            return 2;
        }
        try {
            await writeSession(home, sessionFileName(extensionId, valid.profileId), valid, now());
        } catch (error) {
            // A filesystem error code (EACCES, ENOSPC...) is enough to diagnose and carries no token.
            const code = (error as NodeJS.ErrnoException)?.code ?? 'unknown';
            await writeMessage(output, { ok: false, error: `write failed: ${code}` });
            return 3;
        }
        await writeMessage(output, { ok: true });
        return 0;
    }
    const op = typeof record.op === 'string' ? record.op.slice(0, 40) : typeof record.op;
    await writeMessage(output, { ok: false, error: `unknown op: ${op}` });
    return 2;
}
