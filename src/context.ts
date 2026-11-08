import { findPublicToken, type TokenSource } from './auth/public.js';
import { ApiError, createApifyApi, type ApifyApi, type Me } from './clients/apifyApi.js';
import type { Config } from './config.js';
import { buildCatalog, type ActorSummary } from './core/actors.js';
import { Cache } from './core/cache.js';
import { ToolError } from './core/envelope.js';
import { scanActorDirs } from './core/repo.js';

const MINUTE = 60_000;

export interface Context {
    config: Config;
    cache: Cache;
    now: () => number;
    tokenSource: TokenSource | null;
    /** Throws `public_auth_missing` when there is no API token. */
    api(): ApifyApi;
    account(): Promise<Me>;
    catalog(): Promise<ActorSummary[]>;
    localActorPaths(): Promise<Map<string, string>>;
}

export function createContext(config: Config, api: ApifyApi | null, tokenSource: TokenSource | null, now = Date.now): Context {
    const cache = new Cache(now);
    const ctx: Context = {
        config,
        cache,
        now,
        tokenSource,
        api() {
            if (!api) {
                throw new ToolError(
                    'public_auth_missing',
                    'No Apify API token found.',
                    'Run `apify login` once, or set APIFY_TOKEN in the MCP server config.',
                );
            }
            return api;
        },
        account: () => cache.get('me', 60 * MINUTE, () => wrapApi(() => ctx.api().me())),
        catalog: () =>
            cache.get('catalog', 10 * MINUTE, async () => {
                const me = await ctx.account();
                const [mine, store] = await wrapApi(() => Promise.all([ctx.api().myActors(), ctx.api().storeActors(me.username)]));
                return buildCatalog(mine, store);
            }),
        localActorPaths: () => cache.get('local-actors', 10 * MINUTE, () => scanActorDirs(config.actorDirs)),
    };
    return ctx;
}

export async function createDefaultContext(config: Config): Promise<Context> {
    const token = await findPublicToken();
    return createContext(config, token ? createApifyApi(token.token, config.apiBase) : null, token?.source ?? null);
}

/** Turns API failures into a structured error the agent can relay. */
export async function wrapApi<T>(call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (error) {
        if (error instanceof ToolError) throw error;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
            throw new ToolError('public_auth_missing', 'The Apify API token was rejected.', 'Run `apify login` again, or update APIFY_TOKEN.');
        }
        if (error instanceof ApiError && error.status === 404) throw error;
        throw new ToolError('public_api_error', `Apify API request failed: ${error instanceof Error ? error.message : String(error)}`, 'Try again in a minute.');
    }
}
