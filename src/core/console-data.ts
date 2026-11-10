import type { ConsoleApi, Marketing, ProfitMargin, QualityBusinessValue, QualityImprovements, QualityScores, RunStatistics, SharedRuns } from '../clients/console.js';
import type { Context } from '../context.js';
import { ToolError } from './envelope.js';
import { DISK_TTL_MS, recordDiskUse } from './disk-cache.js';
import { isSettledMonth, monthTtl, normalizeBreakdown, type ActorMoney } from './money.js';
import { addMonths, isoDay, monthOf } from './period.js';

// Cached Console reads. Finished months stay cached for an hour; the current month (and one that ended
// in the last 3 days, when late usage still lands) for 5 minutes.

// Where a cached value came from disk: kept per context so a later tool call that gets the same value
// from memory can still say how old it is.
const diskOrigins = new WeakMap<Context, Map<string, { month: string; fetchedAt: number }>>();

function origins(ctx: Context): Map<string, { month: string; fetchedAt: number }> {
    let map = diskOrigins.get(ctx);
    if (!map) diskOrigins.set(ctx, (map = new Map()));
    return map;
}

/**
 * Memory first, then (for settled months only) a disk entry younger than 24 h, then the Console. Fresh
 * Console values for settled months are written back to disk.
 */
async function settled<T>(ctx: Context, key: string, kind: string, month: string, load: () => Promise<T>): Promise<T> {
    const value = await ctx.cache.get(key, monthTtl(month, ctx.now()), async () => {
        if (!isSettledMonth(month, ctx.now())) return load();
        const disk = await ctx.disk();
        if (!disk) return load();
        const hit = await disk.read<T>(kind, month);
        if (hit && ctx.now() - hit.fetchedAt < DISK_TTL_MS) {
            origins(ctx).set(key, { month, fetchedAt: hit.fetchedAt });
            return hit.value;
        }
        const fresh = await load();
        origins(ctx).delete(key);
        // A cache that cannot be written must never fail the tool.
        await disk.write(kind, month, fresh).catch(() => {});
        return fresh;
    });
    const origin = origins(ctx).get(key);
    if (origin) recordDiskUse(origin.month, origin.fetchedAt);
    return value;
}

async function freshOnDisk(ctx: Context, kind: string, month: string): Promise<boolean> {
    if (!isSettledMonth(month, ctx.now())) return false;
    const hit = await (await ctx.disk())?.read(kind, month);
    return !!hit && ctx.now() - hit.fetchedAt < DISK_TTL_MS;
}

export function breakdown(ctx: Context, api: ConsoleApi, month: string): Promise<ActorMoney[]> {
    return settled(ctx, `breakdown:${month}`, 'breakdown', month, async () => normalizeBreakdown((await api.actorBreakdown(month)).monetizationPerActor));
}

/**
 * Breakdown rows for a few named actors. Reuses the full month when it is cached or already loading
 * (same key as `breakdown`, so it joins that request); otherwise asks the Console for just these actors
 * (~11 KB instead of ~770 KB). Only for callers that read these actors' rows and nothing portfolio-wide.
 */
export async function breakdownFor(ctx: Context, api: ConsoleApi, month: string, actorIds: string[]): Promise<ActorMoney[]> {
    const wanted = new Set(actorIds);
    if (ctx.cache.has(`breakdown:${month}`) || (await freshOnDisk(ctx, 'breakdown', month))) return (await breakdown(ctx, api, month)).filter((row) => wanted.has(row.id));
    const ids = [...wanted].sort();
    const key = `breakdownFor:${month}:${ids.join(',')}`;
    try {
        return await ctx.cache.get(key, monthTtl(month, ctx.now()), async () => normalizeBreakdown((await api.actorBreakdown(month, ids)).monetizationPerActor));
    } catch (error) {
        // The filter is unofficial: if its response stops matching, fall back to the full month.
        if (error instanceof ToolError && error.code === 'endpoint_changed') return (await breakdown(ctx, api, month)).filter((row) => wanted.has(row.id));
        throw error;
    }
}

export function profitMargin(ctx: Context, api: ConsoleApi, month: string, actorIds?: string[]): Promise<ProfitMargin> {
    const key = `pm:${month}:${actorIds?.join(',') ?? '*'}`;
    // Only the account-wide totals go to disk; per-actor ranges stay in memory.
    if (!actorIds) return settled(ctx, key, 'pm', month, () => api.profitMargin(month));
    return ctx.cache.get(key, monthTtl(month, ctx.now()), () => api.profitMargin(month, actorIds));
}

/**
 * Loads this month's and last month's money in the background after the first money tool of a session,
 * through the same cache keys, so the next money question finds it ready.
 */
export async function prefetchMoney(ctx: Context, api: ConsoleApi): Promise<void> {
    const current = monthOf(isoDay(ctx.now()));
    const previous = addMonths(current, -1);
    await Promise.allSettled([breakdown(ctx, api, current), breakdown(ctx, api, previous), profitMargins(ctx, api, [current, previous])]);
}

export async function profitMargins(ctx: Context, api: ConsoleApi, months: string[], actorIds?: string[]): Promise<Map<string, ProfitMargin>> {
    const entries = await Promise.all(months.map(async (month) => [month, await profitMargin(ctx, api, month, actorIds)] as const));
    return new Map(entries);
}

export function marketing(ctx: Context, api: ConsoleApi, month: string, actorIds: string[] | undefined, portion?: number): Promise<Marketing> {
    // The portion is part of the key: last month "up to today's point" and last month in full differ.
    const key = `mk:${month}:${actorIds?.join(',') ?? '*'}:${portion ?? 'all'}`;
    return ctx.cache.get(key, monthTtl(month, ctx.now()), () => api.marketing(month, actorIds, portion));
}

/**
 * Runs per day by status. Account-wide finished months go through the disk cache like money (counts
 * only). Per-actor months stay in memory: one small call each, and nothing per actor goes to disk.
 */
export function runStatistics(ctx: Context, api: ConsoleApi, month: string, actorId?: string): Promise<RunStatistics> {
    if (!actorId) return settled(ctx, `runs:${month}`, 'runs', month, () => api.runStatistics(month));
    return ctx.cache.get(`runs:${month}:${actorId}`, monthTtl(month, ctx.now()), () => api.runStatistics(month, [actorId]));
}

// Shared runs can appear at any time; a fix should show within a session.
const SHARED_RUNS_TTL = 5 * 60_000;

export function sharedRuns(ctx: Context, api: ConsoleApi, actorId: string, limit: number): Promise<SharedRuns> {
    return ctx.cache.get(`shared:${actorId}:${limit}`, SHARED_RUNS_TTL, () => api.sharedRuns([actorId], { limit }));
}

// Quality scores change at most daily, but a fix should show within a session.
const QUALITY_TTL = 5 * 60_000;

export function qualityScores(ctx: Context, api: ConsoleApi, actorId: string): Promise<QualityScores> {
    return ctx.cache.get(`qs:${actorId}`, QUALITY_TTL, () => api.qualityScores(actorId));
}

export function qualityImprovements(ctx: Context, api: ConsoleApi, actorId: string): Promise<QualityImprovements> {
    return ctx.cache.get(`qi:${actorId}`, QUALITY_TTL, () => api.qualityImprovements(actorId));
}

export function qualityBusinessValue(ctx: Context, api: ConsoleApi, actorId: string): Promise<QualityBusinessValue> {
    return ctx.cache.get(`qbv:${actorId}`, QUALITY_TTL, () => api.qualityBusinessValue(actorId));
}
