// Data shapes of the early-warning watch. Everything on disk holds actor IDs, actor names and numbers
// only: never a token, never a request header, never a user identity.

/** Additive per-actor counters. Money is paying-users money; run counts cover every run of the actor. */
export interface Values {
    rev: number;
    cost: number;
    runs: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    aborted: number;
    results: number;
}

export const VALUE_KEYS = ['rev', 'cost', 'runs', 'succeeded', 'failed', 'timedOut', 'aborted', 'results'] as const satisfies readonly (keyof Values)[];

/** One actor's month-to-date Console row, slimmed. */
export interface SlimRow extends Values {
    id: string;
    name: string;
    notice: string | null;
    charged: number | null;
    payingUsers: number | null;
    freeUsers: number | null;
    model: string | null;
}

/** Public Store stats for one actor (no session needed). */
export interface StoreRow {
    id: string;
    name: string;
    users7d: number | null;
    users30d: number | null;
    users90d: number | null;
    notice: string | null;
    runs30d: { runs: number; failed: number; timedOut: number; aborted: number } | null;
}

/** Runs the owner started of their own actors on one UTC day (public API, `/v2/actor-runs`). */
export interface OwnerDay {
    runs: number;
    failed: number;
    timedOut: number;
}

export type OwnerRuns = Record<string, Record<string, OwnerDay>>;

export interface MarketingRow {
    viewers: number | null;
    starters: number | null;
    previousViewers: number | null;
    previousStarters: number | null;
    /** Share (0-1) of traffic from CN with no referrer, when the Console says. */
    cnNoReferrerShare: number | null;
}

export interface Weekly {
    marketing: Record<string, MarketingRow>;
    userCountActors: string[];
}

export type ConsoleOutcome = 'ok' | 'bridge_missing' | 'warming_up' | 'other_account' | 'logged_out' | 'endpoint_changed' | 'error';

export interface Snapshot {
    version: 1;
    takenAt: string;
    day: string;
    month: string;
    rulesVersion: string;
    console: ConsoleOutcome;
    breakdown: SlimRow[] | null;
    prevMonthFinal: { month: string; rows: SlimRow[] } | null;
    store: StoreRow[] | null;
    weekly: Weekly | null;
    /** Step names and error codes only. */
    errors: string[];
}

/** A cumulative month-to-date reading of the Console rows, from a snapshot. */
export interface Reading {
    month: string;
    takenAt: number;
    close: boolean;
    rows: SlimRow[];
}

/** Exact daily values from the one-time backfill (per-actor profit-margin and run statistics). */
export interface BackfillMonth {
    version: 1;
    month: string;
    fetchedAt: string;
    /** First UTC day covered (always the month's first day) and the day after the last complete one. */
    from: string;
    through: string;
    actors: Record<string, { name: string; days: Record<string, Values> }>;
    /** The month's breakdown rows as fetched (final for a finished month). */
    rows: SlimRow[];
}

export type FactSource = 'delta' | 'close' | 'backfill';

export interface Fact extends Values {
    t0: string;
    t1: string;
    days: number;
    id: string;
    name: string;
    charged: number | null;
    src: FactSource;
}

/** Daily paying and free users per actor (`user-count-statistics`). */
export type UsersDaily = Record<string, Record<string, { paying: number; free: number }>>;

export type Tier = 'PAGE' | 'WATCH' | 'info';

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'no_revenue' | 'burst_started' | 'burst_ended' | 'reversal';

export interface Signal {
    rule: RuleId;
    /** Distinguishes variants of one rule that are tracked separately (e.g. R2 buyer quiet vs paying-user drop). */
    variant?: string;
    tier: Tier;
    /** Keep an open alert open, but never open a new one (hysteresis). */
    hold?: boolean;
    /** Weekly money at stake, used to order the digest and to detect worsening. */
    atStakeUsd: number;
    title: string;
    evidence: string;
    numbers: Record<string, number | string | boolean | null>;
    source: string;
    next: string;
    approximate?: boolean;
    ownerRunExclusion?: boolean;
}

export interface ActorSignals {
    id: string;
    name: string;
    signals: Signal[];
    class: string | null;
    exclusions: string[];
}

export interface Alert {
    key: string;
    actorId: string;
    name: string;
    rule: RuleId;
    variant: string | null;
    tier: Tier;
    firstSeen: string;
    lastSeen: string;
    lastNotified: string | null;
    notifiedAtStakeUsd: number | null;
    atStakeUsd: number;
    reminded: boolean;
    backlog: boolean;
    title: string;
    evidence: string;
    next: string;
}

export interface ResolvedAlert {
    key: string;
    name: string;
    rule: RuleId;
    tier: Tier;
    firstSeen: string;
    resolvedAt: string;
    reported: boolean;
}

export interface Snooze {
    actorId: string;
    name: string;
    rule: RuleId | null;
    until: string;
}

export interface WatchState {
    version: 1;
    installedAt: string;
    rulesVersion: string;
    open: Record<string, Alert>;
    resolved: ResolvedAlert[];
    snoozes: Snooze[];
    lastRun: { at: string; console: ConsoleOutcome; errors: string[]; digest: string | null; notified: boolean } | null;
    lastConsoleOkAt: string | null;
    lastNotifiedDay: string | null;
    blindNotifiedAt: string | null;
    /** Keys of R8 concentration entries already reported, so only new ones become WATCH items. */
    concentration: string[];
}

export interface AlertEvent {
    t: string;
    event: 'open' | 'upgrade' | 'worse' | 'remind' | 'resolve';
    key: string;
    actor: string;
    rule: RuleId;
    tier: Tier;
    atStakeUsd: number;
    backlog: boolean;
    snoozed: boolean;
    rulesVersion: string;
    evidence: string;
    ownerRunExclusion?: boolean;
}

export interface WatchConfig {
    /** Actor names (exact or substring, case-insensitive) or IDs the watch skips entirely. */
    ignore: string[];
    /** Optional map of actor name → same-site rival actors (`username/name`) for drill-downs. */
    rivals: Record<string, string[]>;
    /** Optional absolute path the latest digest is copied to (for example a git-excluded notes folder). */
    digestCopyPath: string | null;
    /** Send macOS notifications (default true on macOS). */
    notifications: boolean;
    /** Optional text appended to a rule's next action, e.g. the owner's own skill or runbook; `<actor>` is replaced. */
    extraNext: Partial<Record<RuleId, string>>;
}
