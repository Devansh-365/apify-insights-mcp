import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ConsoleApi } from '../clients/console.js';
import type { Context } from '../context.js';
import { resolveActor, type ActorSummary } from '../core/actors.js';
import { breakdown, qualityBusinessValue, qualityImprovements, qualityScores } from '../core/console-data.js';
import { ok, round, ToolError } from '../core/envelope.js';
import { addMonths, isoDay, monthOf } from '../core/period.js';
import { assignImpactLevels, buildInbox, compactEntry, groupFor, median, trafficFromMoney, trafficWeight, type ActorTraffic, type ImpactLevel, type QualityEntry } from '../core/quality.js';
import { failedNote, scanActors } from '../core/scan.js';

export const actorQualityInput = {
    actor: z.string().optional().describe("One actor (id, name, username/name or title): its score, sub-scores, what Apify praises and its suggestions. Omit for the portfolio's top issues."),
    top: z.number().int().min(1).max(50).default(20).describe('How many actors to scan, by 30-day users. Impact levels are relative to these actors.'),
};

type Args = z.infer<z.ZodObject<typeof actorQualityInput>>;

const TOP_ISSUES = 8;
const ACTORS_PER_ISSUE = 3;
const DESCRIPTION_CHARS = 100;

function pct(value: number | null | undefined): number | null {
    return value == null ? null : round(value * 100, 1);
}

function short(text: string): string {
    return text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS - 1)}…` : text;
}

async function loadQuality(ctx: Context, api: ConsoleApi, actor: ActorSummary): Promise<QualityEntry> {
    const [scores, recommendations, businessValue] = await Promise.all([
        qualityScores(ctx, api, actor.id),
        qualityImprovements(ctx, api, actor.id),
        qualityBusinessValue(ctx, api, actor.id),
    ]);
    return compactEntry(actor.id, { scores, recommendations, businessValue }, actor.isPublic);
}

/** Traffic weights from last month's and this month's money. Without them every actor weighs 1. */
async function loadTraffic(ctx: Context, api: ConsoleApi, now: number): Promise<{ traffic: Map<string, ActorTraffic>; ok: boolean }> {
    const month = monthOf(isoDay(now));
    try {
        const [previous, current] = await Promise.all([breakdown(ctx, api, addMonths(month, -1)), breakdown(ctx, api, month)]);
        return { traffic: trafficFromMoney(previous, current), ok: true };
    } catch {
        return { traffic: new Map(), ok: false };
    }
}

const NO_TRAFFIC_NOTE = 'Money data could not be loaded, so every actor has the same traffic weight and impact follows the work type only.';

export async function actorQuality(ctx: Context, args: Args): Promise<CallToolResult> {
    const api = await ctx.console();
    const now = ctx.now();
    const catalog = await ctx.catalog();
    const asOf = new Date(now).toISOString();

    if (args.actor) {
        const found = resolveActor(catalog, args.actor);
        if (found.kind === 'not_found') throw new ToolError('actor_not_found', `No actor of yours matches "${args.actor}".`, 'Call list_actors with a `query` to find the name.');
        if (found.kind === 'ambiguous') {
            throw new ToolError('actor_ambiguous', `"${args.actor}" matches several actors.`, 'Repeat with one of the candidates.', { candidates: found.candidates.map((actor) => actor.ref) });
        }
        const actor = found.actor;
        const [entry, { traffic, ok: trafficOk }] = await Promise.all([loadQuality(ctx, api, actor), loadTraffic(ctx, api, now)]);
        const base = { asOf, source: ['console (unofficial)' as const], actor: { name: actor.name, ref: actor.ref } };
        if (entry.pending) {
            const why = entry.pending === 'unpublished' ? 'it is not public in the Store' : 'Apify has not scored it yet';
            return ok(`${actor.name}: no quality score yet, because ${why}.`, {
                ...base,
                score: { qualityPct: null, percentilePct: null },
                subScores: null,
                pending: entry.pending,
                praises: [],
                improvements: [],
                notes: ['Apify shows no real score or suggestions until an actor is public and scored; anything before that is a placeholder.'],
            });
        }
        const weight = trafficWeight(traffic.get(actor.id), now);
        const items = entry.improvements.map((improvement) => {
            const group = groupFor(improvement.id);
            return { improvement, group, impact: group.weight * weight, traffic: weight, level: 'low' as ImpactLevel };
        });
        assignImpactLevels(items);
        items.sort((left, right) => right.impact - left.impact);
        const { actorQuality: quality, actorQualityPercentile: percentile, ...rest } = entry.scores ?? {};
        const qualityPct = pct(quality);
        const percentilePct = pct(percentile);
        const improvements = items.map((item) => ({
            id: item.improvement.id,
            title: item.improvement.title,
            description: short(item.improvement.detail || item.improvement.description),
            group: item.group.key,
            groupLabel: item.group.label,
            impact: item.level,
        }));
        const summary = [
            `${actor.name}: quality ${qualityPct ?? 'n/a'}%${percentilePct != null ? ` (percentile ${percentilePct})` : ''}.`,
            entry.praises.length ? `Praises: ${entry.praises.join(', ')}.` : null,
            improvements.length
                ? `${improvements.length} suggestion${improvements.length === 1 ? '' : 's'}: ${improvements.slice(0, 3).map((item) => `${item.id} (${item.groupLabel}, ${item.impact})`).join(', ')}.`
                : 'No improvement suggestions.',
        ].filter(Boolean);
        return ok(summary.join(' '), {
            ...base,
            score: { qualityPct, percentilePct },
            subScores: Object.keys(rest).length ? rest : null,
            pending: null,
            praises: entry.praises,
            improvements,
            notes: [
                'Impact levels here rank this actor’s own suggestions by work type and traffic. Call actor_quality without `actor` to rank suggestions across your actors.',
                ...(trafficOk ? [] : [NO_TRAFFIC_NOTE]),
            ],
        });
    }

    const peers = catalog
        .filter((actor) => actor.isPublic)
        .sort((a, b) => (b.users30d ?? 0) - (a.users30d ?? 0))
        .slice(0, args.top);
    const [scan, { traffic, ok: trafficOk }] = await Promise.all([scanActors(peers, (actor) => loadQuality(ctx, api, actor)), loadTraffic(ctx, api, now)]);
    const scanned = peers.filter((actor) => scan.results.has(actor.id));
    const inbox = buildInbox(scanned, scan.results, traffic, now);
    const scored = [...scan.results.values()].filter((entry) => !entry.pending && entry.scores);
    const medianQualityPct = pct(median(scored.map((entry) => entry.scores!.actorQuality!).filter((value) => value != null)));
    const medianPercentilePct = pct(median(scored.map((entry) => entry.scores!.actorQualityPercentile).filter((value): value is number => value != null)));

    // Rating and user counts (the hidden "market" group) are not work you can do, so they are not listed.
    const visible = inbox.issues.filter((issue) => !issue.group.hidden);
    const issues = visible.slice(0, TOP_ISSUES).map((issue) => ({
        id: issue.id,
        title: issue.title,
        description: short(issue.description),
        group: issue.group.key,
        groupLabel: issue.group.label,
        actorCount: issue.items.length,
        impact: issue.level,
        actors: issue.items.slice(0, ACTORS_PER_ISSUE).map((item) => ({ name: item.actor.name, qualityPct: pct(item.entry.scores?.actorQuality) })),
    }));
    const openSuggestions = inbox.items.filter((item) => !item.group.hidden).length;
    const pending = [...scan.results.values()].filter((entry) => entry.pending).length;
    const failed = failedNote(scan.failed, peers.length);

    const summary = [
        `${inbox.actorsToFix} of ${scanned.length} scanned actors have quality suggestions (${openSuggestions} in all).`,
        issues.length ? `Top: ${issues.slice(0, 3).map((issue) => `${issue.id} on ${issue.actorCount} actor${issue.actorCount === 1 ? '' : 's'} (${issue.groupLabel}, ${issue.impact})`).join('; ')}.` : null,
        medianQualityPct != null ? `Median quality: ${medianQualityPct}%.` : null,
    ].filter(Boolean);

    return ok(summary.join(' '), {
        asOf,
        source: ['console (unofficial)'],
        totals: { scanned: scanned.length, pending, actorsWithSuggestions: inbox.actorsToFix, openSuggestions },
        scores: { medianQualityPct, medianPercentilePct },
        issues,
        ...(visible.length > issues.length ? { omitted: { rows: visible.length - issues.length, hint: 'Pass `actor` to see every suggestion for one actor.' } } : {}),
        notes: [
            `Impact levels are relative to the top ${scanned.length} actors by 30-day users, not the whole portfolio, so they can change with \`top\`. Name one actor to get its detail.`,
            'Impact = work-type weight (security 5, operations 4, schema 3, pricing 2, listing 1) × traffic weight from revenue, runs and users.',
            ...(trafficOk ? [] : [NO_TRAFFIC_NOTE]),
            ...(failed ? [failed] : []),
        ],
    });
}
