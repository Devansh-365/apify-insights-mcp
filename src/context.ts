import { consoleError, currentConsoleToken, refreshedConsoleToken, touchWanted } from './auth/console-session.js';
import { findPublicToken, type TokenSource } from './auth/public.js';
import { sessionStatus, type ConsoleState } from './auth/session.js';
import { ApiError, createApifyApi, type ApifyApi, type Me } from './clients/apify-api.js';
import { createConsoleApi, type ConsoleApi } from './clients/console.js';
import type { Config } from './config.js';
import { buildCatalog, type ActorSummary } from './core/actors.js';
import { Cache } from './core/cache.js';
import { prefetchMoney } from './core/console-data.js';
import { createDiskCache, type DiskCache } from './core/disk-cache.js';
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
    /** The Console client; throws a structured error when no session can be had (waits up to ~1 min for a refresh). */
    console(): Promise<ConsoleApi>;
    /** The Console client only if a fresh session exists right now; never waits. Signals demand either way. */
    optionalConsole(): Promise<{ api: ConsoleApi | null; state: ConsoleState }>;
    /** The on-disk cache for finished months, or null when turned off or there is no account. */
    disk(): Promise<DiskCache | null>;
    /** Called after every tool call: starts the one-time background prefetch once a money tool has run. */
    afterTool(): void;
}

export interface ContextOptions {
    /** Tests: a fixed Console client (null = no session). */
    consoleApi?: ConsoleApi | null;
}

export function createContext(config: Config, api: ApifyApi | null, tokenSource: TokenSource | null, now = Date.now, options: ContextOptions = {}): Context {
    const cache = new Cache(now);
    let consoleApi: ConsoleApi | null = null;
    // The Console client a tool actually used this session (prefetch waits for the first one).
    let usedConsole: ConsoleApi | null = null;
    let prefetched = false;
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
                // `/acts?my=1` does not need the username, so it runs alongside `/users/me` (measured 3.0 s → 1.4 s).
                const [me, mine] = await Promise.all([ctx.account(), wrapApi(() => ctx.api().myActors())]);
                const store = await wrapApi(() => ctx.api().storeActors(me.username));
                return buildCatalog(mine, store);
            }),
        localActorPaths: () => cache.get('local-actors', 10 * MINUTE, () => scanActorDirs(config.actorDirs)),
        async console() {
            if (options.consoleApi !== undefined) {
                if (!options.consoleApi) throw consoleError('bridge_missing');
                usedConsole = options.consoleApi;
                return options.consoleApi;
            }
            const me = await ctx.account();
            // Fail fast before any request when there has never been a session.
            const status = await sessionStatus(config.home, me.id, now());
            if (status.state === 'bridge_missing' || status.state === 'other_account') {
                await touchWanted(config.home);
                throw consoleError(status.state);
            }
            consoleApi ??= createConsoleApi({
                current: () => currentConsoleToken(config.home, me.id, now()),
                refresh: (rejected) => refreshedConsoleToken(config.home, me.id, rejected, { now }),
            });
            usedConsole = consoleApi;
            return consoleApi;
        },
        async optionalConsole() {
            if (options.consoleApi !== undefined) return { api: options.consoleApi, state: options.consoleApi ? 'ok' : 'bridge_missing' };
            const me = await ctx.account();
            const status = await sessionStatus(config.home, me.id, now());
            await touchWanted(config.home);
            if (status.state !== 'ok') return { api: null, state: status.state };
            return { api: await ctx.console(), state: 'ok' };
        },
        disk: () =>
            cache.get('disk', 24 * 60 * MINUTE, async () => {
                if (!config.diskCache) return null;
                const me = await ctx.account();
                return createDiskCache(config.home, me.id, now);
            }),
        afterTool() {
            if (!config.prefetch || prefetched || !usedConsole) return;
            prefetched = true;
            void prefetchMoney(ctx, usedConsole).catch(() => {});
        },
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
