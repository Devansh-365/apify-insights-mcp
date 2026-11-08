import { ToolError } from './envelope.js';
import { reportProgress } from './progress.js';

// Portfolio scans make one or more Console requests per actor. One transient failure should not sink the
// whole answer, so a failed actor is left out and named in a note, never shown with zeros. A session
// problem fails every request the same way, so it ends the scan at once with its own error.

const SESSION_ERRORS = new Set(['bridge_missing', 'logged_out', 'warming_up', 'other_account', 'disabled']);

export function isSessionError(error: unknown): boolean {
    return error instanceof ToolError && SESSION_ERRORS.has(error.code);
}

export interface Scan<A, T> {
    results: Map<string, T>;
    failed: A[];
}

export async function scanActors<A extends { id: string }, T>(actors: A[], load: (actor: A) => Promise<T>): Promise<Scan<A, T>> {
    const results = new Map<string, T>();
    const failed: A[] = [];
    let firstError: unknown;
    let done = 0;
    await Promise.all(
        actors.map(async (actor) => {
            try {
                results.set(actor.id, await load(actor));
            } catch (error) {
                if (isSessionError(error)) throw error;
                firstError ??= error;
                failed.push(actor);
            }
            done++;
            reportProgress(done, actors.length, `${done} of ${actors.length} actors`);
        }),
    );
    // Nothing loaded: an empty answer would read as "no data", so report why instead.
    if (actors.length && !results.size) throw firstError;
    return { results, failed };
}

export function failedNote(failed: Array<{ name: string }>, total: number): string | null {
    if (!failed.length) return null;
    const names = failed.map((actor) => actor.name).sort();
    const shown = names.slice(0, 5).join(', ');
    return `${failed.length} of ${total} actors could not be loaded and were left out: ${shown}${names.length > 5 ? ` and ${names.length - 5} more` : ''}.`;
}
