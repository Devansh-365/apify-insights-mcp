// Public Apify API (api.apify.com/v2). Read-only: every call is a GET.

export interface RunCounts {
    TOTAL?: number;
    SUCCEEDED?: number;
    FAILED?: number;
    'TIMED-OUT'?: number;
    ABORTED?: number;
}

export interface Me {
    id: string;
    username: string;
}

/** `/v2/acts?my=1` item: every own actor, public or private. */
export interface MyActor {
    id: string;
    name: string;
    title?: string;
    username: string;
    stats?: { totalRuns?: number; lastRunStartedAt?: string | null };
}

/** `/v2/store?username=` item: own public actors with user counts and users' run results. */
export interface StoreActor {
    id: string;
    name: string;
    title?: string;
    username: string;
    url?: string;
    notice?: string;
    currentPricingInfo?: Record<string, unknown> | null;
    stats?: {
        totalRuns?: number;
        totalUsers?: number;
        totalUsers7Days?: number;
        totalUsers30Days?: number;
        totalUsers90Days?: number;
        lastRunStartedAt?: string | null;
        actorReviewCount?: number;
        actorReviewRating?: number;
        publicActorRunStats30Days?: RunCounts;
    };
}

/** `/v2/acts/{id}`: one actor in full. */
export interface ActorDetail extends StoreActor {
    isPublic?: boolean;
    isDeprecated?: boolean;
    defaultRunOptions?: { build?: string; timeoutSecs?: number; memoryMbytes?: number };
    pricingInfos?: Array<Record<string, unknown>>;
    taggedBuilds?: Record<string, { buildNumber?: string; finishedAt?: string }>;
    modifiedAt?: string;
}

/** `apify.com/api/store-search` item: one result from the real Store search box (Recombee-backed). */
export interface StoreSearchItem {
    username: string;
    name: string;
    title?: string;
    /** Stats as returned by the Store search endpoint. totalUsers30Days is often absent; use the documented API for reliable 30d counts. */
    stats?: {
        totalUsers?: number;
        totalUsers30Days?: number;
    };
}

export interface ApifyApi {
    me(): Promise<Me>;
    myActors(): Promise<MyActor[]>;
    storeActors(username: string): Promise<StoreActor[]>;
    actor(idOrRef: string): Promise<ActorDetail>;
    /**
     * Query `apify.com/api/store-search` — the same undocumented Recombee-backed endpoint the
     * real Store website search box calls. Returns results in the order a visitor actually sees.
     * Hard-capped at 100 by the backend; pagination is not supported.
     */
    storeSearch(keyword: string, limit: number): Promise<StoreSearchItem[]>;
}

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

const PAGE = 1000;
const STORE_SEARCH_URL = 'https://apify.com/api/store-search';

export function createApifyApi(token: string, base = 'https://api.apify.com/v2'): ApifyApi {
    async function get<T>(path: string, authenticated = true): Promise<T> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
            try {
                const response = await fetch(`${base}${path}`, {
                    headers: { Accept: 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
                    signal: AbortSignal.timeout(20_000),
                });
                if (response.status === 429 || response.status >= 500) {
                    lastError = new ApiError(response.status, `Apify API ${response.status} on ${path.split('?')[0]}`);
                    continue;
                }
                if (!response.ok) throw new ApiError(response.status, `Apify API ${response.status} on ${path.split('?')[0]}`);
                return ((await response.json()) as { data: T }).data;
            } catch (error) {
                if (error instanceof ApiError) throw error;
                lastError = error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    async function all<T>(path: string, authenticated = true): Promise<T[]> {
        const items: T[] = [];
        for (let offset = 0; ; offset += PAGE) {
            const sep = path.includes('?') ? '&' : '?';
            const page = await get<{ items: T[]; total?: number }>(`${path}${sep}limit=${PAGE}&offset=${offset}`, authenticated);
            items.push(...page.items);
            if (page.items.length < PAGE || (page.total != null && items.length >= page.total)) return items;
        }
    }

    async function raw<T>(url: string): Promise<T> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
            try {
                const response = await fetch(url, {
                    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
                    signal: AbortSignal.timeout(20_000),
                });
                if (response.status === 429 || response.status >= 500) {
                    lastError = new ApiError(response.status, `Store search ${response.status} on ${url.split('?')[0]}`);
                    continue;
                }
                if (!response.ok) throw new ApiError(response.status, `Store search ${response.status} on ${url.split('?')[0]}`);
                return (await response.json()) as T;
            } catch (error) {
                if (error instanceof ApiError) throw error;
                lastError = error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    return {
        me: () => get<Me>('/users/me'),
        myActors: () => all<MyActor>('/acts?my=1'),
        storeActors: (username) => all<StoreActor>(`/store?username=${encodeURIComponent(username)}`, false),
        actor: (idOrRef) => get<ActorDetail>(`/acts/${encodeURIComponent(idOrRef.replace('/', '~'))}`),
        storeSearch: async (keyword, limit) => {
            const url = `${STORE_SEARCH_URL}?search=${encodeURIComponent(keyword)}&limit=${Math.min(limit, 100)}`;
            const result = await raw<{ items: StoreSearchItem[] }>(url);
            return result.items ?? [];
        },
    };
}
