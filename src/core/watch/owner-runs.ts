import { OWNER_EXCLUSION } from './constants.js';
import type { OwnerDay, OwnerRuns } from './types.js';

// The owner's own runs of their own actors (public API `/v2/actor-runs`, which lists only runs the
// account started). Two uses:
//  1. Owner-run exclusion (plan amendment 1). A paid-plan owner who test-runs an actor shows up in the
//     Console as one "paying user" who is never charged. A month is excluded when its only paying user
//     looks like the owner: exactly 1 paying user, under $0.01 revenue, the owner ran the actor that
//     month, and the Console run count is either exactly the owner's count (no free users) or at least
//     the owner's count with free users present. CAVEAT: this is a heuristic inferred from run counts; the
//     Console does not say which paying user ran which run. False negative: a real buyer whose runs are
//     never charged (a real charge bug) is hidden whenever the owner also ran the actor that month, and
//     with free users present the match is weaker still. The 4-week calibration review must check every
//     exclusion listed in the digest and in alerts.jsonl against later revenue that was not the owner's.
//  2. Failure counts net of the owner's own test runs (R4), so debugging runs do not page.

export interface RunListItem {
    actId: string;
    status: string;
    startedAt: string;
}

/** Counts per actor per UTC start day, for the given actor IDs only. */
export function aggregateOwnerRuns(items: RunListItem[], ownActorIds: Set<string>): OwnerRuns {
    const out: OwnerRuns = {};
    for (const item of items) {
        if (!ownActorIds.has(item.actId) || typeof item.startedAt !== 'string') continue;
        const day = item.startedAt.slice(0, 10);
        const actor = (out[item.actId] ??= {});
        const counts = (actor[day] ??= { runs: 0, failed: 0, timedOut: 0 });
        counts.runs++;
        if (item.status === 'FAILED') counts.failed++;
        if (item.status === 'TIMED-OUT') counts.timedOut++;
    }
    return out;
}

/** Owner runs of one actor over the days whose ends fall in (from, to]. */
export function ownerRunsIn(days: Record<string, OwnerDay> | undefined, from: number, to: number): OwnerDay {
    const sum = { runs: 0, failed: 0, timedOut: 0 };
    for (const [day, counts] of Object.entries(days ?? {})) {
        const end = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
        if (end > from && end <= to) {
            sum.runs += counts.runs;
            sum.failed += counts.failed;
            sum.timedOut += counts.timedOut;
        }
    }
    return sum;
}

export function ownerRunsInMonth(days: Record<string, OwnerDay> | undefined, month: string, upToMs = Infinity): number {
    let runs = 0;
    for (const [day, counts] of Object.entries(days ?? {})) {
        if (day.startsWith(month) && Date.parse(`${day}T00:00:00Z`) < upToMs) runs += counts.runs;
    }
    return runs;
}

export interface MonthUsers {
    payingUsers: number | null;
    freeUsers: number | null;
    revenueUsd: number;
    runs: number;
}

export type ExclusionStrength = 'exact' | 'probable';

/** Whether this month's only paying user looks like the owner (see the caveat above). */
export function ownerRunExclusion(month: MonthUsers | null, ownerRuns: number): ExclusionStrength | null {
    if (!month || month.payingUsers !== 1 || month.revenueUsd >= OWNER_EXCLUSION.maxRevenueUsd || ownerRuns < 1) return null;
    if ((month.freeUsers ?? 0) === 0) return month.runs === ownerRuns ? 'exact' : null;
    return month.runs >= ownerRuns ? 'probable' : null;
}

/** Paying users with the owner taken out when the exclusion applies. */
export function effectivePayingUsers(month: MonthUsers | null, ownerRuns: number): { count: number | null; excluded: ExclusionStrength | null } {
    if (!month || month.payingUsers == null) return { count: null, excluded: null };
    const excluded = ownerRunExclusion(month, ownerRuns);
    return { count: excluded ? month.payingUsers - 1 : month.payingUsers, excluded };
}

export const OWNER_EXCLUSION_CAVEAT =
    'Heuristic: the Console does not say which paying user ran which run. A month is excluded when its only paying user looks like your own account (1 paying user, under $0.01 revenue, and the run count matches your own runs). A real buyer whose runs are never charged can hide behind this; check each excluded actor at the 4-week review.';
