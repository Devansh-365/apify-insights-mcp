import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, connect, fakeApi, ME, myActor, storeActor, testConfig } from './helpers.js';

const NOW = Date.parse('2026-11-08T03:00:00.000Z');

function portfolio() {
    const mine = [myActor('healthy'), myActor('broken'), myActor('maintenance'), myActor('private-one')];
    const store = [
        storeActor('healthy', 40, { TOTAL: 500, SUCCEEDED: 499, FAILED: 1, ABORTED: 0, 'TIMED-OUT': 0 }),
        storeActor('broken', 12, { TOTAL: 100, SUCCEEDED: 80, FAILED: 15, ABORTED: 0, 'TIMED-OUT': 5 }),
        storeActor('maintenance', 2, { TOTAL: 10, SUCCEEDED: 10, FAILED: 0, ABORTED: 0, 'TIMED-OUT': 0 }, { notice: 'UNDER_MAINTENANCE' }),
    ];
    return fakeApi(mine, store, {
        'id-broken': {
            defaultRunOptions: { build: 'latest', timeoutSecs: 3600, memoryMbytes: 4096 },
            pricingInfos: [{ pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 0.003, unitName: 'result', startedAt: '2026-10-01T00:00:00Z' }],
            taggedBuilds: { latest: { buildNumber: '0.3.1', finishedAt: '2026-11-01T00:00:00Z' } },
        },
    });
}

async function tempHome() {
    return mkdtemp(join(tmpdir(), 'aim-'));
}

describe('server surface', () => {
    it('lists the four public tools, read-only, and the glossary', async () => {
        const { client } = await connect(portfolio(), testConfig(await tempHome()));
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual(['actor_report', 'auth_status', 'list_actors', 'run_health']);
        expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
        const glossary = await client.readResource({ uri: 'apify-insights://glossary' });
        expect((glossary.contents[0] as { text: string }).text).toContain('Aborted runs are excluded');
    });
});

describe('run_health', () => {
    it('returns only problems, flagged first, with rules and evidence', async () => {
        const { client } = await connect(portfolio(), testConfig(await tempHome()));
        const { data, text } = await call(client, 'run_health');
        expect(data.rows.map((r: { ref: string }) => r.ref)).toEqual(['acme/maintenance', 'acme/broken']);
        expect(data.rows[1]).toMatchObject({ flags: ['failing'], failed: 15, timedOut: 5, failureRatePct: 20 });
        expect(data.totals).toMatchObject({ checked: 3, notCheckedPrivate: 1, problems: 2, flagged: 1, failing: 1 });
        expect(data.rules.failing).toContain('aborted runs excluded');
        expect(text).toContain('2 of 3 public actors need attention');
    });
    it('checks one actor by fragment and reports ambiguity as a structured error', async () => {
        const { client } = await connect(portfolio(), testConfig(await tempHome()));
        const single = await call(client, 'run_health', { actor: 'healthy' });
        expect(single.text).toContain('no problems found');
        const missing = await call(client, 'run_health', { actor: 'zzz' });
        expect(missing.result.isError).toBe(true);
        expect(missing.data).toMatchObject({ ok: false, code: 'actor_not_found' });
    });
});

describe('list_actors', () => {
    it('sorts by 30-day users, keeps private actors with null public stats', async () => {
        const { client } = await connect(portfolio(), testConfig(await tempHome()));
        const { data } = await call(client, 'list_actors');
        expect(data.rows.map((r: { name: string }) => r.name)).toEqual(['healthy', 'broken', 'maintenance', 'private-one']);
        expect(data.rows[3]).toMatchObject({ private: true, users30d: null, runs30d: null });
        expect(data.rows[0].private).toBeUndefined();
        expect(data.totals).toMatchObject({ username: 'acme', actors: 4, public: 3, private: 1, withNotice: 1 });
    });
    it('stays under 4 KB by default for a 486-actor account', async () => {
        const names = Array.from({ length: 486 }, (_, i) => `some-long-actor-name-scraper-${i}`);
        const api = fakeApi(
            names.map((name) => myActor(name)),
            names.slice(0, 464).map((name, i) => storeActor(name, i % 50, { TOTAL: 1000 + i, SUCCEEDED: 990, FAILED: 10 + i })),
        );
        const { client } = await connect(api, testConfig(await tempHome()));
        for (const tool of ['list_actors', 'run_health']) {
            const { data } = await call(client, tool);
            expect(JSON.stringify(data).length, tool).toBeLessThanOrEqual(4096);
            expect(data.omitted.rows).toBeGreaterThan(0);
        }
    });
    it('caches the catalog between calls', async () => {
        const api = portfolio();
        const { client } = await connect(api, testConfig(await tempHome()));
        await call(client, 'list_actors');
        await call(client, 'run_health');
        expect(api.calls.filter((name) => name === 'myActors')).toHaveLength(1);
    });
});

describe('actor_report', () => {
    it('joins public detail, pricing in force, memory and the local source folder', async () => {
        const home = await tempHome();
        const actorsDir = join(home, 'actors');
        await mkdir(join(actorsDir, 'broken-folder', '.actor'), { recursive: true });
        await writeFile(join(actorsDir, 'broken-folder', '.actor', 'actor.json'), JSON.stringify({ name: 'broken' }));
        const { client } = await connect(portfolio(), testConfig(home, [actorsDir]));
        const { data, text } = await call(client, 'actor_report', { actor: 'acme/broken' });
        expect(data.runOptions.memoryMbytes).toBe(4096);
        expect(data.pricing).toEqual({ model: 'PRICE_PER_DATASET_ITEM', unit: 'result', priceUsd: 0.003 });
        expect(data.latestBuild.buildNumber).toBe('0.3.1');
        expect(data.flags.map((flag: { flag: string }) => flag.flag)).toEqual(['failing']);
        expect(data.localPath).toBe(join(actorsDir, 'broken-folder'));
        expect(data.money).toBeNull();
        expect(text).toContain('Default memory: 4096 MB');
    });
});

describe('auth_status and errors', () => {
    it('without an API token, public tools return public_auth_missing with a fix', async () => {
        const { client } = await connect(null, testConfig(await tempHome()));
        const { result, data } = await call(client, 'list_actors');
        expect(result.isError).toBe(true);
        expect(data).toMatchObject({ code: 'public_auth_missing' });
        expect(data.fix).toContain('apify login');
        const status = await call(client, 'auth_status');
        expect(status.data.public).toMatchObject({ ok: false, code: 'public_auth_missing' });
        expect(status.data.console.state).toBe('bridge_missing');
    });
    it('reports session states and never returns the UI token', async () => {
        const home = await tempHome();
        await mkdir(join(home, 'sessions'));
        const token = 'SECRET-UI-TOKEN-should-never-appear-anywhere';
        const write = (receivedAt: string, userId = ME.id) =>
            writeFile(join(home, 'sessions', 'p1.json'), JSON.stringify({ uiToken: token, userId, receivedAt, producer: 'bridge' }));

        await write(new Date(NOW - 10 * 60_000).toISOString());
        let status = await call((await connect(portfolio(), testConfig(home))).client, 'auth_status');
        expect(status.data.console).toMatchObject({ state: 'ok', ageMinutes: 10, producer: 'bridge' });
        expect(JSON.stringify(status.result)).not.toContain(token);

        await write(new Date(NOW - 3 * 60 * 60_000).toISOString());
        status = await call((await connect(portfolio(), testConfig(home))).client, 'auth_status');
        expect(status.data.console.state).toBe('warming_up');

        await write(new Date(NOW).toISOString(), 'someone-else');
        status = await call((await connect(portfolio(), testConfig(home))).client, 'auth_status');
        expect(status.data.console.state).toBe('other_account');
        expect(JSON.stringify(status.result)).not.toContain(token);
    });
});
