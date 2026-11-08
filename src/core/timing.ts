// Debug timing, off by default. With APIFY_INSIGHTS_DEBUG=timing every HTTP request and tool call writes
// one line to stderr: host, path (actor IDs masked), the month of Console analytics requests, status, ms
// and bytes. Never headers (the tokens live there) and no other query values.

let enabled = false;

export function timingEnabled(): boolean {
    return enabled;
}

const ACTOR_ID_SEGMENT = /\/[A-Za-z0-9]{17}(?=\/|$)/g;

export function describeRequest(url: string): string {
    try {
        const u = new URL(url);
        const month = u.searchParams.get('month') ?? u.searchParams.get('monthStartAt');
        return `${u.host}${u.pathname.replace(ACTOR_ID_SEGMENT, '/:id')}${month ? ` month=${month.slice(0, 7)}` : ''}`;
    } catch {
        return '(unparsable url)';
    }
}

export function logTiming(line: string): void {
    if (enabled) process.stderr.write(`[timing] ${line}\n`);
}

/** Wraps global fetch when the env asks for timing. Returns whether it did. */
export function installTiming(env: NodeJS.ProcessEnv = process.env, target: { fetch: typeof fetch } = globalThis): boolean {
    if (!/\btiming\b/.test(env.APIFY_INSIGHTS_DEBUG ?? '')) return false;
    enabled = true;
    const original = target.fetch;
    target.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const started = Date.now();
        const what = describeRequest(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        try {
            const response = await original(input, init);
            logTiming(`http ${response.status} ${Date.now() - started}ms ${response.headers.get('content-length') ?? '?'}B ${what}`);
            return response;
        } catch (error) {
            logTiming(`http ERR ${Date.now() - started}ms ${what} ${(error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.name ?? 'error'}`);
            throw error;
        }
    }) as typeof fetch;
    return true;
}
