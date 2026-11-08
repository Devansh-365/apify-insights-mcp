# Install

> Using an AI coding agent? Point it at [skills/setup-apify-insights/SKILL.md](../skills/setup-apify-insights/SKILL.md) and it does all of this for you.

You need Node.js 20 or later, and access to this repository (it installs straight from GitHub with your git login).

**1. Give it your Apify token.** Run `apify login` once (the [Apify CLI](https://docs.apify.com/cli)), or set `APIFY_TOKEN`. Every client below picks up the CLI login, so you never paste the token into a config file.

**2. Add it to your AI clients, all at once:**

```bash
npx -y github:Devansh-365/apify-insights-mcp setup
```

This copies the server to `~/.apify-insights/app/index.js` and registers it with every client it finds: Claude Code, Codex, Gemini CLI and Grok Build through their own `mcp add` commands, and Cursor and OpenCode by adding one entry to their JSON config (a config with comments is left alone and the line to add is printed). Clients then start it with plain `node`, in about 0.1 s and with no network. Run the same command again to update.

**3. Optional, for money data:** install the bridge ([below](#money-tools-the-bridge)).

Restart your client and ask: *"How are my Apify actors doing?"*

## One client at a time

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

## Money tools: the bridge

Money data (revenue, cost, profit) comes from your Apify Console session, which a small Chrome extension keeps available:

```bash
npx -y github:Devansh-365/apify-insights-mcp install
```

This copies the extension to `~/.apify-insights/bridge`, registers a native host for the browsers it finds (Chrome, Chromium, Brave, Edge, Arc; macOS and Linux), and prints the next steps: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick `~/.apify-insights/bridge`. Stay logged in to console.apify.com in that browser. The bridge refreshes the Console session only while a money tool is in use, and talks only to `console-backend.apify.com` and the local native host. `uninstall` removes it.

## Settings

Optional environment variables, set in your client's MCP config:

| Variable | Effect |
|---|---|
| `APIFY_TOKEN` | Apify API token. Without it the server uses your `apify login`. |
| `APIFY_INSIGHTS_ACTOR_DIRS` | Folders that hold one actor per subfolder, so reports link an actor to its source code. |
| `APIFY_INSIGHTS_USAGE_LOG=1` | Appends tool name and time (nothing else) to `~/.apify-insights/usage.jsonl`, for the 14-day trial. |
| `APIFY_INSIGHTS_HOME` | Where the server copy, session files and the usage log live (default `~/.apify-insights`). |

## Check it works

Ask your client *"Check my apify-insights connection"*. That runs `auth_status`, which reports the Apify account it sees and whether the bridge is connected.

| You see | Fix |
|---|---|
| `public_auth_missing` | No token found. Run `apify login`, or set `APIFY_TOKEN` in the client's MCP config. |
| The client lists no `apify-insights` tools | Restart the client. Then check the server is registered: `claude mcp list`, `codex mcp list`, `gemini mcp list`, `grok mcp list`, or `opencode mcp list`. |
| Codex says the server timed out | You launch it with `npx -y github:...`. Run `setup` instead, or set `startup_timeout_sec = 60`. |
| `npx` fails with `could not read Username` or a 404 | Your git cannot reach this repository. Check `git ls-remote https://github.com/Devansh-365/apify-insights-mcp.git`. |
| Money tools say the bridge is missing | Run `install` and load `~/.apify-insights/bridge` in `chrome://extensions`, then stay logged in to console.apify.com. |

## Update or remove

- **Update:** run `npx -y github:Devansh-365/apify-insights-mcp setup` again. It replaces the local copy, and the client configs stay the same. If you use the bridge, run `install` again too and click reload on the extension.
- **Remove the bridge:** `npx -y github:Devansh-365/apify-insights-mcp uninstall`, then remove the extension in `chrome://extensions`.
- **Remove the server from a client:** `claude mcp remove -s user apify-insights`, `codex mcp remove apify-insights`, `gemini mcp remove -s user apify-insights` or `grok mcp remove apify-insights`. For Cursor and OpenCode, delete the `apify-insights` entry from their config. Then delete `~/.apify-insights`.
