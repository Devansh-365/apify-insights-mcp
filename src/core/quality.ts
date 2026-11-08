import type { QualityBusinessValue, QualityImprovements, QualityScores } from '../clients/console.js';
import type { ActorMoney } from './money.js';

// Actor quality inbox, ported from the Apify Insights Plus extension (lib/quality-inbox.js): Apify's
// improvement suggestions grouped by work type and ranked by impact (the work type's weight times the
// actor's traffic). Same groups, weights and level rules. Pure: no network, no state. The suggestion
// lifecycle (fix, snooze, dismiss), "new" badges and score-change history need saved state and stay in
// the extension.

// Month-to-date figures are too noisy to project before this day.
export const PACE_MIN_DAY = 8;
const MAX_DESCRIPTION_LENGTH = 600;

export interface WorkGroup {
    key: string;
    label: string;
    weight: number;
    hidden?: boolean;
    ids: readonly string[];
}

/** Apify's improvement IDs are a closed set; anything new lands in "other". */
export const WORK_GROUPS: readonly WorkGroup[] = [
    { key: 'security', label: 'Security', weight: 5, ids: ['SENSITIVE_PROPERTIES_WITHOUT_SECRET_FLAG', 'PERMISSION_LEVEL'] },
    { key: 'ops', label: 'Operations', weight: 4, ids: ['RELIABILITY', 'ISSUE_RESPONSE_TIME'] },
    { key: 'schema', label: 'Schema', weight: 3, ids: ['HAS_INPUT_SCHEMA', 'HAS_OUTPUT_SCHEMA'] },
    { key: 'pricing', label: 'Pricing', weight: 2, ids: ['ACTOR_START_PRICE', 'PPE_PRICING', 'PPE_PRIMARY_EVENT', 'PPE_PLATFORM_USAGE', 'TIERED_PRICING'] },
    {
        key: 'listing',
        label: 'Listing & docs',
        weight: 1,
        ids: ['NO_README', 'README_QUALITY', 'TITLE_QUALITY', 'DESCRIPTION_QUALITY', 'HAS_AVATAR_IMAGE', 'INPUT_PROPERTY_DESCRIPTION_QUALITY', 'PUBLISH_TASK'],
    },
    { key: 'other', label: 'Other', weight: 1, ids: [] },
    // Rating and user counts are not work you can do directly, so the extension hides them.
    { key: 'market', label: 'Market', weight: 0.5, hidden: true, ids: ['RATING', 'TOTAL_USERS'] },
];

const GROUP_BY_ID = new Map(WORK_GROUPS.flatMap((group) => group.ids.map((id) => [id, group] as const)));
const OTHER = WORK_GROUPS.find((group) => group.key === 'other')!;

export const SCORE_LABELS: Record<string, string> = {
    actorQuality: 'Quality score',
    actorQualityPercentile: 'Quality percentile',
    health: 'Health',
    runSuccessRate: 'Run success rate',
    rating: 'Rating',
    integrability: 'Integrability',
    issueResponseTime: 'Issue response time',
    pricing: 'Pricing',
    hasInputSchema: 'Input schema',
    hasOutputSchema: 'Output schema',
    hasReadme: 'README',
    hasAvatarImage: 'Avatar image',
    readmeQuality: 'README quality',
    inputPropertyDescriptionQuality: 'Input field descriptions',
    titleQuality: 'Title quality',
    descriptionQuality: 'Description quality',
    inputSchemaSecurity: 'Input schema security',
    maintenanceFrequency: 'Maintenance frequency',
    permissionLevel: 'Permission level',
    actorListing: 'Store listing',
    isPPEPlatformUsagePaidByUser: 'Platform usage paid by user',
};

export type ImpactLevel = 'high' | 'medium' | 'low';
export type PendingReason = 'unpublished' | 'unscored';

export interface Improvement {
    id: string;
    title: string;
    description: string;
    detail: string;
    valueLift: number | null;
}

export interface QualityEntry {
    id: string;
    /** Known sub-scores only, 0-1, rounded to 4 decimals. Null while pending. */
    scores: Record<string, number> | null;
    improvements: Improvement[];
    praises: string[];
    pending: PendingReason | null;
}

export interface Traffic {
    revenue: number;
    runs: number;
    payingUsers: number;
    users: number;
}

export interface ActorTraffic {
    previous: Traffic | null;
    current: Traffic | null;
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function number(value: unknown): number {
    return finite(value) ?? 0;
}

export function groupFor(id: string): WorkGroup {
    return GROUP_BY_ID.get(id) ?? OTHER;
}

/** Known sub-scores only; booleans read as 0/1. Null when the response is not an object. */
export function compactScores(scores: QualityScores | null | undefined): Record<string, number> | null {
    if (!scores || typeof scores !== 'object') return null;
    const result: Record<string, number> = {};
    for (const key of Object.keys(SCORE_LABELS)) {
        const raw = scores[key];
        const value = typeof raw === 'boolean' ? Number(raw) : finite(raw);
        if (value != null) result[key] = Math.round(value * 10_000) / 10_000;
    }
    return result;
}

function trimText(value: unknown): string {
    const text = typeof value === 'string' ? value : '';
    return text.length > MAX_DESCRIPTION_LENGTH ? `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…` : text;
}

/** One list keyed by improvement ID from both endpoints; business-value items add detail. */
export function mergeImprovements(recommendations: QualityImprovements | null | undefined, businessValue: QualityBusinessValue | null | undefined): Improvement[] {
    const items: Improvement[] = [];
    const seen = new Map<string, Improvement>();
    const businessItems = Array.isArray(businessValue) ? businessValue : (businessValue?.improvements ?? []);
    for (const raw of [...(recommendations?.improvements ?? []), ...businessItems]) {
        const id = String(raw.id || raw.title || '').trim();
        if (!id) continue;
        const existing = seen.get(id);
        if (existing) {
            if (!existing.detail && raw.descriptionDetail) existing.detail = trimText(raw.descriptionDetail);
            if (existing.valueLift == null && raw.valueLift != null) existing.valueLift = raw.valueLift;
            continue;
        }
        const item: Improvement = {
            id,
            title: String(raw.title || id),
            description: trimText(raw.description),
            detail: raw.descriptionDetail ? trimText(raw.descriptionDetail) : '',
            valueLift: raw.valueLift ?? null,
        };
        seen.set(id, item);
        items.push(item);
    }
    return items;
}

/**
 * Why Apify has no real score yet. The extension also reads `firstPublishedAt` to spot actors published
 * under a day ago; this server does not fetch basic-info, so it uses the Store listing for "public".
 */
export function pendingReason(scores: Record<string, number> | null, isPublic: boolean): PendingReason | null {
    if (!isPublic) return 'unpublished';
    if (!scores || finite(scores.actorQuality) == null) return 'unscored';
    return null;
}

/** A pending actor keeps no scores or suggestions, so placeholders never reach the inbox or medians. */
export function compactEntry(
    actorId: string,
    { scores, recommendations, businessValue }: { scores: QualityScores | null; recommendations: QualityImprovements | null; businessValue: QualityBusinessValue | null },
    isPublic: boolean,
): QualityEntry {
    const compact = compactScores(scores);
    const pending = pendingReason(compact, isPublic);
    return {
        id: actorId,
        scores: pending ? null : compact,
        improvements: pending ? [] : mergeImprovements(recommendations, businessValue),
        praises: pending ? [] : (recommendations?.praises ?? []).map((item) => String(item.title || '')).filter(Boolean).slice(0, 6),
        pending,
    };
}

function monthDays(now: number): number {
    const date = new Date(now);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Month-to-date projected to a full month, once enough of it has passed. */
export function pace(value: number, now: number): number {
    const day = new Date(now).getUTCDate();
    if (day < PACE_MIN_DAY) return 0;
    return (number(value) * monthDays(now)) / day;
}

/** Last month's and this month's actor-breakdown rows as per-actor traffic. */
export function trafficFromMoney(previous: ActorMoney[] | null, current: ActorMoney[] | null): Map<string, ActorTraffic> {
    const traffic = new Map<string, ActorTraffic>();
    const add = (rows: ActorMoney[] | null, slot: keyof ActorTraffic) => {
        for (const row of rows ?? []) {
            const target = traffic.get(row.id) ?? { previous: null, current: null };
            target[slot] = { revenue: row.revenueUsd, runs: row.runs, payingUsers: number(row.payingUsers), users: number(row.payingUsers) + number(row.freeUsers) };
            traffic.set(row.id, target);
        }
    };
    add(previous, 'previous');
    add(current, 'current');
    return traffic;
}

/** max(1, revenue x 100 + runs x 0.1 + paying users x 10 + users x 0.5), each the larger of last month and this month's pace. */
export function trafficWeight(traffic: ActorTraffic | undefined, now: number): number {
    const best = (key: keyof Traffic) => Math.max(number(traffic?.previous?.[key]), pace(number(traffic?.current?.[key]), now));
    return Math.max(1, best('revenue') * 100 + best('runs') * 0.1 + best('payingUsers') * 10 + best('users') * 0.5);
}

export interface InboxItem<A> {
    actor: A;
    entry: QualityEntry;
    improvement: Improvement;
    group: WorkGroup;
    impact: number;
    traffic: number;
    level: ImpactLevel;
}

/** Relative to the given items: top 20% High, next 30% Medium, rest Low; zero-traffic actors always Low. */
export function assignImpactLevels<T extends { impact: number; traffic: number; level: ImpactLevel }>(items: T[]): void {
    const ranked = items.filter((item) => item.traffic > 1).sort((left, right) => right.impact - left.impact);
    const high = Math.ceil(ranked.length * 0.2);
    const medium = Math.ceil(ranked.length * 0.5);
    for (const item of items) item.level = 'low';
    ranked.forEach((item, index) => {
        item.level = index < high ? 'high' : index < medium ? 'medium' : 'low';
    });
}

export interface InboxIssue<A> {
    id: string;
    title: string;
    description: string;
    group: WorkGroup;
    items: InboxItem<A>[];
    impact: number;
    /** The highest level among its actors. */
    level: ImpactLevel;
}

const LEVEL_RANK: Record<ImpactLevel, number> = { high: 2, medium: 1, low: 0 };

/**
 * Every suggestion with its impact level, ranked across actors, plus the same suggestion grouped across
 * actors ("Fix Actor health issues" on 8 of them), ordered by total impact.
 */
export function buildInbox<A extends { id: string; name: string }>(
    actors: A[],
    entries: Map<string, QualityEntry>,
    trafficById: Map<string, ActorTraffic>,
    now: number,
): { items: InboxItem<A>[]; issues: InboxIssue<A>[]; actorsWithSuggestions: number; actorsToFix: number } {
    const items: InboxItem<A>[] = [];
    const withSuggestions = new Set<string>();
    const toFix = new Set<string>();
    for (const actor of actors) {
        const entry = entries.get(actor.id);
        if (!entry || entry.pending) continue;
        const weight = trafficWeight(trafficById.get(actor.id), now);
        for (const improvement of entry.improvements) {
            const group = groupFor(improvement.id);
            withSuggestions.add(actor.id);
            if (!group.hidden) toFix.add(actor.id);
            items.push({ actor, entry, improvement, group, impact: group.weight * weight, traffic: weight, level: 'low' });
        }
    }
    assignImpactLevels(items);
    items.sort((left, right) => right.impact - left.impact || left.actor.name.localeCompare(right.actor.name));
    return { items, issues: issuesFrom(items), actorsWithSuggestions: withSuggestions.size, actorsToFix: toFix.size };
}

export function issuesFrom<A>(items: InboxItem<A>[]): InboxIssue<A>[] {
    const issues = new Map<string, InboxIssue<A>>();
    for (const item of items) {
        const key = `${item.group.key}:${item.improvement.id}`;
        let issue = issues.get(key);
        if (!issue) {
            issue = { id: item.improvement.id, title: item.improvement.title, description: item.improvement.detail || item.improvement.description, group: item.group, items: [], impact: 0, level: 'low' };
            issues.set(key, issue);
        }
        issue.items.push(item);
        issue.impact += item.impact;
        if (LEVEL_RANK[item.level] > LEVEL_RANK[issue.level]) issue.level = item.level;
    }
    for (const issue of issues.values()) issue.items.sort((left, right) => right.impact - left.impact);
    return [...issues.values()].sort((left, right) => right.impact - left.impact || right.items.length - left.items.length || left.title.localeCompare(right.title));
}

export function median(values: number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
