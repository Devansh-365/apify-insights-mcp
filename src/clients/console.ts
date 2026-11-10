import { z } from 'zod';
import { ToolError } from '../core/envelope.js';

// Apify Console analytics backend (unofficial, the same requests the Console page makes). Read-only by
// construction: GET only, fixed path allowlist (actor IDs in paths are validated), query built per
// endpoint from typed arguments. Shapes were
// captured live on 2026-11-08 (test/fixtures/console-shapes.json); a response that no longer matches
// raises `endpoint_changed` naming the field instead of returning wrong numbers.

const BASE = 'https://console-backend.apify.com';

export const ALLOWED_PATHS = [
    'actor-analytics/profit-margin',
    'actor-analytics/actor-breakdown',
    'actor-analytics/run-statistics/monthly/all-users',
    'actor-analytics/user-count-statistics',
    'actor-analytics/monthly-marketing',
    'actor-analytics/shared-runs',
] as const;

export type ConsolePath = (typeof ALLOWED_PATHS)[number];

/** Read endpoints with the actor ID in the path. `:id` is replaced by a validated actor ID at call time. */
export const ALLOWED_ID_PATHS = [
    'actor-quality/scores/:id',
    'actor-quality/praises-and-improvements/:id',
    'actor-quality/business-value-improvements/:id',
] as const;

export type ConsoleIdPath = (typeof ALLOWED_ID_PATHS)[number];

// Apify actor IDs are 17 alphanumeric characters; this also rejects '/', '.', '%' and anything else
// that could change the path.
const ACTOR_ID = /^[A-Za-z0-9]{1,32}$/;

const num = z.number();
const money = z.object({ revenueUsd: num, costUsd: num, profitUsd: num, margin: num.nullable().optional() }).passthrough();
const audiences = z.object({ payingUsersUsd: money, allUsersUsd: money }).passthrough();
// An actor with no runs in the month gets `runsStats: {}` (seen live for the current month), so every
// count is optional and a missing one reads as 0.
const runCounts = z
    .object({ TOTAL: num.optional(), SUCCEEDED: num.optional(), FAILED: num.optional(), 'TIMED-OUT': num.optional(), ABORTED: num.optional(), RESULTS: num.optional() })
    .passthrough();

export const profitMarginSchema = z
    .object({ totalProfitMarginStats: audiences, dailyProfitMarginStats: z.record(z.string(), audiences) })
    .passthrough();

export const breakdownRowSchema = z
    .object({
        actor: z
            .object({ _id: z.string(), name: z.string(), title: z.string().nullish(), username: z.string().nullish(), isPublic: z.boolean().nullish(), notice: z.string().nullish() })
            .passthrough(),
        runsStats: runCounts.nullish(),
        earningsStats: z.object({ totalRevenueUsd: num, totalCostUsd: num, totalProfitUsd: num.nullish() }).passthrough(),
        usersStats: z.object({ payingUsers: num, freeUsers: num }).passthrough().nullish(),
        chargedResults: num.nullish(),
        currentPricingInfo: z.record(z.string(), z.unknown()).nullish(),
    })
    .passthrough();

export const breakdownSchema = z.object({ monetizationPerActor: z.array(breakdownRowSchema) }).passthrough();

export const runStatisticsSchema = z.object({ dailyStats: z.record(z.string(), runCounts) }).passthrough();

// actor-analytics/shared-runs (captured live 2026-11-10): runs users chose to share with the developer.
export const sharedRunSchema = z
    .object({
        _id: z.string(),
        actId: z.string().nullish(),
        status: z.string(),
        startedAt: z.string().nullish(),
        finishedAt: z.string().nullish(),
        buildNumber: z.string().nullish(),
        exitCode: z.number().nullish(),
        isRunOfPayingUser: z.boolean().nullish(),
    })
    .passthrough();

export const sharedRunsSchema = z
    .object({
        data: z.array(sharedRunSchema),
        sequencePagination: z.object({ nextPageToken: z.string().nullish(), totalCount: num.nullish() }).passthrough().nullish(),
    })
    .passthrough();
export const userCountsSchema = z.record(z.string(), z.object({ freeUsers: num, payingUsers: num }).passthrough());
export const marketingSchema = z
    .object({
        numUniqueWebPageViews: num,
        numUniqueConsolePageViews: num,
        numUniqueUsersWithRun: num,
        numUniqueViewingUsers: num,
        topReferrers: z.array(z.object({ origin: z.string(), trafficPercent: num }).passthrough()).optional(),
        topCountryCodes: z.array(z.object({ origin: z.string(), trafficPercent: num }).passthrough()).optional(),
    })
    .passthrough();

// actor-quality/* (captured live 2026-11-08). The scores endpoint returned only 5 keys for the sampled
// actors; the extension reads more sub-scores, so every key is optional.
export const qualityScoresSchema = z.record(z.string(), z.unknown());

const improvementItem = z
    .object({ id: z.string(), title: z.string().nullish(), description: z.string().nullish(), descriptionDetail: z.string().nullish(), valueLift: z.number().nullish() })
    .passthrough();

export const qualityImprovementsSchema = z
    .object({
        praises: z.array(z.object({ title: z.string(), description: z.string().nullish(), percentile: z.number().nullish() }).passthrough()).nullish(),
        improvements: z.array(improvementItem).nullish(),
    })
    .passthrough();

export const qualityBusinessValueSchema = z.union([z.array(improvementItem), z.object({ improvements: z.array(improvementItem).nullish() }).passthrough()]);

export type ProfitMargin = z.infer<typeof profitMarginSchema>;
export type BreakdownRow = z.infer<typeof breakdownRowSchema>;
export type Breakdown = z.infer<typeof breakdownSchema>;
export type RunStatistics = z.infer<typeof runStatisticsSchema>;
export type SharedRun = z.infer<typeof sharedRunSchema>;
export type SharedRuns = z.infer<typeof sharedRunsSchema>;
export type UserCounts = z.infer<typeof userCountsSchema>;
export type Marketing = z.infer<typeof marketingSchema>;
export type QualityScores = z.infer<typeof qualityScoresSchema>;
export type QualityImprovements = z.infer<typeof qualityImprovementsSchema>;
export type QualityBusinessValue = z.infer<typeof qualityBusinessValueSchema>;

export interface ConsoleApi {
    /** Totals and daily money for the account, or for the given actors only. `month` is YYYY-MM. */
    profitMargin(month: string, actorIds?: string[]): Promise<ProfitMargin>;
    /**
     * One row per public actor with revenue, cost, runs, users and pricing (paying-users money). With
     * `actorIds`, only those actors' rows (checked live: same rows as the full list, ~11 KB instead of ~770 KB).
     */
    actorBreakdown(month: string, actorIds?: string[]): Promise<Breakdown>;
    /** Runs per UTC day by status (today included, partial). Several actorIds return their sum, not one row each. */
    runStatistics(month: string, actorIds?: string[]): Promise<RunStatistics>;
    /** Runs users shared with you for these actors, newest finished first. `searchAfter` is the previous page's `nextPageToken`. */
    sharedRuns(actorIds: string[], options: { limit: number; searchAfter?: string }): Promise<SharedRuns>;
    userCounts(month: string, actorIds?: string[]): Promise<UserCounts>;
    /**
     * Store page views and users with a run. The Console multiplies every count by `portionOfMonthElapsed`
     * (checked live 2026-11-08), so pass it only to scale last month for a same-point comparison, never
     * to read the current month.
     */
    marketing(month: string, actorIds?: string[], portionOfMonthElapsed?: number): Promise<Marketing>;
    /** Apify's quality score, its percentile and sub-scores (0-1) for one actor. */
    qualityScores(actorId: string): Promise<QualityScores>;
    /** What Apify praises about one actor and the improvements it suggests. */
    qualityImprovements(actorId: string): Promise<QualityImprovements>;
    /** Extra improvement suggestions tied to business value, with more detail. */
    qualityBusinessValue(actorId: string): Promise<QualityBusinessValue>;
}

/** Builds the URL for an allowed path. Exported for the allowlist tests. */
export function consoleUrl(path: string, params: Record<string, string | undefined>): string {
    if (!(ALLOWED_PATHS as readonly string[]).includes(path)) throw new Error(`Console path not allowed: ${path}`);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
    const qs = query.toString();
    return `${BASE}/${path}${qs ? `?${qs}` : ''}`;
}

/** Builds the URL for an allowed path that contains an actor ID. Exported for the allowlist tests. */
export function consoleIdUrl(template: string, actorId: string): string {
    if (!(ALLOWED_ID_PATHS as readonly string[]).includes(template)) throw new Error(`Console path not allowed: ${template}`);
    if (!ACTOR_ID.test(actorId)) throw new Error(`Not an actor ID: ${JSON.stringify(actorId)}`);
    return `${BASE}/${template.replace(':id', actorId)}`;
}

function parse<T>(schema: z.ZodType<T>, path: string, body: unknown): T {
    const result = schema.safeParse(body);
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const field = issue?.path.join('.') || '(root)';
    throw new ToolError(
        'endpoint_changed',
        `Apify Console response for ${path} changed shape at "${field}" (${issue?.message ?? 'invalid'}).`,
        'The numbers cannot be trusted until this server is updated. Public tools still work.',
        { endpoint: path, field },
    );
}

export interface ConsoleToken {
    value: string;
    receivedAt: string;
}

/** `current` returns the stored token whatever its age; `refresh` waits for one newer than a rejected token. */
export interface TokenProvider {
    current(): Promise<ConsoleToken>;
    refresh(rejected: ConsoleToken): Promise<ConsoleToken>;
}

export interface ConsoleClientOptions {
    /** Extra random delay added to each retry so parallel requests do not retry in step. */
    jitter?: () => number;
    /** First retry waits this long, then double. */
    retryDelayMs?: number;
    /** First wait after a 429 without Retry-After, then double. */
    rateLimitDelayMs?: number;
}

/** Requests in flight at once. The extension uses 8; staying lower leaves room for the Console page itself. */
export const MAX_CONCURRENT = 6;
const SERVER_RETRIES = 2;
const RATE_LIMIT_RETRIES = 3;
const BREAKDOWN_IDS_PER_CALL = 50;
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * A dropped connection (HTTP/2 GOAWAY, reset socket) surfaces as `TypeError: fetch failed` with a socket
 * cause. Safe to retry: every request here is a GET. A timeout abort is a DOMException and is not retried.
 */
export function isNetworkError(error: unknown): boolean {
    if (!(error instanceof TypeError)) return false;
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    return typeof code === 'string' && (code.startsWith('UND_ERR_') || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code));
}

/** Retry-After in ms (seconds or an HTTP date), capped; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
    if (!header) return null;
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
}

export function createConsoleApi(tokens: TokenProvider, fetchImpl: typeof fetch = fetch, options: ConsoleClientOptions = {}): ConsoleApi {
    const jitter = options.jitter ?? (() => Math.random() * 500);
    const retryDelayMs = options.retryDelayMs ?? 1000;
    const rateLimitDelayMs = options.rateLimitDelayMs ?? 2000;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    // One refresh per rejected token, shared by every request that saw the same 401.
    const refreshing = new Map<string, Promise<ConsoleToken>>();
    // After a 429 the whole queue waits, so the other slots do not keep hitting the limit.
    let pausedUntil = 0;
    let active = 0;
    const waiting: Array<() => void> = [];

    async function slot(): Promise<void> {
        if (active < MAX_CONCURRENT) {
            active++;
            return;
        }
        // The releasing request hands its slot straight over, so `active` stays the same.
        await new Promise<void>((resolve) => waiting.push(resolve));
    }

    function release(): void {
        const next = waiting.shift();
        if (next) next();
        else active--;
    }

    async function refreshOnce(rejected: ConsoleToken): Promise<ConsoleToken> {
        // Another request may already have refreshed it: use that token instead of waiting again.
        const latest = await tokens.current();
        if (latest.value !== rejected.value) return latest;
        // Keyed in memory by the rejected token itself; never logged or stored.
        const key = rejected.value;
        let pending = refreshing.get(key);
        if (!pending) {
            pending = tokens.refresh(rejected).finally(() => refreshing.delete(key));
            refreshing.set(key, pending);
        }
        return pending;
    }

    /** `label` names the endpoint in errors; `url` is already built from the allowlist. */
    async function request<T>(label: string, url: string, schema: z.ZodType<T>): Promise<T> {
        await slot();
        try {
            let token = await tokens.current();
            let refreshed = false;
            let serverRetries = 0;
            let rateRetries = 0;
            for (;;) {
                const wait = pausedUntil - Date.now();
                if (wait > 0) await sleep(wait);
                let response: Response;
                let body: unknown;
                try {
                    response = await fetchImpl(url, {
                        method: 'GET',
                        headers: { Authorization: `Bearer ${token.value}`, Accept: 'application/json' },
                        signal: AbortSignal.timeout(30_000),
                    });
                    // The body is read here too: a connection can drop half-way through a large response.
                    if (response.ok) body = await response.json();
                } catch (error) {
                    if (isNetworkError(error) && serverRetries < SERVER_RETRIES) {
                        await sleep(retryDelayMs * 2 ** serverRetries++ + jitter());
                        continue;
                    }
                    throw error;
                }
                if (response.status === 401 || response.status === 403) {
                    if (!refreshed) {
                        refreshed = true;
                        token = await refreshOnce(token);
                        continue;
                    }
                    throw new ToolError('logged_out', 'The Apify Console session was rejected.', 'Open console.apify.com in Chrome and make sure you are logged in.');
                }
                if (response.status === 429 && rateRetries < RATE_LIMIT_RETRIES) {
                    const delay = retryAfterMs(response.headers.get('retry-after')) ?? rateLimitDelayMs * 2 ** rateRetries + jitter();
                    rateRetries++;
                    pausedUntil = Math.max(pausedUntil, Date.now() + delay);
                    continue;
                }
                if (response.status >= 500 && serverRetries < SERVER_RETRIES) {
                    await sleep(retryDelayMs * 2 ** serverRetries++ + jitter());
                    continue;
                }
                if (!response.ok) {
                    throw new ToolError('endpoint_changed', `Apify Console returned ${response.status} for ${label}.`, 'Try again later; public tools still work.', { endpoint: label });
                }
                return parse(schema, label, body);
            }
        } finally {
            release();
        }
    }

    const get = <T>(path: ConsolePath, params: Record<string, string | undefined>, schema: z.ZodType<T>) => request(path, consoleUrl(path, params), schema);
    const getById = <T>(template: ConsoleIdPath, actorId: string, schema: z.ZodType<T>) => request(template, consoleIdUrl(template, actorId), schema);

    const ids = (actorIds?: string[]) => (actorIds?.length ? actorIds.join(',') : undefined);
    const month = (value: string) => `${value}-01`;

    return {
        profitMargin: (m, actorIds) => get('actor-analytics/profit-margin', { month: month(m), actorIds: ids(actorIds) }, profitMarginSchema),
        actorBreakdown: async (m, actorIds) => {
            if (!actorIds) return get('actor-analytics/actor-breakdown', { month: month(m) }, breakdownSchema);
            for (const id of actorIds) if (!ACTOR_ID.test(id)) throw new Error(`Not an actor ID: ${JSON.stringify(id)}`);
            const chunks: string[][] = [];
            for (let i = 0; i < actorIds.length; i += BREAKDOWN_IDS_PER_CALL) chunks.push(actorIds.slice(i, i + BREAKDOWN_IDS_PER_CALL));
            const parts = await Promise.all(chunks.map((chunk) => get('actor-analytics/actor-breakdown', { month: month(m), actorIds: chunk.join(',') }, breakdownSchema)));
            return { monetizationPerActor: parts.flatMap((part) => part.monetizationPerActor) };
        },
        runStatistics: (m, actorIds) => get('actor-analytics/run-statistics/monthly/all-users', { month: month(m), actorIds: ids(actorIds) }, runStatisticsSchema),
        sharedRuns: async (actorIds, { limit, searchAfter }) => {
            for (const id of actorIds) if (!ACTOR_ID.test(id)) throw new Error(`Not an actor ID: ${JSON.stringify(id)}`);
            // The server requires the bracket key `sort[finishedAt]` (URLSearchParams encodes it as
            // sort%5BfinishedAt%5D, which it accepts); `startedAt` and other sort fields are rejected. Keep it.
            return get('actor-analytics/shared-runs', { actorIds: actorIds.join(','), limit: String(limit), 'sort[finishedAt]': '-1', searchAfter }, sharedRunsSchema);
        },
        userCounts: (m, actorIds) => get('actor-analytics/user-count-statistics', { month: month(m), actorIds: ids(actorIds) }, userCountsSchema),
        // This endpoint wants `actorIds` present (empty = all actors) and a month start date.
        marketing: (m, actorIds, portion) =>
            get(
                'actor-analytics/monthly-marketing',
                { monthStartAt: month(m), actorIds: ids(actorIds) ?? '', portionOfMonthElapsed: portion == null ? undefined : String(portion) },
                marketingSchema,
            ),
        qualityScores: (actorId) => getById('actor-quality/scores/:id', actorId, qualityScoresSchema),
        qualityImprovements: (actorId) => getById('actor-quality/praises-and-improvements/:id', actorId, qualityImprovementsSchema),
        qualityBusinessValue: (actorId) => getById('actor-quality/business-value-improvements/:id', actorId, qualityBusinessValueSchema),
    };
}
