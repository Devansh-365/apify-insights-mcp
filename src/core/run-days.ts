import type { RunStatistics } from '../clients/console.js';
import { round } from './envelope.js';
import { daysInRange, monthOf, type Period } from './period.js';

// Runs per UTC day by status, from Console run statistics. Pure functions; the tool does the fetching.

export interface DayCounts {
    date: string;
    runs: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    aborted: number;
}

export interface RunTotals {
    runs: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    aborted: number;
    /** (failed + timed out) ÷ runs, aborted excluded; null when there were no runs. */
    failureRatePct: number | null;
}

function n(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** One day's counts. A missing FAILED is the remainder after the other statuses, as the extension reads it. */
export function statusCounts(date: string, stat: Record<string, unknown> | undefined): DayCounts {
    const runs = n(stat?.TOTAL);
    if (!runs) return { date, runs: 0, succeeded: 0, failed: 0, timedOut: 0, aborted: 0 };
    const succeeded = n(stat?.SUCCEEDED);
    const aborted = n(stat?.ABORTED);
    const timedOut = n(stat?.['TIMED-OUT']);
    const failed = stat?.FAILED == null ? Math.max(0, runs - succeeded - aborted - timedOut) : n(stat.FAILED);
    return { date, runs, succeeded, failed, timedOut, aborted };
}

/** Failed + timed out. Aborted runs are left out: users often abort on purpose. */
export function problems(counts: { failed: number; timedOut: number }): number {
    return counts.failed + counts.timedOut;
}

export function failureRatePct(counts: { runs: number; failed: number; timedOut: number }): number | null {
    return counts.runs ? round((problems(counts) / counts.runs) * 100, 1) : null;
}

/** Counts for each requested day, zeros where the Console has no entry. */
export function daysOf(stats: RunStatistics[], days: string[]): DayCounts[] {
    const merged: Record<string, Record<string, unknown>> = {};
    for (const month of stats) Object.assign(merged, month.dailyStats);
    return days.map((day) => statusCounts(day, merged[day]));
}

export function totalsOf(days: DayCounts[]): RunTotals {
    const sum = { runs: 0, succeeded: 0, failed: 0, timedOut: 0, aborted: 0 };
    for (const day of days) {
        sum.runs += day.runs;
        sum.succeeded += day.succeeded;
        sum.failed += day.failed;
        sum.timedOut += day.timedOut;
        sum.aborted += day.aborted;
    }
    return { ...sum, failureRatePct: failureRatePct(sum) };
}

/** The day with the most failed + timed-out runs (the later one on a tie), or null when there were none. */
export function worstDay(days: DayCounts[]): DayCounts | null {
    let worst: DayCounts | null = null;
    for (const day of days) if (problems(day) > 0 && (!worst || problems(day) >= problems(worst))) worst = day;
    return worst;
}

export function problemDays(days: DayCounts[]): DayCounts[] {
    return days.filter((day) => problems(day) > 0);
}

export interface DayWindow {
    /** The period's days, oldest first. */
    days: string[];
    today: string;
    /** Today is the period's last day (partial). Otherwise today is reported on its own. */
    todayInPeriod: boolean;
    /** Months to fetch: the period's plus the current month, oldest first. */
    months: string[];
}

/**
 * Today rules: a period that reaches today ends with today (partial, counted in totals); a period that
 * ended earlier leaves today out of its totals, and today is fetched and reported separately.
 */
export function dayWindow(period: Period, today: string): DayWindow {
    const todayInPeriod = period.to >= today;
    const months = [...period.months];
    if (!months.includes(monthOf(today))) months.push(monthOf(today));
    return { days: daysInRange(period.from, todayInPeriod ? today : period.to), today, todayInPeriod, months };
}
