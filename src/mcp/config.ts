// MCP server configuration: parsing + validation for the `mcp` atom.json
// key (tickets 01+02). Pure module: no imports beyond node builtins, so
// src/config.ts can use it without a runtime cycle and tests can exercise
// it without fixtures.
//
// Shape (mirrors opencode's V1 MCP config, trimmed to what ATOM wires):
//   "mcp": {
//     "my-local":  { "type": "local",  "command": ["npx","-y","..."],
//                   "cwd"?: "...", "environment"?: {...}, "enabled"?: true,
//                   "timeout"?: 30000 },
//     "my-remote": { "type": "remote", "url": "https://...",
//                   "headers"?: {...}, "enabled"?: true, "timeout"?: 30000 }
//   }
// Everything is optional and validated: unknown servers/keys are ignored
// with warnings, loading never throws.

export const MCP_DEFAULT_TIMEOUT_MS = 30_000;
export const MCP_MAX_TIMEOUT_MS = 120_000;

export type McpLocalConfig = {
  type: "local";
  command: string[];
  cwd?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
};

export type McpOAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
};

export type McpRemoteConfig = {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  /** OAuth config object, or false to disable automatic OAuth detection. */
  oauth?: McpOAuthConfig | false;
  enabled?: boolean;
  timeout?: number;
};

export type McpServerConfig = McpLocalConfig | McpRemoteConfig;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return undefined;
    out[k] = v;
  }
  return out;
}

function asTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), MCP_MAX_TIMEOUT_MS);
}

// Validate one server entry. Returns the config, or an error fragment when
// the entry is unusable (the caller frames it, e.g. `ignoring invalid
// "mcp.<name>" (<fragment>)`). Invalid `enabled`/`timeout` fields fall back
// to defaults with a warning via warn instead of dropping the entry.
export function parseMcpServerEntry(entry: unknown, warn?: (msg: string) => void): McpServerConfig | string {
  const w = warn ?? ((): void => {});
  if (!isRecord(entry)) return "must be an object";
  const type = entry["type"];
  if (type !== "local" && type !== "remote") return 'missing or unknown "type": want "local" or "remote"';
  let enabled: boolean | undefined;
  if (entry["enabled"] !== undefined) {
    if (typeof entry["enabled"] !== "boolean") {
      w(`"enabled" must be a boolean (falling back to default)`);
    } else {
      enabled = entry["enabled"];
    }
  }
  let timeout: number | undefined;
  if (entry["timeout"] !== undefined) {
    const t = asTimeout(entry["timeout"]);
    if (t === undefined) {
      w(`"timeout" must be a positive number of ms (falling back to default)`);
    } else {
      timeout = t;
    }
  }
  if (type === "local") {
    const command = entry["command"];
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      !command.every((c): c is string => typeof c === "string" && c.length > 0)
    ) {
      return 'need a non-empty "command" string array';
    }
    const cfg: McpLocalConfig = { type: "local", command: [...command] };
    if (entry["cwd"] !== undefined) {
      if (typeof entry["cwd"] !== "string" || entry["cwd"].length === 0) {
        return '"cwd" must be a non-empty string';
      }
      cfg.cwd = entry["cwd"];
    }
    if (entry["environment"] !== undefined) {
      const env = asStringMap(entry["environment"]);
      if (env === undefined) return '"environment" must be a string-to-string object';
      cfg.environment = env;
    }
    if (enabled !== undefined) cfg.enabled = enabled;
    if (timeout !== undefined) cfg.timeout = timeout;
    return cfg;
  }
  const url = entry["url"];
  if (typeof url !== "string" || !isHttpUrl(url)) return 'need a non-empty http(s) "url" string';
  const cfg: McpRemoteConfig = { type: "remote", url };
  if (entry["headers"] !== undefined) {
    const headers = asStringMap(entry["headers"]);
    if (headers === undefined) return '"headers" must be a string-to-string object';
    cfg.headers = headers;
  }
  if (entry["oauth"] !== undefined) {
    if (entry["oauth"] === false) {
      cfg.oauth = false;
    } else if (isRecord(entry["oauth"])) {
      const oauth = entry["oauth"] as Record<string, unknown>;
      const parsed: McpOAuthConfig = {};
      for (const key of ["clientId", "clientSecret", "scope"] as const) {
        const v = oauth[key];
        if (v === undefined) continue;
        if (typeof v !== "string" || v.length === 0) {
          return `"oauth.${key}" must be a non-empty string`;
        }
        parsed[key] = v;
      }
      cfg.oauth = parsed;
    } else {
      return '"oauth" must be an object or false';
    }
  }
  if (enabled !== undefined) cfg.enabled = enabled;
  if (timeout !== undefined) cfg.timeout = timeout;
  return cfg;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Model-visible tool naming: `<server>_<tool>` with every unsafe char
// folded to `_` (same rule as opencode's catalog). Sanitization is lossy by
// design, so the manager treats first-registration as winning and drops
// later collisions (including collisions with builtin names, which the
// registry guards separately).
export function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpToolName(server: string, tool: string): string {
  return `${sanitizeMcpName(server)}_${sanitizeMcpName(tool)}`;
}
