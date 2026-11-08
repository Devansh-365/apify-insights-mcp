import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Marketing } from '../clients/console.js';
import type { Context } from '../context.js';
import { assignBucket, BUCKETS, buildTriage, compactEntry, computeThresholds, isEarlyMonth, type AcquisitionEntry, type BucketKey, type Thresholds, type ViewerChange } from '../core/acquisition.js';
import { resolveActor, type ActorSummary } from '../core/actors.js';
import { marketing } from '../core/console-data.js';
import { ok, round, ToolError } from '../core/envelope.js';
import { funnel } from '../core/funnel.js';
import { addMonths, isoDay, monthEnd, monthOf, resolvePeriod } from '../core/period.js';
import { failedNote, scanActors } from '../core/scan.js';

export const acquisitionScoreInput = {
    actor: z.string().optional().describe('One actor (id, name, username/name or title): its bucket, reason and numbers. Omit for the portfolio triage.'),
    month: z
        .union([z.enum(['thisMonth', 'lastMonth']), z.string().regex(/^\d{4}-\d{2}$/)])
        .default('thisMonth')
        .describe('Calendar month. thisMonth (default) is compared with last month at the same point; a past month with the whole month before it.'),
    top: z.number().int().min(1).max(50).default(20).describe('How many actors to scan, by 30-day users. Buckets are relative to these actors.'),
};

type Args = z.infer<z.ZodObject<typeof acquisitionScoreInput>>;

// Steady and Quiet need no action, so they are counted but not listed (keeps the answer short).
const LISTED: Record<BucketKey, number> = { leaking: 5, rising: 5, fading: 5, converting: 5, steady: 0, quiet: 0 };

interface Loaded {
    data: Marketing;
    entry: AcquisitionEntry;
}

function pct(value: number | null): number | null {
    return value == null ? null : round(value * 100, 1);
}

function changePct(value: ViewerChange): number | 'new' | null {
    return value === 'new' ? 'new' : pct(value);
}

function thresholdsOut(t: Thresholds) {
    return { viewerFloor: t.viewerFloor, leakFloor: t.leakFloor, conversionLowPct: pct(t.conversionLow), conversionHighPct: pct(t.conversionHigh) };
}

function relativeNote(scanned: number): string {
    return `Thresholds and bucket sizes are relative to the top ${scanned} actors by 30-day users, not the whole portfolio, so they can change with \`top\`. Name one actor to get its detail.`;
}

const EARLY_NOTE = 'Before day 8 of the month, Rising and Fading are not judged: the change since the same point last month is too noisy.';
const GROWTH_NOTE = 'For referrers, countries and paying users, call growth with this actor and month.';

export async function acquisitionScore(ctx: Context, args: Args): Promise<CallToolResult> {
    const api = await ctx.console();
    const now = ctx.now();
    const period = resolvePeriod(args.month, now);
    const month = period.wholeMonth ?? monthOf(period.from);
    const prevMonth = addMonths(month, -1);
    const current = month === monthOf(isoDay(now));
    // This month is read as it stands. The Console scales a month's numbers by `portionOfMonthElapsed`, so
    // last month is read scaled to the share of this month that has fully passed: the same comparison the
    // Console and the extension make. A past month is compared with the whole month before it. On day 1
    // there is nothing to compare yet.
    const comparePortion = current ? (Number(isoDay(now).slice(8)) - 1) / Number(monthEnd(month).slice(8)) : undefined;
    const early = isEarlyMonth(month, now);
    const catalog = await ctx.catalog();

    const load = async (actor: ActorSummary): Promise<Loaded> => {
        const [data, previous] = await Promise.all([
            marketing(ctx, api, month, [actor.id]),
            comparePortion === 0 ? Promise.resolve(null) : marketing(ctx, api, prevMonth, [actor.id], comparePortion),
        ]);
        return { data, entry: compactEntry(data, previous) };
    };

    let named: ActorSummary | null = null;
    if (args.actor) {
        const found = resolveActor(catalog, args.actor);
        if (found.kind === 'not_found') throw new ToolError('actor_not_found', `No actor of yours matches "${args.actor}".`, 'Call list_actors with a `query` to find the name.');
        if (found.kind === 'ambiguous') {
            throw new ToolError('actor_ambiguous', `"${args.actor}" matches several actors.`, 'Repeat with one of the candidates.', { candidates: found.candidates.map((actor) => actor.ref) });
        }
        named = found.actor;
    }

    // Thresholds are relative, so even one actor is judged against the top actors (cached after the first call).
    const peers = catalog
        .filter((actor) => actor.isPublic && actor.id !== named?.id)
        .sort((a, b) => (b.users30d ?? 0) - (a.users30d ?? 0))
        .slice(0, named ? Math.max(0, args.top - 1) : args.top);
    const [mine, scan] = await Promise.all([named ? load(named) : null, peers.length ? scanActors(peers, load) : { results: new Map<string, Loaded>(), failed: [] as ActorSummary[] }]);
    const loaded = new Map(scan.results);
    const scanned: ActorSummary[] = peers.filter((actor) => loaded.has(actor.id));
    if (named && mine) {
        loaded.set(named.id, mine);
        scanned.unshift(named);
    }
    const thresholds = computeThresholds([...loaded.values()].map((item) => item.entry));
    const asOf = new Date(now).toISOString();
    const periodOut = { label: String(args.month), from: period.from, to: period.to, partial: current };
    const failed = failedNote(scan.failed, scan.failed.length + scanned.length);
    const label = `${month}${current ? ' (in progress)' : ''}`;

    if (named && mine) {
        const assigned = assignBucket(mine.entry, thresholds, { early });
        const bucket = BUCKETS.find((item) => item.key === assigned.key)!;
        const shown = funnel(mine.data);
        const previous = mine.entry.prevViewers == null ? null : { viewingUsers: mine.entry.prevViewers, usersWithRun: mine.entry.prevStarters };
        const notes = [GROWTH_NOTE, relativeNote(scanned.length), ...(early ? [EARLY_NOTE] : []), ...(failed ? [failed] : [])];
        return ok(`${named.name} (${label}): ${bucket.label}, ${bucket.action.toLowerCase()}. ${assigned.reason}.`, {
            asOf,
            source: ['console (unofficial)'],
            period: periodOut,
            actor: { name: named.name, ref: named.ref },
            bucket: { key: bucket.key, label: bucket.label, action: bucket.action },
            reason: assigned.reason,
            funnel: shown,
            previous,
            viewerChangePct: changePct(assigned.viewerChange),
            thresholds: thresholdsOut(thresholds),
            notes,
        });
    }

    const triage = buildTriage(scanned, new Map([...loaded].map(([id, item]) => [id, item.entry])), thresholds, { early });
    const buckets = triage.buckets.map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        action: bucket.action,
        count: bucket.items.length,
        viewingUsers: bucket.viewers,
        actors: bucket.items.slice(0, LISTED[bucket.key]).map((item) => {
            const shown = funnel(loaded.get(item.actor.id)!.data);
            return { name: item.actor.name, viewingUsers: shown.viewingUsers, usersWithRun: shown.usersWithRun, viewToRunPct: shown.viewToRunPct, viewerChangePct: changePct(item.viewerChange), reason: item.reason };
        }),
    }));
    const unlisted = buckets.reduce((sum, bucket) => sum + bucket.count - bucket.actors.length, 0);

    const counts = buckets.map((bucket) => `${bucket.count} ${bucket.key}`).join(', ');
    const summary = [`${label}: ${counts} among your top ${triage.scanned} actors (${triage.viewers.toLocaleString('en-US')} viewers).`];
    const worst = triage.buckets.find((bucket) => bucket.key === 'leaking')?.items[0];
    if (worst) {
        const shown = funnel(loaded.get(worst.actor.id)!.data);
        summary.push(`Worst leaking: ${worst.actor.name} (${shown.viewingUsers} viewers, ${shown.usersWithRun} with a run, ${shown.viewToRunPct ?? 'n/a'}%).`);
    }
    if (early) summary.push(EARLY_NOTE);

    return ok(summary.join('\n'), {
        asOf,
        source: ['console (unofficial)'],
        period: periodOut,
        thresholds: thresholdsOut(thresholds),
        totals: { scanned: triage.scanned, viewingUsers: triage.viewers },
        buckets,
        ...(unlisted ? { omitted: { rows: unlisted, hint: 'Up to 5 actors are listed per bucket that needs action; Steady and Quiet are counted only. Pass `actor` to see any one actor.' } } : {}),
        notes: [relativeNote(triage.scanned), ...(early ? [EARLY_NOTE] : []), ...(failed ? [failed] : []), 'For raw counts, paying users, referrers and countries, call growth.'],
    });
}
