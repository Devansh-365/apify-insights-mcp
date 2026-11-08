import type { MyActor, StoreActor } from '../clients/apifyApi.js';
import { runHealth, type RunHealth } from './flags.js';
import { readPricing, type Pricing } from './pricing.js';

export interface ActorSummary {
    id: string;
    name: string;
    title: string | null;
    ref: string;
    isPublic: boolean;
    users7d: number | null;
    users30d: number | null;
    users90d: number | null;
    totalUsers: number | null;
    totalRuns: number | null;
    lastRunStartedAt: string | null;
    notice: string | null;
    /** Users' runs in the last 30 days (Store stats). Null for private actors, which have no public stats. */
    runs30d: RunHealth | null;
    pricing: Pricing | null;
    rating: number | null;
    reviews: number | null;
    url: string | null;
}

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Joins every own actor (`/acts?my=1`) with its public Store record when it has one. */
export function buildCatalog(mine: MyActor[], store: StoreActor[]): ActorSummary[] {
    const storeById = new Map(store.map((item) => [item.id, item]));
    return mine.map((actor) => {
        const listed = storeById.get(actor.id);
        const stats = listed?.stats;
        return {
            id: actor.id,
            name: actor.name,
            title: listed?.title ?? actor.title ?? null,
            ref: `${actor.username}/${actor.name}`,
            isPublic: !!listed,
            users7d: num(stats?.totalUsers7Days),
            users30d: num(stats?.totalUsers30Days),
            users90d: num(stats?.totalUsers90Days),
            totalUsers: num(stats?.totalUsers),
            totalRuns: num(stats?.totalRuns) ?? num(actor.stats?.totalRuns),
            lastRunStartedAt: stats?.lastRunStartedAt ?? actor.stats?.lastRunStartedAt ?? null,
            notice: listed?.notice ?? null,
            runs30d: runHealth(stats?.publicActorRunStats30Days),
            pricing: listed ? readPricing(listed.currentPricingInfo) : null,
            rating: stats?.actorReviewCount ? num(stats.actorReviewRating) : null,
            reviews: num(stats?.actorReviewCount),
            url: listed?.url ?? null,
        };
    });
}

export type Resolution =
    | { kind: 'found'; actor: ActorSummary }
    | { kind: 'ambiguous'; candidates: ActorSummary[] }
    | { kind: 'not_found' };

/** Accepts an id, `username/name`, `username~name`, a name, a title, or a unique part of one. */
export function resolveActor(catalog: ActorSummary[], query: string): Resolution {
    const q = query.trim().toLowerCase().replace('~', '/');
    if (!q) return { kind: 'not_found' };
    const exact = catalog.filter(
        (actor) =>
            actor.id.toLowerCase() === q ||
            actor.ref.toLowerCase() === q ||
            actor.name.toLowerCase() === q ||
            actor.title?.toLowerCase() === q,
    );
    if (exact.length === 1) return { kind: 'found', actor: exact[0]! };
    const pool = exact.length ? exact : catalog.filter((actor) => actor.name.includes(q) || actor.title?.toLowerCase().includes(q));
    if (pool.length === 1) return { kind: 'found', actor: pool[0]! };
    if (!pool.length) return { kind: 'not_found' };
    return { kind: 'ambiguous', candidates: [...pool].sort((a, b) => (b.users30d ?? -1) - (a.users30d ?? -1)).slice(0, 8) };
}
