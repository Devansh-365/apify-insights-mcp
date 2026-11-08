import { AsyncLocalStorage } from 'node:async_hooks';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Finished months' money on disk, so a new client session does not refetch a past month the Console takes
// 3-8 s to compute. Only months that ended more than 3 days ago are stored, and an entry is used for 24 h
// at most: a probe showed a month that ended weeks ago can still move by cents. Files hold normalized
// numbers only (never a token), live under <home>/cache/v1/<account id>/ with 0700/0600 permissions, and
// deleting the folder is always safe (`apify-insights-mcp cache clear`).

export const DISK_TTL_MS = 24 * 60 * 60 * 1000;
const KEEP_PER_KIND = 24;
const VERSION = 1;

export interface DiskEntry<T> {
    fetchedAt: number;
    value: T;
}

export interface DiskCache {
    read<T>(kind: string, month: string): Promise<DiskEntry<T> | null>;
    write(kind: string, month: string, value: unknown): Promise<void>;
}

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const MONTH = /^\d{4}-\d{2}$/;

export function cacheRoot(home: string): string {
    return join(home, 'cache');
}

export function createDiskCache(home: string, accountId: string, now: () => number = Date.now): DiskCache | null {
    if (!SAFE.test(accountId)) return null;
    const dir = join(cacheRoot(home), `v${VERSION}`, accountId);
    const file = (kind: string, month: string) => {
        if (!SAFE.test(kind) || !MONTH.test(month)) throw new Error(`bad cache key ${kind}-${month}`);
        return join(dir, `${kind}-${month}.json`);
    };
    return {
        async read<T>(kind: string, month: string): Promise<DiskEntry<T> | null> {
            try {
                const parsed = JSON.parse(await readFile(file(kind, month), 'utf8')) as { version?: number; fetchedAt?: string; month?: string; value?: T };
                const fetchedAt = Date.parse(parsed.fetchedAt ?? '');
                if (parsed.version !== VERSION || parsed.month !== month || !Number.isFinite(fetchedAt) || parsed.value === undefined) return null;
                return { fetchedAt, value: parsed.value };
            } catch {
                return null;
            }
        },
        async write(kind: string, month: string, value: unknown): Promise<void> {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await chmod(dir, 0o700);
            const target = file(kind, month);
            const tmp = `${target}.${process.pid}.tmp`;
            await writeFile(tmp, JSON.stringify({ version: VERSION, fetchedAt: new Date(now()).toISOString(), month, value }), { mode: 0o600 });
            await rename(tmp, target);
            // Keep the newest months of this kind only.
            const months = (await readdir(dir))
                .map((name) => new RegExp(`^${kind}-(\\d{4}-\\d{2})\\.json$`).exec(name)?.[1])
                .filter((m): m is string => !!m)
                .sort()
                .reverse();
            await Promise.all(months.slice(KEEP_PER_KIND).map((m) => rm(file(kind, m), { force: true })));
        },
    };
}

/** Removes every cached file for every account. Returns whether anything was there. */
export async function clearDiskCache(home: string): Promise<boolean> {
    const root = cacheRoot(home);
    try {
        await readdir(root);
    } catch {
        return false;
    }
    await rm(root, { recursive: true, force: true });
    return true;
}

// Which disk entries a tool call used, so the answer can say how old they are (Principle: honest freshness).
const used = new AsyncLocalStorage<Map<string, number>>();

export function withDiskUse<T>(run: () => Promise<T>): Promise<{ result: T; used: Map<string, number> }> {
    const map = new Map<string, number>();
    return used.run(map, async () => ({ result: await run(), used: map }));
}

export function recordDiskUse(month: string, fetchedAt: number): void {
    const map = used.getStore();
    if (map) map.set(month, Math.min(map.get(month) ?? Infinity, fetchedAt));
}

export function diskNote(usedMonths: Map<string, number>): string | null {
    if (!usedMonths.size) return null;
    const oldest = Math.min(...usedMonths.values());
    const months = [...usedMonths.keys()].sort().join(', ');
    return `Money for ${months} came from the local cache (fetched ${new Date(oldest).toISOString().slice(0, 16).replace('T', ' ')} UTC); finished months change by cents at most.`;
}
