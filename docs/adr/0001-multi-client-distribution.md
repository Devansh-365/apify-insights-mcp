# ADR 0001: Distribute to every AI client from GitHub, with a committed bundle

- Status: accepted
- Date: 2026-11-08

## Context

The server should be easy to use from Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Grok Build and OpenCode. All of them start local MCP servers over stdio, but each has its own config format and install path.

Constraints:

- No npm release for now, and the repository is private. So `npx -y apify-insights-mcp` is out, and so is the MCP Registry, which only lists packages from public registries.
- Codex gives a server 10 s to start by default.
- The bridge's native host is a file path that Chrome keeps calling, long after the install command has exited.

Measured on macOS, Node 26:

| Launch | Start time |
|---|---|
| `npx -y github:Devansh-365/apify-insights-mcp`, cold cache | ~11 s |
| same, warm cache (npx re-packs git packages on every launch, even when pinned to a commit) | 3.5 to 10 s |
| `node <local copy>/dist/index.js` | 0.1 s |

## Decision

1. **One self-contained bundle, committed.** esbuild bundles `src/` into `dist/index.js` with no runtime dependencies. It is committed, so a git install needs no build step and no dependency install. `npm run check:dist` fails when the bundle is out of date, so run it before committing.
2. **`setup` command.** `npx -y github:... setup` copies the bundle to `~/.apify-insights/app/index.js` and registers `node <that path>` with every client it finds. Claude Code, Codex, Gemini CLI and Grok Build go through their own `mcp add` commands. For Cursor and OpenCode it merges one entry into their JSON config, and never rewrites a file it cannot parse as plain JSON. This takes one command, gives a 0.1 s start with no network, and updating is the same command again.
3. **Native packages where a client has one.** These run their own copy of the bundle:
   - a Claude Code plugin marketplace (`.claude-plugin/`),
   - a Gemini CLI extension (`gemini-extension.json`),
   - a Claude Desktop `.mcpb` attached to each GitHub release.
4. **`npx -y github:...` stays the zero-install fallback** for any other stdio client. It is documented with its startup cost and the Codex timeout.
5. **Token from the Apify CLI login first.** Gemini CLI strips environment variables named `*TOKEN*`, and Codex does not forward the environment unless told to. So `~/.apify/auth.json` (from `apify login`) is the path that works everywhere. Unresolved placeholders such as `${user_config.apify_token}` are treated as unset.
6. **`install` copies the bridge files and the server into `~/.apify-insights`**, so the native host and the unpacked extension never point into npm's cache.

## Consequences

- Build output lives in git. `.gitattributes` marks it generated and hides its diffs.
- Users need git access to the repository until it is public or on npm.
- When the package goes to npm, the configs change from `github:Devansh-365/apify-insights-mcp` to `apify-insights-mcp`, and the server can be listed in the MCP Registry. Nothing else changes.

## Alternatives considered

- **npm package.** The best option for `npx` and needed for the MCP Registry. Not chosen for now (owner's call); this ADR keeps the switch small.
- **`prepare` script for git installs.** npm would install TypeScript and every dev dependency on the user's machine on each launch. Too slow.
- **Pinning `#<tag>` or `#<sha>` in the npx spec.** Measured: no faster, because npx re-packs git packages anyway.
- **Rewriting every client config ourselves, including JSONC and TOML.** It would lose comments and formatting. The clients' own CLIs handle that safely.
