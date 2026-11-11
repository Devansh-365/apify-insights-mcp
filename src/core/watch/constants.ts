// Early-warning watch (experimental): every threshold in one place. Starting values approved by the
// owner on 2026-11-11 (R1 steady -35% and a $5/week floor, R4 10% and 5 failures, R7 $1/day), to be
// reviewed after 4 weeks of alerts.jsonl. Bump RULES_VERSION whenever a rule or threshold changes:
// every digest prints it, so alerts from different rule sets are never compared blindly.

export const RULES_VERSION = 'w1';

/** The feature is off unless this is "1" or the CLI gets `--experimental`. */
export const WATCH_FLAG_ENV = 'APIFY_INSIGHTS_WATCH';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const WEEK_MS = 7 * DAY_MS;

/** A fact spanning more than this many days is spread evenly over its span (and marked approximate). */
export const SPREAD_ABOVE_DAYS = 1.5;

/** A day with at least this much paying-users revenue is a "revenue day". */
export const REVENUE_DAY_USD = 0.05;

export const BASELINE = { windows: 8, minWindows: 4, minCoverage: 0.5 } as const;

export const CLASS = { steadyDays: 35, steadyPeak: 0.4, burstyDays: 14, burstyPeak: 0.6, peakMinTotalUsd: 5 } as const;

/** Actors that may PAGE on R1/R3/R4: revenue over 35 days, or several paying users with some revenue. */
export const POOL = { days: 35, revenueUsd: 3, payingUsers: 3, payingRevenueUsd: 0.5 } as const;

export const R1 = { steadyRatio: 0.65, intermittentRatio: 0.5, minGapUsd: 5, resolveRatio: 0.8, burstRatio: 3, burstPlusUsd: 15, burstEndRatio: 1.5 } as const;

export const R2 = { pudRatio: 0.5, pudMinMedian: 4, quietDays: 14, quietRevenueDays: 4, quietRevenueUsd: 5, monthlyRatio: 0.5, monthlyMinPrevious: 3, watchedActors: 30 } as const;

export const R3 = { minRuns: 50, priorDays: 28, runBandLow: 0.75, runBandHigh: 1.25, yieldRatio: 0.75, holdRatio: 0.85 } as const;

export const R4 = {
    minFailures: 5,
    minRate: 0.1,
    priorDays: 28,
    quietPriorRate: 0.05,
    spikeMultiple: 2,
    fastDays: 2,
    fastFailures: 5,
    fastRate: 0.25,
    timeoutShare: 0.5,
    holdRate: 0.05,
    holdFailures: 3,
} as const;

export const R5 = { users30d: 3, revenue56Usd: 1, remindDays: 7 } as const;

export const R6 = { minDay: 8, viewers: 30, previousStarters: 4, rateRatio: 0.5, minPointDrop: 3, cnShare: 0.5, actors: 30 } as const;

export const R7 = { day1LossUsd: 1, day3LossUsd: 2, day7LossUsd: 3, thinRevenueUsd: 5, thinMargin: 0.2, holdLossUsd: 1 } as const;

export const R8 = { revenue56Usd: 20, peakShare: 0.6, maxPayingUsers: 2 } as const;

export const NO_REVENUE = { minRuns: 10, maxRevenueUsd: 0.005 } as const;

/** Owner-run exclusion: a month whose only paying user looks like the owner's own account. */
export const OWNER_EXCLUSION = { maxRevenueUsd: 0.01 } as const;

export const NOTIFY = { worseRatio: 1.5, remindDays: 14 } as const;

export const DIGEST = { maxPage: 5, maxWatch: 10, maxInfo: 10, keepDays: 180, resolvedKeepDays: 30 } as const;

export const RETENTION = { snapshotDays: 400 } as const;

/** Console money missing this long is itself an alert. */
export const BLIND_HOURS = 48;

/** How long `watch run` waits for the bridge to deliver a fresh Console session. */
export const SESSION_WAIT_MS = 180_000;

/** Days 1..CLOSE_DAYS of a month also fetch the previous month's final rows (late usage still lands). */
export const CLOSE_DAYS = 4;

export const BACKFILL = { defaultDays: 63, minRevenueUsd: 1, minCostUsd: 1, minFailures: 5 } as const;

export const LOG = { maxBytes: 1_000_000, keep: 2 } as const;

/** Order in which an item's next action is chosen (most urgent first). */
export const URGENCY = ['R7', 'R5', 'R4', 'R3', 'R1', 'R2', 'R6', 'R8', 'no_revenue', 'burst_started', 'burst_ended', 'reversal'] as const;
