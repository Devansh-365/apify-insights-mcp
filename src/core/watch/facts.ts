import type { ActorSummary } from '../actors.js';
import type { ActorMoney } from '../money.js';
import { DAY_MS, SPREAD_ABOVE_DAYS } from './constants.js';
import { VALUE_KEYS, type BackfillMonth, type Fact, type Reading, type SlimRow, type Snapshot, type StoreRow, type Values } from './types.js';

// Snapshots are cumulative month-to-date rows. Facts are the differences between consecutive readings
// of the same month, with exact [t0, t1] spans: a missed day becomes one longer span, never zeros, and
// a month's last stretch is closed with the previous month's final rows. Backfilled days are exact UTC
// days. Pure functions: the same snapshots always give the same facts.

export function zero(): Values {
    return { rev: 0, cost: 0, runs: 0, succeeded: 0, failed: 0, timedOut: 0, aborted: 0, results: 0 };
}

export function addInto(target: Values, source: Values, factor = 1): void {
    for (const key of VALUE_KEYS) target[key] += source[key] * factor;
}

export function monthStartMs(month: string): number {
    return Date.parse(`${month}-01T00:00:00Z`);
}

export function nextMonth(month: string): string {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

export function previousMonth(month: string): string {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

export function monthEndMs(month: string): number {
    return monthStartMs(nextMonth(month));
}

export function dayStartMs(day: string): number {
    return Date.parse(`${day}T00:00:00Z`);
}

export function isoDayOf(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

export function slimRow(row: ActorMoney): SlimRow {
    return {
        id: row.id,
        name: row.name,
        notice: row.notice,
        rev: row.revenueUsd,
        cost: row.costUsd,
        runs: row.runs,
        succeeded: row.succeeded,
        failed: row.failed,
        timedOut: row.timedOut,
        aborted: row.aborted,
        results: row.results,
        charged: row.chargedResults,
        payingUsers: row.payingUsers,
        freeUsers: row.freeUsers,
        model: row.pricing?.model ?? null,
    };
}

export function storeRow(actor: ActorSummary): StoreRow {
    return {
        id: actor.id,
        name: actor.name,
        users7d: actor.users7d,
        users30d: actor.users30d,
        users90d: actor.users90d,
        notice: actor.notice && actor.notice !== 'NONE' ? actor.notice : null,
        runs30d: actor.runs30d ? { runs: actor.runs30d.runs, failed: actor.runs30d.failed, timedOut: actor.runs30d.timedOut, aborted: actor.runs30d.aborted } : null,
    };
}

/** The readings of `month` found in a set of snapshots: their own month-to-date rows and any closing rows. */
export function readingsOf(month: string, snapshots: Snapshot[]): Reading[] {
    const readings: Reading[] = [];
    for (const snap of snapshots) {
        const takenAt = Date.parse(snap.takenAt);
        if (snap.breakdown && snap.month === month) readings.push({ month, takenAt, close: false, rows: snap.breakdown });
        if (snap.prevMonthFinal && snap.prevMonthFinal.month === month) readings.push({ month, takenAt, close: true, rows: snap.prevMonthFinal.rows });
    }
    return readings.sort((a, b) => a.takenAt - b.takenAt || Number(a.close) - Number(b.close));
}

function anyNonZero(v: Values): boolean {
    return VALUE_KEYS.some((key) => Math.abs(v[key]) > 1e-12);
}

function fact(id: string, name: string, t0: number, t1: number, v: Values, charged: number | null, src: Fact['src']): Fact {
    return { t0: new Date(t0).toISOString(), t1: new Date(t1).toISOString(), days: Math.round(((t1 - t0) / DAY_MS) * 1000) / 1000, id, name, ...v, charged, src };
}

/**
 * Facts for one month. Backfilled days are used up to the first real reading of that actor (later days
 * are covered by the readings). Each reading then adds the difference from the previous one; the first
 * reading of an actor without backfill covers the month from its first day.
 */
export function deriveMonthFacts(month: string, readings: Reading[], backfill: BackfillMonth | null): Fact[] {
    const start = monthStartMs(month);
    const end = monthEndMs(month);
    const ids = new Map<string, string>();
    for (const reading of readings) for (const row of reading.rows) ids.set(row.id, row.name);
    for (const [id, actor] of Object.entries(backfill?.actors ?? {})) if (!ids.has(id)) ids.set(id, actor.name);
    const facts: Fact[] = [];
    for (const [id, fallbackName] of ids) {
        const own = readings.map((reading) => ({ reading, row: reading.rows.find((row) => row.id === id) })).filter((x) => x.row) as Array<{ reading: Reading; row: SlimRow }>;
        const name = own[own.length - 1]?.row.name ?? fallbackName;
        const firstAt = own.length ? Math.min(own[0]!.reading.takenAt, end) : Infinity;
        const cumulative = zero();
        let charged: number | null = 0;
        let cursor = start;
        const days = Object.entries(backfill?.actors[id]?.days ?? {}).sort(([a], [b]) => a.localeCompare(b));
        for (const [day, values] of days) {
            const d0 = dayStartMs(day);
            const d1 = d0 + DAY_MS;
            if (d0 < start || d1 > end || d1 > firstAt) continue;
            if (d0 !== cursor) continue; // only a gap-free run of days from the month start is exact
            addInto(cumulative, values);
            charged = null;
            cursor = d1;
            if (anyNonZero(values)) facts.push(fact(id, name, d0, d1, { ...values }, null, 'backfill'));
        }
        for (const { reading, row } of own) {
            const t1 = Math.min(reading.takenAt, end);
            if (t1 < cursor) continue;
            const delta = zero();
            for (const key of VALUE_KEYS) delta[key] = row[key] - cumulative[key];
            const chargedDelta = charged != null && row.charged != null ? row.charged - charged : null;
            if (anyNonZero(delta)) facts.push(fact(id, name, cursor, t1, delta, chargedDelta, reading.close ? 'close' : 'delta'));
            for (const key of VALUE_KEYS) cumulative[key] = row[key];
            charged = row.charged;
            cursor = t1;
        }
    }
    return facts.sort((a, b) => a.t1.localeCompare(b.t1) || a.id.localeCompare(b.id));
}

// ---- Windows over facts ----

export interface Slice {
    t0: number;
    t1: number;
    v: Values;
    days: number;
    negativeRev: boolean;
}

export function toSlices(facts: Fact[]): Slice[] {
    return facts.map((f) => {
        const v = zero();
        for (const key of VALUE_KEYS) v[key] = f[key];
        return { t0: Date.parse(f.t0), t1: Date.parse(f.t1), v, days: f.days, negativeRev: f.rev < 0 };
    });
}

export interface WindowSum {
    v: Values;
    approximate: boolean;
    negativeRevUsd: number;
}

/**
 * Sum over (from, to]. A fact of up to 1.5 days counts whole in the window that holds its end; a longer
 * one is spread evenly over its span and makes the window approximate.
 */
export function sumWindow(slices: Slice[], from: number, to: number): WindowSum {
    const v = zero();
    let approximate = false;
    let negativeRevUsd = 0;
    for (const s of slices) {
        let share = 0;
        if (s.days <= SPREAD_ABOVE_DAYS) {
            if (s.t1 > from && s.t1 <= to) share = 1;
        } else {
            const overlap = Math.min(s.t1, to) - Math.max(s.t0, from);
            if (overlap > 0) {
                share = overlap / (s.t1 - s.t0);
                approximate = true;
            }
        }
        if (share > 0) {
            addInto(v, s.v, share);
            if (s.negativeRev) negativeRevUsd += s.v.rev * share;
        }
    }
    return { v, approximate, negativeRevUsd };
}

/** Daily revenue for the `count` UTC days whose ends are at or before `to` (oldest first). */
export function dailyRevenue(slices: Slice[], to: number, count: number): number[] {
    const out: number[] = [];
    for (let i = count; i >= 1; i--) out.push(sumWindow(slices, to - i * DAY_MS, to - (i - 1) * DAY_MS).v.rev);
    return out;
}
