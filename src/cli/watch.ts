import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { currentConsoleToken, refreshedConsoleToken, touchWanted } from '../auth/console-session.js';
import { findPublicToken } from '../auth/public.js';
import { sessionStatus } from '../auth/session.js';
import { createApifyApi, type ApifyApi } from '../clients/apify-api.js';
import { createConsoleApi, type TokenProvider } from '../clients/console.js';
import { SESSION_WAIT_MS, WATCH_FLAG_ENV } from '../core/watch/constants.js';
import { evaluateAll } from '../core/watch/engine.js';
import { dayStartMs, isoDayOf } from '../core/watch/facts.js';
import { createLog, exists, loadWatchConfig, registerSecret } from '../core/watch/files.js';
import { launchAgentPath, launchAgentPlist, LAUNCH_AGENT_LABEL, osascriptNotifier, parseTimes, type Notifier } from '../core/watch/launchd.js';
import { loadReplayData, replay, watchBackfill, watchRun, watchSnooze, watchStatus, type WatchDeps } from '../core/watch/run.js';
import type { RuleId } from '../core/watch/types.js';
import { copyServer, type Runner } from './setup.js';

// `apify-insights-mcp watch <run|backfill|status|snooze|unsnooze|replay|install|uninstall>`: the
// experimental early-warning job. Off unless APIFY_INSIGHTS_WATCH=1 or `--experimental` is passed.

export interface WatchCliOptions {
    env: NodeJS.ProcessEnv;
    home: string;
    homeDir: string;
    platform: NodeJS.Platform;
    log: (line: string) => void;
    nodePath: string;
    sourceEntry: string;
    run?: Runner;
    /** Tests: replace the network and the notifier. */
    deps?: Partial<Pick<WatchDeps, 'api' | 'console' | 'now' | 'notifier'>>;
}

const USAGE = [
    'Usage: apify-insights-mcp watch <command> --experimental',
    '  run [--force] [--weekly]        take today\'s snapshot, judge the rules, write the digest, notify on new PAGE items',
    '  backfill [--days 63] [--force]  one time: day-level money and runs for the earning actors',
    '  status                          data, last run, open alerts',
    '  snooze <actor> [--days 7] [--rule R4]   silence an actor (or one rule) for a while; unsnooze <actor> undoes it',
    '  replay [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--actor a,b] [--explain actor@YYYY-MM-DD]   re-run the rules on stored data',
    '  install [--print] [--times 05:45,09:00,13:00,19:00]   macOS: add the LaunchAgent (the owner runs this)',
    '  uninstall                       macOS: remove the LaunchAgent',
    `The feature is experimental and off by default: pass --experimental or set ${WATCH_FLAG_ENV}=1.`,
].join('\n');

function flagValue(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    if (i >= 0) return args[i + 1];
    const inline = args.find((a) => a.startsWith(`${name}=`));
    return inline?.slice(name.length + 1);
}

const RULES = new Set(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']);

const defaultRunner: Runner = (command, args) =>
    new Promise((resolve) => execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}`.trim() })));

async function realDeps(options: WatchCliOptions): Promise<WatchDeps | string> {
    const home = options.home;
    let api: ApifyApi | undefined = options.deps?.api;
    if (!api) {
        const token = await findPublicToken(options.env);
        if (!token) return 'No Apify API token found: run `apify login` once, or set APIFY_TOKEN.';
        api = createApifyApi(token.token, options.env.APIFY_API_BASE || 'https://api.apify.com/v2');
    }
    const now = options.deps?.now ?? Date.now;
    const log = createLog(home, options.log, now);
    const consoleFactory: WatchDeps['console'] =
        options.deps?.console ??
        (async (accountId) => {
            const status = await sessionStatus(home, accountId, now());
            if (status.state === 'bridge_missing' || status.state === 'other_account') {
                await touchWanted(home);
                return { api: null, outcome: status.state };
            }
            // The token stays inside these two functions and the request header; it is only registered
            // with the log's redaction filter (memory only), never stored or printed.
            const tokens: TokenProvider = {
                current: async () => {
                    const token = await currentConsoleToken(home, accountId, now());
                    registerSecret(token.value);
                    return token;
                },
                refresh: async (rejected) => {
                    const token = await refreshedConsoleToken(home, accountId, rejected, { timeoutMs: SESSION_WAIT_MS });
                    registerSecret(token.value);
                    return token;
                },
            };
            return { api: createConsoleApi(tokens), outcome: status.state === 'ok' ? 'ok' : 'warming_up' };
        });
    const notifier: Notifier = options.deps?.notifier ?? osascriptNotifier;
    return { home, api, console: consoleFactory, now, log, notifier };
}

function printReplay(result: ReturnType<typeof replay>, focus: string[], log: (line: string) => void): void {
    log(`Replay ${result.from}..${result.to} (one run per day at 00:00 UTC; R5 has no history and is left out)`);
    const rows = [...result.actors.values()].sort((a, b) => (a.firstPage?.day ?? '9').localeCompare(b.firstPage?.day ?? '9') || a.name.localeCompare(b.name));
    const paged = rows.filter((r) => r.firstPage);
    log(`Actors that paged: ${paged.length}; watch only: ${rows.length - paged.length}`);
    for (const r of paged) log(`  PAGE ${r.firstPage!.day} ${r.firstPage!.rules.join('+')}  ${r.name}  (${r.pageOpens} PAGE opens)`);
    log('PAGE opens per week (Monday):');
    for (const w of result.pagesPerWeek) log(`  ${w.week}: ${w.opens}`);
    for (const name of focus) {
        const r = rows.find((x) => x.name === name || x.name.includes(name));
        if (!r) {
            log(`${name}: never alerted`);
            continue;
        }
        log(`${r.name}: first PAGE ${r.firstPage ? `${r.firstPage.day} (${r.firstPage.rules.join('+')})` : 'never'}; first WATCH ${r.firstWatch ? `${r.firstWatch.day} (${r.firstWatch.rules.join('+')})` : 'never'}; PAGE opens: ${r.pageDays.join(', ') || 'none'}`);
    }
}

export async function watchCli(args: string[], options: WatchCliOptions): Promise<number> {
    const { log } = options;
    const [sub, ...rest] = args;
    const flagOn = options.env[WATCH_FLAG_ENV] === '1' || args.includes('--experimental');
    if (!sub || sub === 'help' || sub === '--help') {
        log(USAGE);
        return sub ? 0 : 1;
    }
    if (!flagOn) {
        log(`watch is experimental and off by default. Pass --experimental or set ${WATCH_FLAG_ENV}=1.`);
        return 2;
    }
    const home = options.home;
    if (sub === 'status') {
        const installed = options.platform === 'darwin' ? await exists(launchAgentPath(options.homeDir)) : null;
        const result = await watchStatus(home, (options.deps?.now ?? Date.now)(), { flagOn, launchAgentInstalled: installed });
        for (const line of result.lines) log(line);
        return result.code;
    }
    if (sub === 'snooze' || sub === 'unsnooze') {
        const query = rest.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !RULES.has(a));
        if (!query) {
            log(USAGE);
            return 1;
        }
        const rule = flagValue(rest, '--rule');
        if (rule && !RULES.has(rule)) {
            log(`Unknown rule ${rule}; use R1..R8.`);
            return 1;
        }
        const days = Number(flagValue(rest, '--days') ?? 7);
        const result = await watchSnooze(home, (options.deps?.now ?? Date.now)(), query, Number.isFinite(days) && days > 0 ? days : 7, (rule as RuleId) ?? null, sub === 'unsnooze');
        for (const line of result.lines) log(line);
        return result.code;
    }
    if (sub === 'replay') {
        const prepared = await loadReplayData(home);
        if (!prepared.actors.size) {
            log('No stored data to replay: run `watch backfill` first.');
            return 1;
        }
        const config = await loadWatchConfig(home);
        const firstKnown = Math.min(...[...prepared.actors.values()].map((a) => a.coveredFrom).filter(Number.isFinite));
        const from = flagValue(rest, '--from') ?? isoDayOf(firstKnown + 7 * 86_400_000);
        const to = flagValue(rest, '--to') ?? isoDayOf((options.deps?.now ?? Date.now)());
        const focus = (flagValue(rest, '--actor') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        printReplay(replay(prepared, config, from, to), focus, log);
        const explain = flagValue(rest, '--explain');
        if (explain) {
            const [name, day] = explain.split('@');
            const evaluation = evaluateAll(prepared, { asOf: dayStartMs(day ?? to), weekly: new Date(dayStartMs(day ?? to)).getUTCDay() === 1, money: true, config });
            const actor = evaluation.actors.find((a) => a.name === name) ?? null;
            const id = actor?.id ?? [...prepared.actors.entries()].find(([, a]) => a.name === name)?.[0];
            const facts = id ? evaluation.facts.get(id) : undefined;
            log(`explain ${name} at ${day} 00:00 UTC: ${facts ? JSON.stringify({ rev7d: facts.w0.v.rev, prev7d: facts.w1.v.rev, baseline: facts.baseline, windows: facts.baselineWindows, class: facts.cls, revenueDays56: facts.revenueDays56, peakShare56: facts.peakShare56, pool: facts.pool, runs7d: facts.w0.v.runs, failed7d: facts.w0.v.failed, timedOut7d: facts.w0.v.timedOut, results7d: facts.w0.v.results, cost7d: facts.w0.v.cost }) : 'no facts'}`);
            for (const s of actor?.signals ?? []) log(`  ${s.tier}${s.hold ? ' (hold)' : ''} ${s.rule}: ${s.evidence}`);
        }
        return 0;
    }
    if (sub === 'install' || sub === 'uninstall') {
        if (options.platform !== 'darwin') {
            log('watch install uses a macOS LaunchAgent. On other systems, schedule `apify-insights-mcp watch run --experimental` with cron.');
            return 1;
        }
        const plistPath = launchAgentPath(options.homeDir);
        const run = options.run ?? defaultRunner;
        const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
        if (sub === 'uninstall') {
            await run('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
            await rm(plistPath, { force: true });
            log(`Removed ${plistPath}. Your data in ${home}/watch is kept; delete that folder to remove it.`);
            return 0;
        }
        let times;
        try {
            times = parseTimes(flagValue(rest, '--times'));
        } catch (error) {
            log(error instanceof Error ? error.message : String(error));
            return 1;
        }
        const entryPath = rest.includes('--print') ? `${home}/app/index.js` : await copyServer(options.sourceEntry, home);
        const plist = launchAgentPlist({ nodePath: options.nodePath, entryPath, home, times });
        if (rest.includes('--print')) {
            log(plist);
            return 0;
        }
        await mkdir(dirname(plistPath), { recursive: true });
        await writeFile(plistPath, plist, { mode: 0o644 });
        await chmod(plistPath, 0o644);
        await run('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
        const loaded = await run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
        log(`Server copied to ${entryPath}`);
        log(`LaunchAgent written: ${plistPath}`);
        log(loaded.ok ? `Loaded: runs daily at ${times.map((t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`).join(', ')} local time (the first success per UTC day does the work).` : `launchctl did not load it: ${loaded.output}`);
        log('Undo with: apify-insights-mcp watch uninstall --experimental');
        return loaded.ok ? 0 : 1;
    }
    const deps = await realDeps(options);
    if (typeof deps === 'string') {
        log(deps);
        return 1;
    }
    try {
        if (sub === 'run') return (await watchRun(deps, { force: rest.includes('--force'), weekly: rest.includes('--weekly') })).code;
        if (sub === 'backfill') {
            const days = Number(flagValue(rest, '--days') ?? 63);
            return (await watchBackfill(deps, { days: Number.isFinite(days) && days > 0 ? Math.min(days, 400) : 63, force: rest.includes('--force') })).code;
        }
    } finally {
        await (deps.log as { flush?: () => Promise<void> }).flush?.();
    }
    log(USAGE);
    return 1;
}

/** For `daily_brief` and the MCP tool: whether the experimental watch is switched on in this environment. */
export function watchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[WATCH_FLAG_ENV] === '1';
}
