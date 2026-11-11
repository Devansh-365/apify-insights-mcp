import { DAY_MS, RULES_VERSION } from './constants.js';
import { dayStartMs, deriveMonthFacts, isoDayOf, monthEndMs, monthStartMs, nextMonth, previousMonth, readingsOf, sumWindow, toSlices, type Slice } from './facts.js';
import { isIgnored } from './files.js';
import { ownerRunsInMonth } from './owner-runs.js';
import { evaluateActor, type ActorFacts, type ActorInput, type MonthInfo } from './rules.js';
import type { ActorSignals, BackfillMonth, Fact, OwnerRuns, Reading, RuleId, SlimRow, Snapshot, UsersDaily, WatchConfig } from './types.js';

// Turns the stored snapshots, backfill, daily users and owner runs into per-actor rule inputs at a
// given moment (`asOf`), and evaluates them. Used by `watch run` (asOf = now) and by `watch replay`
// (asOf = each past day, seeing only data that existed then). No I/O.

export interface WatchData {
    snapshots: Snapshot[];
    backfill: BackfillMonth[];
    users: UsersDaily;
    owner: OwnerRuns;
}

const MONEY_RULES: RuleId[] = ['R1', 'R2', 'R3', 'R4', 'R6', 'R7', 'R8'];

export function monthOfMs(ms: number): string {
    return isoDayOf(ms).slice(0, 7);
}

/** Readings of a month from snapshots plus the backfill's own breakdown rows (a reading at fetch time). */
export function allReadings(month: string, data: WatchData): Reading[] {
    const readings = readingsOf(month, data.snapshots);
    for (const b of data.backfill) {
        if (b.month !== month) continue;
        const takenAt = Date.parse(b.fetchedAt);
        readings.push({ month, takenAt, close: takenAt >= monthEndMs(month), rows: b.rows });
    }
    return readings.sort((a, b) => a.takenAt - b.takenAt || Number(a.close) - Number(b.close));
}

/** Months that have any data, oldest first. */
export function dataMonths(data: WatchData): string[] {
    const months = new Set<string>();
    for (const s of data.snapshots) {
        months.add(s.month);
        if (s.prevMonthFinal) months.add(s.prevMonthFinal.month);
    }
    for (const b of data.backfill) months.add(b.month);
    return [...months].sort();
}

export function deriveAllFacts(data: WatchData, months = dataMonths(data)): Map<string, Fact[]> {
    const out = new Map<string, Fact[]>();
    for (const month of months) out.set(month, deriveMonthFacts(month, allReadings(month, data), data.backfill.find((b) => b.month === month) ?? null));
    return out;
}

interface ActorIndex {
    name: string;
    slices: Slice[];
    coveredFrom: number;
    /** Times at which this actor's cumulative data is known (reading times and backfill day ends). */
    knownAt: number[];
}

export interface PreparedData {
    data: WatchData;
    actors: Map<string, ActorIndex>;
    readingsByMonth: Map<string, Reading[]>;
    /** Owner-run history is known from here (ms); null when there is none. The run list keeps only recent runs. */
    ownerFrom: number | null;
}

export function prepare(data: WatchData): PreparedData {
    const months = dataMonths(data);
    const readingsByMonth = new Map(months.map((m) => [m, allReadings(m, data)]));
    const facts = deriveAllFacts(data, months);
    const actors = new Map<string, ActorIndex>();
    // Coverage starts with the first month in which the actor had any activity: a zero row for a month
    // before it existed must not count as baseline weeks.
    const touch = (id: string, name: string, month: string, active: boolean) => {
        let a = actors.get(id);
        if (!a) actors.set(id, (a = { name, slices: [], coveredFrom: Infinity, knownAt: [] }));
        if (active) a.coveredFrom = Math.min(a.coveredFrom, monthStartMs(month));
        return a;
    };
    const active = (row: SlimRow) => row.runs > 0 || Math.abs(row.rev) > 0 || Math.abs(row.cost) > 0;
    for (const [month, readings] of readingsByMonth) {
        for (const r of readings) for (const row of r.rows) touch(row.id, row.name, month, active(row)).knownAt.push(Math.min(r.takenAt, monthEndMs(month)));
    }
    for (const b of data.backfill) {
        for (const [id, actor] of Object.entries(b.actors)) {
            const a = touch(id, actor.name, b.month, b.rows.some((row) => row.id === id && active(row)));
            for (const day of Object.keys(actor.days)) a.knownAt.push(dayStartMs(day) + DAY_MS);
        }
    }
    for (const list of facts.values()) for (const f of list) actors.get(f.id)?.slices.push(...toSlices([f]));
    for (const a of actors.values()) {
        a.knownAt.sort((x, y) => x - y);
        a.slices.sort((x, y) => x.t1 - y.t1);
    }
    return { data, actors, readingsByMonth, ownerFrom: ownerCoverageStart(data.owner) };
}

/** The first whole UTC day of owner-run history (the earliest stored day is usually cut off by retention). */
export function ownerCoverageStart(owner: OwnerRuns): number | null {
    let first: string | null = null;
    for (const days of Object.values(owner)) for (const day of Object.keys(days)) if (!first || day < first) first = day;
    return first ? dayStartMs(first) + DAY_MS : null;
}

function latestRow(readings: Reading[] | undefined, id: string, asOf: number): { row: SlimRow; reading: Reading } | null {
    let best: { row: SlimRow; reading: Reading } | null = null;
    for (const reading of readings ?? []) {
        if (reading.takenAt > asOf) continue;
        const row = reading.rows.find((r) => r.id === id);
        if (row) best = { row, reading };
    }
    return best;
}

function monthInfo(p: PreparedData, id: string, month: string, asOf: number, slices: Slice[]): MonthInfo | null {
    const found = latestRow(p.readingsByMonth.get(month), id, asOf);
    const end = monthEndMs(month);
    const elapsed = Math.max(0, Math.min(asOf, end) - monthStartMs(month)) / DAY_MS;
    if (found) {
        const { row } = found;
        return { month, source: 'breakdown', payingUsers: row.payingUsers, freeUsers: row.freeUsers, revenueUsd: row.rev, runs: row.runs, model: row.model, charged: row.charged, results: row.results, succeeded: row.succeeded, days: elapsed };
    }
    // No row known yet at asOf (replay inside a backfilled month): daily maxima are a lower bound.
    const days = p.data.users[id];
    if (!days && !slices.length) return null;
    let paying = 0;
    let free = 0;
    let seen = false;
    for (const [day, c] of Object.entries(days ?? {})) {
        if (!day.startsWith(month) || dayStartMs(day) + DAY_MS > asOf) continue;
        seen = true;
        paying = Math.max(paying, c.paying);
        free = Math.max(free, c.free);
    }
    const w = sumWindow(slices, monthStartMs(month) - 1, Math.min(asOf, end));
    const model = [...(p.readingsByMonth.get(previousMonth(month)) ?? []), ...(p.readingsByMonth.get(month) ?? [])].flatMap((r) => r.rows).find((r) => r.id === id)?.model ?? null;
    return {
        month,
        source: 'daily-max',
        payingUsers: seen ? paying : null,
        freeUsers: seen ? free : null,
        revenueUsd: w.v.rev,
        runs: w.v.runs,
        model,
        charged: null,
        results: w.v.results,
        succeeded: w.v.succeeded,
        days: elapsed,
    };
}

export interface EvaluateOptions {
    asOf: number;
    weekly: boolean;
    money: boolean;
    config: WatchConfig;
    /** Store notices and users (production); undefined in replay. */
    store?: Snapshot['store'];
    noticeSince?: Map<string, string>;
    marketing?: NonNullable<Snapshot['weekly']>['marketing'];
    extraNext?: Partial<Record<RuleId, string>>;
}

export interface Evaluation {
    asOf: string;
    rulesVersion: string;
    actors: ActorSignals[];
    facts: Map<string, ActorFacts>;
    evaluated: Set<RuleId>;
}

export function evaluateAll(p: PreparedData, opts: EvaluateOptions): Evaluation {
    const asOf = opts.asOf;
    const thisMonth = monthOfMs(asOf - 1);
    const lastMonth = previousMonth(thisMonth);
    const dayOfMonth = Number(isoDayOf(asOf - 1).slice(8));
    const storeById = new Map((opts.store ?? []).map((s) => [s.id, s]));
    const ids = new Set<string>([...p.actors.keys(), ...storeById.keys()]);
    const out: ActorSignals[] = [];
    const factsOut = new Map<string, ActorFacts>();
    // Same day last month, for R2's monthly check (needs last month's snapshots, so from the second month on).
    const sameDay = p.data.snapshots.filter((s) => s.month === lastMonth && s.breakdown && Number(s.day.slice(8)) <= dayOfMonth).sort((a, b) => a.day.localeCompare(b.day)).pop();
    for (const id of ids) {
        const index = p.actors.get(id);
        const store = storeById.get(id);
        const name = index?.name ?? store?.name ?? id;
        if (isIgnored(opts.config, { id, name })) continue;
        const slices = (index?.slices ?? []).filter((s) => s.t1 <= asOf);
        const known = (index?.knownAt ?? []).filter((t) => t <= asOf);
        const input: ActorInput = {
            id,
            name,
            slices,
            coveredFrom: index && known.length && Number.isFinite(index.coveredFrom) ? index.coveredFrom : null,
            latestDataAt: known.length ? Math.min(asOf, known[known.length - 1]!) : null,
            usersDaily: p.data.users[id],
            ownerDaily: p.data.owner[id],
            ownerFrom: p.ownerFrom,
            thisMonth: index ? monthInfo(p, id, thisMonth, asOf, slices) : null,
            lastMonth: index ? monthInfo(p, id, lastMonth, asOf, slices) : null,
            ownerRunsThisMonth: ownerRunsInMonth(p.data.owner[id], thisMonth, asOf),
            ownerRunsLastMonth: ownerRunsInMonth(p.data.owner[id], lastMonth),
            notice: opts.store ? (store?.notice ?? null) : undefined,
            noticeSince: opts.noticeSince?.get(id) ?? null,
            users30d: store?.users30d ?? null,
            marketing: opts.marketing?.[id] ?? null,
            payingSameDayLastMonth: sameDay?.breakdown?.find((r) => r.id === id)?.payingUsers ?? null,
        };
        const { signals, facts } = evaluateActor(input, { asOf, weekly: opts.weekly, dayOfMonth, money: opts.money && !!index, extraNext: opts.extraNext });
        if (facts) factsOut.set(id, facts);
        if (facts?.exclusions.length) for (const s of signals) s.ownerRunExclusion = true;
        if (signals.length || facts?.exclusions.length) out.push({ id, name, signals, class: facts?.cls ?? null, exclusions: facts?.exclusions ?? [] });
    }
    const evaluated = new Set<RuleId>(opts.money ? ['R5', ...MONEY_RULES, 'no_revenue'] : ['R5']);
    // Weekly-only rules are not judged on other days, so their alerts are not resolved by their absence.
    if (!opts.weekly) {
        evaluated.delete('R6');
        evaluated.delete('R8');
    }
    if (!opts.store) evaluated.delete('R5');
    return { asOf: new Date(asOf).toISOString(), rulesVersion: RULES_VERSION, actors: out, facts: factsOut, evaluated };
}

/** When each currently set notice was first seen in consecutive snapshots (newest run back). */
export function noticeSince(snapshots: Snapshot[]): Map<string, string> {
    const ordered = [...snapshots].filter((s) => s.store).sort((a, b) => b.takenAt.localeCompare(a.takenAt));
    const since = new Map<string, string>();
    const latest = ordered[0];
    if (!latest?.store) return since;
    for (const row of latest.store) {
        if (!row.notice) continue;
        let first = latest.takenAt;
        for (const snap of ordered.slice(1)) {
            const r = snap.store?.find((x) => x.id === row.id);
            if (!r || r.notice !== row.notice) break;
            first = snap.takenAt;
        }
        since.set(row.id, first);
    }
    return since;
}

export { nextMonth };
