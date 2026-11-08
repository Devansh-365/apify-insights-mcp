import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TokenSource = 'env' | 'apify-cli';

export interface PublicToken {
    token: string;
    source: TokenSource;
}

/**
 * The Apify API token: APIFY_TOKEN first, then the Apify CLI login (`apify login` writes ~/.apify/auth.json).
 * Returns null when neither exists; the caller turns that into a `public_auth_missing` error.
 */
export async function findPublicToken(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<PublicToken | null> {
    if (env.APIFY_TOKEN?.trim()) return { token: env.APIFY_TOKEN.trim(), source: 'env' };
    try {
        const auth = JSON.parse(await readFile(join(home, '.apify', 'auth.json'), 'utf8')) as { token?: unknown };
        if (typeof auth.token === 'string' && auth.token.trim()) return { token: auth.token.trim(), source: 'apify-cli' };
    } catch {
        // No CLI login.
    }
    return null;
}
