import { copyFile } from 'node:fs/promises';
import type { ApifyApi } from '../../clients/apify-api.js';
import type { ConsoleApi } from '../../clients/console.js';
import { ToolError } from '../envelope.js';
import { BACKFILL, BLIND_HOURS, CLOSE_DAYS, DAY_MS, HOUR_MS, R2, R6, RULES_VERSION } from './constants.js';
import { backfillCandidates, errorCode, fetchBreakdown, fetchCatalog, fetchMarketing, fetchOwnerRuns, fetchUserCounts, outcomeOf, runBackfill, type Catalog } from './collect.js';
import { renderDigest, notificationText } from './digest.js';
import { deriveAllFacts, evaluateAll, monthOfMs, noticeSince, prepare, type Evaluation, type PreparedData } from './engine.js';
import { dayStartMs, isoDayOf, monthStartMs, previousMonth } from './facts.js';
import { appendSecure, ensureDir, exists, isIgnored, loadWatchConfig, paths, readGz, readJson, removeFile, writeJson, writeSecure } from './files.js';
import type { Notifier } from './launchd.js';
import { buildItems, emptyState, transition } from './state.js';
import { cleanup, latestSnapshot, loadBackfill, loadData, saveBackfill, saveOwnerRuns, saveSnapshot, saveUsers, writeFacts } from './store.js';
import type { ConsoleOutcome, RuleId, Snapshot, WatchConfig, WatchState } from './types.js';

// `watch run`, `watch backfill`, `watch status`, `watch snooze` and `watch replay`. Dependencies are
// passed in, so the tests run the whole pipeline against fakes and a temporary folder.

export interface WatchDeps {
    home: string;
    api: ApifyApi;
    /** Builds the Console client for this account, or says why there is none. Never exposes the token. */
    console: (accountId: string) => Promise<{ api: ConsoleApi | null; outcome: ConsoleOutcome }>;
    now: () => number;
    log: (line: string) => void;
    notifier: Notifier;
}

const LOCK_STALE_MS = 20 * 60_000;

async function withLock<T>(home: string, now: number, run: () => Promise<T>): Promise<T | 'locked'> {
    const p = paths(home);
    await ensureDir(p.root);
    const held = await readJson<{ pid: number; at: number }>(p.lock);
    if (held && now - held.at < LOCK_STALE_MS) return 'locked';
    await writeJson(p.lock, { pid: process.pid, at: now });
    try {
        return await run();
    } finally {
        await removeFile(p.lock);
    }
}

function usd(v: number): string {
    return `$${(Math.round(v * 100) / 100).toFixed(2)}`;
}

async function loadState(home: string): Promise<WatchState | null> {
    const state = await readJson<WatchState>(paths(home).state);
    return state?.version === 1 ? state : null;
}

async function appendEvents(home: string, events: object[]): Promise<void> {
    if (!events.length) return;
    await appendSecure(paths(home).alerts, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function consoleLine(snapshot: Snapshot | null, lastOk: string | null, now: number): string {
    if (snapshot?.console === 'ok') return `Console snapshot ${snapshot.takenAt.slice(0, 16).replace('T', ' ')} UTC (fresh)`;
    const age = lastOk ? `${Math.round((now - Date.parse(lastOk)) / HOUR_MS)} h old (${lastOk.slice(0, 16).replace('T', ' ')} UTC)` : 'never taken';
    return `Console money MISSING this run (${snapshot?.console ?? 'not tried'}); the last Console snapshot is ${age}. Money rules were not judged; only public signals (R5) ran.`;
}

/** Top actors by revenue over this and last month's latest rows (for the Monday user-count fetch). */
function topEarners(prepared: PreparedData, now: number, config: WatchConfig, limit: number): string[] {
    const month = monthOfMs(now);
    const totals = new Map<string, number>();
    for (const m of [month, previousMonth(month)]) {
        const readings = prepared.readingsByMonth.get(m) ?? [];
        const last = readings[readings.length - 1];
        for (const row of last?.rows ?? []) if (!isIgnored(config, row)) totals.set(row.id, (totals.get(row.id) ?? 0) + row.rev);
    }
    return [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

export interface RunOptions {
    force?: boolean;
    weekly?: boolean;
}

export interface RunResult {
    code: number;
    summary: string;
}

export async function watchRun(deps: WatchDeps, options: RunOptions = {}): Promise<RunResult> {
    const started = deps.now();
    const result = await withLock(deps.home, started, () => runLocked(deps, options));
    if (result === 'locked') {
        deps.log('watch run: another run is in progress; exiting.');
        return { code: 0, summary: 'locked' };
    }
    return result;
}

async function runLocked(deps: WatchDeps, options: RunOptions): Promise<RunResult> {
    const { home, api, log } = deps;
    const now = deps.now();
    const p = paths(home);
    const day = isoDayOf(now);
    const month = day.slice(0, 7);
    const prevMonth = previousMonth(month);
    const dayOfMonth = Number(day.slice(8));
    const errors: string[] = [];
    const prevState = await loadState(home);
    const config = await loadWatchConfig(home);
    const existing = await readGz<Snapshot>(p.snapshot(day));
    if (existing?.console === 'ok' && !options.force) {
        log(`watch run: today's snapshot was already taken at ${existing.takenAt} (first success per UTC day wins). Nothing to do.`);
        return { code: 0, summary: 'already done' };
    }

    // 1. Public data (needs no Console session).
    let catalog: Catalog | null = null;
    let accountId: string | null = null;
    try {
        const me = await api.me();
        accountId = me.id;
        catalog = await fetchCatalog(api, me.username);
        log(`store: ${catalog.store.length} public actors`);
    } catch (error) {
        errors.push(`store:${errorCode(error)}`);
        log(`store: failed (${errorCode(error)})`);
    }

    // 2. Console money.
    let outcome: ConsoleOutcome = 'bridge_missing';
    let breakdown: Snapshot['breakdown'] = null;
    let prevMonthFinal: Snapshot['prevMonthFinal'] = null;
    let consoleApi: ConsoleApi | null = null;
    if (accountId) {
        const made = await deps.console(accountId);
        outcome = made.outcome;
        consoleApi = made.api;
    }
    const earlier = await loadData(home, isoDayOf(now - 120 * DAY_MS));
    if (consoleApi) {
        try {
            breakdown = await fetchBreakdown(consoleApi, month);
            outcome = 'ok';
            log(`console: breakdown ${month} (${breakdown.length} rows)`);
            const hadPrev = earlier.snapshots.some((s) => s.month === prevMonth) || earlier.backfill.some((b) => b.month === prevMonth);
            const closed = earlier.snapshots.some((s) => s.month === month && s.prevMonthFinal?.month === prevMonth);
            if (dayOfMonth <= CLOSE_DAYS || (hadPrev && !closed)) {
                prevMonthFinal = { month: prevMonth, rows: await fetchBreakdown(consoleApi, prevMonth) };
                log(`console: closing rows for ${prevMonth}`);
            }
        } catch (error) {
            outcome = outcomeOf(error);
            errors.push(`console:${errorCode(error)}`);
            log(`console: failed (${errorCode(error)}); continuing with public data only`);
            if (!breakdown) consoleApi = null;
        }
    } else {
        log(`console: no session (${outcome}); continuing with public data only`);
    }

    // 3. The owner's own runs (public API).
    if (catalog) {
        const since = prevMonthFinal || dayOfMonth <= 7 ? `${prevMonth}-01` : `${month}-01`;
        try {
            const owner = await fetchOwnerRuns(api, since, catalog.ownIds);
            if (owner) await saveOwnerRuns(home, owner, since);
        } catch (error) {
            errors.push(`owner-runs:${errorCode(error)}`);
        }
    }

    // 4. Monday tier (also on the first run, so the install backlog is complete).
    const weekly = !!options.weekly || new Date(now).getUTCDay() === 1 || !prevState;
    let weeklyData: Snapshot['weekly'] = null;
    if (weekly && consoleApi && breakdown) {
        const pre = prepare({ ...earlier, snapshots: [...earlier.snapshots, { version: 1, takenAt: new Date(now).toISOString(), day, month, rulesVersion: RULES_VERSION, console: 'ok', breakdown, prevMonthFinal, store: null, weekly: null, errors: [] }] });
        const watched = topEarners(pre, now, config, R2.watchedActors);
        const months = dayOfMonth <= 8 ? [prevMonth, month] : [month];
        const counts = await fetchUserCounts(consoleApi, watched, months);
        if (counts.failed) errors.push(`user-counts:${counts.failed}`);
        await saveUsers(home, counts.users, `${months[0]}-01`);
        let marketing = {};
        if (dayOfMonth >= R6.minDay && catalog) {
            const byUsers = [...catalog.store].filter((s) => !isIgnored(config, s)).sort((a, b) => (b.users30d ?? 0) - (a.users30d ?? 0)).slice(0, R6.actors).map((s) => s.id);
            const daysIn = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
            const m = await fetchMarketing(consoleApi, byUsers, month, prevMonth, (dayOfMonth - 1) / daysIn);
            if (m.failed) errors.push(`marketing:${m.failed}`);
            marketing = m.rows;
        }
        weeklyData = { marketing, userCountActors: watched };
        log(`weekly: user counts for ${watched.length} actors, marketing for ${Object.keys(marketing).length}`);
    }

    // 5. Snapshot (a degraded one never replaces today's full one; see the early exit above).
    const snapshot: Snapshot = {
        version: 1,
        takenAt: new Date(now).toISOString(),
        day,
        month,
        rulesVersion: RULES_VERSION,
        console: breakdown ? 'ok' : outcome === 'ok' ? 'error' : outcome,
        breakdown,
        prevMonthFinal,
        store: catalog?.store ?? existing?.store ?? null,
        weekly: weeklyData,
        errors,
    };
    await saveSnapshot(home, snapshot);

    // 6. Facts, rules, state.
    const data = await loadData(home, isoDayOf(now - 120 * DAY_MS));
    const prepared = prepare(data);
    const facts = deriveAllFacts(data);
    await writeFacts(home, facts);
    const money = snapshot.console === 'ok';
    const storeRows = snapshot.store ?? (await latestSnapshot(home, (s) => !!s.store))?.store ?? undefined;
    const evaluation = evaluateAll(prepared, {
        asOf: now,
        weekly,
        money,
        config,
        store: storeRows,
        noticeSince: noticeSince(data.snapshots),
        marketing: weeklyData?.marketing,
        extraNext: config.extraNext,
    });
    const first = !prevState;
    const tr = transition(prevState, evaluation.actors, now, evaluation.evaluated);
    const state = tr.state;
    if (money) state.lastConsoleOkAt = snapshot.takenAt;
    await appendEvents(home, tr.events);
    const items = buildItems(evaluation.actors, state, tr.opened, now);

    // 7. Digest on Mondays, on PAGE changes and on the first run.
    let digestPath: string | null = null;
    const unreported = state.resolved.filter((r) => !r.reported);
    if (weekly || tr.pageChanged || first) {
        const backfill = data.backfill;
        const dataLine = backfill.length
            ? `Facts from ${backfill.map((b) => b.from).sort()[0]} (backfill: ${Object.keys(backfill[backfill.length - 1]!.actors).length} actors at day level); later days from daily snapshots`
            : 'No backfill yet: baselines fill in over 4 weeks of daily snapshots (run `watch backfill` once to start with 63 days)';
        const text = renderDigest({
            day,
            asOf: evaluation.asOf,
            items,
            actors: evaluation.actors,
            facts: evaluation.facts,
            state,
            resolved: unreported,
            firstRun: first,
            weekly,
            consoleLine: consoleLine(snapshot, state.lastConsoleOkAt, now),
            storeLine: snapshot.store ? `Store stats ${snapshot.takenAt.slice(0, 16).replace('T', ' ')} UTC (${snapshot.store.length} public actors)` : 'Store stats MISSING this run',
            dataLine,
            notes: [
                'Money is paying-users money. Run counts and results cover every run of the actor (all users, your own included); R4 subtracts your own runs where the run list has them.',
                ...(config.ignore.length ? [`Ignored by config: ${config.ignore.join(', ')}`] : []),
            ],
        });
        digestPath = p.digest(day);
        await writeSecure(digestPath, text);
        for (const r of unreported) r.reported = true;
        if (config.digestCopyPath) {
            try {
                await copyFile(digestPath, config.digestCopyPath);
            } catch {
                errors.push('digest-copy:failed');
            }
        }
    }

    // 8. Notifications: new or worse PAGE items (at most one a day), and 48 h without Console money.
    let notified = false;
    const pageNotify = tr.notify.filter((n) => n.alert.tier === 'PAGE');
    if (!first && pageNotify.length && config.notifications && state.lastNotifiedDay !== day) {
        const text = notificationText(pageNotify.map((n) => ({ name: n.alert.name, rule: n.alert.rule, atStakeUsd: n.alert.atStakeUsd })));
        notified = await deps.notifier(text.title, text.message);
        if (notified) state.lastNotifiedDay = day;
    }
    if (!money) {
        const blindSince = Date.parse(state.lastConsoleOkAt ?? state.installedAt);
        const already = state.blindNotifiedAt && Date.parse(state.blindNotifiedAt) >= blindSince;
        if (now - blindSince >= BLIND_HOURS * HOUR_MS && !already && config.notifications) {
            const since = new Date(blindSince).toISOString().slice(0, 10);
            const ok = await deps.notifier('Early warning paused', `Money signals paused since ${since}: open Chrome and check you are logged in to console.apify.com.`);
            if (ok) state.blindNotifiedAt = new Date(now).toISOString();
            log(`blind: no Console money since ${since}${ok ? ' (notified)' : ''}`);
        }
    }

    state.lastRun = { at: new Date(now).toISOString(), console: snapshot.console, errors, digest: digestPath, notified };
    await writeJson(p.state, state);
    await cleanup(home, now);

    const counts = { PAGE: 0, WATCH: 0 };
    for (const a of Object.values(state.open)) if (a.tier === 'PAGE' || a.tier === 'WATCH') counts[a.tier]++;
    const summary = `watch run ${day}: console ${snapshot.console}, ${counts.PAGE} PAGE and ${counts.WATCH} WATCH open, ${tr.events.filter((e) => e.event === 'open').length} opened, ${tr.events.filter((e) => e.event === 'resolve').length} resolved${first ? ' (first run: backlog, no notification)' : ''}${notified ? ', notified' : ''}${digestPath ? `, digest ${digestPath}` : ''}${errors.length ? `, errors: ${errors.join(' ')}` : ''}`;
    log(summary);
    return { code: 0, summary };
}

// ---- backfill ----

export interface BackfillOptions {
    days?: number;
    force?: boolean;
}

export async function watchBackfill(deps: WatchDeps, options: BackfillOptions = {}): Promise<RunResult> {
    const result = await withLock(deps.home, deps.now(), () => backfillLocked(deps, options));
    if (result === 'locked') return { code: 1, summary: 'another watch run is in progress' };
    return result;
}

async function backfillLocked(deps: WatchDeps, options: BackfillOptions): Promise<RunResult> {
    const { home, api, log } = deps;
    const now = deps.now();
    const days = options.days ?? BACKFILL.defaultDays;
    const existing = await loadBackfill(home);
    if (existing.length && !options.force) {
        const msg = `A backfill already exists (${existing.map((b) => b.month).join(', ')}). It runs once; pass --force to fetch it again.`;
        log(msg);
        return { code: 1, summary: msg };
    }
    const me = await api.me();
    const made = await deps.console(me.id);
    if (!made.api) {
        const msg = `No Console session (${made.outcome}): open Chrome logged in to console.apify.com, run \`touch ~/.apify-insights/wanted\`, wait a minute and retry.`;
        log(msg);
        return { code: 1, summary: msg };
    }
    const config = await loadWatchConfig(home);
    const todayStart = dayStartMs(isoDayOf(now));
    const fromDay = isoDayOf(todayStart - days * DAY_MS);
    const months: string[] = [];
    for (let m = fromDay.slice(0, 7); m <= isoDayOf(now).slice(0, 7); m = isoDayOf(monthStartMs(m) + 32 * DAY_MS).slice(0, 7)) months.push(m);
    const started = Date.now();
    log(`backfill: ${days} days from ${fromDay} (whole months ${months.join(', ')}), one request at a time`);
    const monthRows = new Map<string, { rows: Awaited<ReturnType<typeof fetchBreakdown>>; fetchedAt: string }>();
    try {
        for (const month of months) monthRows.set(month, { rows: await fetchBreakdown(made.api, month), fetchedAt: new Date(deps.now()).toISOString() });
    } catch (error) {
        const msg = `backfill: Console breakdown failed (${errorCode(error)}).${error instanceof ToolError ? ` ${error.fix}` : ''}`;
        log(msg);
        return { code: 1, summary: msg };
    }
    const candidates = backfillCandidates([...monthRows.values()].map((m) => m.rows), BACKFILL);
    for (const [id, name] of candidates) if (isIgnored(config, { id, name })) candidates.delete(id);
    log(`backfill: ${candidates.size} actors (revenue or cost $1+ in a month, or 5+ failures with a paying user)`);
    let result;
    try {
        result = await runBackfill(made.api, months, monthRows, candidates, now, log);
    } catch (error) {
        const msg = `backfill: stopped (${errorCode(error)}).${error instanceof ToolError ? ` ${error.fix}` : ''} Nothing was saved; retry.`;
        log(msg);
        return { code: 1, summary: msg };
    }
    for (const month of result.months) await saveBackfill(home, month);
    await saveUsers(home, result.users);
    try {
        const ids = new Set([...(await api.myActors()).map((a) => a.id)]);
        const owner = await fetchOwnerRuns(api, `${months[0]}-01`, ids);
        if (owner) await saveOwnerRuns(home, owner, `${months[0]}-01`);
    } catch (error) {
        log(`backfill: owner runs failed (${errorCode(error)}); the owner-run exclusion will start with the next run`);
    }
    const data = await loadData(home);
    await writeFacts(home, deriveAllFacts(data));
    const seconds = Math.round((Date.now() - started) / 1000);
    const summary = `backfill done: ${candidates.size} actors, months ${months.join(', ')}, ${result.calls + months.length} Console requests in ${seconds} s${result.failed.length ? `, ${result.failed.length} actor-months failed (${[...new Set(result.failed.map((f) => f.code))].join(', ')})` : ''}`;
    log(summary);
    return { code: result.failed.length ? 1 : 0, summary };
}

// ---- status ----

export async function watchStatus(home: string, now: number, extra: { flagOn: boolean; launchAgentInstalled: boolean | null }): Promise<{ code: number; lines: string[] }> {
    const p = paths(home);
    const state = await loadState(home);
    const backfill = await loadBackfill(home);
    const lastOk = await latestSnapshot(home, (s) => s.console === 'ok');
    const lines: string[] = [];
    lines.push(`Early-warning watch (experimental, rules ${RULES_VERSION}): ${extra.flagOn ? 'flag on' : 'flag off (set APIFY_INSIGHTS_WATCH=1 or pass --experimental)'}`);
    lines.push(`Data folder: ${p.root}${(await exists(p.root)) ? '' : ' (not created yet)'}`);
    lines.push(`LaunchAgent: ${extra.launchAgentInstalled == null ? 'n/a (macOS only)' : extra.launchAgentInstalled ? 'installed' : 'not installed (run `watch install`)'}`);
    if (backfill.length) {
        const actors = new Set(backfill.flatMap((b) => Object.keys(b.actors)));
        lines.push(`Backfill: complete, ${actors.size} actors at day level, ${backfill.map((b) => b.from).sort()[0]} to ${backfill.map((b) => b.through).sort().pop()} (exclusive), fetched ${backfill[0]!.fetchedAt.slice(0, 16).replace('T', ' ')} UTC`);
    } else lines.push('Backfill: not run (run `watch backfill` once)');
    lines.push(`Last Console snapshot: ${lastOk ? `${lastOk.takenAt.slice(0, 16).replace('T', ' ')} UTC (${Math.round((now - Date.parse(lastOk.takenAt)) / HOUR_MS)} h ago)` : 'none'}`);
    if (state?.lastRun) {
        lines.push(`Last run: ${state.lastRun.at.slice(0, 16).replace('T', ' ')} UTC, console ${state.lastRun.console}, ${state.lastRun.errors.length} errors${state.lastRun.errors.length ? ` (${state.lastRun.errors.join(' ')})` : ''}`);
        const open = Object.values(state.open);
        const pages = open.filter((a) => a.tier === 'PAGE');
        const oldest = pages.map((a) => a.firstSeen).sort()[0];
        lines.push(`Open alerts: ${pages.length} PAGE${oldest ? ` (oldest since ${oldest.slice(0, 10)})` : ''}, ${open.filter((a) => a.tier === 'WATCH').length} WATCH; ${state.snoozes.filter((s) => Date.parse(s.until) > now).length} snoozed`);
        for (const a of pages.sort((x, y) => y.atStakeUsd - x.atStakeUsd).slice(0, 5)) lines.push(`  [PAGE] ${a.name} ${a.rule} ${usd(a.atStakeUsd)}/week since ${a.firstSeen.slice(0, 10)}${a.backlog ? ' (backlog)' : ''}`);
        if (state.lastRun.digest) lines.push(`Last digest: ${state.lastRun.digest}`);
    } else lines.push('Last run: never');
    const errors = state?.lastRun?.errors.length ?? 0;
    return { code: errors ? 1 : 0, lines };
}

// ---- snooze ----

export async function watchSnooze(home: string, now: number, query: string, days: number, rule: RuleId | null, remove = false): Promise<{ code: number; lines: string[] }> {
    const state = await loadState(home);
    if (!state) return { code: 1, lines: ['No watch state yet: run `watch run` first.'] };
    const latest = await latestSnapshot(home);
    const known = new Map<string, string>();
    for (const row of latest?.store ?? []) known.set(row.id, row.name);
    for (const row of latest?.breakdown ?? []) known.set(row.id, row.name);
    for (const a of Object.values(state.open)) known.set(a.actorId, a.name);
    const q = query.trim().toLowerCase();
    const exact = [...known].filter(([id, name]) => id.toLowerCase() === q || name.toLowerCase() === q);
    const matches = exact.length ? exact : [...known].filter(([, name]) => name.toLowerCase().includes(q));
    if (matches.length !== 1) return { code: 1, lines: [matches.length ? `"${query}" matches ${matches.length} actors: ${matches.slice(0, 8).map(([, n]) => n).join(', ')}` : `No actor matches "${query}".`] };
    const [actorId, name] = matches[0]!;
    state.snoozes = state.snoozes.filter((s) => !(s.actorId === actorId && (rule == null || s.rule === rule)) && Date.parse(s.until) > now);
    if (!remove) state.snoozes.push({ actorId, name, rule, until: new Date(now + days * DAY_MS).toISOString() });
    await writeJson(paths(home).state, state);
    return { code: 0, lines: [remove ? `Unsnoozed ${name}${rule ? ` (${rule})` : ''}.` : `Snoozed ${name}${rule ? ` (${rule})` : ' (all rules)'} until ${new Date(now + days * DAY_MS).toISOString().slice(0, 10)}. It still shows in the digest under Snoozed; it does not notify.`] };
}

// ---- replay ----

export interface ReplayOutcome {
    name: string;
    firstPage: { day: string; rules: RuleId[] } | null;
    firstWatch: { day: string; rules: RuleId[] } | null;
    pageOpens: number;
    pageDays: string[];
}

export interface ReplayResult {
    from: string;
    to: string;
    actors: Map<string, ReplayOutcome>;
    pagesPerWeek: Array<{ week: string; opens: number }>;
}

/**
 * Re-runs the rules once per UTC day from `from` to `to` (each run at 00:00 UTC, seeing only data that
 * existed then: complete days before it). Store notices have no history, so R5 is left out. The state
 * starts empty with no install backlog, so every first alert counts.
 */
export function replay(prepared: PreparedData, config: WatchConfig, from: string, to: string): ReplayResult {
    let state: WatchState = emptyState(dayStartMs(from));
    const actors = new Map<string, ReplayOutcome>();
    const weeks = new Map<string, number>();
    for (let t = dayStartMs(from); t <= dayStartMs(to); t += DAY_MS) {
        const day = isoDayOf(t);
        const weekly = new Date(t).getUTCDay() === 1;
        const evaluation: Evaluation = evaluateAll(prepared, { asOf: t, weekly, money: true, config });
        const tr = transition(state, evaluation.actors, t, evaluation.evaluated);
        state = tr.state;
        for (const e of tr.events) {
            if (e.event !== 'open' && e.event !== 'upgrade') continue;
            const id = e.key.split(':')[0]!;
            const o = actors.get(id) ?? { name: e.actor, firstPage: null, firstWatch: null, pageOpens: 0, pageDays: [] };
            if (e.tier === 'PAGE') {
                if (!o.firstPage) o.firstPage = { day, rules: [] };
                if (o.firstPage.day === day && !o.firstPage.rules.includes(e.rule)) o.firstPage.rules.push(e.rule);
                o.pageOpens++;
                o.pageDays.push(`${day} ${e.rule}`);
                const monday = isoDayOf(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS);
                weeks.set(monday, (weeks.get(monday) ?? 0) + 1);
            } else if (e.tier === 'WATCH') {
                if (!o.firstWatch) o.firstWatch = { day, rules: [] };
                if (o.firstWatch.day === day && !o.firstWatch.rules.includes(e.rule)) o.firstWatch.rules.push(e.rule);
            }
            actors.set(id, o);
        }
    }
    return { from, to, actors, pagesPerWeek: [...weeks.entries()].sort().map(([week, opens]) => ({ week, opens })) };
}

export async function loadReplayData(home: string): Promise<PreparedData> {
    return prepare(await loadData(home));
}
