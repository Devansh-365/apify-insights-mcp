// Node 20 and 22 ship undici 6, whose fetch closes an idle connection after 4 s, so a tool call made after
// a pause pays a new TCP + TLS handshake (measured: ~1.5 s vs 0.31 s per Console call on Node 20.20).
// Node 26 (undici 8) already keeps them. Instead of adding the 400 KB `undici` package, this swaps the
// global dispatcher fetch already uses for one of the same class with a 60 s keep-alive. The global only
// exists after the first fetch; on any surprise it leaves the default alone.

const DISPATCHER = Symbol.for('undici.globalDispatcher.1');

type Holder = Record<symbol, unknown>;

export function tuneKeepAlive(holder: Holder = globalThis as unknown as Holder, undiciVersion = process.versions.undici ?? ''): boolean {
    const major = Number(undiciVersion.split('.')[0]);
    if (!Number.isFinite(major) || major >= 7) return false;
    const current = holder[DISPATCHER] as { constructor?: new (options: Record<string, number>) => unknown; tunedKeepAlive?: boolean } | undefined;
    if (!current || current.tunedKeepAlive || current.constructor?.name !== 'Agent') return false;
    try {
        const tuned = new current.constructor({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 }) as { tunedKeepAlive?: boolean };
        tuned.tunedKeepAlive = true;
        holder[DISPATCHER] = tuned;
        return true;
    } catch {
        return false;
    }
}
