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
export type UserCounts = z.infer<typeof userCountsSchema>;
export type Marketing = z.infer<typeof marketingSchema>;
export type QualityScores = z.infer<typeof qualityScoresSchema>;
export type QualityImprovements = z.infer<typeof qualityImprovementsSchema>;
export type QualityBusinessValue = z.infer<typeof qualityBusinessValueSchema>;

export interface ConsoleApi {
    /** Totals and daily money for the account, or for the given actors only. `month` is YYYY-MM. */
    profitMargin(month: string, actorIds?: string[]): Promise<ProfitMargin>;
    /** One row per public actor with revenue, cost, runs, users and pricing (paying-users money). */
    actorBreakdown(month: string): Promise<Breakdown>;
    runStatistics(month: string, actorIds?: string[]): Promise<RunStatistics>;
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

export type TokenProvider = () => Promise<string>;

export interface ConsoleClientOptions {
    /** Extra random delay added to each retry so parallel requests do not retry in step. */
    jitter?: () => number;
    /** First retry waits this long, then double. */
    retryDelayMs?: number;
}

/** Requests in flight at once. The extension uses 8; staying lower leaves room for the Console page itself. */
export const MAX_CONCURRENT = 6;

export function createConsoleApi(getToken: TokenProvider, fetchImpl: typeof fetch = fetch, options: ConsoleClientOptions = {}): ConsoleApi {
    const jitter = options.jitter ?? (() => Math.random() * 500);
    const retryDelayMs = options.retryDelayMs ?? 1000;
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

    /** `label` names the endpoint in errors; `url` is already built from the allowlist. */
    async function request<T>(label: string, url: string, schema: z.ZodType<T>): Promise<T> {
        await slot();
        try {
            for (let attempt = 0; ; attempt++) {
                const token = await getToken();
                const response = await fetchImpl(url, {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                    signal: AbortSignal.timeout(30_000),
                });
                if (response.status === 401 || response.status === 403) {
                    throw new ToolError('logged_out', 'The Apify Console session was rejected.', 'Open console.apify.com in Chrome and make sure you are logged in.');
                }
                if ((response.status === 429 || response.status >= 500) && attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt + jitter()));
                    continue;
                }
                if (!response.ok) {
                    throw new ToolError('endpoint_changed', `Apify Console returned ${response.status} for ${label}.`, 'Try again later; public tools still work.', { endpoint: label });
                }
                return parse(schema, label, await response.json());
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
        actorBreakdown: (m) => get('actor-analytics/actor-breakdown', { month: month(m) }, breakdownSchema),
        runStatistics: (m, actorIds) => get('actor-analytics/run-statistics/monthly/all-users', { month: month(m), actorIds: ids(actorIds) }, runStatisticsSchema),
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
