import { z } from 'zod';
import { ToolError } from '../core/envelope.js';

// Apify Console analytics backend (unofficial, the same requests the Console page makes). Read-only by
// construction: GET only, fixed path allowlist, query built per endpoint from typed arguments. Shapes were
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

const num = z.number();
const money = z.object({ revenueUsd: num, costUsd: num, profitUsd: num, margin: num.nullable().optional() }).passthrough();
const audiences = z.object({ payingUsersUsd: money, allUsersUsd: money }).passthrough();
const runCounts = z
    .object({ TOTAL: num, SUCCEEDED: num.optional(), FAILED: num.optional(), 'TIMED-OUT': num.optional(), ABORTED: num.optional(), RESULTS: num.optional() })
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

export type ProfitMargin = z.infer<typeof profitMarginSchema>;
export type BreakdownRow = z.infer<typeof breakdownRowSchema>;
export type Breakdown = z.infer<typeof breakdownSchema>;
export type RunStatistics = z.infer<typeof runStatisticsSchema>;
export type UserCounts = z.infer<typeof userCountsSchema>;
export type Marketing = z.infer<typeof marketingSchema>;

export interface ConsoleApi {
    /** Totals and daily money for the account, or for the given actors only. `month` is YYYY-MM. */
    profitMargin(month: string, actorIds?: string[]): Promise<ProfitMargin>;
    /** One row per public actor with revenue, cost, runs, users and pricing (paying-users money). */
    actorBreakdown(month: string): Promise<Breakdown>;
    runStatistics(month: string, actorIds?: string[]): Promise<RunStatistics>;
    userCounts(month: string, actorIds?: string[]): Promise<UserCounts>;
    /** Store page views and users with a run; `portionOfMonthElapsed` only for the current month. */
    marketing(month: string, actorIds?: string[], portionOfMonthElapsed?: number): Promise<Marketing>;
}

/** Builds the URL for an allowed path. Exported for the allowlist tests. */
export function consoleUrl(path: string, params: Record<string, string | undefined>): string {
    if (!(ALLOWED_PATHS as readonly string[]).includes(path)) throw new Error(`Console path not allowed: ${path}`);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
    const qs = query.toString();
    return `${BASE}/${path}${qs ? `?${qs}` : ''}`;
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

export function createConsoleApi(getToken: TokenProvider, fetchImpl: typeof fetch = fetch): ConsoleApi {
    // One request at a time per process, like the Console page itself.
    let queue: Promise<unknown> = Promise.resolve();

    async function request<T>(path: ConsolePath, params: Record<string, string | undefined>, schema: z.ZodType<T>): Promise<T> {
        const url = consoleUrl(path, params);
        const run = async () => {
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
                    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
                    continue;
                }
                if (!response.ok) {
                    throw new ToolError('endpoint_changed', `Apify Console returned ${response.status} for ${path}.`, 'Try again later; public tools still work.', { endpoint: path });
                }
                return parse(schema, path, await response.json());
            }
        };
        const result = queue.then(run, run);
        queue = result.catch(() => undefined);
        return result;
    }

    const ids = (actorIds?: string[]) => (actorIds?.length ? actorIds.join(',') : undefined);
    const month = (value: string) => `${value}-01`;

    return {
        profitMargin: (m, actorIds) => request('actor-analytics/profit-margin', { month: month(m), actorIds: ids(actorIds) }, profitMarginSchema),
        actorBreakdown: (m) => request('actor-analytics/actor-breakdown', { month: month(m) }, breakdownSchema),
        runStatistics: (m, actorIds) => request('actor-analytics/run-statistics/monthly/all-users', { month: month(m), actorIds: ids(actorIds) }, runStatisticsSchema),
        userCounts: (m, actorIds) => request('actor-analytics/user-count-statistics', { month: month(m), actorIds: ids(actorIds) }, userCountsSchema),
        // This endpoint wants `actorIds` present (empty = all actors) and a month start date.
        marketing: (m, actorIds, portion) =>
            request(
                'actor-analytics/monthly-marketing',
                { monthStartAt: month(m), actorIds: ids(actorIds) ?? '', portionOfMonthElapsed: portion == null ? undefined : String(portion) },
                marketingSchema,
            ),
    };
}
