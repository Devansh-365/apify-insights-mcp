import { readFile } from 'node:fs/promises';
import { DAY_MS, DIGEST, RETENTION } from './constants.js';
import type { WatchData } from './engine.js';
import { listNames, paths, readGz, removeFile, writeGz, writeSecure } from './files.js';
import type { BackfillMonth, Fact, OwnerRuns, Snapshot, UsersDaily } from './types.js';

// Reading and writing the watch folder's data files. Months are YYYY-MM, days YYYY-MM-DD (UTC).

const SNAPSHOT_FILE = /^(\d{4}-\d{2}-\d{2})\.json\.gz$/;
const MONTH_FILE = /^(\d{4}-\d{2})\.json\.gz$/;

export async function loadSnapshots(home: string, fromDay = '0000-00-00'): Promise<Snapshot[]> {
    const p = paths(home);
    const out: Snapshot[] = [];
    for (const name of await listNames(p.snapshots, SNAPSHOT_FILE)) {
        const day = SNAPSHOT_FILE.exec(name)![1]!;
        if (day < fromDay) continue;
        const snap = await readGz<Snapshot>(p.snapshot(day));
        if (snap?.version === 1) out.push(snap);
    }
    return out;
}

export async function latestSnapshot(home: string, predicate: (s: Snapshot) => boolean = () => true): Promise<Snapshot | null> {
    const p = paths(home);
    const names = (await listNames(p.snapshots, SNAPSHOT_FILE)).reverse();
    for (const name of names) {
        const snap = await readGz<Snapshot>(p.snapshot(SNAPSHOT_FILE.exec(name)![1]!));
        if (snap?.version === 1 && predicate(snap)) return snap;
    }
    return null;
}

export async function loadBackfill(home: string): Promise<BackfillMonth[]> {
    const p = paths(home);
    const out: BackfillMonth[] = [];
    for (const name of await listNames(p.backfill, MONTH_FILE)) {
        const b = await readGz<BackfillMonth>(p.backfillMonth(MONTH_FILE.exec(name)![1]!));
        if (b?.version === 1) out.push(b);
    }
    return out;
}

async function loadMonthly<T extends Record<string, Record<string, unknown>>>(dir: string, file: (month: string) => string): Promise<T> {
    const merged = {} as Record<string, Record<string, unknown>>;
    for (const name of await listNames(dir, MONTH_FILE)) {
        const data = await readGz<{ byActor?: T }>(file(MONTH_FILE.exec(name)![1]!));
        for (const [id, days] of Object.entries(data?.byActor ?? {})) Object.assign((merged[id] ??= {}), days);
    }
    return merged as T;
}

export const loadUsers = (home: string) => loadMonthly<UsersDaily>(paths(home).users, paths(home).usersMonth);
export const loadOwnerRuns = (home: string) => loadMonthly<OwnerRuns>(paths(home).ownerRuns, paths(home).ownerMonth);

export async function loadData(home: string, fromDay?: string): Promise<WatchData> {
    const [snapshots, backfill, users, owner] = await Promise.all([loadSnapshots(home, fromDay), loadBackfill(home), loadUsers(home), loadOwnerRuns(home)]);
    return { snapshots, backfill, users, owner };
}

/** Merges daily values into per-month files; days in `replaceFrom..` of the given actors are replaced. */
async function saveMonthly<V>(dir: string, file: (month: string) => string, byActor: Record<string, Record<string, V>>, replaceFrom: string | null, actorScope: 'given' | 'all'): Promise<void> {
    const months = new Map<string, Record<string, Record<string, V>>>();
    for (const [id, days] of Object.entries(byActor)) {
        for (const [day, value] of Object.entries(days)) {
            const month = day.slice(0, 7);
            let m = months.get(month);
            if (!m) months.set(month, (m = {}));
            (m[id] ??= {})[day] = value;
        }
    }
    if (replaceFrom) {
        // Existing months from replaceFrom on are rewritten even without new days, to clear stale ones.
        for (const name of await listNames(dir, MONTH_FILE)) {
            const month = MONTH_FILE.exec(name)![1]!;
            if (month >= replaceFrom.slice(0, 7) && !months.has(month)) months.set(month, {});
        }
    }
    for (const [month, fresh] of months) {
        const existing = (await readGz<{ byActor?: Record<string, Record<string, V>> }>(file(month)))?.byActor ?? {};
        for (const [id, days] of Object.entries(existing)) {
            const keep = actorScope === 'all' || id in byActor;
            for (const day of Object.keys(days)) if (replaceFrom && day >= replaceFrom && keep) delete days[day];
        }
        for (const [id, days] of Object.entries(fresh)) Object.assign((existing[id] ??= {}), days);
        await writeGz(file(month), { version: 1, month, byActor: existing });
    }
}

export function saveUsers(home: string, byActor: UsersDaily, replaceFrom: string | null = null): Promise<void> {
    return saveMonthly(paths(home).users, paths(home).usersMonth, byActor, replaceFrom, 'given');
}

/** The owner's runs from `sinceDay` on are replaced for every actor (the run list is complete for that range). */
export function saveOwnerRuns(home: string, byActor: OwnerRuns, sinceDay: string): Promise<void> {
    return saveMonthly(paths(home).ownerRuns, paths(home).ownerMonth, byActor, sinceDay, 'all');
}

export async function saveBackfill(home: string, month: BackfillMonth): Promise<void> {
    await writeGz(paths(home).backfillMonth(month.month), month);
}

export async function saveSnapshot(home: string, snapshot: Snapshot): Promise<void> {
    await writeGz(paths(home).snapshot(snapshot.day), snapshot);
}

export async function writeFacts(home: string, facts: Map<string, Fact[]>): Promise<void> {
    for (const [month, list] of facts) await writeSecure(paths(home).factsMonth(month), list.map((f) => JSON.stringify(f)).join('\n') + (list.length ? '\n' : ''));
}

export async function readFacts(home: string, month: string): Promise<Fact[]> {
    try {
        const raw = await readFile(paths(home).factsMonth(month), 'utf8');
        return raw
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Fact);
    } catch {
        return [];
    }
}

/** Drops snapshots older than 400 days and digests older than 180 days. */
export async function cleanup(home: string, now: number): Promise<void> {
    const p = paths(home);
    const cut = (days: number) => new Date(now - days * DAY_MS).toISOString().slice(0, 10);
    for (const name of await listNames(p.snapshots, SNAPSHOT_FILE)) if (SNAPSHOT_FILE.exec(name)![1]! < cut(RETENTION.snapshotDays)) await removeFile(`${p.snapshots}/${name}`);
    for (const name of await listNames(p.digests, /^\d{4}-\d{2}-\d{2}\.md$/)) if (name.slice(0, 10) < cut(DIGEST.keepDays)) await removeFile(`${p.digests}/${name}`);
}
