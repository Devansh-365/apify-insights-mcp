import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError } from '../core/envelope.js';
import { readSessionToken, sessionStatus, type ConsoleState } from './session.js';

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

/**
 * Returns a usable UI token, waiting up to `timeoutMs` for the bridge to deliver a fresh one after the
 * demand signal. Fails fast when no bridge has ever written a session.
 */
export async function waitForConsoleToken(
    home: string,
    accountUserId: string,
    options: { now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
): Promise<string> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + (options.timeoutMs ?? 65_000);
    await touchWanted(home);
    for (;;) {
        const token = await readSessionToken(home, accountUserId, now());
        if (token) return token;
        const status = await sessionStatus(home, accountUserId, now());
        if (status.state === 'bridge_missing' || status.state === 'other_account') throw consoleError(status.state);
        if (now() >= deadline) throw consoleError('warming_up');
        await sleep(3000);
    }
}
