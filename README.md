# apify-insights-mcp

An MCP server for Apify creators. Ask Claude about your own actors: what you earned yesterday, which actors lose money and at what price they would break even, which are broken or flagged by Apify, how many users each has, and where you rank in Store search.

Read-only. It never changes anything in your Apify account.

## Status

| Part | State |
|---|---|
| Public tools (`auth_status`, `list_actors`, `run_health`, `actor_report`, `store_rank`, `competitor_benchmark`) | Working. Need only your Apify API token. |
| Money tools (`daily_brief`, `revenue_summary`, `actor_profitability`, `growth`, money parts of `run_health` / `actor_report`) | Built and tested on made-up data. They need the Console session from the bridge extension below. |
| Bridge (Chrome extension + native host) | Built. Load unpacked; not on the Chrome Web Store. |

## Setup

1. Log in once with the Apify CLI (`apify login`), or set `APIFY_TOKEN`.
2. Build: `npm install && npm run build`.
3. For money data, install the bridge:

```bash
node dist/index.js install
```

   This registers a native host for the browsers it finds (Chrome, Chromium, Brave, Edge, Arc; macOS and Linux) and prints the next steps: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `bridge/` folder. Stay logged in to console.apify.com in that browser. The bridge refreshes the Console session only while a money tool is in use, and talks only to `console-backend.apify.com` and the local native host. `node dist/index.js uninstall` removes it.

4. Add the server to Claude Code:

```bash
claude mcp add apify-insights -- node /path/to/apify-insights-mcp/dist/index.js
```

Optional environment variables (`-e NAME=value` on `claude mcp add`):

| Variable | Effect |
|---|---|
| `APIFY_INSIGHTS_ACTOR_DIRS` | Folders that hold one actor per subfolder, so reports link an actor to its source code. |
| `APIFY_INSIGHTS_USAGE_LOG=1` | Appends tool name and time (nothing else) to `~/.apify-insights/usage.jsonl`, for the 14-day trial. |
| `APIFY_INSIGHTS_HOME` | Where session files and the usage log live (default `~/.apify-insights`). |

## Tools

| Tool | Answers |
|---|---|
| `daily_brief` | How did I do yesterday and this month so far vs the same days last month, and which three actors should I look at, each with the rule that flagged it. |
| `revenue_summary` | Revenue, cost, profit and margin for any period (yesterday, last7d, a month, a date range), optionally compared with the previous period. Paying users or all users. |
| `actor_profitability` | Money per actor for a month: top, losers, movers, no_revenue, below_cost. Includes cost and revenue per 1,000 results and the break-even price. |
| `run_health` | Which actors need attention: flagged by Apify (hidden from Store search), failing, or charging nothing. With money: revenue at risk. |
| `actor_report` | One actor in depth: users, run results, flags, price, default memory and timeout, latest build, reviews, local source folder, last three months of money. |
| `growth` | Views to runs to paying users for a month, per actor; one actor adds top referrers and countries. |
| `list_actors` | My actors with users (7/30 days), users' runs and failure rate, last run, Apify notice. |
| `store_rank` | My positions in Apify Store search for up to 10 keywords, and who ranks above. |
| `competitor_benchmark` | My public portfolio vs another creator's. |
| `auth_status` | Is the token working, for which account, and is a Console session connected? |

Prompts: `morning-brief`, `loss-hunt`, `health-check`. The resource `apify-insights://glossary` defines every metric and rule.

### Rules

- **Money** is what the Apify Console shows. Per-actor money is paying users only and exists per calendar month; day ranges per actor cover only named actors or your top 10 earners.
- **failing**: at least 3 failed or timed-out runs and a 5% or higher failure rate in users' runs over 30 days. Aborted runs do not count.
- **flagged**: Apify has put a notice on the actor, such as "under maintenance".
- **losing / thin_margin / below_cost / no_revenue / declining / growing**: see the glossary; thresholds scale with your portfolio (1% of the monthly profit pace, at least $1).
- A missing value is `null`, with a note saying why. It never means zero.

## Development

```bash
npm test              # unit and protocol tests on made-up data
npm run build
node scripts/smoke.mjs <actor> <other-creator> <keyword>   # one live call per tool; prints summaries only
node scripts/trial-report.mjs                              # active days per week from the usage log
```

## Author

Devansh Tiwari
