import { AsyncLocalStorage } from 'node:async_hooks';

// MCP progress notifications for slow tool calls. Sent only when the client asked for them (the request
// carries `_meta.progressToken`); `progress` always increases, as the spec requires. Clients that reset
// their timeout on progress then keep waiting instead of giving up, and the user sees what is happening.
// Tools call `reportProgress` / `progressPing` without plumbing: the reporter rides on AsyncLocalStorage.

interface ProgressParams {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
}

interface ProgressExtra {
    _meta?: { progressToken?: string | number };
    sendNotification?: (notification: { method: 'notifications/progress'; params: ProgressParams }) => Promise<void>;
}

interface Reporter {
    report(done: number, total?: number, message?: string): void;
    ping(message: string): void;
}

const store = new AsyncLocalStorage<Reporter>();
const MIN_GAP_MS = 250;

export function createReporter(extra: ProgressExtra | undefined, now: () => number = Date.now): Reporter | null {
    const token = extra?._meta?.progressToken;
    const send = extra?.sendNotification;
    if (token === undefined || !send) return null;
    let last = 0;
    let lastSentAt = -Infinity;
    const emit = (progress: number, total: number | undefined, message: string | undefined, force: boolean) => {
        if (progress <= last) return;
        if (!force && now() - lastSentAt < MIN_GAP_MS) return;
        last = progress;
        lastSentAt = now();
        const params: ProgressParams = { progressToken: token, progress };
        if (total !== undefined) params.total = total;
        if (message) params.message = message;
        // A lost progress message must never fail the tool.
        send({ method: 'notifications/progress', params }).catch(() => {});
    };
    return {
        report: (done, total, message) => emit(done, total, message, total !== undefined && done >= total),
        // A small step past the last value, for waits with no count (e.g. a session refresh).
        ping: (message) => emit(last + 0.01, undefined, message, true),
    };
}

export function withProgress<T>(extra: ProgressExtra | undefined, run: () => Promise<T>): Promise<T> {
    const reporter = createReporter(extra);
    return reporter ? store.run(reporter, run) : run();
}

export function reportProgress(done: number, total?: number, message?: string): void {
    store.getStore()?.report(done, total, message);
}

export function progressPing(message: string): void {
    store.getStore()?.ping(message);
}
