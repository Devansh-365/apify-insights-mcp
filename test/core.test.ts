import { describe, expect, it } from 'vitest';
import { buildCatalog, resolveActor } from '../src/core/actors.js';
import { failingFlag, noticeFlag, runHealth } from '../src/core/flags.js';
import { currentPricingInfo, readPricing } from '../src/core/pricing.js';
import { myActor, storeActor } from './helpers.js';

describe('runHealth', () => {
    it('derives FAILED when the response leaves it out', () => {
        expect(runHealth({ TOTAL: 10, SUCCEEDED: 6, ABORTED: 1, 'TIMED-OUT': 1 })).toMatchObject({ failed: 2, timedOut: 1, failures: 3 });
    });
    it('excludes aborted runs from failures', () => {
        expect(runHealth({ TOTAL: 100, SUCCEEDED: 50, ABORTED: 50, FAILED: 0, 'TIMED-OUT': 0 })!.failureRate).toBe(0);
    });
    it('returns null without counts and a null rate without runs', () => {
        expect(runHealth(undefined)).toBeNull();
        expect(runHealth({ TOTAL: 0 })!.failureRate).toBeNull();
    });
});

describe('failingFlag (ported thresholds: 3 failures, 5%)', () => {
    const cases: Array<[Record<string, number>, boolean]> = [
        [{ TOTAL: 60, SUCCEEDED: 57, FAILED: 3 }, true], // 3 failures, 5.0%
        [{ TOTAL: 61, SUCCEEDED: 58, FAILED: 3 }, false], // 4.9%
        [{ TOTAL: 20, SUCCEEDED: 18, FAILED: 2 }, false], // 10% but only 2 failures
        [{ TOTAL: 40, SUCCEEDED: 37, 'TIMED-OUT': 3, FAILED: 0 }, true], // timeouts count
        [{ TOTAL: 40, SUCCEEDED: 30, ABORTED: 10, FAILED: 0 }, false], // aborts do not
    ];
    it.each(cases)('%j -> %s', (counts, expected) => {
        expect(!!failingFlag(runHealth(counts), '30d')).toBe(expected);
    });
});

describe('noticeFlag', () => {
    it('ignores NONE and missing notices', () => {
        expect(noticeFlag('NONE')).toBeNull();
        expect(noticeFlag(null)).toBeNull();
        expect(noticeFlag('UNDER_MAINTENANCE')!.evidence.notice).toBe('UNDER_MAINTENANCE');
    });
});

describe('pricing', () => {
    it('reads the primary pay-per-event price from tiers', () => {
        const info = {
            pricingModel: 'PAY_PER_EVENT',
            pricingPerEvent: {
                actorChargeEvents: {
                    start: { eventTitle: 'Actor start', isOneTimeEvent: true, eventPriceUsd: 0.01 },
                    item: { eventTitle: 'Result', isPrimaryEvent: true, eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.003 }, GOLD: { tieredEventPriceUsd: 0.002 } } },
                },
            },
        };
        expect(readPricing(info)).toEqual({ model: 'PAY_PER_EVENT', unit: 'Result', priceUsd: 0.003 });
    });
    it('reads per-unit pricing and returns null for missing info', () => {
        expect(readPricing({ pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 0.002, unitName: 'result' })!.priceUsd).toBe(0.002);
        expect(readPricing(null)).toBeNull();
    });
    it('picks the latest pricing already in force, ignoring future changes', () => {
        const now = Date.parse('2026-11-08T00:00:00Z');
        const infos = [
            { startedAt: '2026-12-01T00:00:00Z', id: 'future' },
            { startedAt: '2026-10-01T00:00:00Z', id: 'current' },
            { startedAt: '2026-01-01T00:00:00Z', id: 'old' },
        ];
        expect((currentPricingInfo(infos, now) as { id: string }).id).toBe('current');
    });
});

describe('catalog and resolver', () => {
    const catalog = buildCatalog(
        [myActor('google-maps-scraper'), myActor('google-lens-ocr'), myActor('secret-tool')],
        [storeActor('google-maps-scraper', 50, { TOTAL: 10, SUCCEEDED: 10 }), storeActor('google-lens-ocr', 5, { TOTAL: 10, SUCCEEDED: 10 })],
    );
    it('marks actors without a Store record as private with null public stats', () => {
        const secret = catalog.find((actor) => actor.name === 'secret-tool')!;
        expect(secret).toMatchObject({ isPublic: false, users30d: null, runs30d: null, totalRuns: 10 });
    });
    it('resolves id, ref with ~, exact name, and unique fragments', () => {
        expect(resolveActor(catalog, 'id-google-lens-ocr')).toMatchObject({ kind: 'found' });
        expect(resolveActor(catalog, 'acme~google-maps-scraper')).toMatchObject({ kind: 'found' });
        expect(resolveActor(catalog, 'lens')).toMatchObject({ kind: 'found', actor: { name: 'google-lens-ocr' } });
    });
    it('reports ambiguity with candidates sorted by users, and misses', () => {
        const result = resolveActor(catalog, 'google');
        expect(result.kind).toBe('ambiguous');
        if (result.kind === 'ambiguous') expect(result.candidates[0]!.name).toBe('google-maps-scraper');
        expect(resolveActor(catalog, 'nothing-like-this')).toEqual({ kind: 'not_found' });
    });
});
