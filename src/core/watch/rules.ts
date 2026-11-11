import { BASELINE, CLASS, DAY_MS, NO_REVENUE, POOL, R1, R2, R3, R4, R5, R6, R7, R8, REVENUE_DAY_USD, WEEK_MS } from './constants.js';
import { dailyRevenue, sumWindow, type Slice, type WindowSum } from './facts.js';
import { effectivePayingUsers, ownerRunsIn, type ExclusionStrength, type MonthUsers } from './owner-runs.js';
import type { MarketingRow, OwnerDay, RuleId, Signal, Tier } from './types.js';

// The early-warning rules (05-early-warning-architecture.md, signal table). Pure functions: each actor
// is judged against its own 8-week baseline and recurrence class, from local facts only. No network,
// no state; the state layer decides what is new, worse or resolved.

export interface MonthInfo extends MonthUsers {
    month: string;
    /** `breakdown`: a Console row; `daily-max`: the largest daily paying-user count, a lower bound (replay). */
    source: 'breakdown' | 'daily-max';
    model: string | null;
    charged: number | null;
    results: number;
    succeeded: number;
    days: number;
}

export interface ActorInput {
    id: string;
    name: string;
    slices: Slice[];
    /** Data for this actor is known from here (ms) to `latestDataAt`; null when there is none. */
    coveredFrom: number | null;
    latestDataAt: number | null;
    usersDaily?: Record<string, { paying: number; free: number }>;
    ownerDaily?: Record<string, OwnerDay>;
    /** Owner-run history starts here (ms); windows that begin earlier have no owner counts (null, not 0). */
    ownerFrom?: number | null;
    thisMonth: MonthInfo | null;
    lastMonth: MonthInfo | null;
    ownerRunsThisMonth: number;
    ownerRunsLastMonth: number;
    /** Undefined when no Store stats were read for this run (replay). */
    notice?: string | null;
    noticeSince?: string | null;
    users30d: number | null;
    marketing?: MarketingRow | null;
    /** Distinct paying users on the same day last month (from last month's snapshots), for R2's monthly check. */
    payingSameDayLastMonth?: number | null;
}

export interface EvalOptions {
    asOf: number;
    /** Monday tier: R2 paying user-days, R6, R8. */
    weekly: boolean;
    dayOfMonth: number;
    /** Console money facts are available (false in degraded mode: only R5 runs). */
    money: boolean;
    /** Appended to each rule's next action (owner's own skills or runbooks). */
    extraNext?: Partial<Record<RuleId, string>>;
}

export type ActorClass = 'steady' | 'intermittent' | 'bursty' | 'new';

export interface ActorFacts {
    w0: WindowSum;
    w1: WindowSum;
    baseline: number | null;
    baselineWindows: number;
    cls: ActorClass;
    revenueDays56: number;
    revenue56: number;
    peakShare56: number | null;
    revenue35: number;
    pool: boolean;
    payingThis: number | null;
    payingLast: number | null;
    exclusions: string[];
}

const usd = (v: number) => `$${(Math.round(v * 100) / 100).toFixed(2)}`;
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function median(values: number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function coverage(input: ActorInput, from: number, to: number): number {
    if (input.coveredFrom == null || input.latestDataAt == null) return 0;
    const overlap = Math.min(to, input.latestDataAt) - Math.max(from, input.coveredFrom);
    return Math.max(0, overlap) / (to - from);
}

export function classify(revenueDays56: number, peakShare56: number | null, hasBaseline: boolean): ActorClass {
    if (!hasBaseline) return 'new';
    if (revenueDays56 >= CLASS.steadyDays && (peakShare56 == null || peakShare56 < CLASS.steadyPeak)) return 'steady';
    if (revenueDays56 < CLASS.burstyDays || (peakShare56 != null && peakShare56 >= CLASS.burstyPeak)) return 'bursty';
    return 'intermittent';
}

/** Windows, baseline, class and earning pool for one actor at `asOf`. */
export function actorFacts(input: ActorInput, asOf: number): ActorFacts {
    const w0 = sumWindow(input.slices, asOf - WEEK_MS, asOf);
    const w1 = sumWindow(input.slices, asOf - 2 * WEEK_MS, asOf - WEEK_MS);
    const windows: number[] = [];
    for (let k = 1; k <= BASELINE.windows; k++) {
        const from = asOf - (k + 1) * WEEK_MS;
        const to = asOf - k * WEEK_MS;
        if (coverage(input, from, to) >= BASELINE.minCoverage) windows.push(sumWindow(input.slices, from, to).v.rev);
    }
    const baseline = windows.length >= BASELINE.minWindows ? median(windows) : null;
    // The 56 days before W0.
    const days56 = dailyRevenue(input.slices, asOf - WEEK_MS, 56);
    const revenue56 = days56.reduce((a, b) => a + b, 0);
    const revenueDays56 = days56.filter((v) => v >= REVENUE_DAY_USD).length;
    let peak = 0;
    for (let i = 0; i + 7 <= days56.length; i++) peak = Math.max(peak, days56.slice(i, i + 7).reduce((a, b) => a + b, 0));
    const peakShare56 = revenue56 >= CLASS.peakMinTotalUsd ? peak / revenue56 : null;
    const cls = classify(revenueDays56, peakShare56, baseline != null);
    const revenue35 = sumWindow(input.slices, asOf - POOL.days * DAY_MS, asOf).v.rev;
    const exclusions: string[] = [];
    const paying = (month: MonthInfo | null, ownerRuns: number) => {
        const result = effectivePayingUsers(month, ownerRuns);
        if (result.excluded && month) exclusions.push(exclusionText(month.month, result.excluded, month, ownerRuns));
        return result.count;
    };
    const payingThis = paying(input.thisMonth, input.ownerRunsThisMonth);
    const payingLast = paying(input.lastMonth, input.ownerRunsLastMonth);
    const pool =
        revenue35 >= POOL.revenueUsd ||
        (payingThis != null && payingThis >= POOL.payingUsers && (input.thisMonth?.revenueUsd ?? 0) >= POOL.payingRevenueUsd) ||
        (payingLast != null && payingLast >= POOL.payingUsers && (input.lastMonth?.revenueUsd ?? 0) >= POOL.payingRevenueUsd);
    return { w0, w1, baseline, baselineWindows: windows.length, cls, revenueDays56, revenue56, peakShare56, revenue35, pool, payingThis, payingLast, exclusions };
}

function exclusionText(month: string, strength: ExclusionStrength, m: MonthInfo, ownerRuns: number): string {
    return `${month}: 1 paying user treated as your own account (${strength}: ${m.runs} Console runs, ${ownerRuns} of them yours, ${m.freeUsers ?? 0} free users, ${usd(m.revenueUsd)} revenue)`;
}

function nextText(rule: RuleId, name: string, base: string, extra?: Partial<Record<RuleId, string>>): string {
    const more = extra?.[rule];
    return more ? `${base} Then: ${more.replaceAll('<actor>', name)}` : base;
}

const NEXT: Record<RuleId, (a: string) => string> = {
    R1: (a) =>
        `actor_report("${a}"), then run_health("${a}", period: "last30d"). Flat failures and flat results per run mean buyer volume (no fix; note it). Results per run down: see R3. Then check same-site rivals' 7-day users and store_rank.`,
    R2: (a) => `growth("${a}", month: "thisMonth"). Check failures in the 7 days before the drop; if failures came first, fix them; otherwise no fix.`,
    R3: (a) => `One Cloud test (2 at most) with a broad query and maxItems 300 to check pagination. Full pages mean the buyer narrowed their queries (no fix); short pages mean pagination or blocking to fix in "${a}".`,
    R4: (a) => `run_health("${a}", period: "last7d") for the failed runs, log tails and buildBeforeFirstProblem. If the spike started right after a build, roll the build tag back first, then fix.`,
    R5: (a) => `Reproduce Apify's QA run of "${a}" on its default input and fix it; then clear the notice through the API and check that the actor shows in Store search again.`,
    R6: (a) => `acquisition_score("${a}") and growth("${a}") for referrers and countries. If the traffic mix changed, ignore; otherwise run the prefilled input once and check recent README or title changes.`,
    R7: (a) =>
        `run_health("${a}", period: "last7d") (timeouts?), then cut cost per run: memory, proxy, timeouts and retry limits that also cover paying users. If the cause is unknown and the loss keeps running, pause the actor.`,
    R8: (a) => `No fix. Leave this revenue out of MRR plans and check run_health("${a}") weekly; a monitoring or incremental mode can turn batch buyers into recurring ones.`,
    no_revenue: (a) => `actor_report("${a}"): check that the code charges its events for paying users.`,
    burst_started: (a) => `run_health("${a}"): check that it keeps up; nothing else.`,
    burst_ended: () => 'Nothing to do: the burst ended and revenue is back near its baseline.',
    reversal: () => 'Check Apify notifications for a refund or fraud reversal.',
};

const SOURCE_MONEY = 'Console breakdown deltas and backfilled days (paying-users money)';
const SOURCE_RUNS = "Console run counts (every run of the actor, your own runs subtracted where known)";

function signal(rule: RuleId, tier: Tier, a: ActorInput, opts: EvalOptions, fields: Omit<Signal, 'rule' | 'tier' | 'next'> & { next?: string }): Signal {
    return { rule, tier, ...fields, next: fields.next ?? nextText(rule, a.name, NEXT[rule](a.name), opts.extraNext) };
}

/** All signals for one actor at `opts.asOf`. `open` lists rule keys already open, for R6's PAGE upgrade. */
export function evaluateActor(input: ActorInput, opts: EvalOptions): { signals: Signal[]; facts: ActorFacts | null } {
    const signals: Signal[] = [];
    const asOf = opts.asOf;
    const f = opts.money ? actorFacts(input, asOf) : null;

    // R5: a notice (public data, works without the Console session).
    if (input.notice) {
        const paying = Math.max(f?.payingThis ?? 0, f?.payingLast ?? 0);
        const revenue56 = f?.revenue56 ?? 0;
        const page = (input.users30d ?? 0) >= R5.users30d || paying >= 1 || revenue56 >= R5.revenue56Usd;
        signals.push(
            signal('R5', page ? 'PAGE' : 'WATCH', input, opts, {
                atStakeUsd: r2(revenue56 / 8),
                title: `R5 Apify notice ${input.notice}`,
                evidence: `notice ${input.notice}${input.noticeSince ? ` (first seen by the watch ${input.noticeSince.slice(0, 10)})` : ''} | users 30d ${input.users30d ?? 'null'} | paying users ${f ? paying : 'null'} | 56-day revenue ${f ? usd(revenue56) : 'null'}`,
                numbers: { notice: input.notice, users30d: input.users30d, payingUsers: f ? paying : null, revenue56Usd: f ? r2(revenue56) : null },
                source: 'Public Store stats (notice)',
            }),
        );
    }
    if (!f) return { signals, facts: null };

    const { w0, w1, baseline: B, cls } = f;
    const rev0 = w0.v.rev;
    const rev1 = w1.v.rev;
    const approx = w0.approximate || w1.approximate;
    const classText = `class ${cls} (revenue on ${f.revenueDays56} of 56 days${f.peakShare56 != null ? `, peak week ${pct(f.peakShare56)}` : ''})`;

    // R7: cost above revenue (any actor, no pool gate).
    const window = (days: number) => sumWindow(input.slices, asOf - days * DAY_MS, asOf);
    const d1 = window(1);
    const d3 = window(3);
    const d7 = w0;
    const loss = (w: WindowSum) => w.v.cost - w.v.rev;
    const loss1 = loss(d1);
    const loss3 = loss(d3);
    const loss7 = loss(d7);
    // Owner runs are subtracted only where owner-run history exists; before it they are unknown (null), not 0.
    const ownerFrom = input.ownerFrom ?? null;
    const ownIn = (from: number, to: number): OwnerDay | null => (ownerFrom != null && ownerFrom < to ? ownerRunsIn(input.ownerDaily, Math.max(from, ownerFrom), to) : null);
    const ownText = (own: OwnerDay | null, from: number, days: number) => {
        const since = ownerFrom != null ? new Date(ownerFrom).toISOString().slice(0, 10) : null;
        if (!own) return `your own runs not subtracted (no owner-run history${since ? ` before ${since}` : ''})`;
        return `your own runs excluded (${own.runs} in ${days} days${ownerFrom != null && from < ownerFrom ? `, counted from ${since} only` : ''})`;
    };
    const own7 = ownIn(asOf - WEEK_MS, asOf);
    if (loss1 >= R7.day1LossUsd || loss3 >= R7.day3LossUsd || loss7 >= R7.day7LossUsd) {
        const reversal = d7.negativeRevUsd < -0.005 && loss7 + d7.negativeRevUsd < R7.day7LossUsd && loss1 + d1.negativeRevUsd < R7.day1LossUsd;
        const timedOut = d7.v.timedOut;
        signals.push(
            signal('R7', 'PAGE', input, opts, {
                atStakeUsd: r2(Math.max(loss7, loss3, loss1)),
                title: reversal ? 'R7 loss from a revenue reversal' : 'R7 cost above revenue',
                evidence: `24 h loss ${usd(loss1)} (cost ${usd(d1.v.cost)}, revenue ${usd(d1.v.rev)}) | 3-day loss ${usd(loss3)} | 7-day loss ${usd(loss7)} | 7-day runs ${Math.round(d7.v.runs)}, timed out ${Math.round(timedOut)}, failed ${Math.round(d7.v.failed)} | your own runs in 7 days ${own7 ? own7.runs : 'not available'}${reversal ? ` | revenue reversal ${usd(d7.negativeRevUsd)}` : ''}`,
                numbers: { loss24hUsd: r2(loss1), loss3dUsd: r2(loss3), loss7dUsd: r2(loss7), cost24hUsd: r2(d1.v.cost), revenue24hUsd: r2(d1.v.rev), runs7d: Math.round(d7.v.runs), timedOut7d: Math.round(timedOut), ownerRuns7d: own7?.runs ?? null, reversal },
                source: SOURCE_MONEY,
                approximate: d1.approximate || approx,
                next: reversal ? nextText('reversal', input.name, NEXT.reversal(input.name), opts.extraNext) : undefined,
            }),
        );
    } else if (loss7 >= R7.holdLossUsd) {
        signals.push(signal('R7', 'PAGE', input, opts, { hold: true, atStakeUsd: r2(loss7), title: 'R7 cost above revenue', evidence: `7-day loss ${usd(loss7)}`, numbers: { loss7dUsd: r2(loss7) }, source: SOURCE_MONEY }));
    } else if (rev0 >= R7.thinRevenueUsd && (rev0 - d7.v.cost) / rev0 < R7.thinMargin) {
        signals.push(
            signal('R7', 'WATCH', input, opts, {
                variant: 'thin',
                atStakeUsd: r2(Math.max(0, d7.v.cost - rev0 * (1 - R7.thinMargin))),
                title: 'R7 thin margin',
                evidence: `7-day revenue ${usd(rev0)}, cost ${usd(d7.v.cost)}, margin ${pct((rev0 - d7.v.cost) / rev0)}`,
                numbers: { revenue7dUsd: r2(rev0), cost7dUsd: r2(d7.v.cost) },
                source: SOURCE_MONEY,
                approximate: approx,
            }),
        );
    }
    if (d7.negativeRevUsd <= -0.05) {
        signals.push(
            signal('reversal', 'info', input, opts, {
                atStakeUsd: r2(-d7.negativeRevUsd),
                title: 'revenue reversal',
                evidence: `negative revenue ${usd(d7.negativeRevUsd)} in 7 days (refund or fraud reversal; kept as it is)`,
                numbers: { negativeRevenueUsd: r2(d7.negativeRevUsd) },
                source: SOURCE_MONEY,
            }),
        );
    }

    // R4: failure or timeout spike (net of the owner's own runs).
    const net = (w: WindowSum, own: OwnerDay | null) => {
        const runs = Math.max(0, w.v.runs - (own?.runs ?? 0));
        const failed = Math.max(0, w.v.failed - (own?.failed ?? 0));
        const timedOut = Math.max(0, w.v.timedOut - (own?.timedOut ?? 0));
        return { runs, failed, timedOut, failures: failed + timedOut, rate: runs > 0 ? (failed + timedOut) / runs : null };
    };
    const n0 = net(w0, own7);
    const priorFrom = asOf - WEEK_MS - R4.priorDays * DAY_MS;
    const prior = sumWindow(input.slices, priorFrom, asOf - WEEK_MS);
    const nPrior = net(prior, ownIn(priorFrom, asOf - WEEK_MS));
    const fastW = window(R4.fastDays);
    const ownFast = ownIn(asOf - R4.fastDays * DAY_MS, asOf);
    const nFast = net(fastW, ownFast);
    const usersPaying28 = Object.entries(input.usersDaily ?? {}).some(([day, c]) => {
        const end = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
        return end > asOf - 28 * DAY_MS && end <= asOf && c.paying > 0;
    });
    const anyPaying = (f.payingThis ?? 0) >= 1 || (f.payingLast ?? 0) >= 1 || usersPaying28;
    const spike = n0.rate != null && n0.failures >= R4.minFailures && n0.rate >= R4.minRate && (nPrior.rate == null || nPrior.rate < R4.quietPriorRate || n0.rate >= R4.spikeMultiple * nPrior.rate);
    const fast = f.pool && nFast.rate != null && nFast.failures >= R4.fastFailures && nFast.rate >= R4.fastRate;
    if ((spike && (f.pool || anyPaying)) || fast) {
        const use = fast && !spike ? nFast : n0;
        const timeouts = use.failures > 0 && use.timedOut / use.failures >= R4.timeoutShare;
        const weeklyRevenue = Math.max(rev0, prior.v.rev / 4);
        signals.push(
            signal('R4', f.pool ? 'PAGE' : 'WATCH', input, opts, {
                atStakeUsd: r2(weeklyRevenue * (use.rate ?? 0)),
                title: `R4 ${timeouts ? 'timeout' : 'failure'} spike${fast && !spike ? ' (last 2 days)' : ''}`,
                evidence: `${fast && !spike ? '2-day' : '7-day'} ${use.failures} of ${use.runs} runs ${timeouts ? 'timed out or failed' : 'failed or timed out'} (${pct(use.rate ?? 0)}; ${use.timedOut} timed out) vs ${nPrior.rate == null ? 'no runs' : pct(nPrior.rate)} in the 28 days before | ${fast && !spike ? ownText(ownFast, asOf - R4.fastDays * DAY_MS, R4.fastDays) : ownText(own7, asOf - WEEK_MS, 7)} | paying users ${f.payingThis ?? 'null'} this month, ${f.payingLast ?? 'null'} last`,
                numbers: { failures: use.failures, runs: use.runs, timedOut: use.timedOut, failureRatePct: r2((use.rate ?? 0) * 100), priorFailureRatePct: nPrior.rate == null ? null : r2(nPrior.rate * 100), ownerRuns7d: own7?.runs ?? null, fastPath: fast && !spike },
                source: SOURCE_RUNS,
                approximate: approx,
            }),
        );
    } else if (n0.rate != null && n0.rate >= R4.holdRate && n0.failures >= R4.holdFailures) {
        signals.push(signal('R4', 'WATCH', input, opts, { hold: true, atStakeUsd: r2(rev0 * n0.rate), title: 'R4 failure spike', evidence: `7-day failure rate ${pct(n0.rate)}`, numbers: { failureRatePct: r2(n0.rate * 100) }, source: SOURCE_RUNS }));
    }

    // R3: results per run drop at flat runs.
    if (w0.v.runs >= R3.minRuns && w0.v.succeeded > 0) {
        const yFrom = asOf - WEEK_MS - R3.priorDays * DAY_MS;
        const y = sumWindow(input.slices, yFrom, asOf - WEEK_MS);
        const fromFacts = coverage(input, yFrom, asOf - WEEK_MS) >= 0.95 && y.v.succeeded > 0;
        const last = input.lastMonth;
        const yieldPrior = fromFacts ? y.v.results / y.v.succeeded : last && last.succeeded > 0 ? last.results / last.succeeded : null;
        const weeklyRuns = fromFacts ? y.v.runs / 4 : last && last.days > 0 ? (last.runs / last.days) * 7 : null;
        const yield0 = w0.v.results / w0.v.succeeded;
        if (yieldPrior && weeklyRuns) {
            const band = w0.v.runs / weeklyRuns;
            const ratio = yield0 / yieldPrior;
            const flat = band >= R3.runBandLow && band <= R3.runBandHigh;
            const perResult = input.thisMonth?.model === 'PRICE_PER_DATASET_ITEM' || ((input.thisMonth?.charged ?? input.lastMonth?.charged ?? 0) > 0);
            const evidence = `results per run ${yield0.toFixed(1)} vs ${yieldPrior.toFixed(1)} in the 28 days before (${pct(ratio - 1)}) | runs per day ${(w0.v.runs / 7).toFixed(0)} vs ${(weeklyRuns / 7).toFixed(0)}`;
            if (flat && ratio <= R3.yieldRatio) {
                signals.push(
                    signal('R3', f.pool && perResult ? 'PAGE' : 'WATCH', input, opts, {
                        atStakeUsd: r2(rev0 * (1 - ratio)),
                        title: 'R3 yield drop',
                        evidence,
                        numbers: { resultsPerRun: r2(yield0), priorResultsPerRun: r2(yieldPrior), runsPerDay: r2(w0.v.runs / 7), priorRunsPerDay: r2(weeklyRuns / 7), basis: fromFacts ? 'facts' : 'last month' },
                        source: 'Console run counts and results',
                        approximate: approx,
                    }),
                );
            } else if (ratio <= R3.holdRatio) {
                signals.push(signal('R3', 'WATCH', input, opts, { hold: true, atStakeUsd: r2(rev0 * (1 - ratio)), title: 'R3 yield drop', evidence, numbers: { resultsPerRun: r2(yield0) }, source: 'Console run counts and results' }));
            }
        }
    }

    // R1: weekly revenue against the actor's own baseline; info lines for bursts.
    if (B != null) {
        const gap = B - rev0;
        const evidence = `7d revenue ${usd(rev0)} vs 8-week median ${usd(B)} (${B > 0 ? pct(rev0 / B - 1) : 'n/a'}) | previous 7d ${usd(rev1)} | ${classText} | paying users ${f.payingThis ?? 'null'} (last month ${f.payingLast ?? 'null'})`;
        const numbers = { revenue7dUsd: r2(rev0), previous7dUsd: r2(rev1), baselineUsd: r2(B), class: cls, revenueDays56: f.revenueDays56, peakShare56: f.peakShare56 == null ? null : r2(f.peakShare56) };
        const r1 = (tier: Tier, hold = false) =>
            signals.push(signal('R1', f.pool ? tier : 'WATCH', input, opts, { hold, atStakeUsd: r2(Math.max(0, gap)), title: 'R1 revenue drop', evidence, numbers, source: SOURCE_MONEY, approximate: approx }));
        if (cls === 'steady') {
            if (rev0 <= R1.steadyRatio * B && gap >= R1.minGapUsd) r1('PAGE');
            else if (rev0 < R1.resolveRatio * B) r1('PAGE', true);
        } else if (cls === 'intermittent') {
            if (rev0 <= R1.intermittentRatio * B && gap >= R1.minGapUsd) r1(rev1 <= R1.intermittentRatio * B ? 'PAGE' : 'WATCH');
            else if (rev0 < R1.resolveRatio * B) r1('WATCH', true);
        } else if (cls === 'bursty' && rev1 >= R1.burstRatio * B && rev1 >= B + R1.burstPlusUsd && rev0 < R1.burstEndRatio * B) {
            signals.push(signal('burst_ended', 'info', input, opts, { atStakeUsd: 0, title: 'burst ended', evidence, numbers, source: SOURCE_MONEY, approximate: approx }));
        }
        if (rev0 >= R1.burstRatio * B && rev0 >= B + R1.burstPlusUsd) {
            signals.push(signal('burst_started', 'info', input, opts, { atStakeUsd: 0, title: 'burst started', evidence, numbers, source: SOURCE_MONEY, approximate: approx }));
        }
    }

    // R2 buyer quiet (daily): earned on 4+ days, then nothing for 14 days.
    const last14 = sumWindow(input.slices, asOf - R2.quietDays * DAY_MS, asOf).v.rev;
    if (f.revenueDays56 >= R2.quietRevenueDays && f.revenue56 >= R2.quietRevenueUsd && last14 < REVENUE_DAY_USD) {
        signals.push(
            signal('R2', 'WATCH', input, opts, {
                variant: 'quiet',
                atStakeUsd: r2(f.revenue56 / 8),
                title: 'R2 buyer quiet',
                evidence: `no revenue for 14 days after ${f.revenueDays56} revenue days (${usd(f.revenue56)} in the 56 days before) | ${classText}`,
                numbers: { revenueDays56: f.revenueDays56, revenue56Usd: r2(f.revenue56), revenue14dUsd: r2(last14) },
                source: SOURCE_MONEY,
            }),
        );
    } else if (f.revenueDays56 >= R2.quietRevenueDays && f.revenue56 >= R2.quietRevenueUsd && rev0 < REVENUE_DAY_USD) {
        signals.push(signal('R2', 'WATCH', input, opts, { variant: 'quiet', hold: true, atStakeUsd: r2(f.revenue56 / 8), title: 'R2 buyer quiet', evidence: 'still no revenue', numbers: {}, source: SOURCE_MONEY }));
    }
    // R2 monthly check: distinct paying users month to date vs the same day last month.
    if (input.payingSameDayLastMonth != null && input.payingSameDayLastMonth >= R2.monthlyMinPrevious && f.payingThis != null && opts.dayOfMonth >= 3) {
        if (f.payingThis <= R2.monthlyRatio * input.payingSameDayLastMonth) {
            signals.push(
                signal('R2', 'WATCH', input, opts, {
                    variant: 'monthly',
                    atStakeUsd: r2(Math.max(0, f.revenue56 / 8)),
                    title: 'R2 paying users down',
                    evidence: `${f.payingThis} paying users this month to date vs ${input.payingSameDayLastMonth} at the same day last month`,
                    numbers: { payingUsers: f.payingThis, payingSameDayLastMonth: input.payingSameDayLastMonth },
                    source: 'Console breakdown (distinct paying users)',
                }),
            );
        }
    }
    // R2 paying user-days (weekly).
    if (opts.weekly && input.usersDaily) {
        const pud = (from: number, to: number) => {
            let sum = 0;
            let days = 0;
            for (const [day, c] of Object.entries(input.usersDaily!)) {
                const end = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
                if (end > from && end <= to) {
                    sum += c.paying;
                    days++;
                }
            }
            return { sum, days };
        };
        const now = pud(asOf - WEEK_MS, asOf);
        const base: number[] = [];
        for (let k = 1; k <= BASELINE.windows; k++) {
            const w = pud(asOf - (k + 1) * WEEK_MS, asOf - k * WEEK_MS);
            if (w.days >= 4) base.push(w.sum);
        }
        const med = base.length >= BASELINE.minWindows ? median(base) : null;
        if (now.days >= 5 && med != null && med >= R2.pudMinMedian && now.sum <= R2.pudRatio * med) {
            signals.push(
                signal('R2', 'WATCH', input, opts, {
                    variant: 'pud',
                    atStakeUsd: r2(Math.max(0, (B ?? 0) - rev0)),
                    title: 'R2 paying user-days down',
                    evidence: `paying user-days ${now.sum} in 7 days vs 8-week median ${med}`,
                    numbers: { payingUserDays: now.sum, medianPayingUserDays: med },
                    source: 'Console user-count statistics',
                }),
            );
        }
    }

    // R6: view-to-run collapse (weekly, from day 8).
    const m = input.marketing;
    if (opts.weekly && opts.dayOfMonth >= R6.minDay && m && m.viewers != null && m.starters != null && m.previousViewers && m.previousStarters != null) {
        const rate = Math.min(1, m.starters / Math.max(1, m.viewers));
        const prevRate = Math.min(1, m.previousStarters / m.previousViewers);
        if (m.viewers >= R6.viewers && m.previousStarters >= R6.previousStarters && rate <= R6.rateRatio * prevRate && (prevRate - rate) * 100 >= R6.minPointDrop) {
            const cn = m.cnNoReferrerShare != null && m.cnNoReferrerShare >= R6.cnShare;
            signals.push(
                signal('R6', cn ? 'info' : 'WATCH', input, opts, {
                    atStakeUsd: 0,
                    title: 'R6 view-to-run collapse',
                    evidence: `view-to-run ${pct(rate)} (${m.starters} of ${m.viewers} viewers) vs ${pct(prevRate)} at the same point last month${cn ? ' | most traffic is CN with no referrer (downgraded to info)' : ''}`,
                    numbers: { viewers: m.viewers, starters: m.starters, viewToRunPct: r2(rate * 100), previousViewToRunPct: r2(prevRate * 100) },
                    source: 'Console monthly marketing',
                }),
            );
        }
    }

    // R8: single-buyer concentration (weekly table).
    if (opts.weekly && f.revenue56 >= R8.revenue56Usd) {
        const fewPaying = f.payingThis != null && f.payingLast != null && f.payingThis <= R8.maxPayingUsers && f.payingLast <= R8.maxPayingUsers;
        if ((f.peakShare56 != null && f.peakShare56 >= R8.peakShare) || fewPaying) {
            signals.push(
                signal('R8', 'WATCH', input, opts, {
                    atStakeUsd: r2(f.revenue56 / 8),
                    title: 'R8 single-buyer concentration',
                    evidence: `56-day revenue ${usd(f.revenue56)} | peak week ${f.peakShare56 == null ? 'null' : pct(f.peakShare56)} | paying users ${f.payingThis ?? 'null'} this month, ${f.payingLast ?? 'null'} last`,
                    numbers: { revenue56Usd: r2(f.revenue56), peakShare56: f.peakShare56 == null ? null : r2(f.peakShare56), payingUsers: f.payingThis, payingUsersLastMonth: f.payingLast },
                    source: 'Facts and Console breakdown (paying users are a proxy: no per-buyer revenue exists)',
                }),
            );
        }
    }

    // no_revenue (info): paying users but nothing charged on a charging actor, owner months excluded.
    const t = input.thisMonth;
    if (t && t.source === 'breakdown' && t.runs >= NO_REVENUE.minRuns && (f.payingThis ?? 0) >= 1 && t.revenueUsd < NO_REVENUE.maxRevenueUsd && (t.model === 'PAY_PER_EVENT' || t.model === 'PRICE_PER_DATASET_ITEM')) {
        signals.push(
            signal('no_revenue', 'info', input, opts, {
                atStakeUsd: 0,
                title: 'paying users but $0 charged',
                evidence: `${t.runs} runs and ${f.payingThis} paying user(s) this month, ${usd(t.revenueUsd)} revenue (${t.model})`,
                numbers: { runs: t.runs, payingUsers: f.payingThis },
                source: 'Console breakdown',
            }),
        );
    }

    // R6 becomes PAGE only next to an R4 or R5 on the same actor.
    if (signals.some((s) => (s.rule === 'R4' || s.rule === 'R5') && !s.hold && s.tier === 'PAGE')) for (const s of signals) if (s.rule === 'R6' && s.tier === 'WATCH') s.tier = 'PAGE';
    return { signals, facts: f };
}
