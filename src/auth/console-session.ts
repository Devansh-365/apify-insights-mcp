import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError } from '../core/envelope.js';
import { progressPing } from '../core/progress.js';
import { readAnySessionToken, sessionStatus, type ConsoleState } from './session.js';

// Demand-driven refresh (auth plan §4): touching `<home>/wanted` tells the bridge extension that a private
// tool is in use; on its next 1-minute alarm it fetches a fresh token. Without recent demand it stays idle.

export async function touchWanted(home: string): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const path = join(home, 'wanted');
    const now = new Date();
    try {
        await utimes(path, now, now);
    } catch {
        await writeFile(path, '', { mode: 0o600 });
    }
}

const FIX: Record<Exclude<ConsoleState, 'ok'>, [string, string]> = {
    bridge_missing: [
        'No Apify Console session is connected, so revenue data is unavailable.',
        'Install the bridge once: run `npx -y github:Devansh-365/apify-insights-mcp install`, load the printed folder in chrome://extensions, and stay logged in to console.apify.com.',
    ],
    warming_up: ['The Apify Console session is being refreshed.', 'Keep Chrome open and logged in to console.apify.com, then retry in a minute.'],
    other_account: [
        'The Console session in Chrome belongs to a different Apify account than the API token.',
        'Log in to console.apify.com with the same account as `apify login`.',
    ],
};

export function consoleError(state: Exclude<ConsoleState, 'ok'>): ToolError {
    const [message, fix] = FIX[state];
    return new ToolError(state, message, fix);
}

export interface ConsoleToken {
    value: string;
    /** When the bridge stored it (ISO), '' if unknown. */
    receivedAt: string;
}

/**
 * The newest token for this account, however old: the Console often still accepts a token older than the
 * 2-hour freshness mark, and rejects a dead one with 401, which `refreshedConsoleToken` then handles.
 * Touches `wanted` every time so the bridge keeps the session fresh while private tools are in use.
 * Fails fast when no bridge has ever written a session or it belongs to another account.
 */
export async function currentConsoleToken(home: string, accountUserId: string, now = Date.now()): Promise<ConsoleToken> {
    await touchWanted(home);
    const status = await sessionStatus(home, accountUserId, now);
    if (status.state === 'bridge_missing' || status.state === 'other_account') throw consoleError(status.state);
    const token = await readAnySessionToken(home, accountUserId);
    if (!token) throw consoleError('bridge_missing');
    return token;
}

function arrived(token: ConsoleToken): number {
    const at = Date.parse(token.receivedAt);
    return Number.isFinite(at) ? at : 0;
}

/**
 * After the Console rejected `rejected`, waits up to `timeoutMs` for the bridge to store a newer token
 * (it refreshes on its 1-minute alarm once `wanted` is touched).
 */
export async function refreshedConsoleToken(
    home: string,
    accountUserId: string,
    rejected: ConsoleToken,
    options: { now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
): Promise<ConsoleToken> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + (options.timeoutMs ?? 65_000);
    for (;;) {
        await touchWanted(home);
        const token = await readAnySessionToken(home, accountUserId);
        if (token && arrived(token) > arrived(rejected)) return token;
        const status = await sessionStatus(home, accountUserId, now());
        if (status.state === 'bridge_missing' || status.state === 'other_account') throw consoleError(status.state);
        if (now() >= deadline) throw consoleError('warming_up');
        progressPing('Waiting for the Apify Console session to refresh');
        await sleep(3000);
    }
}
