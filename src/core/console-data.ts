import type { ConsoleApi, Marketing, ProfitMargin } from '../clients/console.js';
import type { Context } from '../context.js';
import { monthTtl, normalizeBreakdown, type ActorMoney } from './money.js';

// Cached Console reads. Finished months stay cached for an hour; the current month (and one that ended
// in the last 3 days, when late usage still lands) for 5 minutes.

export function breakdown(ctx: Context, api: ConsoleApi, month: string): Promise<ActorMoney[]> {
    return ctx.cache.get(`breakdown:${month}`, monthTtl(month, ctx.now()), async () => normalizeBreakdown((await api.actorBreakdown(month)).monetizationPerActor));
}

export function profitMargin(ctx: Context, api: ConsoleApi, month: string, actorIds?: string[]): Promise<ProfitMargin> {
    const key = `pm:${month}:${actorIds?.join(',') ?? '*'}`;
    return ctx.cache.get(key, monthTtl(month, ctx.now()), () => api.profitMargin(month, actorIds));
}

export async function profitMargins(ctx: Context, api: ConsoleApi, months: string[], actorIds?: string[]): Promise<Map<string, ProfitMargin>> {
    const entries = await Promise.all(months.map(async (month) => [month, await profitMargin(ctx, api, month, actorIds)] as const));
    return new Map(entries);
}

export function marketing(ctx: Context, api: ConsoleApi, month: string, actorIds: string[] | undefined, portion?: number): Promise<Marketing> {
    const key = `mk:${month}:${actorIds?.join(',') ?? '*'}`;
    return ctx.cache.get(key, monthTtl(month, ctx.now()), () => api.marketing(month, actorIds, portion));
}
