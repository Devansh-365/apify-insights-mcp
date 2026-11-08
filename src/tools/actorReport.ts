import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { wrapApi } from '../context.js';
import { resolveActor } from '../core/actors.js';
import { ok, round, ToolError } from '../core/envelope.js';
import { failingFlag, noticeFlag, runHealth, type Flag } from '../core/flags.js';
import { currentPricingInfo, readPricing } from '../core/pricing.js';

export const actorReportInput = {
    actor: z.string().describe('The actor: id, name, username/name, or title.'),
};

type Args = z.infer<z.ZodObject<typeof actorReportInput>>;

export async function actorReport(ctx: Context, args: Args): Promise<CallToolResult> {
    const catalog = await ctx.catalog();
    const found = resolveActor(catalog, args.actor);
    if (found.kind === 'not_found') {
        throw new ToolError('actor_not_found', `No actor of yours matches "${args.actor}".`, 'Call list_actors with a `query` to find the name.');
    }
    if (found.kind === 'ambiguous') {
        throw new ToolError('actor_ambiguous', `"${args.actor}" matches several actors.`, 'Repeat with one of the candidates.', {
            candidates: found.candidates.map((actor) => actor.ref),
        });
    }
    const summary = found.actor;
    const [detail, localPaths] = await Promise.all([
        ctx.cache.get(`actor:${summary.id}`, 5 * 60_000, () => wrapApi(() => ctx.api().actor(summary.id))),
        ctx.localActorPaths(),
    ]);

    const health = detail.stats?.publicActorRunStats30Days ? runHealth(detail.stats.publicActorRunStats30Days) : summary.runs30d;
    const notice = detail.notice ?? summary.notice;
    const flags = [noticeFlag(notice), failingFlag(health, "last 30 days, users' runs")].filter((flag): flag is Flag => !!flag);
    const pricing = readPricing(currentPricingInfo(detail.pricingInfos, ctx.now())) ?? summary.pricing;
    const latest = detail.taggedBuilds?.latest;
    const localPath = localPaths.get(summary.name) ?? null;
    const notes = ['Revenue, cost, profit and paying/free users need the Console session (not available in this version).'];
    if (!summary.isPublic) notes.push('Private actor: users and run results are not in public stats, so they are null.');
    if (!localPath && ctx.config.actorDirs.length) notes.push('No local source folder found for this actor in APIFY_INSIGHTS_ACTOR_DIRS.');

    const lines = [
        `${summary.ref}${detail.title ? ` — ${detail.title}` : ''}${summary.isPublic ? '' : ' (private)'}.`,
        summary.users30d != null ? `Users: ${summary.users7d} (7d), ${summary.users30d} (30d), ${summary.users90d} (90d).` : '',
        health ? `Users' runs, 30d: ${health.runs}, failure rate ${round((health.failureRate ?? 0) * 100, 1)}%.` : '',
        pricing?.priceUsd != null ? `Price: $${pricing.priceUsd} per ${pricing.unit ?? 'unit'} (${pricing.model}).` : '',
        detail.defaultRunOptions?.memoryMbytes ? `Default memory: ${detail.defaultRunOptions.memoryMbytes} MB.` : '',
        flags.length ? `Flags: ${flags.map((flag) => flag.flag).join(', ')}.` : 'No flags.',
        localPath ? `Source: ${localPath}` : '',
    ].filter(Boolean);

    return ok(lines.join('\n'), {
        asOf: new Date(ctx.now()).toISOString(),
        source: ['apify-api'],
        actor: {
            id: summary.id,
            ref: summary.ref,
            title: detail.title ?? summary.title,
            url: summary.url,
            isPublic: summary.isPublic,
            isDeprecated: detail.isDeprecated ?? null,
            notice: notice && notice !== 'NONE' ? notice : null,
            modifiedAt: detail.modifiedAt ?? null,
        },
        users: { users7d: summary.users7d, users30d: summary.users30d, users90d: summary.users90d, total: summary.totalUsers },
        runs: {
            totalRuns: detail.stats?.totalRuns ?? summary.totalRuns,
            lastRunStartedAt: detail.stats?.lastRunStartedAt ?? summary.lastRunStartedAt,
            last30dUsersRuns: health && { ...health, failureRate: round(health.failureRate, 4) },
        },
        pricing,
        runOptions: {
            memoryMbytes: detail.defaultRunOptions?.memoryMbytes ?? null,
            timeoutSecs: detail.defaultRunOptions?.timeoutSecs ?? null,
            build: detail.defaultRunOptions?.build ?? null,
        },
        latestBuild: latest ? { buildNumber: latest.buildNumber ?? null, finishedAt: latest.finishedAt ?? null } : null,
        reviews: { count: summary.reviews, rating: summary.rating },
        flags,
        localPath,
        money: null,
        notes,
    });
}
