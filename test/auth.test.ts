import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPublicToken } from '../src/auth/public.js';

let home: string;
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'aim-auth-'));
    await mkdir(join(home, '.apify'));
    await writeFile(join(home, '.apify', 'auth.json'), JSON.stringify({ token: 'cli-token' }));
});
afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

describe('findPublicToken', () => {
    it('prefers APIFY_TOKEN, then the Apify CLI login', async () => {
        expect(await findPublicToken({ APIFY_TOKEN: ' env-token ' }, home)).toEqual({ token: 'env-token', source: 'env' });
        expect(await findPublicToken({}, home)).toEqual({ token: 'cli-token', source: 'apify-cli' });
        expect(await findPublicToken({ APIFY_TOKEN: '  ' }, home)).toEqual({ token: 'cli-token', source: 'apify-cli' });
    });

    it('ignores a client placeholder passed through unresolved', async () => {
        for (const placeholder of ['${user_config.apify_token}', '${APIFY_TOKEN}', '$APIFY_TOKEN']) {
            expect(await findPublicToken({ APIFY_TOKEN: placeholder }, home)).toEqual({ token: 'cli-token', source: 'apify-cli' });
        }
    });

    it('returns null with no token anywhere', async () => {
        await rm(join(home, '.apify'), { recursive: true });
        expect(await findPublicToken({}, home)).toBeNull();
    });
});
