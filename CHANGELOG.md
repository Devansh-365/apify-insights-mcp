# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.1]: https://github.com/Devansh-365/apify-insights-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Devansh-365/apify-insights-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Devansh-365/apify-insights-mcp/releases/tag/v0.1.0
