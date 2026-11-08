// Dogfood trial report (plan §9): reads <home>/usage.jsonl (tool name + time only) and prints active
// days per 7-day window since the first logged call, calls per tool, and the kill/pivot verdict.
// Usage: node scripts/trial-report.mjs [home]   (default: $APIFY_INSIGHTS_HOME or ~/.apify-insights)
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.argv[2] || process.env.APIFY_INSIGHTS_HOME || join(homedir(), '.apify-insights');
const DAY = 86_400_000;

let text;
try {
    text = await readFile(join(home, 'usage.jsonl'), 'utf8');
} catch {
    console.log(`No usage log at ${join(home, 'usage.jsonl')}. Start the server with APIFY_INSIGHTS_USAGE_LOG=1.`);
    process.exit(1);
}
const entries = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => typeof entry.t === 'string' && typeof entry.tool === 'string');
if (!entries.length) {
    console.log('The usage log is empty.');
    process.exit(1);
}

// Local calendar days: the habit is about the owner's days, not UTC.
const localDay = (iso) => new Date(iso).toLocaleDateString('en-CA');
const start = Date.parse(`${localDay(entries[0].t)}T00:00:00`);
const elapsedDays = Math.floor((Date.now() - start) / DAY) + 1;

const windows = [];
for (let offset = 0; offset < Math.min(elapsedDays, 14); offset += 7) {
    const from = start + offset * DAY;
    const to = from + 7 * DAY;
    const days = new Set(entries.filter((e) => Date.parse(e.t) >= from && Date.parse(e.t) < to).map((e) => localDay(e.t)));
    windows.push({ week: offset / 7 + 1, from: localDay(new Date(from).toISOString()), complete: Date.now() >= to, activeDays: days.size });
}
const perTool = {};
for (const entry of entries) perTool[entry.tool] = (perTool[entry.tool] ?? 0) + 1;

console.log(`Trial started ${localDay(entries[0].t)}; day ${Math.min(elapsedDays, 14)} of 14${elapsedDays > 14 ? ' (finished)' : ''}.`);
for (const w of windows) console.log(`Week ${w.week} (from ${w.from}${w.complete ? '' : ', in progress'}): ${w.activeDays} of 7 days active.`);
console.log('Calls per tool:', Object.entries(perTool).sort((a, b) => b[1] - a[1]).map(([tool, n]) => `${tool} ${n}`).join(', '));

const complete = windows.filter((w) => w.complete);
if (elapsedDays < 14 || complete.length < 2) {
    console.log('Verdict: not yet (needs 14 days).');
} else {
    const worst = Math.min(...complete.map((w) => w.activeDays));
    const verdict = worst >= 5 ? 'PASS: habit target met (5+ of 7 days each week).' : worst >= 2 ? 'PIVOT: 2-4 days/week. Spend one week on the brief only, then re-measure 7 days.' : 'KILL: under 2 active days in a week. Stop investing; keep the extension.';
    console.log(`Verdict: ${verdict}`);
}
