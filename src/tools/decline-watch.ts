import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { wrapApi } from '../context.js';
import { resolveActor } from '../core/actors.js';
import { ok, round, ToolError } from '../core/envelope.js';
import { isoDay, monthOf } from '../core/period.js';
import { DAY_MS, RULES_VERSION, WEEK_MS } from '../core/watch/constants.js';
import { evaluateAll, prepare } from '../core/watch/engine.js';
import { sumWindow } from '../core/watch/facts.js';
import { loadWatchConfig } from '../core/watch/files.js';
import { readWatchSummary } from '../core/watch/reader.js';
import { latestSnapshot, loadData } from '../core/watch/store.js';
import type { Alert } from '../core/watch/types.js';

// `decline_watch` (experimental, only registered when APIFY_INSIGHTS_WATCH=1): reads the early-warning
// job's local state and latest digest. With `actor`, a drill-down from local facts plus up to 3 live
// single-actor Console reads, one after another, and rivals' public 7-day users from config.json.
// Read-only: it never writes, snoozes or changes anything (snooze is a CLI command).

export const declineWatchInput = {
    actor: z.string().min(1).optional().describe('Name, username/name or ID of one of your actors, for a drill-down.'),
    include: z.enum(['page', 'all']).default('page').describe('page: open PAGE alerts only (default). all: also WATCH alerts and the latest digest text.'),
};

type Args = { actor?: string; include?: 'page' | 'all' };

function alertOut(a: Alert) {
    return { actor: a.name, rule: a.rule, tier: a.tier, title: a.title, evidence: a.evidence, atStakeUsdPerWeek: round(a.atStakeUsd), firstSeen: a.firstSeen.slice(0, 10), backlog: a.backlog, next: a.next };
}

const NOT_RUN_FIX = 'Run `npx -y github:Devansh-365/apify-insights-mcp watch backfill --experimental` once, then `watch run --experimental` (or `watch install` for the daily schedule).';

export async function declineWatch(ctx: Context, args: Args): Promise<CallToolResult> {
    const now = ctx.now();
    const home = ctx.config.home;
    const summary = await readWatchSummary(home);
    if (!summary.state) throw new ToolError('disabled', 'The early-warning watch has not run on this computer yet.', NOT_RUN_FIX);
    const include = args.include ?? 'page';
    const lastRun = summary.state.lastRun;
    const lastOk = summary.state.lastConsoleOkAt;
    const base = {
        asOf: new Date(now).toISOString(),
        source: ['apify-api' as const, 'console (unofficial)' as const],
        rulesVersion: RULES_VERSION,
        lastRun: lastRun ? { at: lastRun.at, console: lastRun.console, errors: lastRun.errors } : null,
        lastConsoleSnapshotAt: lastOk,
        digestPath: summary.digestPath,
    };

    if (!args.actor) {
        const pages = summary.pages.map(alertOut);
        const watches = include === 'all' ? summary.watches.map(alertOut) : undefined;
        const lines = [
            `Early warning (experimental, rules ${RULES_VERSION}): ${pages.length} open PAGE, ${summary.watches.length} WATCH. Last run ${lastRun ? lastRun.at.slice(0, 16).replace('T', ' ') : 'never'} UTC${lastRun && lastRun.console !== 'ok' ? ` (Console ${lastRun.console}: money signals paused)` : ''}.`,
            ...pages.slice(0, 5).map((p, i) => `${i + 1}. ${p.actor}: ${p.title} ($${p.atStakeUsdPerWeek}/week, since ${p.firstSeen}${p.backlog ? ', install backlog' : ''}). Next: ${p.next}`),
        ];
        return ok(lines.join('\n'), {
            ...base,
            page: pages,
            ...(watches ? { watch: watches } : {}),
            snoozed: summary.state.snoozes.filter((s) => Date.parse(s.until) > now).map((s) => ({ actor: s.name, rule: s.rule, until: s.until.slice(0, 10) })),
            ...(include === 'all' && summary.digest ? { digest: summary.digest.slice(0, 12_000) } : {}),
            notes: [
                'PAGE alerts notify once when new or 50% worse; WATCH alerts appear in the digest only. Backlog alerts were already true when the watch was installed.',
                'Money is paying-users money; run counts cover every run of the actor. Numbers come from the last watch run, not live.',
            ],
        });
    }

    const catalog = await ctx.catalog();
    const found = resolveActor(catalog, args.actor);
    if (found.kind === 'not_found') throw new ToolError('actor_not_found', `No actor of yours matches "${args.actor}".`, 'Call list_actors with a `query` to find the name.');
    if (found.kind === 'ambiguous') throw new ToolError('actor_ambiguous', `"${args.actor}" matches several actors.`, 'Repeat with one of the candidates.', { candidates: found.candidates.map((a) => a.ref) });
    const actor = found.actor;
    const config = await loadWatchConfig(home);
    const data = await loadData(home, isoDay(now - 120 * DAY_MS));
    const prepared = prepare(data);
    const latestStore = (await latestSnapshot(home, (s) => !!s.store))?.store ?? undefined;
    const asOf = Math.min(now, Date.parse(lastOk ?? new Date(now).toISOString()));
    const evaluation = evaluateAll(prepared, { asOf, weekly: false, money: !!lastOk, config: { ...config, ignore: [] }, store: latestStore });
    const facts = evaluation.facts.get(actor.id) ?? null;
    const signals = evaluation.actors.find((a) => a.id === actor.id)?.signals ?? [];
    const index = prepared.actors.get(actor.id);
    const weeks = index
        ? Array.from({ length: 9 }, (_, k) => {
              const to = asOf - k * WEEK_MS;
              const w = sumWindow(index.slices.filter((s) => s.t1 <= asOf), to - WEEK_MS, to);
              return {
                  weekEnding: isoDay(to - 1),
                  revenueUsd: round(w.v.rev),
                  costUsd: round(w.v.cost),
                  runs: Math.round(w.v.runs),
                  failed: Math.round(w.v.failed),
                  timedOut: Math.round(w.v.timedOut),
                  resultsPerRun: w.v.succeeded ? round(w.v.results / w.v.succeeded, 1) : null,
                  approximate: w.approximate,
              };
          })
        : [];
    const open = Object.values(summary.state.open).filter((a) => a.actorId === actor.id).map(alertOut);

    // Live reads: up to 3 single-actor Console calls, one after another, only if a session exists now.
    const notes: string[] = [];
    let live: Record<string, unknown> | null = null;
    const { api, state } = await ctx.optionalConsole();
    if (api) {
        const month = monthOf(isoDay(now));
        try {
            const pm = await api.profitMargin(month, [actor.id]);
            const uc = await api.userCounts(month, [actor.id]);
            const rs = await api.runStatistics(month, [actor.id]);
            const days = Object.keys(pm.dailyProfitMarginStats).sort().slice(-7);
            live = {
                month,
                monthToDate: { revenueUsd: round(pm.totalProfitMarginStats.payingUsersUsd.revenueUsd), costUsd: round(pm.totalProfitMarginStats.payingUsersUsd.costUsd) },
                lastDays: days.map((day) => ({
                    day: day.slice(0, 10),
                    revenueUsd: round(pm.dailyProfitMarginStats[day]!.payingUsersUsd.revenueUsd),
                    costUsd: round(pm.dailyProfitMarginStats[day]!.payingUsersUsd.costUsd),
                    payingUsers: uc[day.slice(0, 10)]?.payingUsers ?? null,
                    runs: (rs.dailyStats[day.slice(0, 10)] as { TOTAL?: number } | undefined)?.TOTAL ?? null,
                })),
            };
        } catch (error) {
            notes.push(`Live Console reads failed (${error instanceof ToolError ? error.code : 'error'}); local facts only.`);
        }
    } else notes.push(`Live Console reads skipped: no fresh session (${state}). Local facts only.`);

    const rivals: Array<{ actor: string; users7d: number | null }> = [];
    for (const ref of (config.rivals[actor.name] ?? []).slice(0, 5)) {
        try {
            const detail = await wrapApi(() => ctx.api().actor(ref));
            rivals.push({ actor: ref, users7d: detail.stats?.totalUsers7Days ?? null });
        } catch {
            rivals.push({ actor: ref, users7d: null });
        }
    }
    if (!config.rivals[actor.name]) notes.push('No rivals listed for this actor in ~/.apify-insights/watch/config.json ("rivals": {"<actor name>": ["username/name"]}).');

    const lines = [
        `${actor.name}: ${open.length ? open.map((a) => `[${a.tier}] ${a.title}`).join(', ') : 'no open alerts'}.`,
        facts
            ? `7d revenue $${round(facts.w0.v.rev)} vs 8-week median ${facts.baseline == null ? 'n/a (under 4 weeks of data)' : `$${round(facts.baseline)}`}; class ${facts.cls}; revenue on ${facts.revenueDays56} of 56 days; ${facts.pool ? 'in' : 'not in'} the earning pool.`
            : 'No local facts for this actor yet.',
    ];
    return ok(lines.join('\n'), {
        ...base,
        actor: actor.name,
        open,
        signalsNow: signals.map((s) => ({ rule: s.rule, tier: s.tier, hold: !!s.hold, title: s.title, evidence: s.evidence })),
        facts: facts
            ? {
                  revenue7dUsd: round(facts.w0.v.rev),
                  previous7dUsd: round(facts.w1.v.rev),
                  baselineUsd: round(facts.baseline),
                  baselineWindows: facts.baselineWindows,
                  class: facts.cls,
                  revenueDays56: facts.revenueDays56,
                  revenue56Usd: round(facts.revenue56),
                  peakShare56: round(facts.peakShare56, 3),
                  earningPool: facts.pool,
                  payingUsersThisMonth: facts.payingThis,
                  payingUsersLastMonth: facts.payingLast,
                  ownerRunExclusions: facts.exclusions,
              }
            : null,
        weeks,
        live,
        rivals,
        notes: [...notes, 'Weeks end at the last Console snapshot; a week marked approximate holds a multi-day gap spread evenly.'],
    });
}
