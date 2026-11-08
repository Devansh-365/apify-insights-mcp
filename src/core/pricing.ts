// Reads an actor's pricing the way apify-insights-plus lib/portfolio.js does: the primary (else first
// recurring) pay-per-event event, or the per-unit price for other models.

export interface Pricing {
    model: string | null;
    unit: string | null;
    priceUsd: number | null;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

export function readPricing(info: unknown): Pricing | null {
    const pricing = asObject(info);
    if (!pricing) return null;
    const model = typeof pricing.pricingModel === 'string' ? pricing.pricingModel : null;
    const events = asObject(asObject(pricing.pricingPerEvent)?.actorChargeEvents);
    if (events) {
        const list = Object.values(events).map(asObject).filter((event): event is Json => !!event);
        const event = list.find((item) => item.isPrimaryEvent) ?? list.find((item) => !item.isOneTimeEvent) ?? null;
        if (event) {
            const tiers = asObject(event.eventTieredPricingUsd);
            const firstTier = tiers ? asObject(tiers.FREE) ?? asObject(Object.values(tiers)[0]) : null;
            const price = tiers ? firstTier?.tieredEventPriceUsd : event.eventPriceUsd;
            return {
                model,
                unit: typeof event.eventTitle === 'string' ? event.eventTitle : 'event',
                priceUsd: typeof price === 'number' ? price : null,
            };
        }
    }
    const price = pricing.pricePerUnitUsd;
    return {
        model,
        unit: typeof pricing.unitName === 'string' ? pricing.unitName : null,
        priceUsd: typeof price === 'number' ? price : null,
    };
}

/** The pricing in force now: the latest `pricingInfos` entry whose `startedAt` is not in the future. */
export function currentPricingInfo(infos: Array<Record<string, unknown>> | undefined, now = Date.now()): unknown {
    if (!infos?.length) return null;
    const startedAt = (info: Record<string, unknown>) => {
        const at = typeof info.startedAt === 'string' ? Date.parse(info.startedAt) : NaN;
        return Number.isFinite(at) ? at : 0;
    };
    const started = infos.filter((info) => startedAt(info) <= now).sort((a, b) => startedAt(a) - startedAt(b));
    return started.at(-1) ?? null;
}
