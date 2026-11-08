import { describe, expect, it } from 'vitest';
import type { ActorMoney } from '../src/core/money.js';
import { assignImpactLevels, buildInbox, compactEntry, compactScores, groupFor, median, mergeImprovements, pendingReason, trafficFromMoney, trafficWeight, type ImpactLevel, type QualityEntry } from '../src/core/quality.js';

// Made-up quality data only.
const DAY_20 = Date.parse('2026-11-20T12:00:00Z');
const DAY_5 = Date.parse('2026-11-05T12:00:00Z');

describe('scores and suggestions', () => {
    it('keeps known sub-scores, rounds them and reads booleans as 0/1', () => {
        expect(compactScores({ actorQuality: 0.849123, hasReadme: true, somethingElse: 3 })).toEqual({ actorQuality: 0.8491, hasReadme: 1 });
        expect(compactScores(null)).toBeNull();
    });
    it('merges both suggestion lists by id, taking detail from business value', () => {
        const merged = mergeImprovements(
            { improvements: [{ id: 'RELIABILITY', title: 'Fix Actor health issues', description: 'Short.' }] },
            [{ id: 'RELIABILITY', title: 'Fix Actor health issues', descriptionDetail: 'Longer detail.', valueLift: 0.1 }, { id: 'TIERED_PRICING', title: 'Add tiers' }],
        );
        expect(merged).toEqual([
            { id: 'RELIABILITY', title: 'Fix Actor health issues', description: 'Short.', detail: 'Longer detail.', valueLift: 0.1 },
            { id: 'TIERED_PRICING', title: 'Add tiers', description: '', detail: '', valueLift: null },
        ]);
        expect(mergeImprovements({ improvements: [] }, { improvements: [{ id: 'NO_README', title: 'Add a README' }] }).map((item) => item.id)).toEqual(['NO_README']);
    });
    it('marks pending actors and keeps nothing from them', () => {
        expect(pendingReason({ actorQuality: 0.8 }, false)).toBe('unpublished');
        expect(pendingReason({ hasReadme: 1 }, true)).toBe('unscored');
        expect(pendingReason({ actorQuality: 0.8 }, true)).toBeNull();
        const entry = compactEntry('a', { scores: { hasReadme: 1 }, recommendations: { praises: [{ title: 'Nice' }], improvements: [{ id: 'RELIABILITY', title: 'x' }] }, businessValue: [] }, true);
        expect(entry).toEqual({ id: 'a', scores: null, improvements: [], praises: [], pending: 'unscored' });
    });
    it('maps suggestion ids to work types, unknown ones to other', () => {
        expect(groupFor('RELIABILITY')).toMatchObject({ key: 'ops', weight: 4 });
        expect(groupFor('SENSITIVE_PROPERTIES_WITHOUT_SECRET_FLAG')).toMatchObject({ key: 'security', weight: 5 });
        expect(groupFor('TOTAL_USERS')).toMatchObject({ key: 'market', hidden: true });
        expect(groupFor('SOMETHING_NEW')).toMatchObject({ key: 'other', weight: 1 });
    });
});

describe('impact', () => {
    it('ranks the top 20% high and the next 30% medium; zero-traffic actors are always low', () => {
        const items = Array.from({ length: 10 }, (_, i) => ({ impact: 10 - i, traffic: 2, level: 'low' as ImpactLevel }));
        const idle = { impact: 1000, traffic: 1, level: 'high' as ImpactLevel };
        assignImpactLevels([...items, idle]);
        expect(items.map((item) => item.level)).toEqual(['high', 'high', 'medium', 'medium', 'medium', 'low', 'low', 'low', 'low', 'low']);
        expect(idle.level).toBe('low');
    });
    it('weighs traffic from the larger of last month and this month’s pace', () => {
        const traffic = { previous: { revenue: 1, runs: 100, payingUsers: 2, users: 10 }, current: { revenue: 1, runs: 0, payingUsers: 0, users: 0 } };
        expect(trafficWeight(traffic, DAY_5)).toBe(100 + 10 + 20 + 5); // before day 8, no pace
        expect(trafficWeight(traffic, DAY_20)).toBeCloseTo(150 + 10 + 20 + 5); // $1 by day 20 of 30 paces to $1.50
        expect(trafficWeight(undefined, DAY_20)).toBe(1);
    });
    it('reads traffic from money rows', () => {
        const row = (id: string, revenue: number, runs: number, paying: number, free: number) => ({ id, revenueUsd: revenue, runs, payingUsers: paying, freeUsers: free }) as ActorMoney;
        const traffic = trafficFromMoney([row('a', 2, 10, 1, 3)], [row('a', 1, 5, 1, 1), row('b', 0, 1, 0, 1)]);
        expect(traffic.get('a')).toEqual({ previous: { revenue: 2, runs: 10, payingUsers: 1, users: 4 }, current: { revenue: 1, runs: 5, payingUsers: 1, users: 2 } });
        expect(traffic.get('b')?.previous).toBeNull();
    });
    it('median', () => {
        expect(median([])).toBeNull();
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 2, 3])).toBe(2.5);
    });
});

describe('buildInbox', () => {
    const entry = (id: string, ids: string[], pending: QualityEntry['pending'] = null): QualityEntry => ({
        id,
        scores: pending ? null : { actorQuality: 0.8 },
        improvements: ids.map((item) => ({ id: item, title: item, description: `${item} text`, detail: '', valueLift: null })),
        praises: [],
        pending,
    });
    it('groups the same suggestion across actors and orders issues by total impact', () => {
        const actors = ['big', 'mid', 'small', 'waiting'].map((name) => ({ id: name, name }));
        const entries = new Map([
            ['big', entry('big', ['HAS_OUTPUT_SCHEMA', 'TOTAL_USERS'])],
            ['mid', entry('mid', ['RELIABILITY', 'HAS_OUTPUT_SCHEMA'])],
            ['small', entry('small', ['RELIABILITY'])],
            ['waiting', entry('waiting', ['RELIABILITY'], 'unscored')],
        ]);
        const traffic = new Map([
            ['big', { previous: { revenue: 10, runs: 0, payingUsers: 0, users: 0 }, current: null }],
            ['mid', { previous: { revenue: 1, runs: 0, payingUsers: 0, users: 0 }, current: null }],
        ]);
        const inbox = buildInbox(actors, entries, traffic, DAY_5);
        // HAS_OUTPUT_SCHEMA: 3 x 1000 + 3 x 100; RELIABILITY: 4 x 100 + 4 x 1; TOTAL_USERS: 0.5 x 1000.
        expect(inbox.issues.map((issue) => [issue.id, issue.items.map((item) => item.actor.name)])).toEqual([
            ['HAS_OUTPUT_SCHEMA', ['big', 'mid']],
            ['TOTAL_USERS', ['big']],
            ['RELIABILITY', ['mid', 'small']],
        ]);
        expect(inbox.issues[0]!.level).toBe('high');
        expect(inbox.actorsWithSuggestions).toBe(3);
        expect(inbox.actorsToFix).toBe(3);
        expect(inbox.items.some((item) => item.actor.name === 'waiting')).toBe(false);
    });
});
