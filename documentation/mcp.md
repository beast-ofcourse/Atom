# MCP Servers

ATOM connects to external [Model Context Protocol](https://modelcontextprotocol.io/) servers and exposes their tools to the model as first-class tools. One singleton (`src/mcp/manager.ts`) owns every connection: config load, concurrent connects, the sanitized tool catalog, calls, and shutdown. Failures are per-server and never block other servers or startup.

Sources of truth: `src/mcp/config.ts` (parsing), `src/mcp/client.ts` (protocol), `src/mcp/manager.ts` (lifecycle), `src/mcp/auth.ts` + `src/mcp/oauth.ts` (credentials). Covered by `tests/mcp.test.ts`.

## Configuration

Servers live under the `mcp` key in `atom.json` (project wins over global per key; see [Configuration](configuration.md)). Every key is optional; loading never throws — invalid entries are dropped with warnings surfaced in `/context`, while invalid `enabled`/`timeout` fields fall back to defaults with a warning instead of dropping the entry. Tool-name collisions (lossy `<server>_<tool>` sanitization folding two tools together) drop the later registration with a warning that also surfaces in `/context` under `mcp warnings:` — diagnostics never use `console`, which would tear the TUI.

```json
{
  "mcp": {
    "everything": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-everything"] },
    "docs": { "type": "remote", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer TOKEN" } }
  }
}
```

| Field | Local | Remote | Notes |
|---|---|---|---|
| `type` | `"local"` | `"remote"` | Required; anything else drops the entry |
| `command` | string array, non-empty | — | Spawned as a stdio child; `cwd` + `environment` optional extras |
| `url` | — | http(s) string | Required; non-http(s) drops the entry |
| `headers` | — | string-to-string object | Sent on every HTTP request (e.g. static `Authorization`) |
| `oauth` | — | object or `false` | Pre-registered `clientId`/`clientSecret`/`scope`, or `false` to disable OAuth detection |
| `enabled` | boolean | boolean | Default on; `false` never spawns (`disabled` status) |
| `timeout` | ms | ms | Per-call budget, default 30000, clamped to 120000 |

## Tool naming

Each server tool appears as `<server>_<tool>` (e.g. `docs_search`), with every unsafe char folded to `_` (`sanitizeMcpName` — same rule as opencode's catalog). Sanitization is lossy by design, so first registration wins and later collisions are dropped with a console warning — the model never sees an ambiguous name.

## Lifecycle and status

Every configured server is in exactly one state:

| Status | Meaning |
|---|---|
| `connected` (+ tool count) | Handshake plus `tools/list` succeeded |
| `disabled` | `enabled: false` — never spawned |
| `failed` (+ error) | Spawn, connect, or handshake failed; unreachable remotes fail without blocking the rest |
| `needs_auth` | Remote returned 401 — run `atom --mcp-auth <server>` |

Connects run concurrently at refresh. The catalog stays live: `notifications/tools/list_changed` re-lists that server in place (stale catalog kept on failure), and an exited local process or closed SSE stream evicts that server's tools and marks it `failed`.

## Using MCP in the TUI

- `/mcp` opens the server popup (snapshot-on-open status list): `↑`/`↓` moves, `Space` toggles enable/disable in place (persisted to project `atom.json` and reconnected), `Esc` closes.
- Server tools validate args inline (`missing required field`, type/enum/`additionalProperties` checks) and dispatch through the shared loop like builtins. MCP calls render a one-line activity label (`⚙ <server>_<tool>`).
- Approval is fail-closed: MCP tools prompt in normal mode. Scope them with session rules — `t1_*` covers a whole server family, exact names stay exact, deny wins over allow (see [Permissions](permissions.md)). Yolo and session trust auto-run them like any other approval-gated tool.
- Output caps match local tools: text results over 64KB truncate to a head plus an overflow-file pointer (`read` it with `offset`/`limit`); binary resource blobs are omitted with a size note, never dumped into context.

## Resources and prompts

Beyond tools, servers may offer resources (files, schemas, app context) and prompts. ATOM probes both capabilities per server at connect; the synthetic cross-server tools below appear in the catalog exactly when at least one connected server proves support, so the model never sees tools that can only error:

| Tool | What it does |
|---|---|
| `list_mcp_resources` | List resources across servers; optional `server` scopes to one |
| `list_mcp_resource_templates` | List parameterized `uriTemplate`s; fill one in to read it |
| `read_mcp_resource` | Read one resource by exact `server` + `uri` (URIs are opaque server identifiers, not file paths) |
| `list_mcp_prompts` | List prompts across servers; optional `server` scopes to one |
| `get_mcp_prompt` | Fetch one prompt by `server` + `name` with string-only `arguments` |

Targeting a server without the capability is a clean `Error:` naming the servers that do support it — never a crash.

## Authentication (remote OAuth)

```bash
atom --mcp-auth <server>    # browser OAuth flow, stores credentials, reconnects, exits
atom --mcp-logout <server>  # drop stored credentials for one server, exits
atom --mcp-list             # print every configured server with live state, exits
```

Flow details (`src/mcp/oauth.ts`, store in `src/mcp/auth.ts`):

- Discovery via `/.well-known/oauth-authorization-server`, dynamic client registration with a loopback `127.0.0.1` callback, CSRF-checked `state`, PKCE (`S256`) code exchange.
- Credentials persist in `~/.atom/mcp-auth.json` (`ATOM_HOME` overrides home), owner-only permissions, bound to the server URL — changing the URL invalidates them. Malformed files read as empty, never throw.
- Expired tokens refresh inline when a refresh token exists (the old refresh token is retained if the server omits a fresh one); expiry without refresh surfaces as `needs_auth`/`expired`, not a generic failure.
- Servers without a registration endpoint need a pre-registered `oauth.clientId` in `atom.json`, else auth fails with guidance. `oauth: false` disables OAuth detection entirely.

## Failure semantics

`execute()` never throws: every failure becomes an `Error: ...` string the model can react to — unknown tool (with the live catalog as hint), server not connected, auth needed (with the exact `--mcp-auth` command), timeout naming server, tool, and budget. Timeouts name the phase on connect (`timed out while tools/list after …`).

## Security notes

- Toggling a server persists its full effective entry to project `atom.json` but strips `Authorization` headers and `oauth.clientSecret` — secrets stay in env vars and `mcp-auth.json`, never in project config.
- Treat server output as untrusted input: it can carry anything, including instruction-like text. Never print or commit `mcp-auth.json`.
- Local servers spawn with your user privileges and configured `environment` — only configure servers you trust, same bar as shell approval.

## Troubleshooting

| Symptom | Check first |
|---|---|
| `failed: ...` on a local server | `command[0]` on `PATH`? `cwd` exists? Run the command by hand and watch stderr |
| `failed` on a remote server | URL reachable? `atom --mcp-list` shows the error; static `headers` correct? |
| `needs_auth` | `atom --mcp-auth <server>`; for no-registration servers add `oauth.clientId` |
| Tool missing from the model | `/mcp` status — `disabled`/`failed` servers contribute no tools; sanitized-name collision drops losers (console warning) |
| `timed out after …` | Raise `timeout` (max 120000); hanging servers keep their stale catalog and stay `connected` |
| Auth lost after URL edit | Expected — credentials bind to URL; re-run `atom --mcp-auth <server>` |
