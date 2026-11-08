import { describe, expect, it } from 'vitest';
import { ALLOWED_ID_PATHS, consoleIdUrl, createConsoleApi, MAX_CONCURRENT } from '../src/clients/console.js';

const TOKEN = 'fake-ui-token-0123456789abcdefghijklmnopqrstu';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('console client: quality endpoints (AC10)', () => {
    it('builds URLs only for allowlisted actor-ID paths and valid IDs', () => {
        expect(ALLOWED_ID_PATHS.every((path) => path.startsWith('actor-quality/') && path.endsWith('/:id'))).toBe(true);
        expect(consoleIdUrl('actor-quality/scores/:id', 'AbC123xyz')).toBe('https://console-backend.apify.com/actor-quality/scores/AbC123xyz');
        expect(consoleIdUrl('actor-quality/praises-and-improvements/:id', 'a1')).toBe('https://console-backend.apify.com/actor-quality/praises-and-improvements/a1');
        expect(consoleIdUrl('actor-quality/business-value-improvements/:id', 'a1')).toBe('https://console-backend.apify.com/actor-quality/business-value-improvements/a1');
        expect(() => consoleIdUrl('actor/:id/delete', 'a1')).toThrow(/not allowed/);
        for (const bad of ['../users/me', 'a/b', 'a%2Fb', 'a.b', '', 'a?x=1']) expect(() => consoleIdUrl('actor-quality/scores/:id', bad), bad).toThrow(/Not an actor ID/);
    });
    it('parses the live shapes, including the sparse scores response', async () => {
        const bodies: Record<string, unknown> = {
            scores: { hasInputSchema: 1, hasOutputSchema: 1, hasReadme: 1, actorQuality: 0.849, actorQualityPercentile: 0.936 },
            'praises-and-improvements': { praises: [{ title: 'Great README', description: 'x', percentile: 0.9 }], improvements: [{ id: 'TOTAL_USERS', title: 'Get users', description: 'y' }] },
            'business-value-improvements': [],
        };
        const seen: string[] = [];
        const api = createConsoleApi(async () => TOKEN, (async (url: string, init: RequestInit) => {
            seen.push(`${init.method} ${url}`);
            return json(bodies[url.split('/')[4]!]);
        }) as typeof fetch);
        expect(await api.qualityScores('abc')).toMatchObject({ actorQuality: 0.849 });
        expect(await api.qualityImprovements('abc')).toMatchObject({ improvements: [{ id: 'TOTAL_USERS' }] });
        expect(await api.qualityBusinessValue('abc')).toEqual([]);
        expect(seen.every((line) => line.startsWith('GET https://console-backend.apify.com/actor-quality/'))).toBe(true);
    });
    it('names the endpoint when a quality response changes shape', async () => {
        const api = createConsoleApi(async () => TOKEN, (async () => json({ improvements: 'nope' })) as typeof fetch);
        await expect(api.qualityImprovements('abc')).rejects.toMatchObject({ code: 'endpoint_changed', details: { endpoint: 'actor-quality/praises-and-improvements/:id' } });
    });
});

describe('console client: concurrency and retries (AC21)', () => {
    it(`runs at most ${MAX_CONCURRENT} requests at once`, async () => {
        let active = 0;
        let peak = 0;
        const api = createConsoleApi(async () => TOKEN, (async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return json({});
        }) as typeof fetch);
        await Promise.all(Array.from({ length: 20 }, (_, i) => api.qualityScores(`a${i}`)));
        expect(peak).toBe(MAX_CONCURRENT);
    });
    it('retries 429 and 5xx with backoff plus jitter, then gives up', async () => {
        let attempts = 0;
        let jitterCalls = 0;
        const flaky = createConsoleApi(
            async () => TOKEN,
            (async () => (++attempts < 3 ? new Response('busy', { status: 429 }) : json({ actorQuality: 0.5 }))) as typeof fetch,
            { retryDelayMs: 0, jitter: () => (jitterCalls++, 0) },
        );
        expect(await flaky.qualityScores('abc')).toEqual({ actorQuality: 0.5 });
        expect(attempts).toBe(3);
        expect(jitterCalls).toBe(2);

        const down = createConsoleApi(async () => TOKEN, (async () => new Response('down', { status: 503 })) as typeof fetch, { retryDelayMs: 0, jitter: () => 0 });
        await expect(down.qualityScores('abc')).rejects.toMatchObject({ code: 'endpoint_changed' });
    });
    it('frees the slot after a rejected session so later requests still run', async () => {
        let calls = 0;
        const api = createConsoleApi(async () => TOKEN, (async () => (++calls <= MAX_CONCURRENT ? new Response('{}', { status: 401 }) : json({}))) as typeof fetch);
        const first = await Promise.allSettled(Array.from({ length: MAX_CONCURRENT }, (_, i) => api.qualityScores(`a${i}`)));
        expect(first.every((item) => item.status === 'rejected')).toBe(true);
        await expect(api.qualityScores('later')).resolves.toEqual({});
    });
});
