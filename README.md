# apify-insights-mcp

An MCP server for Apify creators. Ask Claude about your own actors: what you earned yesterday, which actors lose money and at what price they would break even, which are broken or flagged by Apify, how many users each has, and where you rank in Store search.

Read-only. It never changes anything in your Apify account.

## Status

| Part | State |
|---|---|
| Public tools (`auth_status`, `list_actors`, `run_health`, `actor_report`, `store_rank`, `competitor_benchmark`) | Working. Need only your Apify API token. |
| Money tools (`daily_brief`, `revenue_summary`, `actor_profitability`, `growth`, money parts of `run_health` / `actor_report`) | Built and tested on made-up data. They need the Console session from the bridge extension below. |
| Bridge (Chrome extension + native host) | Built. Load unpacked; not on the Chrome Web Store. |
| Clients | Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Grok Build, OpenCode and any other stdio MCP client. |

## Install

You need Node.js 20 or later, and access to this repository (it installs straight from GitHub with your git login).

**1. Give it your Apify token.** Run `apify login` once (the [Apify CLI](https://docs.apify.com/cli)), or set `APIFY_TOKEN`. Every client below picks up the CLI login, so you never paste the token into a config file.

**2. Add it to your AI clients, all at once:**

```bash
npx -y github:Devansh-365/apify-insights-mcp setup
```

This copies the server to `~/.apify-insights/app/index.js` and registers it with every client it finds: Claude Code, Codex, Gemini CLI and Grok Build through their own `mcp add` commands, and Cursor and OpenCode by adding one entry to their JSON config (a config with comments is left alone and the line to add is printed). Clients then start it with plain `node`, in about 0.1 s and with no network. Run the same command again to update.

**3. Optional, for money data:** install the bridge with `npx -y github:Devansh-365/apify-insights-mcp install` ([details](#money-tools-the-bridge)).

Restart your client and ask: *"How are my Apify actors doing?"*

### One client at a time

Prefer to add it by hand, or using a client `setup` does not cover? Each client has a native install path.

<details>
<summary><b>Claude Code</b> (plugin)</summary>

```text
/plugin install apify-insights --marketplace Devansh-365/apify-insights-mcp
```

Or as a plain MCP server: `claude mcp add -s user apify-insights -- npx -y github:Devansh-365/apify-insights-mcp`
</details>

<details>
<summary><b>Claude Desktop</b> (one-click extension)</summary>

Download `apify-insights-<version>.mcpb` from the [latest release](https://github.com/Devansh-365/apify-insights-mcp/releases/latest) and double-click it. Claude Desktop runs it with its own Node.js. Paste your Apify token in the extension's settings, or leave the field empty if you ran `apify login`.
</details>

<details>
<summary><b>Cursor</b></summary>

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=apify-insights&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImdpdGh1YjpEZXZhbnNoLTM2NS9hcGlmeS1pbnNpZ2h0cy1tY3AiXX0%3D)

Or add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "apify-insights": { "command": "npx", "args": ["-y", "github:Devansh-365/apify-insights-mcp"] }
  }
}
```
</details>

<details>
<summary><b>Gemini CLI</b> (extension)</summary>

```bash
gemini extensions install https://github.com/Devansh-365/apify-insights-mcp
```

Gemini CLI hides environment variables whose names contain `TOKEN` from MCP servers, so use `apify login` rather than `APIFY_TOKEN` here. Update with `gemini extensions update apify-insights`.
</details>

<details>
<summary><b>Codex</b> (CLI and IDE extension)</summary>

```bash
codex mcp add apify-insights -- npx -y github:Devansh-365/apify-insights-mcp
```

Or in `~/.codex/config.toml`. Starting from GitHub takes several seconds, longer than Codex's 10-second default, hence the timeout; `env_vars` passes `APIFY_TOKEN` through if you use it:

```toml
[mcp_servers.apify-insights]
command = "npx"
args = ["-y", "github:Devansh-365/apify-insights-mcp"]
env_vars = ["APIFY_TOKEN"]
startup_timeout_sec = 60
```
</details>

<details>
<summary><b>Grok Build</b></summary>

```bash
grok mcp add apify-insights -- npx -y github:Devansh-365/apify-insights-mcp
```

Grok Build also reads servers you added to Claude Code (`~/.claude.json`) and Cursor (`.cursor/mcp.json`), so if either has it, Grok already does.
</details>

<details>
<summary><b>OpenCode</b></summary>

In `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "apify-insights": {
      "type": "local",
      "command": ["npx", "-y", "github:Devansh-365/apify-insights-mcp"],
      "enabled": true
    }
  }
}
```
</details>

<details>
<summary><b>Any other MCP client</b> (VS Code, Windsurf, Cline, Zed...)</summary>

It is a standard stdio server. Use command `npx` with arguments `-y github:Devansh-365/apify-insights-mcp`, or, after `setup`, command `node` with argument `~/.apify-insights/app/index.js` written as a full path. On Windows, clients that cannot start `npx` directly need command `cmd` with arguments `/c npx -y github:Devansh-365/apify-insights-mcp`.
</details>

Starting from `npx -y github:...` downloads and unpacks the repository on every launch (4 to 15 s). `setup`, the Claude Code plugin, the Gemini extension and the Desktop extension avoid that by running a local copy.

### Money tools: the bridge

Money data (revenue, cost, profit) comes from your Apify Console session, which a small Chrome extension keeps available:

```bash
npx -y github:Devansh-365/apify-insights-mcp install
```

This copies the extension to `~/.apify-insights/bridge`, registers a native host for the browsers it finds (Chrome, Chromium, Brave, Edge, Arc; macOS and Linux), and prints the next steps: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick `~/.apify-insights/bridge`. Stay logged in to console.apify.com in that browser. The bridge refreshes the Console session only while a money tool is in use, and talks only to `console-backend.apify.com` and the local native host. `uninstall` removes it.

### Settings

Optional environment variables, set in your client's MCP config:

| Variable | Effect |
|---|---|
| `APIFY_TOKEN` | Apify API token. Without it the server uses your `apify login`. |
| `APIFY_INSIGHTS_ACTOR_DIRS` | Folders that hold one actor per subfolder, so reports link an actor to its source code. |
| `APIFY_INSIGHTS_USAGE_LOG=1` | Appends tool name and time (nothing else) to `~/.apify-insights/usage.jsonl`, for the 14-day trial. |
| `APIFY_INSIGHTS_HOME` | Where the server copy, session files and the usage log live (default `~/.apify-insights`). |

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

Why the install works the way it does: [ADR 0001](docs/adr/0001-multi-client-distribution.md).

```bash
npm test              # unit and protocol tests on made-up data
npm run build         # bundles src/ into dist/index.js, which is committed: rebuild before every commit
npm run check:dist    # fails if dist/index.js is out of date (CI runs this)
npm run pack:mcpb     # builds release/apify-insights-<version>.mcpb for Claude Desktop
node scripts/smoke.mjs <actor> <other-creator> <keyword>   # one live call per tool; prints summaries only
node scripts/trial-report.mjs                              # active days per week from the usage log
```

## Author

Devansh Tiwari

## License

[MIT](LICENSE). See [CHANGELOG.md](CHANGELOG.md) for release notes.
