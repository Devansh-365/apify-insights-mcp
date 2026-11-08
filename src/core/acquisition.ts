import type { Marketing } from '../clients/console.js';

// Acquisition triage, ported from the Apify Insights Plus extension (lib/acquisition-triage.js): each
// actor goes into one bucket (Leaking, Rising, Fading, Converting, Steady, Quiet) from its detail-page
// viewers, input-page viewers and starters, with a plain-language reason. Same constants, same rules,
// same wording. Pure: no network, no state. Snapshots and "changed since last scan" stay in the extension.

// Month-over-month change is too noisy to judge during the first week.
export const CHANGE_MIN_DAY = 8;
// Absolute floors under the percentile thresholds, so a handful of viewers never counts as real volume
// and 2 -> 4 viewers is never a surge.
export const MIN_VIEWERS = 3;
export const MIN_LEAK_VIEWERS = 10;
export const MIN_STARTERS = 2;
export const MIN_VIEWER_SHIFT = 5;
export const RISE_MIN = 0.3;
export const FALL_MIN = -0.25;
// Below these, Rising still warns about the funnel and Leaking blames the listing (few viewers reach the
// input page) rather than the input.
export const LOW_CONVERSION = 0.05;
export const FEW_REACH_INPUT = 0.15;

export type BucketKey = 'leaking' | 'rising' | 'fading' | 'converting' | 'steady' | 'quiet';

export interface Bucket {
    key: BucketKey;
    label: string;
    action: string;
}

/** In priority order: a leaking funnel is fixed before traffic is pushed at it. */
export const BUCKETS: readonly Bucket[] = [
    { key: 'leaking', label: 'Leaking', action: 'Fix the listing' },
    { key: 'rising', label: 'Rising', action: 'Market it more' },
    { key: 'fading', label: 'Fading', action: 'Find out why' },
    { key: 'converting', label: 'Converting', action: 'Double down' },
    { key: 'steady', label: 'Steady', action: 'Nothing to do' },
    { key: 'quiet', label: 'Quiet', action: 'Too little traffic to judge' },
];

export interface AcquisitionEntry {
    viewers: number | null;
    inputViewers: number | null;
    starters: number | null;
    prevViewers: number | null;
    prevInputViewers: number | null;
    prevStarters: number | null;
}

export interface Thresholds {
    viewerFloor: number;
    leakFloor: number;
    /** Conversion (0-1, capped) at the 25th and 75th percentile of actors at or above viewerFloor. */
    conversionLow: number;
    conversionHigh: number;
    sample: number;
}

export type ViewerChange = number | 'new' | null;

export interface Assignment {
    key: BucketKey;
    reason: string;
    /** Capped at 1. Internal to bucketing; tools output the uncapped viewToRunPct from funnel(). */
    rate: number | null;
    viewerChange: ViewerChange;
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number | null {
    const result = finite(value);
    return result == null ? null : Math.max(0, result);
}

function formatCount(value: number | null | undefined): string {
    return Number(value || 0).toLocaleString('en-US');
}

export function formatRate(value: number): string {
    const percent = value * 100;
    if (percent > 0 && percent < 1) return '<1%';
    return `${percent < 10 ? percent.toFixed(1).replace(/\.0$/, '') : Math.round(percent)}%`;
}

function plural(value: number, one: string, many: string): string {
    return `${formatCount(value)} ${value === 1 ? one : many}`;
}

/** Same rule as the extension's portfolio page, so thresholds read the same. */
export function percentile(values: number[], fraction: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

/** One actor's monthly-marketing response, plus last month's at the same point (null when not fetched). */
export function compactEntry(data: Marketing | null, previous: Marketing | null): AcquisitionEntry {
    return {
        viewers: count(data?.numUniqueViewingUsers),
        inputViewers: count(data?.numUniqueConsolePageViews),
        starters: count(data?.numUniqueUsersWithRun),
        prevViewers: count(previous?.numUniqueViewingUsers),
        prevInputViewers: count(previous?.numUniqueConsolePageViews),
        prevStarters: count(previous?.numUniqueUsersWithRun),
    };
}

/** Relative change, "new" when last month was zero, null when unknown. */
export function change(current: number | null, previous: number | null): ViewerChange {
    if (current == null || previous == null) return null;
    if (previous === 0) return current === 0 ? 0 : 'new';
    return (current - previous) / previous;
}

/** Starters can exceed viewers (API and scheduled runs never open the page), so the rate is capped at 100%. */
export function conversion(entry: AcquisitionEntry | null): number | null {
    if (!entry || !entry.viewers || entry.starters == null) return null;
    return Math.min(1, entry.starters / entry.viewers);
}

/** Rising and Fading compare with the same point last month, which means little in the first week. */
export function isEarlyMonth(month: string, now: number): boolean {
    const date = new Date(now);
    const current = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    return month.slice(0, 7) === current && date.getUTCDate() < CHANGE_MIN_DAY;
}

/** Volume and conversion thresholds relative to the given actors. */
export function computeThresholds(entries: AcquisitionEntry[]): Thresholds {
    const usable = entries.filter((entry) => entry.viewers != null);
    const viewed = usable.map((entry) => entry.viewers!).filter((value) => value > 0);
    const viewerFloor = Math.max(MIN_VIEWERS, Math.round(percentile(viewed, 0.25)));
    const leakFloor = Math.max(MIN_LEAK_VIEWERS, Math.round(percentile(viewed, 0.5)));
    const rates = usable
        .filter((entry) => entry.viewers! >= viewerFloor)
        .map(conversion)
        .filter((value): value is number => value != null);
    return { viewerFloor, leakFloor, conversionLow: percentile(rates, 0.25), conversionHigh: percentile(rates, 0.75), sample: rates.length };
}

function changeText(value: number): string {
    return `${value > 0 ? 'up' : 'down'} ${formatRate(Math.abs(value))}`;
}

/** First match wins: Leaking, Rising, Fading, Converting, Steady, Quiet. */
export function assignBucket(entry: AcquisitionEntry | null, thresholds: Thresholds, { early = false }: { early?: boolean } = {}): Assignment {
    if (!entry || entry.viewers == null) return { key: 'quiet', reason: 'No acquisition data this month', rate: null, viewerChange: null };
    const t = thresholds;
    const viewers = entry.viewers;
    const starters = entry.starters ?? 0;
    const rate = conversion(entry);
    const viewerChange = change(viewers, entry.prevViewers);
    const shift = entry.prevViewers == null ? 0 : viewers - entry.prevViewers;
    const result = (key: BucketKey, reason: string): Assignment => ({ key, reason, rate, viewerChange });

    if (viewers >= t.leakFloor && starters <= viewers && (starters < MIN_STARTERS || (rate ?? 0) < t.conversionLow)) {
        const reachInput = entry.inputViewers == null ? null : entry.inputViewers / viewers;
        const where =
            reachInput != null && reachInput < FEW_REACH_INPUT
                ? 'few reach the input page, so check the README, title, and pricing'
                : "they reach the input page but don't start, so check input defaults and required fields";
        return result('leaking', `${formatCount(viewers)} viewers, ${formatCount(starters)} started (${formatRate(rate || 0)}): ${where}`);
    }
    if (!early && viewers >= t.viewerFloor && (viewerChange === 'new' || (viewerChange != null && viewerChange >= RISE_MIN)) && shift >= MIN_VIEWER_SHIFT) {
        const weak = rate != null && rate < LOW_CONVERSION ? `; only ${formatRate(rate)} start it, so fix the listing too` : '';
        const growth =
            viewerChange === 'new'
                ? `${plural(viewers, 'viewer', 'viewers')}, none at this point last month`
                : `Viewers ${changeText(viewerChange as number)} (${formatCount(entry.prevViewers)} → ${formatCount(viewers)})`;
        return result('rising', `${growth}${weak}`);
    }
    // max(): an actor whose viewers fell below the floor this month is still Fading.
    if (!early && Math.max(viewers, entry.prevViewers || 0) >= t.viewerFloor && typeof viewerChange === 'number' && viewerChange <= FALL_MIN && -shift >= MIN_VIEWER_SHIFT) {
        return result('fading', `Viewers ${changeText(viewerChange)} (${formatCount(entry.prevViewers)} → ${formatCount(viewers)})`);
    }
    if (viewers >= t.viewerFloor && starters >= MIN_STARTERS && t.conversionHigh > 0 && rate != null && rate >= t.conversionHigh) {
        return result('converting', `${formatRate(rate)} of viewers start it (${formatCount(starters)} of ${formatCount(viewers)}), top quarter of your Actors`);
    }
    if (viewers >= t.viewerFloor) {
        return result('steady', `${plural(viewers, 'viewer', 'viewers')}, ${formatCount(starters)} started, no strong signal`);
    }
    return result('quiet', viewers ? `Only ${plural(viewers, 'viewer', 'viewers')} this month` : 'No viewers this month');
}

/** Within a bucket, the actor with the most at stake comes first. */
export function sortValue(key: BucketKey, entry: AcquisitionEntry): number {
    const viewers = entry.viewers || 0;
    const previous = entry.prevViewers || 0;
    if (key === 'rising') return viewers - previous;
    if (key === 'fading') return previous - viewers;
    if (key === 'converting') return entry.starters || 0;
    return viewers;
}

export interface TriageItem<A> extends Assignment {
    actor: A;
    entry: AcquisitionEntry;
}

export interface TriageBucket<A> extends Bucket {
    items: TriageItem<A>[];
    viewers: number;
}

/** Buckets in priority order, each sorted by what is at stake. Only actors with an entry are placed. */
export function buildTriage<A extends { id: string; name: string }>(
    actors: A[],
    entries: Map<string, AcquisitionEntry>,
    thresholds: Thresholds,
    { early = false }: { early?: boolean } = {},
): { buckets: TriageBucket<A>[]; scanned: number; viewers: number } {
    const buckets = new Map(BUCKETS.map((bucket) => [bucket.key, { ...bucket, items: [] as TriageItem<A>[], viewers: 0 }]));
    let scanned = 0;
    let viewers = 0;
    for (const actor of actors) {
        const entry = entries.get(actor.id);
        if (!entry) continue;
        scanned++;
        const assigned = assignBucket(entry, thresholds, { early });
        const bucket = buckets.get(assigned.key)!;
        bucket.items.push({ actor, entry, ...assigned });
        bucket.viewers += entry.viewers || 0;
        viewers += entry.viewers || 0;
    }
    for (const bucket of buckets.values()) {
        bucket.items.sort((left, right) => sortValue(right.key, right.entry) - sortValue(left.key, left.entry) || left.actor.name.localeCompare(right.actor.name));
    }
    return { buckets: [...buckets.values()], scanned, viewers };
}
