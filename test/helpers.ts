import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ActorDetail, ApifyApi, MyActor, StoreActor } from '../src/clients/apifyApi.js';
import type { Config } from '../src/config.js';
import { createContext } from '../src/context.js';
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

export function fakeApi(mine: MyActor[], store: StoreActor[], details: Record<string, Partial<ActorDetail>> = {}): ApifyApi & { calls: string[] } {
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
            return store;
        },
        async actor(id) {
            calls.push(`actor:${id}`);
            const base = store.find((item) => item.id === id) ?? mine.find((item) => item.id === id);
            if (!base) throw new Error('not found');
            return { ...base, ...details[id] } as ActorDetail;
        },
    };
}

export function testConfig(home: string, actorDirs: string[] = []): Config {
    return { home, actorDirs, apiBase: 'http://unused' };
}

export async function connect(api: ApifyApi | null, config: Config, now = () => Date.parse('2026-11-08T03:00:00.000Z')) {
    const ctx = createContext(config, api, api ? 'env' : null, now);
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
