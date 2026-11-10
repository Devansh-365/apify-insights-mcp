import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, connect, fakeApi, fakeConsole, myActor, storeActor, testConfig, type FakeActorMonth } from './helpers.js';

// Same numbers before and after the speed work: every tool's structured output on made-up data is
// snapshotted. The snapshots were written on the code before the latency changes (plan AC1); any change
// to a figure fails here.

const NOW = () => Date.parse('2026-11-08T03:00:00.000Z');

const MONTHS: Record<string, Record<string, FakeActorMonth>> = {
    '2026-11': {
        healthy: { revenue: 80, cost: 20, runs: 500, results: 100_000, charged: 40_000, paying: 10, free: 30 },
        broken: { revenue: 2, cost: 12, runs: 100, failed: 15, timedOut: 5, results: 5000, charged: 1000, paying: 3 },
        steady: { revenue: 20, cost: 5, runs: 200, paying: 4 },
    },
    '2026-10': {
        healthy: { revenue: 155, cost: 40, runs: 1500, paying: 12 },
        broken: { revenue: 31, cost: 8, runs: 300, paying: 4 },
        steady: { revenue: 60, cost: 15, runs: 600, paying: 5 },
    },
    '2026-09': {
        healthy: { revenue: 120, cost: 30, runs: 1200, paying: 11 },
        broken: { revenue: 25, cost: 7, runs: 250, paying: 3 },
        steady: { revenue: 50, cost: 12, runs: 500, paying: 5 },
    },
};

function portfolio() {
    return fakeApi(
        [myActor('healthy'), myActor('broken'), myActor('steady'), myActor('private-one')],
        [
            storeActor('healthy', 40, { TOTAL: 500, SUCCEEDED: 499, FAILED: 1, ABORTED: 0, 'TIMED-OUT': 0 }),
            storeActor('broken', 12, { TOTAL: 100, SUCCEEDED: 80, FAILED: 15, ABORTED: 0, 'TIMED-OUT': 5 }),
            storeActor('steady', 20, { TOTAL: 200, SUCCEEDED: 198, FAILED: 2, ABORTED: 0, 'TIMED-OUT': 0 }),
        ],
    );
}

const CALLS: Array<[string, Record<string, unknown>]> = [
    ['daily_brief', {}],
    ['list_actors', {}],
    ['run_health', {}],
    ['run_health', { actor: 'broken' }],
    ['revenue_summary', {}],
    ['revenue_summary', { period: 'lastMonth', compareTo: 'previousPeriod' }],
    ['revenue_summary', { period: 'last7d', compareTo: 'sameDaysLastMonth', includeDaily: true }],
    ['actor_profitability', {}],
    ['actor_profitability', { period: 'lastMonth', view: 'losers' }],
    ['actor_profitability', { period: 'last7d', actors: ['healthy', 'broken'] }],
    ['actor_report', { actor: 'healthy' }],
    ['actor_report', { actor: 'broken' }],
    ['growth', {}],
    ['growth', { actor: 'steady' }],
    ['acquisition_score', {}],
    ['acquisition_score', { actor: 'healthy' }],
    ['actor_quality', {}],
    ['actor_quality', { actor: 'broken' }],
];

describe('tool output stays the same (AC1)', () => {
    for (const [name, args] of CALLS) {
        it(`${name} ${JSON.stringify(args)}`, async () => {
            const home = await mkdtemp(join(tmpdir(), 'aim-regression-'));
            const { client } = await connect(portfolio(), testConfig(home), NOW, { consoleApi: fakeConsole(MONTHS) });
            const { data, text } = await call(client, name, args);
            expect({ text, data }).toMatchSnapshot();
        });
    }
});
