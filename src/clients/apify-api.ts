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

/** `/v2/acts/{id}/builds` item. */
export interface BuildItem {
    id: string;
    status: string;
    buildNumber?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
}

/** The end of a run's log. `available: false` when the API did not return it (not shared, deleted, no access). */
export interface RunLog {
    available: boolean;
    lines: string[];
    /** The log was longer than the byte cap; `lines` are the last lines of the part that was read. */
    truncatedAtBytes: boolean;
}

export interface RunLogOptions {
    maxBytes?: number;
    lines?: number;
    lineChars?: number;
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
    /** Newest builds first. */
    builds(actorId: string, limit: number): Promise<BuildItem[]>;
    /** The last lines of a run's log, read with a byte cap. Never throws for a missing log. */
    runLog(runId: string, options?: RunLogOptions): Promise<RunLog>;
    /**
     * Runs this account started (any actor), newest first, back to `startedAfter` (ISO). Used by the
     * experimental watch to tell the owner's own test runs apart. Optional so test fakes can omit it.
     */
    myRuns?(startedAfter: string): Promise<OwnRun[]>;
}

/** `/v2/actor-runs` item, trimmed to what the watch needs. */
export interface OwnRun {
    actId: string;
    status: string;
    startedAt: string;
}

/** Most pages `myRuns` reads (1,000 runs each). */
export const MY_RUNS_MAX_PAGES = 40;

export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

const PAGE = 1000;
const RUN_ID = /^[A-Za-z0-9]{1,32}$/;
/** Logs are read up to this size; failing runs usually end with the error, so the tail is what matters. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;
const STORE_SEARCH_URL = 'https://apify.com/api/store-search';

/**
 * Streams a body and keeps only its last `lines` lines (each cut to `lineChars`), so memory stays small
 * whatever the log size. Stops after `maxBytes`; then `truncatedAtBytes` is true and the lines are the
 * last ones read, not the end of the log. Exported for tests.
 */
export async function tailOf(body: ReadableStream<Uint8Array> | null, maxBytes: number, lines: number, lineChars: number): Promise<{ lines: string[]; truncatedAtBytes: boolean }> {
    if (!body) return { lines: [], truncatedAtBytes: false };
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const kept: string[] = [];
    const cut = (line: string) => (line.length > lineChars ? `${line.slice(0, lineChars)}…` : line);
    const keep = (line: string) => {
        kept.push(cut(line.replace(/\r$/, '')));
        if (kept.length > lines) kept.shift();
    };
    let partial = '';
    let size = 0;
    let truncated = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = maxBytes - size;
        const chunk = value.byteLength > room ? value.subarray(0, room) : value;
        size += chunk.byteLength;
        const parts = (partial + decoder.decode(chunk, { stream: true })).split('\n');
        partial = parts.pop() ?? '';
        // A single huge line must not grow without bound.
        if (partial.length > lineChars * 4) partial = partial.slice(0, lineChars * 4);
        for (const line of parts) keep(line);
        if (value.byteLength > room || size >= maxBytes) {
            truncated = value.byteLength > room || !(await reader.read()).done;
            await reader.cancel().catch(() => {});
            break;
        }
    }
    partial += decoder.decode();
    if (partial) keep(partial);
    return { lines: kept, truncatedAtBytes: truncated };
}

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

    async function runLog(runId: string, options: RunLogOptions = {}): Promise<RunLog> {
        const missing: RunLog = { available: false, lines: [], truncatedAtBytes: false };
        if (!RUN_ID.test(runId)) return missing;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
            try {
                const response = await fetch(`${base}/actor-runs/${runId}/log`, {
                    headers: { Accept: 'text/plain', Authorization: `Bearer ${token}` },
                    signal: AbortSignal.timeout(20_000),
                });
                if (response.status === 429 || response.status >= 500) {
                    await response.body?.cancel().catch(() => {});
                    continue;
                }
                if (!response.ok) {
                    await response.body?.cancel().catch(() => {});
                    return missing;
                }
                const tail = await tailOf(response.body, options.maxBytes ?? MAX_LOG_BYTES, options.lines ?? 30, options.lineChars ?? 300);
                return { available: true, ...tail };
            } catch {
                // Network error or timeout: try again, then give up quietly.
            }
        }
        return missing;
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
        builds: async (actorId, limit) => (await get<{ items: BuildItem[] }>(`/acts/${encodeURIComponent(actorId)}/builds?desc=1&limit=${limit}`)).items,
        runLog,
        myRuns: async (startedAfter) => {
            const since = Date.parse(startedAfter);
            const out: OwnRun[] = [];
            for (let page = 0; page < MY_RUNS_MAX_PAGES; page++) {
                const data = await get<{ items: Array<{ actId?: string; status?: string; startedAt?: string }> }>(`/actor-runs?desc=1&limit=${PAGE}&offset=${page * PAGE}`);
                let older = false;
                for (const item of data.items) {
                    if (typeof item.actId !== 'string' || typeof item.startedAt !== 'string' || typeof item.status !== 'string') continue;
                    if (Date.parse(item.startedAt) < since) {
                        older = true;
                        continue;
                    }
                    out.push({ actId: item.actId, status: item.status, startedAt: item.startedAt });
                }
                if (older || data.items.length < PAGE) break;
            }
            return out;
        },
    };
}
