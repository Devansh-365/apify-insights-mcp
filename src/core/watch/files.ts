import { appendFile, chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { LOG } from './constants.js';
import type { WatchConfig } from './types.js';

// The watch folder (<home>/watch): 0700 folders, 0600 files, writes via tmp + rename. Nothing here ever
// receives a token; the log still passes every line through a redaction filter (ADR-7) in case an error
// message carries one.

export function watchDir(home: string): string {
    return join(home, 'watch');
}

export const paths = (home: string) => {
    const root = watchDir(home);
    return {
        root,
        snapshots: join(root, 'snapshots'),
        facts: join(root, 'facts'),
        backfill: join(root, 'backfill'),
        users: join(root, 'users'),
        ownerRuns: join(root, 'owner-runs'),
        digests: join(root, 'digests'),
        state: join(root, 'state.json'),
        alerts: join(root, 'alerts.jsonl'),
        config: join(root, 'config.json'),
        log: join(root, 'watch.log'),
        lock: join(root, 'run.lock'),
        snapshot: (day: string) => join(root, 'snapshots', `${day}.json.gz`),
        factsMonth: (month: string) => join(root, 'facts', `${month}.jsonl`),
        backfillMonth: (month: string) => join(root, 'backfill', `${month}.json.gz`),
        usersMonth: (month: string) => join(root, 'users', `${month}.json.gz`),
        ownerMonth: (month: string) => join(root, 'owner-runs', `${month}.json.gz`),
        digest: (day: string) => join(root, 'digests', `${day}.md`),
    };
};

export type WatchPaths = ReturnType<typeof paths>;

export async function ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
}

/** Writes atomically with 0600 permissions, creating 0700 parent folders. */
export async function writeSecure(path: string, data: string | Buffer): Promise<void> {
    await ensureDir(dirname(path));
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
}

export async function appendSecure(path: string, line: string): Promise<void> {
    await ensureDir(dirname(path));
    await appendFile(path, line, { mode: 0o600 });
    await chmod(path, 0o600);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
    await writeSecure(path, `${JSON.stringify(value, null, 1)}\n`);
}

export async function readJson<T>(path: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
        return null;
    }
}

export async function writeGz(path: string, value: unknown): Promise<void> {
    await writeSecure(path, gzipSync(Buffer.from(JSON.stringify(value))));
}

export async function readGz<T>(path: string): Promise<T | null> {
    try {
        return JSON.parse(gunzipSync(await readFile(path)).toString('utf8')) as T;
    } catch {
        return null;
    }
}

export async function listNames(dir: string, pattern: RegExp): Promise<string[]> {
    try {
        return (await readdir(dir)).filter((name) => pattern.test(name)).sort();
    } catch {
        return [];
    }
}

export async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

export async function removeFile(path: string): Promise<void> {
    await rm(path, { force: true });
}

export const DEFAULT_CONFIG: WatchConfig = { ignore: [], rivals: {}, digestCopyPath: null, notifications: true, extraNext: {} };

export async function loadWatchConfig(home: string): Promise<WatchConfig> {
    const raw = await readJson<Partial<WatchConfig>>(paths(home).config);
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
    return {
        ignore: Array.isArray(raw.ignore) ? raw.ignore.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [],
        rivals: raw.rivals && typeof raw.rivals === 'object' ? (raw.rivals as Record<string, string[]>) : {},
        digestCopyPath: typeof raw.digestCopyPath === 'string' && raw.digestCopyPath ? raw.digestCopyPath : null,
        notifications: raw.notifications !== false,
        extraNext: raw.extraNext && typeof raw.extraNext === 'object' ? (raw.extraNext as WatchConfig['extraNext']) : {},
    };
}

/** True when the actor matches an ignore entry (ID, exact name, or a case-insensitive part of the name). */
export function isIgnored(config: WatchConfig, actor: { id: string; name: string }): boolean {
    const name = actor.name.toLowerCase();
    return config.ignore.some((entry) => {
        const e = entry.trim().toLowerCase();
        return e === actor.id.toLowerCase() || name === e || name.includes(e);
    });
}

// ---- Log with redaction ----

const secrets = new Set<string>();

/** Registers a value (e.g. the Console token the client just used) that must never reach the log. Memory only. */
export function registerSecret(value: string | null | undefined): void {
    if (value && value.length >= 8) secrets.add(value);
}

export function redact(line: string): string {
    let out = line.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join('[redacted]');
    return out;
}

export interface WatchLog {
    (line: string): void;
    flush(): Promise<void>;
}

/** Appends timestamped, redacted lines to watch.log (rotated at 1 MB, 2 kept) and echoes them to `echo`. */
export function createLog(home: string, echo: (line: string) => void, now: () => number = Date.now): WatchLog {
    const p = paths(home);
    let chain: Promise<void> = Promise.resolve();
    const log = ((line: string) => {
        const clean = redact(line);
        echo(clean);
        const entry = `${new Date(now()).toISOString()} ${clean}\n`;
        chain = chain.then(async () => {
            try {
                const size = (await stat(p.log).catch(() => null))?.size ?? 0;
                if (size > LOG.maxBytes) {
                    for (let i = LOG.keep - 1; i >= 1; i--) await rename(`${p.log}.${i}`, `${p.log}.${i + 1}`).catch(() => {});
                    await rename(p.log, `${p.log}.1`).catch(() => {});
                    await rm(`${p.log}.${LOG.keep + 1}`, { force: true }).catch(() => {});
                }
                await appendSecure(p.log, entry);
            } catch {
                // A log that cannot be written must never stop the job.
            }
        });
    }) as WatchLog;
    log.flush = () => chain;
    return log;
}
