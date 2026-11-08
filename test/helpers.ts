import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ActorDetail, ApifyApi, MyActor, StoreActor, StoreSearchItem } from '../src/clients/apify-api.js';
import type { BreakdownRow, ConsoleApi, Marketing, ProfitMargin, QualityBusinessValue, QualityImprovements, QualityScores } from '../src/clients/console.js';
import type { Config } from '../src/config.js';
import { createContext, type ContextOptions } from '../src/context.js';
import { createServer } from '../src/server.js';

// Made-up accounts and numbers. No real account data lives in this repo.
export const ME = { id: 'user123', username: 'acme' };

export function myActor(name: string, extra: Partial<MyActor> = {}): MyActor {
    return { id: `id-${name}`, name, username: ME.username, stats: { totalRuns: 10, lastRunStartedAt: '2026-11-01T00:00:00.000Z' }, ...extra };
}

export function storeActor(name: string, users30d: number, runs: Record<string, number>, extra: Partial<StoreActor> = {}): StoreActor {
    return {
        id: `id-${name}`,
        name,
        title: `${name} title`,
        username: ME.username,
        url: `https://apify.com/${ME.username}/${name}`,
        notice: 'NONE',
        currentPricingInfo: { pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 0.002, unitName: 'result' },
        stats: {
            totalRuns: 1000,
            totalUsers: users30d * 3,
            totalUsers7Days: Math.round(users30d / 3),
            totalUsers30Days: users30d,
            totalUsers90Days: users30d * 2,
            lastRunStartedAt: '2026-11-07T10:00:00.000Z',
            publicActorRunStats30Days: runs,
        },
        ...extra,
    };
}

export function fakeApi(
    mine: MyActor[],
    store: StoreActor[],
    details: Record<string, Partial<ActorDetail>> = {},
    storeSearchData: Map<string, StoreSearchItem[]> = new Map(),
    storeByUsername: Map<string, StoreActor[]> = new Map(),
): ApifyApi & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        async me() {
            calls.push('me');
            return ME;
        },
        async myActors() {
            calls.push('myActors');
            return mine;
        },
        async storeActors(username) {
            calls.push(`store:${username}`);
            return storeByUsername.get(username) ?? store;
        },
        async actor(id) {
            calls.push(`actor:${id}`);
            const base = store.find((item) => item.id === id) ?? mine.find((item) => item.id === id);
            if (!base) throw new Error('not found');
            return { ...base, ...details[id] } as ActorDetail;
        },
        async storeSearch(keyword, limit) {
            calls.push(`storeSearch:${keyword}`);
            return (storeSearchData.get(keyword) ?? []).slice(0, limit);
        },
    };
}

export function testConfig(home: string, actorDirs: string[] = [], usageLog = false): Config {
    return { home, actorDirs, apiBase: 'http://unused', usageLog };
}

export interface FakeActorMonth {
    revenue: number;
    cost: number;
    runs: number;
    failed?: number;
    timedOut?: number;
    results?: number;
    charged?: number;
    paying?: number;
    free?: number;
    pricing?: Record<string, unknown>;
}

const PER_RESULT = { pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 0.002, unitName: 'result' };

export function breakdownRow(name: string, m: FakeActorMonth): BreakdownRow {
    const failed = m.failed ?? 0;
    const timedOut = m.timedOut ?? 0;
    return {
        actor: { _id: `id-${name}`, name, title: `${name} title`, username: ME.username, isPublic: true, notice: 'NONE' },
        runsStats: { TOTAL: m.runs, SUCCEEDED: m.runs - failed - timedOut, FAILED: failed, 'TIMED-OUT': timedOut, ABORTED: 0, RESULTS: m.results ?? m.runs * 100 },
        earningsStats: { totalRevenueUsd: m.revenue, totalCostUsd: m.cost, totalProfitUsd: m.revenue - m.cost },
        usersStats: { payingUsers: m.paying ?? 1, freeUsers: m.free ?? 0 },
        chargedResults: m.charged ?? m.runs * 50,
        currentPricingInfo: m.pricing ?? PER_RESULT,
    };
}

export interface FakeQuality {
    scores: QualityScores;
    improvements: QualityImprovements;
    businessValue: QualityBusinessValue;
}

/** Fixed made-up quality data, the same for every actor unless a test passes its own. */
export const DEFAULT_QUALITY: FakeQuality = {
    scores: { hasInputSchema: 1, hasOutputSchema: 1, hasReadme: 1, actorQuality: 0.8, actorQualityPercentile: 0.9 },
    improvements: { praises: [{ title: 'Has input schema', description: 'Clear input.', percentile: 0.9 }], improvements: [{ id: 'RELIABILITY', title: 'Fix Actor health issues', description: 'Raise the run success rate.' }] },
    businessValue: [],
};

/**
 * A Console backend made of per-actor month figures. Daily money spreads each actor's month evenly over
 * the days that have data (the whole month if it ended, else days 1..today), so day sums equal month
 * totals. Free-plan money is paying money x 1.5.
 */
export function fakeConsole(
    months: Record<string, Record<string, FakeActorMonth>>,
    now = Date.parse('2026-11-08T03:00:00.000Z'),
    marketing: (actorIds?: string[], month?: string, portion?: number) => Marketing = () => ({ numUniqueWebPageViews: 900, numUniqueConsolePageViews: 300, numUniqueUsersWithRun: 120, numUniqueViewingUsers: 600 }),
    quality: (actorId: string) => FakeQuality = () => DEFAULT_QUALITY,
): ConsoleApi & { calls: string[] } {
    const calls: string[] = [];
    const today = new Date(now).toISOString().slice(0, 10);
    const days = (month: string) => {
        const [y, m] = month.split('-').map(Number) as [number, number];
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const count = today.startsWith(month) ? Number(today.slice(8)) : last;
        return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
    };
    const side = (revenue: number, cost: number) => ({ revenueUsd: revenue, costUsd: cost, profitUsd: revenue - cost, margin: revenue ? (revenue - cost) / revenue : 0 });
    const both = (revenue: number, cost: number) => ({ payingUsersUsd: side(revenue, cost), allUsersUsd: side(revenue * 1.5, cost * 1.5) });
    return {
        calls,
        async profitMargin(month, actorIds) {
            calls.push(`profitMargin:${month}:${actorIds?.join(',') ?? '*'}`);
            const rows = Object.entries(months[month] ?? {}).filter(([name]) => !actorIds || actorIds.includes(`id-${name}`));
            const revenue = rows.reduce((sum, [, m]) => sum + m.revenue, 0);
            const cost = rows.reduce((sum, [, m]) => sum + m.cost, 0);
            const list = days(month);
            const daily: ProfitMargin['dailyProfitMarginStats'] = {};
            for (const day of list) daily[day] = both(revenue / list.length, cost / list.length);
            return { totalProfitMarginStats: both(revenue, cost), dailyProfitMarginStats: daily };
        },
        async actorBreakdown(month) {
            calls.push(`breakdown:${month}`);
            return { monetizationPerActor: Object.entries(months[month] ?? {}).map(([name, m]) => breakdownRow(name, m)) };
        },
        async runStatistics() {
            return { dailyStats: {} };
        },
        async userCounts() {
            return {};
        },
        async marketing(month, actorIds, portion) {
            calls.push(`marketing:${month}:${actorIds?.join(',') ?? '*'}`);
            return marketing(actorIds, month, portion);
        },
        async qualityScores(actorId) {
            calls.push(`qualityScores:${actorId}`);
            return quality(actorId).scores;
        },
        async qualityImprovements(actorId) {
            calls.push(`qualityImprovements:${actorId}`);
            return quality(actorId).improvements;
        },
        async qualityBusinessValue(actorId) {
            calls.push(`qualityBusinessValue:${actorId}`);
            return quality(actorId).businessValue;
        },
    };
}

export async function connect(api: ApifyApi | null, config: Config, now = () => Date.parse('2026-11-08T03:00:00.000Z'), options: ContextOptions = {}) {
    const ctx = createContext(config, api, api ? 'env' : null, now, options);
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, ctx };
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return { result, data: result.structuredContent as Record<string, any>, text: (result.content as Array<{ text: string }>)[0]!.text };
}
