import { z } from 'zod';
import { ToolError } from './envelope.js';

// Periods are UTC calendar days. Days are inclusive; "complete" means the day has ended.

export const periodInput = z
    .union([
        z.enum(['today', 'yesterday', 'last7d', 'last30d', 'thisMonth', 'lastMonth']),
        z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM'),
        z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    ])
    .describe('today | yesterday | last7d | last30d (both end yesterday) | thisMonth | lastMonth | "YYYY-MM" | {from, to} (YYYY-MM-DD, max 12 months)');

export type PeriodInput = z.infer<typeof periodInput>;

export interface Period {
    label: string;
    from: string;
    to: string;
    /** Months the period touches, as YYYY-MM, oldest first. */
    months: string[];
    /** Exactly one whole calendar month (possibly the current, unfinished one). */
    wholeMonth: string | null;
    /** Includes today or a day that has not ended. */
    partial: boolean;
}

const DAY = 86_400_000;

export function isoDay(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

function parseDay(day: string): number {
    const ms = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(ms) || isoDay(ms) !== day) throw new ToolError('period_invalid', `"${day}" is not a valid date.`, 'Use YYYY-MM-DD.');
    return ms;
}

export function monthOf(day: string): string {
    return day.slice(0, 7);
}

export function monthStart(month: string): string {
    return `${month}-01`;
}

export function monthEnd(month: string): string {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return isoDay(Date.UTC(y, m, 0));
}

export function addMonths(month: string, delta: number): string {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

export function daysInRange(from: string, to: string): string[] {
    const days: string[] = [];
    for (let t = parseDay(from); t <= parseDay(to); t += DAY) days.push(isoDay(t));
    return days;
}

function build(label: string, from: string, to: string, today: string): Period {
    if (from > to) throw new ToolError('period_invalid', `Period starts after it ends (${from} > ${to}).`, 'Swap from and to.');
    if (from > today) throw new ToolError('period_invalid', `Period starts in the future (${from}).`, 'Use a past period.');
    const months: string[] = [];
    for (let month = monthOf(from); month <= monthOf(to); month = addMonths(month, 1)) months.push(month);
    if (months.length > 12) throw new ToolError('period_invalid', 'Periods are limited to 12 months.', 'Use a shorter range.');
    const only = months.length === 1 ? months[0]! : null;
    const wholeMonth = only && from === monthStart(only) && (to === monthEnd(only) || (to === today && monthOf(today) === only)) ? only : null;
    return { label, from, to, months, wholeMonth, partial: to >= today };
}

export function resolvePeriod(input: PeriodInput, now: number): Period {
    const today = isoDay(now);
    const yesterday = isoDay(parseDay(today) - DAY);
    const thisMonth = monthOf(today);
    if (typeof input === 'object') {
        parseDay(input.from);
        parseDay(input.to);
        const to = input.to > today ? today : input.to;
        return build(`${input.from}..${input.to}`, input.from, to, today);
    }
    switch (input) {
        case 'today':
            return build('today', today, today, today);
        case 'yesterday':
            return build('yesterday', yesterday, yesterday, today);
        case 'last7d':
            return build('last7d', isoDay(parseDay(yesterday) - 6 * DAY), yesterday, today);
        case 'last30d':
            return build('last30d', isoDay(parseDay(yesterday) - 29 * DAY), yesterday, today);
        case 'thisMonth':
            return build('thisMonth', monthStart(thisMonth), today, today);
        case 'lastMonth': {
            const last = addMonths(thisMonth, -1);
            return build('lastMonth', monthStart(last), monthEnd(last), today);
        }
        default: {
            if (input > thisMonth) throw new ToolError('period_invalid', `${input} is in the future.`, 'Use a past month.');
            return build(input, monthStart(input), input === thisMonth ? today : monthEnd(input), today);
        }
    }
}

export type CompareTo = 'previousPeriod' | 'sameDaysLastMonth';

/**
 * The comparison window. `previousPeriod`: the same number of days right before (a whole month compares
 * with the previous whole month). `sameDaysLastMonth`: the same day numbers one month earlier, clipped
 * to that month's length, so a partial month compares like with like.
 */
export function comparisonPeriod(period: Period, compareTo: CompareTo, now: number): Period {
    const today = isoDay(now);
    if (compareTo === 'previousPeriod' && period.wholeMonth && !period.partial) {
        const previous = addMonths(period.wholeMonth, -1);
        return build(`${previous} (previous month)`, monthStart(previous), monthEnd(previous), today);
    }
    if (compareTo === 'previousPeriod') {
        const length = daysInRange(period.from, period.to).length;
        const end = parseDay(period.from) - DAY;
        return build('previous period', isoDay(end - (length - 1) * DAY), isoDay(end), today);
    }
    const shift = (day: string) => {
        const month = addMonths(monthOf(day), -1);
        const last = monthEnd(month);
        const candidate = `${month}-${day.slice(8)}`;
        return candidate > last ? last : candidate;
    };
    return build('same days last month', shift(period.from), shift(period.to), today);
}
