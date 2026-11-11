import { DAY_MS, DIGEST, NOTIFY, R5, RULES_VERSION, URGENCY } from './constants.js';
import type { ActorSignals, Alert, AlertEvent, RuleId, Signal, Snooze, Tier, WatchState } from './types.js';

// Alert state per (actor, rule): notify only when an alert is new, has worsened by 50%+, or is still
// open after 14 days (one reminder; 7 days for a notice). Resolutions are reported once. The first run
// (no state file) lists everything already true as a silent backlog. Pure: no I/O.

const TIER_RANK: Record<Tier, number> = { info: 0, WATCH: 1, PAGE: 2 };

export function emptyState(now: number): WatchState {
    return {
        version: 1,
        installedAt: new Date(now).toISOString(),
        rulesVersion: RULES_VERSION,
        open: {},
        resolved: [],
        snoozes: [],
        lastRun: null,
        lastConsoleOkAt: null,
        lastNotifiedDay: null,
        blindNotifiedAt: null,
        concentration: [],
    };
}

export function alertKey(actorId: string, signal: Pick<Signal, 'rule' | 'variant'>): string {
    return `${actorId}:${signal.rule}${signal.variant ? `:${signal.variant}` : ''}`;
}

export function isSnoozed(snoozes: Snooze[], actorId: string, rule: RuleId, now: number): boolean {
    return snoozes.some((s) => s.actorId === actorId && (s.rule == null || s.rule === rule) && Date.parse(s.until) > now);
}

export interface Transition {
    state: WatchState;
    events: AlertEvent[];
    /** PAGE alerts that are new, worse or due a reminder, and not snoozed or backlog. */
    notify: Array<{ alert: Alert; reason: 'new' | 'upgrade' | 'worse' | 'remind' }>;
    /** Whether any PAGE alert opened, worsened or resolved (a digest is written then). */
    pageChanged: boolean;
    /** Keys opened in this run (for "new" markers in the digest). */
    opened: Set<string>;
}

/**
 * Applies this run's signals. `evaluated` names the rules that were actually judged (in degraded mode
 * only R5), so an alert whose rule was not evaluated is never resolved by missing data.
 */
export function transition(prev: WatchState | null, actors: ActorSignals[], now: number, evaluated: Set<RuleId>): Transition {
    const first = prev == null;
    const state: WatchState = structuredClone(prev ?? emptyState(now));
    state.rulesVersion = RULES_VERSION;
    const at = new Date(now).toISOString();
    const events: AlertEvent[] = [];
    const notify: Transition['notify'] = [];
    const opened = new Set<string>();
    const seen = new Set<string>();
    let pageChanged = false;
    state.snoozes = state.snoozes.filter((s) => Date.parse(s.until) > now);

    const event = (kind: AlertEvent['event'], alert: Alert, signal?: Signal) =>
        events.push({
            t: at,
            event: kind,
            key: alert.key,
            actor: alert.name,
            rule: alert.rule,
            tier: alert.tier,
            atStakeUsd: alert.atStakeUsd,
            backlog: alert.backlog,
            snoozed: isSnoozed(state.snoozes, alert.actorId, alert.rule, now),
            rulesVersion: RULES_VERSION,
            evidence: alert.evidence,
            ...(signal?.ownerRunExclusion ? { ownerRunExclusion: true } : {}),
        });

    for (const actor of actors) {
        for (const signal of actor.signals) {
            if (signal.tier === 'info') continue;
            const key = alertKey(actor.id, signal);
            const existing = state.open[key];
            if (signal.hold) {
                if (existing) {
                    seen.add(key);
                    existing.lastSeen = at;
                }
                continue;
            }
            seen.add(key);
            const snoozed = isSnoozed(state.snoozes, actor.id, signal.rule, now);
            if (!existing) {
                const alert: Alert = {
                    key,
                    actorId: actor.id,
                    name: actor.name,
                    rule: signal.rule,
                    variant: signal.variant ?? null,
                    tier: signal.tier,
                    firstSeen: at,
                    lastSeen: at,
                    lastNotified: null,
                    notifiedAtStakeUsd: signal.atStakeUsd,
                    atStakeUsd: signal.atStakeUsd,
                    reminded: first,
                    backlog: first,
                    title: signal.title,
                    evidence: signal.evidence,
                    next: signal.next,
                };
                state.open[key] = alert;
                opened.add(key);
                event('open', alert, signal);
                if (alert.tier === 'PAGE' && !first) {
                    pageChanged = true;
                    if (!snoozed) notify.push({ alert, reason: 'new' });
                }
                continue;
            }
            const before = existing.tier;
            existing.lastSeen = at;
            existing.atStakeUsd = signal.atStakeUsd;
            existing.title = signal.title;
            existing.evidence = signal.evidence;
            existing.next = signal.next;
            if (TIER_RANK[signal.tier] > TIER_RANK[before]) {
                existing.tier = signal.tier;
                existing.backlog = false;
                event('upgrade', existing, signal);
                if (signal.tier === 'PAGE') {
                    pageChanged = true;
                    existing.notifiedAtStakeUsd = signal.atStakeUsd;
                    if (!snoozed) notify.push({ alert: existing, reason: 'upgrade' });
                }
                continue;
            }
            const base = existing.notifiedAtStakeUsd ?? 0;
            if (existing.tier === 'PAGE' && signal.atStakeUsd > 0 && signal.atStakeUsd >= NOTIFY.worseRatio * Math.max(base, 0.01) && signal.atStakeUsd - base >= 1) {
                existing.notifiedAtStakeUsd = signal.atStakeUsd;
                event('worse', existing, signal);
                pageChanged = true;
                if (!snoozed) notify.push({ alert: existing, reason: 'worse' });
                continue;
            }
            const remindAfter = (existing.rule === 'R5' ? R5.remindDays : NOTIFY.remindDays) * DAY_MS;
            if (existing.tier === 'PAGE' && !existing.reminded && now - Date.parse(existing.firstSeen) >= remindAfter) {
                existing.reminded = true;
                event('remind', existing, signal);
                if (!snoozed) notify.push({ alert: existing, reason: 'remind' });
            }
        }
    }

    for (const [key, alert] of Object.entries(state.open)) {
        if (seen.has(key) || !evaluated.has(alert.rule)) continue;
        delete state.open[key];
        event('resolve', alert);
        if (alert.tier === 'PAGE') pageChanged = true;
        state.resolved.push({ key, name: alert.name, rule: alert.rule, tier: alert.tier, firstSeen: alert.firstSeen, resolvedAt: at, reported: false });
    }
    state.resolved = state.resolved.filter((r) => now - Date.parse(r.resolvedAt) < DIGEST.resolvedKeepDays * DAY_MS);
    return { state, events, notify, pageChanged, opened };
}

/** One item per actor: highest tier, next action from the most urgent signal, weekly money at stake. */
export interface Item {
    actorId: string;
    name: string;
    tier: Tier;
    signals: Signal[];
    atStakeUsd: number;
    next: string;
    firstSeen: string | null;
    isNew: boolean;
    snoozed: boolean;
    backlog: boolean;
}

export function buildItems(actors: ActorSignals[], state: WatchState, opened: Set<string>, now: number): Item[] {
    const items: Item[] = [];
    for (const actor of actors) {
        const live = actor.signals.filter((s) => !s.hold || state.open[alertKey(actor.id, s)]);
        if (!live.length) continue;
        // A held signal takes the tier its open alert has.
        const tierOf = (s: Signal): Tier => (s.hold ? (state.open[alertKey(actor.id, s)]?.tier ?? s.tier) : s.tier);
        const tier = live.reduce<Tier>((best, s) => (TIER_RANK[tierOf(s)] > TIER_RANK[best] ? tierOf(s) : best), 'info');
        const urgent = [...live].sort((a, b) => URGENCY.indexOf(a.rule) - URGENCY.indexOf(b.rule))[0]!;
        const keys = live.map((s) => alertKey(actor.id, s));
        const alerts = keys.map((k) => state.open[k]).filter((a): a is Alert => !!a);
        const firstSeen = alerts.map((a) => a.firstSeen).sort()[0] ?? null;
        items.push({
            actorId: actor.id,
            name: actor.name,
            tier,
            signals: live.map((s) => {
                if (!s.hold) return s;
                const open = state.open[alertKey(actor.id, s)]!;
                return { ...s, tier: open.tier, title: open.title, evidence: `${open.evidence} (still open: ${s.evidence})`, next: open.next };
            }),
            atStakeUsd: Math.max(0, ...live.map((s) => s.atStakeUsd)),
            next: urgent.next,
            firstSeen,
            isNew: keys.some((k) => opened.has(k)),
            snoozed: live.every((s) => isSnoozed(state.snoozes, actor.id, s.rule, now)),
            backlog: alerts.length > 0 && alerts.every((a) => a.backlog),
        });
    }
    return items.sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.atStakeUsd - a.atStakeUsd || a.name.localeCompare(b.name));
}
