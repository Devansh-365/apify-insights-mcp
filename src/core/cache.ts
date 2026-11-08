/** In-memory TTL cache. Concurrent callers of the same key share one in-flight request. */
export class Cache {
    private entries = new Map<string, { value: Promise<unknown>; expires: number }>();

    constructor(private now: () => number = Date.now) {}

    get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
        const hit = this.entries.get(key);
        if (hit && hit.expires > this.now()) return hit.value as Promise<T>;
        const value = load();
        this.entries.set(key, { value, expires: this.now() + ttlMs });
        // A failed load must not be served from cache.
        value.catch(() => {
            if (this.entries.get(key)?.value === value) this.entries.delete(key);
        });
        return value;
    }
}
