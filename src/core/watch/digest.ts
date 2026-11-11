import { DIGEST, RULES_VERSION } from './constants.js';
import { OWNER_EXCLUSION_CAVEAT } from './owner-runs.js';
import type { ActorFacts } from './rules.js';
import type { Item } from './state.js';
import type { ActorSignals, ResolvedAlert, WatchState } from './types.js';

// The markdown digest: verdict first, one item per actor, PAGE then WATCH then info, ordered by weekly
// money at stake. Numbers and actor names only.

export interface DigestInput {
    day: string;
    asOf: string;
    items: Item[];
    actors: ActorSignals[];
    facts: Map<string, ActorFacts>;
    state: WatchState;
    resolved: ResolvedAlert[];
    firstRun: boolean;
    weekly: boolean;
    consoleLine: string;
    storeLine: string;
    dataLine: string;
    notes: string[];
}

const usd = (v: number) => `$${(Math.round(v * 100) / 100).toFixed(2)}`;

function itemBlock(item: Item): string[] {
    const rules = item.signals.filter((s) => s.tier !== 'info' || item.tier === 'info');
    const title = rules.map((s) => s.title).join(' + ');
    const flags = [item.isNew ? 'new' : null, item.snoozed ? 'snoozed' : null, rules.some((s) => s.approximate) ? '~approximate' : null].filter(Boolean).join(', ');
    const lines = [`[${item.tier}] ${item.name} - ${title}${item.firstSeen ? `   first seen ${item.firstSeen.slice(0, 10)}` : ''}${flags ? ` (${flags})` : ''}`];
    for (const s of rules) lines.push(`  ${s.rule}: ${s.evidence}`);
    const sources = [...new Set(rules.map((s) => s.source))].join('; ');
    lines.push(`  at stake ${usd(item.atStakeUsd)}/week | source: ${sources}`);
    lines.push(`  Next: ${item.next}`);
    return lines;
}

function oneLine(item: Item): string {
    const s = item.signals.filter((x) => x.tier !== 'info');
    return `${item.name}: ${s.map((x) => `${x.title}: ${x.evidence}`).join(' | ')}`;
}

export function renderDigest(input: DigestInput): string {
    const live = input.items.filter((i) => !(input.firstRun && i.backlog));
    const page = live.filter((i) => i.tier === 'PAGE' && !i.snoozed);
    // A standing concentration entry is listed in its table only; it shows as WATCH when it is new.
    const watch = live.filter((i) => i.tier === 'WATCH' && !i.snoozed && !(i.signals.every((s) => s.rule === 'R8') && !i.isNew));
    const info = input.items.filter((i) => i.tier === 'info');
    const snoozed = input.items.filter((i) => i.snoozed && i.tier !== 'info');
    const backlog = input.firstRun ? input.items.filter((i) => i.backlog && i.tier !== 'info') : [];
    const out: string[] = [];
    out.push(`# Early warning ${input.day}`);
    out.push('');
    let verdict: string;
    if (input.firstRun) verdict = `First run: ${backlog.length} existing problem(s) listed under "Backlog at install" (no notification).`;
    else if (page.length) {
        const fresh = page.filter((p) => p.isNew).length;
        verdict = `${page.length} PAGE item(s) need a look${fresh ? ` (${fresh} new)` : ''}; ${watch.length} WATCH.`;
    } else verdict = `Nothing to page on. ${watch.length} WATCH item(s).`;
    out.push(`**${verdict}**`);
    out.push('');
    out.push(`Rules ${RULES_VERSION} (experimental) | evaluated ${input.asOf.slice(0, 16).replace('T', ' ')} UTC`);
    out.push(`- ${input.consoleLine}`);
    out.push(`- ${input.storeLine}`);
    out.push(`- ${input.dataLine}`);
    for (const note of input.notes) out.push(`- ${note}`);
    out.push('');
    if (!input.firstRun || page.length) {
        out.push(`## PAGE (${page.length})`);
        out.push('');
        if (!page.length) out.push('None.');
        for (const item of page.slice(0, DIGEST.maxPage)) out.push(...itemBlock(item), '');
        if (page.length > DIGEST.maxPage) out.push(`(${page.length - DIGEST.maxPage} more PAGE items in state.json)`, '');
        out.push(`## WATCH (${watch.length})`);
        out.push('');
        if (!watch.length) out.push('None.');
        for (const item of watch.slice(0, DIGEST.maxWatch)) out.push(`- ${oneLine(item)}${item.isNew ? ' (new)' : ''}. Next: ${item.next}`);
        if (watch.length > DIGEST.maxWatch) out.push(`- (${watch.length - DIGEST.maxWatch} more WATCH items in state.json)`);
        out.push('');
    }
    if (backlog.length) {
        out.push(`## Backlog at install (${backlog.length}, silent)`);
        out.push('');
        out.push('Already true on the first run. These do not notify; they notify later only if they get 50% worse.');
        out.push('');
        for (const item of backlog) out.push(`- [${item.tier}] ${oneLine(item)}. Next: ${item.next}`);
        out.push('');
    }
    if (info.length) {
        out.push(`## Info (${info.length})`);
        out.push('');
        for (const item of info.slice(0, DIGEST.maxInfo)) out.push(`- ${item.name}: ${item.signals.map((s) => `${s.title}: ${s.evidence}`).join(' | ')}`);
        if (info.length > DIGEST.maxInfo) out.push(`- (${info.length - DIGEST.maxInfo} more)`);
        out.push('');
    }
    if (input.resolved.length) {
        out.push(`## Resolved (${input.resolved.length})`);
        out.push('');
        for (const r of input.resolved) out.push(`- ${r.name}: ${r.rule} (${r.tier}) open since ${r.firstSeen.slice(0, 10)}, resolved ${r.resolvedAt.slice(0, 10)}`);
        out.push('');
    }
    if (snoozed.length) {
        out.push(`## Snoozed (${snoozed.length})`);
        out.push('');
        for (const item of snoozed) {
            const until = input.state.snoozes.filter((s) => s.actorId === item.actorId).map((s) => s.until.slice(0, 10)).sort().pop();
            out.push(`- ${item.name}: ${item.signals.map((s) => s.rule).join(', ')} until ${until ?? 'unknown'}`);
        }
        out.push('');
    }
    if (input.weekly) {
        const conc = input.actors.filter((a) => a.signals.some((s) => s.rule === 'R8'));
        const total56 = [...input.facts.values()].reduce((sum, f) => sum + Math.max(0, f.revenue56), 0);
        const top = [...input.facts.entries()].sort((a, b) => b[1].revenue56 - a[1].revenue56)[0];
        const concTotal = conc.reduce((sum, a) => sum + (input.facts.get(a.id)?.revenue56 ?? 0), 0);
        out.push(`## Concentration (${conc.length})`);
        out.push('');
        out.push('Actors whose 56-day revenue rests on one burst or on at most 2 paying users (proxies: the Console has no per-buyer revenue).');
        out.push('');
        for (const a of conc) out.push(`- ${a.name}: ${a.signals.find((s) => s.rule === 'R8')!.evidence}`);
        if (total56 > 0) {
            const share = (v: number) => `${Math.round((v / total56) * 1000) / 10}%`;
            const topName = top ? (input.actors.find((a) => a.id === top[0])?.name ?? null) : null;
            const topPart = top ? `; the top actor${topName ? ` (${topName})` : ''} holds ${share(top[1].revenue56)}` : '';
            out.push(`- Portfolio: concentration actors hold ${share(concTotal)} of 56-day revenue (${usd(total56)})${topPart}.`);
        }
        out.push('');
    }
    const excluded = input.actors.filter((a) => a.exclusions.length);
    if (excluded.length) {
        out.push(`## Owner-run exclusions (${excluded.length}, heuristic)`);
        out.push('');
        out.push(OWNER_EXCLUSION_CAVEAT);
        out.push('');
        for (const a of excluded) out.push(`- ${a.name}: ${a.exclusions.join('; ')}`);
        out.push('');
    }
    out.push('Tiers: PAGE notifies (new or 50% worse, one reminder after 14 days); WATCH and info only appear here. Snooze with: apify-insights-mcp watch snooze <actor> --days 7 --experimental');
    return `${out.join('\n')}\n`;
}

/** The notification text: actor names and dollar figures only. */
export function notificationText(alerts: Array<{ name: string; rule: string; atStakeUsd: number }>): { title: string; message: string } {
    const head = alerts
        .slice(0, 3)
        .map((a) => `${a.name} (${a.rule}, ${usd(a.atStakeUsd)}/wk)`)
        .join(', ');
    const more = alerts.length > 3 ? ` and ${alerts.length - 3} more` : '';
    return { title: `Early warning: ${alerts.length} PAGE alert${alerts.length === 1 ? '' : 's'}`, message: `${head}${more}. Run decline_watch or read the digest.` };
}
