import { describe, expect, it } from 'vitest';
import { assignBucket, buildTriage, compactEntry, computeThresholds, conversion, isEarlyMonth, type AcquisitionEntry, type Thresholds } from '../src/core/acquisition.js';

// Made-up funnels. Thresholds are fixed here so each rule is tested on its own.
const T: Thresholds = { viewerFloor: 10, leakFloor: 20, conversionLow: 0.05, conversionHigh: 0.3, sample: 10 };

function entry(viewers: number | null, starters: number, prevViewers: number | null = viewers, inputViewers: number | null = viewers == null ? null : viewers / 2): AcquisitionEntry {
    return { viewers, inputViewers, starters, prevViewers, prevInputViewers: null, prevStarters: null };
}

describe('assignBucket (ported rules)', () => {
    it('Leaking: blames the listing when few viewers reach the input page', () => {
        const result = assignBucket(entry(100, 1, 100, 10), T);
        expect(result.key).toBe('leaking');
        expect(result.reason).toContain('few reach the input page');
    });
    it('Leaking: blames the input when viewers reach the input page but do not start', () => {
        const result = assignBucket(entry(100, 1, 100, 50), T);
        expect(result.key).toBe('leaking');
        expect(result.reason).toContain("they reach the input page but don't start");
    });
    it('is not Leaking when more users ran it than viewed it', () => {
        expect(assignBucket(entry(100, 140), T).key).not.toBe('leaking');
    });
    it('Rising: viewers up 30%+ and by 5+, suppressed early in the month', () => {
        expect(assignBucket(entry(50, 10, 30), T)).toMatchObject({ key: 'rising' });
        expect(assignBucket(entry(50, 10, 30), T, { early: true }).key).toBe('steady');
    });
    it('Rising: new when there were no viewers at this point last month', () => {
        const result = assignBucket(entry(12, 3, 0), T);
        expect(result).toMatchObject({ key: 'rising', viewerChange: 'new' });
        expect(result.reason).toContain('none at this point last month');
    });
    it('Fading: viewers down 25%+ and by 5+, suppressed early in the month', () => {
        expect(assignBucket(entry(30, 5, 60), T).key).toBe('fading');
        expect(assignBucket(entry(30, 5, 60), T, { early: true }).key).toBe('steady');
    });
    it('Fading: still caught when this month fell below the viewer floor (AC20)', () => {
        // 4 viewers is under viewerFloor 10, but last month had 20: max(4, 20) >= 10.
        expect(assignBucket(entry(4, 1, 20), T).key).toBe('fading');
    });
    it('Converting, Steady and Quiet', () => {
        expect(assignBucket(entry(15, 9), T).key).toBe('converting');
        expect(assignBucket(entry(15, 2), T).key).toBe('steady');
        expect(assignBucket(entry(5, 0), T)).toMatchObject({ key: 'quiet', reason: 'Only 5 viewers this month' });
        expect(assignBucket(entry(null, 0), T)).toMatchObject({ key: 'quiet', reason: 'No acquisition data this month' });
    });
});

describe('thresholds and helpers', () => {
    it('falls back to the minimum floors with no data', () => {
        expect(computeThresholds([])).toEqual({ viewerFloor: 3, leakFloor: 10, conversionLow: 0, conversionHigh: 0, sample: 0 });
    });
    it('uses the 25th and 50th percentile of viewers', () => {
        const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1, 1));
        const t = computeThresholds(entries);
        expect(t.viewerFloor).toBe(6);
        expect(t.leakFloor).toBe(11);
    });
    it('caps conversion at 100%', () => {
        expect(conversion(entry(10, 14))).toBe(1);
        expect(conversion(entry(0, 3))).toBeNull();
    });
    it('treats days 1-7 of the current month as early', () => {
        expect(isEarlyMonth('2026-11', Date.parse('2026-11-07T23:00:00Z'))).toBe(true);
        expect(isEarlyMonth('2026-11', Date.parse('2026-11-08T00:00:00Z'))).toBe(false);
        expect(isEarlyMonth('2026-10', Date.parse('2026-11-03T00:00:00Z'))).toBe(false);
    });
    it('reads a marketing response and last month at the same point', () => {
        const m = (viewers: number, runs: number) => ({ numUniqueWebPageViews: viewers * 2, numUniqueConsolePageViews: viewers / 2, numUniqueUsersWithRun: runs, numUniqueViewingUsers: viewers });
        expect(compactEntry(m(40, 4), m(20, 2))).toEqual({ viewers: 40, inputViewers: 20, starters: 4, prevViewers: 20, prevInputViewers: 10, prevStarters: 2 });
        expect(compactEntry(m(40, 4), null)).toMatchObject({ prevViewers: null });
    });
});

describe('buildTriage', () => {
    it('puts every actor in exactly one bucket, most at stake first', () => {
        const actors = ['leak', 'rise-small', 'rise-big', 'fade', 'conv', 'steady', 'quiet'].map((name) => ({ id: name, name }));
        const entries = new Map<string, AcquisitionEntry>([
            ['leak', entry(100, 1, 100, 10)],
            ['rise-small', entry(40, 8, 20)],
            ['rise-big', entry(90, 18, 30)],
            ['fade', entry(30, 5, 60)],
            ['conv', entry(15, 9)],
            ['steady', entry(15, 2)],
            ['quiet', entry(2, 0)],
        ]);
        const triage = buildTriage(actors, entries, T);
        const byKey = Object.fromEntries(triage.buckets.map((bucket) => [bucket.key, bucket.items.map((item) => item.actor.name)]));
        expect(byKey).toEqual({ leaking: ['leak'], rising: ['rise-big', 'rise-small'], fading: ['fade'], converting: ['conv'], steady: ['steady'], quiet: ['quiet'] });
        expect(triage.scanned).toBe(7);
        expect(triage.buckets.reduce((sum, bucket) => sum + bucket.items.length, 0)).toBe(7);
        expect(triage.viewers).toBe(100 + 40 + 90 + 30 + 15 + 15 + 2);
    });
});
