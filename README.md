# apify-insights-mcp

An MCP server for Apify creators. Ask Claude about your own actors: which are broken, which are flagged by Apify, how many users each has, what they cost to run and how they are priced.

Read-only. It never changes anything in your Apify account.

## Status

| Part | State |
|---|---|
| Public tools (`auth_status`, `list_actors`, `run_health`, `actor_report`) | Working. Need only your Apify API token. |
| Revenue, cost and profit tools | Not built yet. They need a Console session and are planned for a later version. |

## Setup

1. Log in once with the Apify CLI (`apify login`), or set `APIFY_TOKEN`.
2. Build: `npm install && npm run build`.
3. Add it to Claude Code:

```bash
claude mcp add apify-insights -- node /path/to/apify-insights-mcp/dist/index.js
```

Optional: point it at the folder that holds your actors' source code, so reports link an actor to its code:

```bash
claude mcp add apify-insights -e APIFY_INSIGHTS_ACTOR_DIRS=/path/to/repo/actors -- node /path/to/apify-insights-mcp/dist/index.js
```

## Tools

| Tool | Answers |
|---|---|
| `auth_status` | Is the token working, for which account, and is a Console session connected? |
| `list_actors` | My actors with users (7/30 days), users' runs and failure rate (30 days), last run, Apify notice. Top 25 by default. |
| `run_health` | Which actors need attention: flagged by Apify (hidden from Store search) or failing. Worst first. |
| `actor_report` | One actor in depth: users, run results, flags, current price, default memory and timeout, latest build, reviews, local source folder. |

The resource `apify-insights://glossary` defines every metric.

### Rules

- **failing**: at least 3 failed or timed-out runs and a 5% or higher failure rate in users' runs over 30 days. Aborted runs do not count, because users often abort on purpose.
- **flagged**: Apify has put a notice on the actor, such as "under maintenance".
- A missing value is `null`, with a note saying why. It never means zero.

## Development

```bash
npm test              # unit and protocol tests on made-up data
npm run build
node scripts/smoke.mjs <actor-name>   # one live call per tool against your account; prints summaries only
```
