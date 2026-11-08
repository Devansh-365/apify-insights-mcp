import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface Config {
    /** Where session files and the usage log live. */
    home: string;
    /** Folders that hold one actor per subfolder (e.g. a monorepo's `actors/`), used to link an actor to its code. */
    actorDirs: string[];
    apiBase: string;
    /** Append tool name + timestamp (no arguments, no numbers) to `<home>/usage.jsonl`, for the dogfood trial. */
    usageLog: boolean;
    /** Keep finished months' money in `<home>/cache` for up to 24 h across sessions (APIFY_INSIGHTS_CACHE=0 turns it off). */
    diskCache?: boolean;
    /** After the first money tool of a session, load this and last month's money in the background (APIFY_INSIGHTS_PREFETCH=0 turns it off). */
    prefetch?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    return {
        home: env.APIFY_INSIGHTS_HOME || join(homedir(), '.apify-insights'),
        actorDirs: (env.APIFY_INSIGHTS_ACTOR_DIRS || '').split(delimiter).map((dir) => dir.trim()).filter(Boolean),
        apiBase: env.APIFY_API_BASE || 'https://api.apify.com/v2',
        usageLog: env.APIFY_INSIGHTS_USAGE_LOG === '1',
        diskCache: env.APIFY_INSIGHTS_CACHE !== '0',
        prefetch: env.APIFY_INSIGHTS_PREFETCH !== '0',
    };
}
