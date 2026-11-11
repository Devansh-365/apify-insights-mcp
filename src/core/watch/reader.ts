import { readFile } from 'node:fs/promises';
import { HOUR_MS } from './constants.js';
import { paths, readJson } from './files.js';
import type { Alert, WatchState } from './types.js';

// Read-only view of the watch's local files for the MCP side (`decline_watch`, the `daily_brief` line).
// It never writes and never touches the network.

export interface WatchSummary {
    state: WatchState | null;
    pages: Alert[];
    watches: Alert[];
    digestPath: string | null;
    digest: string | null;
}

export async function readWatchSummary(home: string): Promise<WatchSummary> {
    const state = await readJson<WatchState>(paths(home).state);
    if (!state || state.version !== 1) return { state: null, pages: [], watches: [], digestPath: null, digest: null };
    const open = Object.values(state.open);
    const byStake = (a: Alert, b: Alert) => b.atStakeUsd - a.atStakeUsd || a.name.localeCompare(b.name);
    const digestPath = state.lastRun?.digest ?? null;
    let digest: string | null = null;
    if (digestPath) digest = await readFile(digestPath, 'utf8').catch(() => null);
    return { state, pages: open.filter((a) => a.tier === 'PAGE').sort(byStake), watches: open.filter((a) => a.tier === 'WATCH').sort(byStake), digestPath, digest };
}

/** The one line `daily_brief` adds when the watch is switched on. */
export function briefLine(summary: WatchSummary, now: number): string {
    if (!summary.state?.lastRun) return 'Early warning (experimental): not run yet. Run `apify-insights-mcp watch run --experimental`, or install it with `watch install`.';
    const pages = summary.pages.filter((a) => !a.backlog);
    const oldest = pages.map((a) => a.firstSeen).sort()[0];
    const age = Math.round((now - Date.parse(summary.state.lastRun.at)) / HOUR_MS);
    const stale = age >= 30 ? ` Last run ${age} h ago.` : '';
    const actors = new Set(pages.map((a) => a.actorId)).size;
    const backlog = new Set(summary.pages.filter((a) => a.backlog).map((a) => a.actorId)).size;
    const watching = new Set(summary.watches.map((a) => a.actorId)).size;
    const head = actors ? `${actors} actor${actors === 1 ? '' : 's'} with open PAGE alerts, oldest since ${oldest!.slice(0, 10)}` : 'no open PAGE alerts';
    return `Early warning (experimental): ${head}${backlog ? ` (+${backlog} from the install backlog)` : ''}; ${watching} on WATCH. Details: decline_watch.${stale}`;
}
