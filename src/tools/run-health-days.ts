import type { ConsoleApi, SharedRun } from '../clients/console.js';
import type { Context } from '../context.js';
import { wrapApi } from '../context.js';
import type { ActorSummary } from '../core/actors.js';
import { ToolError } from '../core/envelope.js';
import { breakdown, runStatistics, sharedRuns } from '../core/console-data.js';
import { reportProgress } from '../core/progress.js';
import { dayWindow, daysOf, problemDays, problems, totalsOf, worstDay, type DayCounts, type DayWindow } from '../core/run-days.js';
import { isoDay, type Period } from '../core/period.js';

// Per-day failed / timed-out / aborted counts for `run_health` when a `period` is passed. Counts come
// from Console run statistics (UTC calendar days, every run of the actor); the rest of run_health uses
// the public rolling 30-day window, so the two can differ.

/** Most actors the day view checks, whatever `top` says: each one costs one request per month. */
export const MAX_DAY_ACTORS = 25;
/** Over this many months the day view checks at most 10 actors. */
const LONG_RANGE_MONTHS = 3;
const SHARED_RUNS_LIMIT = 100;
const LOG_RUNS = 3;
const BUILDS = 5;
const PROBLEM_STATUSES = new Set(['FAILED', 'TIMED-OUT']);

export const DAY_SOURCE_NOTE =
    'byDay counts every run per UTC calendar day from the Apify Console. The rest of run_health uses the public rolling 30 days of users\' runs, so the numbers can differ.';

type DayRow = Omit<DayCounts, 'succeeded'> & { partial?: true };

function dayRow(day: DayCounts, window: DayWindow): DayRow {
    const { succeeded: _succeeded, ...rest } = day;
    return window.todayInPeriod && day.date === window.today ? { ...rest, partial: true } : rest;
}

function todayBlock(window: DayWindow, days: DayCounts[]) {
    if (window.todayInPeriod) return undefined;
    const today = days.find((day) => day.date === window.today);
    return today ? { ...dayRow(today, window), partial: true as const } : undefined;
}

function periodBlock(period: Period, window: DayWindow) {
    return { label: period.label, from: window.days[0]!, to: window.days[window.days.length - 1]!, timezone: 'UTC' as const, source: 'console-run-statistics' as const };
}

function span(days: DayCounts[]) {
    const bad = problemDays(days);
    const worst = worstDay(days);
    return {
        problemDays: bad.length,
        firstProblemDay: bad[0]?.date ?? null,
        lastProblemDay: bad[bad.length - 1]?.date ?? null,
        worstDay: worst ? { date: worst.date, failed: worst.failed, timedOut: worst.timedOut, runs: worst.runs } : null,
    };
}

/** All the window's days plus today, from per-month run statistics. */
function windowDays(stats: Awaited<ReturnType<typeof runStatistics>>[], window: DayWindow): { inPeriod: DayCounts[]; withToday: DayCounts[] } {
    const inPeriod = daysOf(stats, window.days);
    const withToday = window.todayInPeriod ? inPeriod : [...inPeriod, ...daysOf(stats, [window.today])];
    return { inPeriod, withToday };
}

export interface PortfolioDays {
    byDay: Record<string, unknown>;
    summary: string;
    notes: string[];
}

export async function portfolioDays(ctx: Context, api: ConsoleApi, catalog: ActorSummary[], period: Period, top: number): Promise<PortfolioDays> {
    const window = dayWindow(period, isoDay(ctx.now()));
    const notes: string[] = [];
    const cap = window.months.length > LONG_RANGE_MONTHS ? 10 : MAX_DAY_ACTORS;
    const limit = Math.min(top, cap);
    if (limit < top) notes.push(`byDay checks at most ${limit} actors for this period (one request per actor per month).`);

    const [accountStats, monthRows] = await Promise.all([
        Promise.all(window.months.map((month) => runStatistics(ctx, api, month))),
        Promise.all(window.months.map((month) => breakdown(ctx, api, month))),
    ]);
    const account = windowDays(accountStats, window);
    const accountTotals = totalsOf(account.inPeriod);

    // Candidates: actors with failed or timed-out runs in the months touched, most first. Monthly counts
    // only pick who to check; every number shown comes from that actor's daily stats.
    const monthly = new Map<string, { name: string; problems: number }>();
    for (const rows of monthRows) {
        for (const row of rows) {
            const entry = monthly.get(row.id) ?? { name: row.name, problems: 0 };
            entry.problems += row.failed + row.timedOut;
            monthly.set(row.id, entry);
        }
    }
    const candidates = [...monthly.entries()].filter(([, entry]) => entry.problems > 0).sort((a, b) => b[1].problems - a[1].problems || a[1].name.localeCompare(b[1].name));
    const checked = candidates.slice(0, limit);
    const byId = new Map(catalog.map((actor) => [actor.id, actor]));

    let done = 0;
    const actors = await Promise.all(
        checked.map(async ([id, entry]) => {
            const stats = await Promise.all(window.months.map((month) => runStatistics(ctx, api, month, id)));
            reportProgress(++done, checked.length, `Checked runs per day for ${entry.name}`);
            const { inPeriod, withToday } = windowDays(stats, window);
            const totals = totalsOf(inPeriod);
            const today = withToday.find((day) => day.date === window.today);
            return {
                ref: byId.get(id)?.ref ?? entry.name,
                runs: totals.runs,
                failed: totals.failed,
                timedOut: totals.timedOut,
                aborted: totals.aborted,
                failureRatePct: totals.failureRatePct,
                todayFailed: today?.failed ?? 0,
                todayTimedOut: today?.timedOut ?? 0,
                ...span(inPeriod),
                days: problemDays(inPeriod).map((day) => dayRow(day, window)),
            };
        }),
    );
    // Aborted runs never rank: failed + timed out in the period, then today's, then name.
    const listed = actors
        .filter((actor) => problems(actor) > 0 || actor.todayFailed + actor.todayTimedOut > 0)
        .sort((a, b) => problems(b) - problems(a) || b.todayFailed + b.todayTimedOut - (a.todayFailed + a.todayTimedOut) || a.ref.localeCompare(b.ref));

    if (candidates.length > checked.length) {
        notes.push(`${candidates.length - checked.length} more actors had failed or timed-out runs in ${window.months.join(', ')} and were not checked; ${limit < cap ? `raise \`top\` (up to ${cap}) or ` : ''}pass \`actor\` for one of them.`);
    }
    if (checked.length === candidates.length) {
        const listedProblems = actors.reduce((sum, actor) => sum + problems(actor), 0);
        if (listedProblems < problems(accountTotals)) {
            notes.push(`Actors listed add up to ${listedProblems} failed or timed-out runs; the account total is ${problems(accountTotals)}. The rest are in actors missing from the Console breakdown.`);
        }
    }
    notes.push(DAY_SOURCE_NOTE);

    const todayRow = todayBlock(window, account.withToday);
    const todayCounts = account.withToday.find((day) => day.date === window.today);
    const worst = listed[0];
    const summary =
        `By day (${period.label}, UTC): ${accountTotals.failed} failed, ${accountTotals.timedOut} timed out, ${accountTotals.aborted} aborted of ${accountTotals.runs} runs` +
        (todayCounts ? `; today so far ${todayCounts.failed} failed, ${todayCounts.timedOut} timed out of ${todayCounts.runs}` : '') +
        (worst ? `. Most: ${worst.ref} (${worst.failed} failed, ${worst.timedOut} timed out${worst.worstDay ? `, worst ${worst.worstDay.date}` : ''})` : '') +
        '.';

    return {
        summary,
        notes,
        byDay: {
            period: periodBlock(period, window),
            account: { totals: accountTotals, days: account.inPeriod.map((day) => dayRow(day, window)) },
            ...(todayRow ? { today: todayRow } : {}),
            actors: listed,
            coverage: { actorsWithProblemRuns: candidates.length, checked: checked.length },
        },
    };
}

function runDay(run: SharedRun): string | null {
    const at = run.finishedAt ?? run.startedAt;
    return at ? at.slice(0, 10) : null;
}

export interface ActorDays {
    byDay: Record<string, unknown>;
    sharedRuns: Record<string, unknown> | null;
    builds: Array<{ buildNumber: string | null; status: string; finishedAt: string | null }> | null;
    buildBeforeFirstProblem: { buildNumber: string | null; finishedAt: string | null } | null;
    summary: string;
    notes: string[];
}

export async function actorDays(ctx: Context, api: ConsoleApi, actor: ActorSummary, period: Period, logs: boolean): Promise<ActorDays> {
    const window = dayWindow(period, isoDay(ctx.now()));
    const notes: string[] = [];
    const [stats, shared, builds] = await Promise.all([
        Promise.all(window.months.map((month) => runStatistics(ctx, api, month, actor.id))),
        // One more try on a dropped connection; the cache forgets a failed load.
        sharedRuns(ctx, api, actor.id, SHARED_RUNS_LIMIT)
            .catch((error: unknown) => (error instanceof ToolError ? Promise.reject(error) : sharedRuns(ctx, api, actor.id, SHARED_RUNS_LIMIT)))
            .catch((error: unknown) => {
            notes.push(`Shared runs could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }),
        wrapApi(() => ctx.api().builds(actor.id, BUILDS)).catch((error: unknown) => {
            notes.push(`Builds could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }),
    ]);
    const { inPeriod, withToday } = windowDays(stats, window);
    const totals = totalsOf(inPeriod);
    const spanned = span(inPeriod);

    let sharedBlock: ActorDays['sharedRuns'] = null;
    if (shared) {
        const from = window.days[0]!;
        const to = window.days[window.days.length - 1]!;
        const inWindow = (day: string | null) => !!day && ((day >= from && day <= to) || day === window.today);
        const failing = shared.data.filter((run) => PROBLEM_STATUSES.has(run.status) && inWindow(runDay(run)));
        const withLogs = logs ? failing.slice(0, LOG_RUNS) : [];
        const tails = await Promise.all(withLogs.map((run) => ctx.api().runLog(run._id)));
        sharedBlock = {
            shared: shared.sequencePagination?.totalCount ?? shared.data.length,
            failedInPeriod: failing.length,
            failed: failing.slice(0, Math.max(LOG_RUNS, 10)).map((run, i) => ({
                runId: run._id,
                status: run.status,
                startedAt: run.startedAt ?? null,
                finishedAt: run.finishedAt ?? null,
                buildNumber: run.buildNumber ?? null,
                exitCode: run.exitCode ?? null,
                payingUser: run.isRunOfPayingUser ?? null,
                consoleUrl: `https://console.apify.com/view/runs/${run._id}`,
                ...(i < tails.length ? { logTail: tails[i]!.available ? tails[i]!.lines : null, ...(tails[i]!.truncatedAtBytes ? { logTruncated: true } : {}) } : {}),
            })),
        };
        notes.push('Only runs users chose to share are listed; most users do not share runs. The counts come from run statistics and cover every run.');
        if (tails.some((tail) => !tail.available)) notes.push('logTail is null where the API did not return the log (not shared any more, or deleted).');
        if (withLogs.length) notes.push('Log tails can contain your users\' input. They are shown here only and never saved.');
    }

    const buildRows = builds?.map((build) => ({ buildNumber: build.buildNumber ?? null, status: build.status, finishedAt: build.finishedAt ?? null })) ?? null;
    let before: ActorDays['buildBeforeFirstProblem'] = null;
    if (buildRows && spanned.firstProblemDay) {
        const start = `${spanned.firstProblemDay}T00:00:00.000Z`;
        const found = buildRows.find((build) => build.status === 'SUCCEEDED' && build.finishedAt != null && build.finishedAt < start);
        before = found ? { buildNumber: found.buildNumber, finishedAt: found.finishedAt } : null;
        if (!found) notes.push(`None of the last ${BUILDS} builds finished before ${spanned.firstProblemDay}, so buildBeforeFirstProblem is null.`);
    }
    notes.push(DAY_SOURCE_NOTE);

    const today = withToday.find((day) => day.date === window.today);
    const todayRow = todayBlock(window, withToday);
    const summary =
        `By day (${period.label}, UTC): ${totals.failed} failed, ${totals.timedOut} timed out, ${totals.aborted} aborted of ${totals.runs} runs` +
        (spanned.problemDays ? ` on ${spanned.problemDays} day${spanned.problemDays === 1 ? '' : 's'} (worst ${spanned.worstDay!.date})` : '') +
        (today ? `; today so far ${today.failed} failed, ${today.timedOut} timed out of ${today.runs}` : '') +
        (sharedBlock ? `. ${sharedBlock.failedInPeriod} failed shared run${sharedBlock.failedInPeriod === 1 ? '' : 's'} in the period` : '') +
        '.';

    return {
        summary,
        notes,
        byDay: {
            period: periodBlock(period, window),
            totals,
            ...spanned,
            days: inPeriod.map((day) => dayRow(day, window)),
            ...(todayRow ? { today: todayRow } : {}),
        },
        sharedRuns: sharedBlock,
        builds: buildRows,
        buildBeforeFirstProblem: before,
    };
}
