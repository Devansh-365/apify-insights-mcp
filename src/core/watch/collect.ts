import type { ApifyApi } from '../../clients/apify-api.js';
import type { ConsoleApi, Marketing } from '../../clients/console.js';
import { buildCatalog, type ActorSummary } from '../actors.js';
import { ToolError } from '../envelope.js';
import { normalizeBreakdown } from '../money.js';
import { statusCounts } from '../run-days.js';
import { DAY_MS } from './constants.js';
import { dayStartMs, isoDayOf, monthEndMs, monthStartMs, slimRow, storeRow } from './facts.js';
import { aggregateOwnerRuns } from './owner-runs.js';
import type { BackfillMonth, ConsoleOutcome, MarketingRow, OwnerRuns, SlimRow, StoreRow, UsersDaily, Values } from './types.js';

// Network reads for the watch, all sequential (parallel Console calls were seen failing with
// "fetch failed"). Public API: actor list, Store stats, the owner's own runs. Console: one breakdown a
// day, the previous month's final rows early in a month, per-actor series for the one-time backfill and
// the Monday tier. Only GETs, through the existing allowlisted clients.

export type Log = (line: string) => void;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One extra try after a plain "fetch failed" (the client already retries socket errors it can classify). */
export async function once<T>(call: () => Promise<T>, waitMs = 2000): Promise<T> {
    try {
        return await call();
    } catch (error) {
        if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
            await sleep(waitMs);
            return call();
        }
        throw error;
    }
}

export function outcomeOf(error: unknown): ConsoleOutcome {
    if (error instanceof ToolError && ['bridge_missing', 'warming_up', 'other_account', 'logged_out', 'endpoint_changed'].includes(error.code)) return error.code as ConsoleOutcome;
    return 'error';
}

export function errorCode(error: unknown): string {
    if (error instanceof ToolError) return error.code;
    if (error instanceof Error) return error.name === 'TypeError' ? 'network' : error.name || 'error';
    return 'error';
}

export interface Catalog {
    actors: ActorSummary[];
    store: StoreRow[];
    ownIds: Set<string>;
}

export async function fetchCatalog(api: ApifyApi, username: string): Promise<Catalog> {
    const mine = await api.myActors();
    const store = await api.storeActors(username);
    const actors = buildCatalog(mine, store);
    return { actors, store: actors.filter((a) => a.isPublic).map(storeRow), ownIds: new Set(mine.map((a) => a.id)) };
}

export async function fetchBreakdown(consoleApi: ConsoleApi, month: string): Promise<SlimRow[]> {
    return normalizeBreakdown((await once(() => consoleApi.actorBreakdown(month))).monetizationPerActor).map(slimRow);
}

export async function fetchOwnerRuns(api: ApifyApi, since: string, ownIds: Set<string>): Promise<OwnerRuns | null> {
    if (!api.myRuns) return null;
    return aggregateOwnerRuns(await api.myRuns(`${since}T00:00:00.000Z`), ownIds);
}

/** Exact daily values for one actor and month, complete UTC days before `todayStart` only. */
export async function fetchActorMonth(consoleApi: ConsoleApi, id: string, month: string, todayStart: number): Promise<{ days: Record<string, Values>; users: Record<string, { paying: number; free: number }> }> {
    const pm = await once(() => consoleApi.profitMargin(month, [id]));
    const rs = await once(() => consoleApi.runStatistics(month, [id]));
    const uc = await once(() => consoleApi.userCounts(month, [id]));
    const days: Record<string, Values> = {};
    const end = Math.min(todayStart, monthEndMs(month));
    for (let t = monthStartMs(month); t < end; t += DAY_MS) {
        const day = isoDayOf(t);
        days[day] = { rev: 0, cost: 0, runs: 0, succeeded: 0, failed: 0, timedOut: 0, aborted: 0, results: 0 };
    }
    for (const [key, stats] of Object.entries(pm.dailyProfitMarginStats)) {
        const v = days[key.slice(0, 10)];
        if (!v) continue;
        v.rev += stats.payingUsersUsd.revenueUsd;
        v.cost += stats.payingUsersUsd.costUsd;
    }
    for (const [key, stat] of Object.entries(rs.dailyStats)) {
        const v = days[key.slice(0, 10)];
        if (!v) continue;
        const c = statusCounts(key.slice(0, 10), stat as Record<string, unknown>);
        v.runs += c.runs;
        v.succeeded += c.succeeded;
        v.failed += c.failed;
        v.timedOut += c.timedOut;
        v.aborted += c.aborted;
        v.results += typeof (stat as { RESULTS?: unknown }).RESULTS === 'number' ? ((stat as { RESULTS: number }).RESULTS) : 0;
    }
    const users: Record<string, { paying: number; free: number }> = {};
    for (const [key, c] of Object.entries(uc)) {
        const day = key.slice(0, 10);
        if (dayStartMs(day) < end && day.startsWith(month)) users[day] = { paying: c.payingUsers, free: c.freeUsers };
    }
    return { days, users };
}

/** Actors worth a day-level backfill: earned or cost $1+ in a month, or 5+ failures with a paying user. */
export function backfillCandidates(monthRows: SlimRow[][], thresholds: { minRevenueUsd: number; minCostUsd: number; minFailures: number }): Map<string, string> {
    const out = new Map<string, string>();
    for (const rows of monthRows) {
        for (const row of rows) {
            if (row.rev >= thresholds.minRevenueUsd || row.cost >= thresholds.minCostUsd || (row.failed + row.timedOut >= thresholds.minFailures && (row.payingUsers ?? 0) >= 1)) out.set(row.id, row.name);
        }
    }
    return out;
}

export interface BackfillResult {
    months: BackfillMonth[];
    users: UsersDaily;
    calls: number;
    failed: Array<{ name: string; month: string; code: string }>;
}

export async function runBackfill(
    consoleApi: ConsoleApi,
    months: string[],
    monthRows: Map<string, { rows: SlimRow[]; fetchedAt: string }>,
    candidates: Map<string, string>,
    now: number,
    log: Log,
): Promise<BackfillResult> {
    const todayStart = dayStartMs(isoDayOf(now));
    const out = new Map<string, BackfillMonth>();
    for (const month of months) {
        const fetched = monthRows.get(month)!;
        const through = isoDayOf(Math.min(todayStart, monthEndMs(month)));
        out.set(month, { version: 1, month, fetchedAt: fetched.fetchedAt, from: `${month}-01`, through, actors: {}, rows: fetched.rows });
    }
    const users: UsersDaily = {};
    const failed: BackfillResult['failed'] = [];
    let calls = 0;
    let done = 0;
    for (const [id, name] of candidates) {
        for (const month of months) {
            try {
                const result = await fetchActorMonth(consoleApi, id, month, todayStart);
                calls += 3;
                out.get(month)!.actors[id] = { name, days: result.days };
                Object.assign((users[id] ??= {}), result.users);
            } catch (error) {
                calls += 1;
                failed.push({ name, month, code: errorCode(error) });
                if (error instanceof ToolError && (error.code === 'logged_out' || error.code === 'warming_up')) throw error;
            }
        }
        done++;
        if (done % 10 === 0 || done === candidates.size) log(`backfill: ${done}/${candidates.size} actors`);
    }
    return { months: [...out.values()], users, calls, failed };
}

/** Daily paying and free users for the given actors, for the current month (and the previous one early in a month). */
export async function fetchUserCounts(consoleApi: ConsoleApi, ids: string[], months: string[]): Promise<{ users: UsersDaily; failed: number }> {
    const users: UsersDaily = {};
    let failed = 0;
    for (const id of ids) {
        for (const month of months) {
            try {
                const uc = await once(() => consoleApi.userCounts(month, [id]));
                for (const [key, c] of Object.entries(uc)) if (key.startsWith(month)) (users[id] ??= {})[key.slice(0, 10)] = { paying: c.payingUsers, free: c.freeUsers };
            } catch {
                failed++;
            }
        }
    }
    return { users, failed };
}

function share(list: Marketing['topCountryCodes'], match: (origin: string) => boolean): number | null {
    if (!list) return null;
    return list.filter((x) => match(x.origin)).reduce((sum, x) => sum + x.trafficPercent, 0) / 100;
}

/** Month to date and last month scaled to the same point (as acquisition_score does). */
export async function fetchMarketing(consoleApi: ConsoleApi, ids: string[], month: string, previous: string, portion: number): Promise<{ rows: Record<string, MarketingRow>; failed: number }> {
    const rows: Record<string, MarketingRow> = {};
    let failed = 0;
    for (const id of ids) {
        try {
            const now = await once(() => consoleApi.marketing(month, [id]));
            const before = portion > 0 ? await once(() => consoleApi.marketing(previous, [id], portion)) : null;
            const cn = share(now.topCountryCodes, (o) => o.toUpperCase() === 'CN');
            const direct = share(now.topReferrers, (o) => !o || /^(direct|\(direct\)|none|null|unknown)$/i.test(o.trim()));
            rows[id] = {
                viewers: now.numUniqueViewingUsers,
                starters: now.numUniqueUsersWithRun,
                previousViewers: before?.numUniqueViewingUsers ?? null,
                previousStarters: before?.numUniqueUsersWithRun ?? null,
                cnNoReferrerShare: cn != null && direct != null ? Math.min(cn, direct) : null,
            };
        } catch {
            failed++;
        }
    }
    return { rows, failed };
}
