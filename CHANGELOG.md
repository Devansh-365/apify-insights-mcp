# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-11-08

### Added

- Local cache of finished months' money under `~/.apify-insights/cache/`, used for up to 24 hours so a new client session does not wait 3 to 8 s per month again. Only months that ended more than 3 days ago are saved. Answers that used it say which months and when they were fetched. Files hold numbers only and are readable only by you. `APIFY_INSIGHTS_CACHE=0` turns it off.
- `cache clear` command that deletes the local cache.
- After the first money question, the server loads this and last month in the background once per session. `APIFY_INSIGHTS_PREFETCH=0` turns it off.
- Progress messages during long calls (`daily_brief`, portfolio scans, day ranges, waiting for the Console session) for clients that ask for them, so they keep waiting instead of timing out.
- `APIFY_INSIGHTS_DEBUG=timing` writes one line per request to stderr (status, milliseconds, size, path with actor IDs masked), never a token.
- `scripts/bench.mjs` for timing tool calls against your own account.

### Changed

- Money tools use the Console session they already have and only wait for a new one when the Console rejects it. Before, once the saved session was 2 hours old every money call waited for the bridge to deliver a new one, up to 65 s, even when the old one still worked.
- `actor_report` loads its two earlier months for that one actor only (about 11 KB instead of about 770 KB each), and loads its actor details, local source folder and money at the same time.
- `revenue_summary` with a comparison loads both periods at the same time; `actor_profitability` over a day range loads its months at the same time.
- The actor list loads your account and your actors at the same time before the Store lookup.
- On Node 20, idle connections stay open for 60 s instead of 4 s, so calls a few seconds apart reuse the connection. Newer Node versions are unchanged.

### Fixed

- A connection dropped by the server mid-request (`UND_ERR_SOCKET`, `ECONNRESET` and similar) is retried instead of failing the tool.
- A Console 429 waits for `Retry-After` (up to 30 s) and pauses every queued Console request, instead of retrying at once.
- Several requests rejected at the same time share one session refresh.

## [0.4.0] - 2026-11-08

### Added

- `acquisition_score`: marks each of your top actors as Leaking, Rising, Fading, Converting, Steady or Quiet against the same point last month and your other actors, with the reason and what to do. Pass `actor` for one actor. It uses the same numbers and field names as `growth`, which keeps the raw counts, paying users, referrers and countries.
- `actor_quality`: Apify's quality score and improvement suggestions, grouped by work type (security, operations, schema, pricing, listing) and ranked by impact (work-type weight × traffic). Across your top actors it lists the top issues with the actors they affect; for one actor it shows the score, sub-scores, praises and suggestions.
- Prompts `funnel-check` and `quality-review`.
- Glossary entries for acquisition buckets, thresholds, quality scores, work types and impact.
- Console support for the read-only `actor-quality/scores`, `praises-and-improvements` and `business-value-improvements` endpoints. Actor IDs in these paths are checked before any request is sent.

### Changed

- The Console client runs up to 6 requests at once (it ran one at a time), and retries add a random delay of up to 0.5 s so parallel requests do not retry together.
- `growth` and `acquisition_score` share one function for their view and run numbers. `viewToRunPct` is shown uncapped in both and can exceed 100%.

### Fixed

- `growth` for the current month showed views and runs scaled down by the share of the month that had passed (about a quarter of the real numbers on day 8). The Console multiplies counts by `portionOfMonthElapsed`, so the current month is now read without it.
- Cached store-page numbers now depend on that scaling, so last month scaled for a comparison is never reused as the whole of last month.

## [0.3.0] - 2026-11-08

### Added

- Works in Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Grok Build, OpenCode and any other stdio MCP client.
- `setup` command: `npx -y github:Devansh-365/apify-insights-mcp setup` copies the server to `~/.apify-insights/app` and registers it with every client it finds. Claude Code, Codex, Gemini CLI and Grok Build go through their own `mcp add`; Cursor and OpenCode get one entry merged into their JSON config.
- Claude Code plugin marketplace: `/plugin install apify-insights --marketplace Devansh-365/apify-insights-mcp`.
- Gemini CLI extension: `gemini extensions install https://github.com/Devansh-365/apify-insights-mcp`.
- Claude Desktop extension (`.mcpb`), attached to each GitHub release, with a settings field for the Apify token.
- "Add to Cursor" button and per-client setup in the README.
- CI: typecheck, tests, a check that the committed bundle matches the source, and a startup check.

### Changed

- The server ships as one self-contained file, `dist/index.js`, with no runtime dependencies. It is committed so clients can run it straight from GitHub.
- `install` copies the bridge extension to `~/.apify-insights/bridge` and the server to `~/.apify-insights/app`, so neither depends on npm's cache. If you loaded the extension from the repository's `bridge/` folder before, run `install` again and load `~/.apify-insights/bridge` instead.
- The MCP `serverInfo.version` now matches the package version (it was stuck at 0.2.0).

### Fixed

- An unresolved client placeholder in `APIFY_TOKEN` (such as `${user_config.apify_token}` when the field is left empty) no longer hides the `apify login` token.

## [0.2.1] - 2026-11-08

### Fixed

- Money tools no longer fail when an actor had no runs in the month. The Console returns `runsStats: {}` for such actors; every run count is now optional and a missing one reads as 0.

## [0.2.0] - 2026-11-08

### Added

- `daily_brief`: yesterday and month-to-date vs the same days last month, plus the three actors to look at and the rule that flagged each.
- `revenue_summary`: revenue, cost, profit and margin for any period, optionally compared with the previous period, for paying users or all users.
- `actor_profitability`: money per actor for a month (top, losers, movers, no_revenue, below_cost), with cost and revenue per 1,000 results and the break-even price.
- `growth`: views to runs to paying users per actor for a month; for one actor, top referrers and countries.
- `store_rank`: positions in Apify Store search for up to 10 keywords, and who ranks above.
- `competitor_benchmark`: your public portfolio vs another creator's.
- Money sections in `run_health` (revenue at risk) and `actor_report` (last three months).
- Console bridge: a Chrome extension and native host that keep a Console session available to the money tools, with `install` and `uninstall` commands for Chrome, Chromium, Brave, Edge and Arc on macOS and Linux.
- Prompts `morning-brief`, `loss-hunt` and `health-check`.
- Optional usage log (`APIFY_INSIGHTS_USAGE_LOG=1`) and `scripts/trial-report.mjs`.

### Removed

- The phase 0 Console token test harness.

## [0.1.0] - 2026-11-08

### Added

- Stdio MCP server with the `apify-insights://glossary` resource that defines every metric and rule.
- `auth_status`: whether the Apify token works, for which account, and whether a Console session is connected. The token is never exposed.
- `list_actors`: your actors with users (7/30 days), users' runs and failure rate, last run and Apify notice.
- `run_health`: actors that are flagged by Apify, failing, or charging nothing.
- `actor_report`: one actor in depth (users, runs, flags, price, memory and timeout, latest build, reviews, local source folder).
- Read-only Apify API client with paging and retries.
- Actor catalog, resolver, cache, response envelope and local source lookup (`APIFY_INSIGHTS_ACTOR_DIRS`).
- Unit and protocol tests on made-up data, and a live smoke test over stdio (`scripts/smoke.mjs`).

[0.5.0]: https://github.com/Devansh-365/apify-insights-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Devansh-365/apify-insights-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Devansh-365/apify-insights-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Devansh-365/apify-insights-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Devansh-365/apify-insights-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Devansh-365/apify-insights-mcp/releases/tag/v0.1.0
