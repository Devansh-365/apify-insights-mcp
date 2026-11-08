import type { RunCounts } from '../clients/apifyApi.js';

// Flag rules, plan §6. `failing` is ported from apify-insights-plus lib/portfolio.js so the extension and
// this server agree: failed + timed-out runs count, aborted runs do not (users abort on purpose).
export const FAILURE_RATE = 0.05;
export const MIN_FAILURES = 3;

export type FlagName = 'flagged' | 'failing';

export interface Flag {
    flag: FlagName;
    rule: string;
    evidence: Record<string, number | string>;
}

export interface RunHealth {
    runs: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    aborted: number;
    failures: number;
    failureRate: number | null;
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Same arithmetic as the extension's runStatusCounts: FAILED is derived when the response leaves it out. */
export function runHealth(counts: RunCounts | undefined | null): RunHealth | null {
    if (!counts) return null;
    const runs = count(counts.TOTAL);
    const succeeded = count(counts.SUCCEEDED);
    const aborted = count(counts.ABORTED);
    const timedOut = count(counts['TIMED-OUT']);
    const failed = counts.FAILED == null ? Math.max(0, runs - succeeded - aborted - timedOut) : count(counts.FAILED);
    const failures = failed + timedOut;
    return { runs, succeeded, failed, timedOut, aborted, failures, failureRate: runs ? failures / runs : null };
}

export function noticeFlag(notice: string | undefined | null): Flag | null {
    if (!notice || notice === 'NONE') return null;
    return { flag: 'flagged', rule: 'Apify has set a notice on this actor (e.g. UNDER_MAINTENANCE)', evidence: { notice } };
}

export function failingFlag(health: RunHealth | null, window: string): Flag | null {
    if (!health || health.failureRate == null) return null;
    if (health.failures < MIN_FAILURES || health.failureRate < FAILURE_RATE) return null;
    return {
        flag: 'failing',
        rule: `At least ${MIN_FAILURES} failed or timed-out runs and a ${FAILURE_RATE * 100}%+ failure rate (aborted runs excluded)`,
        evidence: {
            window,
            runs: health.runs,
            failed: health.failed,
            timedOut: health.timedOut,
            failureRatePct: Math.round(health.failureRate * 1000) / 10,
        },
    };
}
