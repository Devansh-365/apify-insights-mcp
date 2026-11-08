import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Session files are written by the bridge extension's native host or by `apify-insights-mcp login`
// (contract: actorstack .omc/plans/apify-insights-mcp.md §4). This module only reports their state;
// the token itself never leaves `readSessionToken`, and nothing here logs it.

export type ConsoleState = 'ok' | 'bridge_missing' | 'warming_up' | 'other_account';

export interface SessionStatus {
    state: ConsoleState;
    producer: string | null;
    receivedAt: string | null;
    ageMinutes: number | null;
}

interface SessionFile {
    uiToken?: unknown;
    userId?: unknown;
    receivedAt?: unknown;
    producer?: unknown;
}

// Phase 0 measured a UI token still valid after 3 hours; treat anything older than 2 hours as stale.
const FRESH_FOR_MS = 2 * 60 * 60 * 1000;

async function newestSession(home: string): Promise<SessionFile | null> {
    const dir = join(home, 'sessions');
    let names: string[];
    try {
        names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch {
        return null;
    }
    let newest: { file: SessionFile; mtime: number } | null = null;
    for (const name of names) {
        try {
            const path = join(dir, name);
            const [info, raw] = await Promise.all([stat(path), readFile(path, 'utf8')]);
            const file = JSON.parse(raw) as SessionFile;
            if (typeof file.uiToken !== 'string' || !file.uiToken) continue;
            if (!newest || info.mtimeMs > newest.mtime) newest = { file, mtime: info.mtimeMs };
        } catch {
            // A half-written or foreign file; the producers write via tmp + rename, so skip it.
        }
    }
    return newest?.file ?? null;
}

export async function sessionStatus(home: string, accountUserId: string | null, now = Date.now()): Promise<SessionStatus> {
    const file = await newestSession(home);
    if (!file) return { state: 'bridge_missing', producer: null, receivedAt: null, ageMinutes: null };
    const receivedAt = typeof file.receivedAt === 'string' ? file.receivedAt : null;
    const received = receivedAt ? Date.parse(receivedAt) : NaN;
    const ageMinutes = Number.isFinite(received) ? Math.max(0, Math.round((now - received) / 60000)) : null;
    const producer = typeof file.producer === 'string' ? file.producer : null;
    let state: ConsoleState = 'ok';
    if (accountUserId && typeof file.userId === 'string' && file.userId !== accountUserId) state = 'other_account';
    else if (!Number.isFinite(received) || now - received > FRESH_FOR_MS) state = 'warming_up';
    return { state, producer, receivedAt, ageMinutes };
}

/** For the Console client (M3). Returns the token only when the session is fresh and belongs to this account. */
export async function readSessionToken(home: string, accountUserId: string, now = Date.now()): Promise<string | null> {
    const status = await sessionStatus(home, accountUserId, now);
    if (status.state !== 'ok') return null;
    const file = await newestSession(home);
    return typeof file?.uiToken === 'string' ? file.uiToken : null;
}
