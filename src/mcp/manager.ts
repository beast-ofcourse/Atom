// MCP manager: server lifecycle, tool catalog, and the execution
// boundary (tickets 01+02). One singleton owns every MCP connection:
// config load (project cwd), concurrent connects, sanitized `<server>_<tool>`
// catalog, calls, and shutdown. Failures are per-server and never block
// other servers or startup.
//
// Boundary rules this module upholds:
// - Nothing here imports tools/registry (the registry imports us — never
//   the reverse, per tests/architecture.test.ts).
// - execute() NEVER throws: every failure becomes an `Error: ...` string.
// - validateArgs() mirrors the registry's detail-string contract; the
//   registry frames it with invalidCall.

import * as fs from "node:fs";
import * as path from "node:path";
import { loadAtomConfig, projectConfigPath } from "../config.js";
import {
  getEntryForUrl,
  isTokenExpired,
  loadAuthFile,
  removeEntry,
  saveAuthFile,
  setClientInfo,
  setTokens,
  type McpClientInfo,
  type McpTokens,
} from "./auth.js";
import { discoverEndpoints, refreshTokens, runOAuthFlow } from "./oauth.js";
import { appendOverflow } from "../tools/overflow.js";import { READ_CHAR_CAP, truncateHead } from "../tools/shared.js";
import {
  MCP_DEFAULT_TIMEOUT_MS,
  mcpToolName,
  type McpOAuthConfig,
  type McpRemoteConfig,
  type McpServerConfig,
} from "./config.js";
import {
  HttpTransport,
  McpAuthNeeded,
  McpClient,
  McpError,
  McpTimeout,
  MCP_PROTOCOL_VERSION,
  resolveLocalCwd,
  StdioTransport,
} from "./client.js";

export type McpStatus =
  | { status: "connected"; tools: number }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" };

export type McpToolEntry = {
  /** Model-visible sanitized name (`<server>_<tool>`). */
  name: string;
  /** Owning server, or "" for synthetic cross-server ops. */
  server: string;
  /** Native tool name ("" for synthetic ops). */
  tool: string;
  description: string;
  parameters: Record<string, unknown>;
  kind: "tool" | "resourceOp";
  op?: "list_resources" | "list_templates" | "read_resource" | "list_prompts" | "get_prompt";
};

type LiveServer = {
  config: McpServerConfig;
  client: McpClient | null;
  transport: StdioTransport | HttpTransport | null;
  status: McpStatus;
  timeout: number;
  /** Capability probes from refresh (ticket 04): false until proven. */
  caps: { resources: boolean; prompts: boolean };
};

const NO_CAPS = (): { resources: boolean; prompts: boolean } => ({ resources: false, prompts: false });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolParameters(inputSchema: Record<string, unknown>): Record<string, unknown> {
  return inputSchema["type"] === "object"
    ? inputSchema
    : { type: "object", properties: {}, additionalProperties: false as const };
}

function isRecordWithType(value: unknown, type: string): boolean {
  return isRecord(value) && value["type"] === type;
}

// Generic JSON-schema-lite validation against a cached inputSchema:
// required presence, property types, enums, and additionalProperties.
// Returns the registry-style detail string (without prefix) or null.
export function validateAgainstSchema(
  toolName: string,
  schema: Record<string, unknown>,
  args: Record<string, unknown>
): string | null {
  const props = isRecord(schema["properties"]) ? (schema["properties"] as Record<string, unknown>) : {};
  const summarize = (): string => {
    const parts = Object.entries(props).map(([k, v]) => {
      const t = isRecord(v) && typeof v["type"] === "string" ? (v["type"] as string) : "any";
      return `"${k}": ${t}`;
    });
    return `{${parts.join(", ")}}`;
  };
  const exp = summarize();
  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key !== "string") continue;
      if (args[key] === undefined) {
        return `missing required field "${key}" for tool "${toolName}". Expected ${exp}`;
      }
    }
  }
  for (const [key, propSchema] of Object.entries(props)) {
    const value = args[key];
    if (value === undefined || !isRecord(propSchema)) continue;
    const t = propSchema["type"];
    const ok =
      typeof t !== "string" ||
      (t === "string" && typeof value === "string") ||
      (t === "number" && typeof value === "number" && Number.isFinite(value)) ||
      (t === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (t === "boolean" && typeof value === "boolean") ||
      (t === "array" && Array.isArray(value)) ||
      (t === "object" && isRecord(value)) ||
      (t === "null" && value === null);
    if (!ok) {
      const want = typeof t === "string" ? t : "matching value";
      const got = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      return `field "${key}" for tool "${toolName}" must be a ${want} (got ${got}). Expected ${exp}`;
    }
    const en = propSchema["enum"];
    if (Array.isArray(en) && !en.includes(value)) {
      return `field "${key}" for tool "${toolName}" must be one of ${JSON.stringify(en)} (got ${JSON.stringify(value)}). Expected ${exp}`;
    }
  }
  if (schema["additionalProperties"] === false) {
    for (const key of Object.keys(args)) {
      if (!(key in props)) {
        return `unknown field "${key}" for tool "${toolName}". Expected ${exp}`;
      }
    }
  }
  return null;
}

export class McpManager {
  private servers = new Map<string, LiveServer>();
  private tools = new Map<string, McpToolEntry>();
  private refreshedFor: string | null = null;
  private refreshPromise: Promise<void> | null = null;

  /** Sync snapshot of model-visible MCP tool names (populated by refresh). */
  names(): string[] {
    return [...this.tools.keys()];
  }

  isMcpTool(name: string): boolean {
    return this.tools.has(name);
  }

  definitions(): McpToolEntry[] {
    return [...this.tools.values()];
  }

  status(): Record<string, McpStatus> {
    const out: Record<string, McpStatus> = {};
    for (const [name, s] of this.servers) out[name] = s.status;
    return out;
  }

  validateArgs(name: string, args: Record<string, unknown>): string | null {
    const entry = this.tools.get(name);
    if (!entry) return null;
    return validateAgainstSchema(name, entry.parameters, args);
  }

  /** Connect every configured server (concurrent, per-server isolation). */
  async refresh(cwd: string = process.cwd()): Promise<void> {
    if (this.refreshPromise && this.refreshedFor === cwd) {
      await this.refreshPromise;
      return;
    }
    this.refreshPromise = this.doRefresh(cwd).finally(() => {
      this.refreshPromise = null;
    });
    await this.refreshPromise;
  }

  /** Ensure the cache matches cwd; no-op when already fresh. */
  async ensureReady(cwd: string = process.cwd()): Promise<void> {
    if (this.refreshPromise) {
      // A refresh is already in flight (concurrent callers): join it first
      // so two refreshes never interleave and orphan each other's clients.
      await this.refreshPromise.catch(() => {});
    }
    if (this.refreshedFor === cwd) return;
    await this.refresh(cwd);
  }

  private async doRefresh(cwd: string): Promise<void> {
    await this.shutdown();
    this.refreshedFor = cwd;
    let servers: Record<string, McpServerConfig> = {};
    try {
      servers = loadAtomConfig(cwd).config.mcp ?? {};
    } catch {
      servers = {};
    }
    const entries = Object.entries(servers);
    // First registration wins across sanitized-name collisions (lossy
    // sanitization can fold two distinct tools together); losers are
    // dropped so the model never sees an ambiguous name.
    // Connections remain concurrent for latency, but tool registration
    // is deferred until all connections complete and then applied in
    // original entries order so the winner is deterministic.
    type PendingConnection = {
      name: string;
      config: McpServerConfig;
      timeout: number;
      transport: StdioTransport | HttpTransport | null;
      client: McpClient | null;
      defs: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
      caps: { resources: boolean; prompts: boolean };
      status: McpStatus;
    };
    const pending: PendingConnection[] = await Promise.all(
      entries.map(async ([name, config]): Promise<PendingConnection> => {
        const timeout = config.timeout ?? MCP_DEFAULT_TIMEOUT_MS;
        if (config.enabled === false) {
          return { name, config, timeout, transport: null, client: null, defs: [], caps: NO_CAPS(), status: { status: "disabled" } };
        }
        let transport: StdioTransport | HttpTransport | null = null;
        let phase = "starting";
        try {
          phase = "starting";
          transport =
            config.type === "local"
              ? await this.startLocal(config, cwd)
              : await this.startRemote(name, config, timeout);
          phase = "initialize";
          const client = new McpClient(transport);
          transport.onNotification = (method) => {
            if (method === "notifications/tools/list_changed") {
              void this.refreshServerTools(name).catch(() => {});
            }
          };
          if (!(transport instanceof StdioTransport)) {
            transport.onClose = () => {
              this.dropTransport(transport as HttpTransport, "MCP SSE stream closed");
            };
          }
          await client.connect(MCP_PROTOCOL_VERSION, timeout);
          phase = "tools/list";
          const defs = await client.listTools(timeout);
          // Capability probes (ticket 04): one cheap round-trip each; a
          // method-not-found error simply means "not supported".
          const caps = NO_CAPS();
          try {
            await client.listResources(timeout);
            caps.resources = true;
          } catch {
            caps.resources = false;
          }
          try {
            await client.listPrompts(timeout);
            caps.prompts = true;
          } catch {
            caps.prompts = false;
          }
          return { name, config, timeout, transport, client, defs, caps, status: { status: "connected", tools: 0 } };
        } catch (e) {
          if (transport) {
            try {
              await transport.close();
            } catch {
              // best-effort
            }
          }
          if (e instanceof McpAuthNeeded) {
            return { name, config, timeout, transport: null, client: null, defs: [], caps: NO_CAPS(), status: { status: "needs_auth" } };
          }
          // Name the phase on timeouts: the status map is keyed by server,
          // so "timed out while tools/list" plus the key says everything.
          const error =
            e instanceof McpTimeout ? `timed out while ${phase} after ${timeout}ms` : errorText(e);
          return {
            name,
            config,
            timeout,
            transport: null,
            client: null,
            defs: [],
            caps: NO_CAPS(),
            status: { status: "failed", error },
          };
        }
      })
    );
    const claimed = new Set<string>();
    for (const entry of pending) {
      if (entry.status.status === "disabled" || entry.status.status === "needs_auth" || entry.status.status === "failed") {
        this.servers.set(entry.name, { config: entry.config, client: null, transport: null, status: entry.status, timeout: entry.timeout, caps: entry.caps });
        continue;
      }
      let count = 0;
      for (const def of entry.defs) {
        const visible = mcpToolName(entry.name, def.name);
        if (claimed.has(visible)) {
          // Lossy sanitization can fold distinct tools to one name —
          // warn so misconfiguration is not silent.
          console.warn(`MCP: dropping tool "${entry.name}.${def.name}" — sanitized name "${visible}" already claimed`);
          continue;
        }
        claimed.add(visible);
        const parameters = toolParameters(def.inputSchema);
        this.tools.set(visible, {
          name: visible,
          server: entry.name,
          tool: def.name,
          description: def.description ?? "",
          parameters,
          kind: "tool",
        });
        count++;
      }
      this.servers.set(entry.name, { config: entry.config, client: entry.client, transport: entry.transport, status: { status: "connected", tools: count }, timeout: entry.timeout, caps: entry.caps });
    }
    // Synthetic cross-server resource tools (ticket 04): visible exactly
    // when at least one connected server proved resource support, so the
    // model never sees tools that can only error.
    if ([...this.servers.values()].some((s) => s.status.status === "connected" && s.caps.resources)) {
      for (const op of RESOURCE_OPS) {
        if (claimed.has(op.name)) {
          console.warn(`MCP: dropping synthetic tool "${op.name}" — name already claimed`);
          continue;
        }
        claimed.add(op.name);
        this.tools.set(op.name, {
          name: op.name,
          server: "",
          tool: "",
          description: op.description,
          parameters: op.parameters,
          kind: "resourceOp",
          op: op.op,
        });
      }
    }
    // Synthetic prompt tools (ticket 04 gap fix): same gate but for
    // prompts capability. Without this the model could never discover
    // prompts via tools.
    if ([...this.servers.values()].some((s) => s.status.status === "connected" && s.caps.prompts)) {
      for (const op of PROMPT_OPS) {
        if (claimed.has(op.name)) {
          console.warn(`MCP: dropping synthetic tool "${op.name}" — name already claimed`);
          continue;
        }
        claimed.add(op.name);
        this.tools.set(op.name, {
          name: op.name,
          server: "",
          tool: "",
          description: op.description,
          parameters: op.parameters,
          kind: "resourceOp",
          op: op.op,
        });
      }
    }
    this.installExitHook();
  }

  private supportError(kind: "resources" | "prompts", server?: string): string {
    const supporters = [...this.servers.entries()]
      .filter(([, s]) => s.status.status === "connected" && (kind === "resources" ? s.caps.resources : s.caps.prompts))
      .map(([name]) => name)
      .sort();
    const noun = kind === "resources" ? "resources" : "prompts";
    if (server) {
      return supporters.length > 0
        ? `Error: MCP server "${server}" does not support ${noun}. Servers with ${noun}: ${supporters.join(", ")}`
        : `Error: MCP server "${server}" does not support ${noun}. None of the connected servers support ${noun}.`;
    }
    return `Error: None of the connected servers support ${noun}.`;
  }

  private liveClient(server: string, kind: "resources" | "prompts"): { client: McpClient; timeout: number } {
    const live = this.servers.get(server);
    if (!live || !live.client || live.status.status !== "connected") {
      throw new McpError(`MCP server "${server}" is not connected`);
    }
    if (kind === "resources" ? !live.caps.resources : !live.caps.prompts) {
      throw new McpError(this.supportError(kind, server).slice("Error: ".length));
    }
    return { client: live.client, timeout: live.timeout };
  }

  /** List resources across supporting servers, optionally scoped to one. */
  async listResources(
    server?: string
  ): Promise<Array<{ server: string; resource: Record<string, unknown> }>> {
    const out: Array<{ server: string; resource: Record<string, unknown> }> = [];
    const targets = server
      ? [server]
      : [...this.servers.keys()].filter((n) => {
          const s = this.servers.get(n)!;
          return s.status.status === "connected" && s.caps.resources;
        });
    for (const name of targets) {
      const { client, timeout } = this.liveClient(name, "resources");
      for (const resource of await client.listResources(timeout)) {
        out.push({ server: name, resource });
      }
    }
    return out;
  }

  async listResourceTemplates(
    server?: string
  ): Promise<Array<{ server: string; template: Record<string, unknown> }>> {
    const out: Array<{ server: string; template: Record<string, unknown> }> = [];
    const targets = server
      ? [server]
      : [...this.servers.keys()].filter((n) => {
          const s = this.servers.get(n)!;
          return s.status.status === "connected" && s.caps.resources;
        });
    for (const name of targets) {
      const { client, timeout } = this.liveClient(name, "resources");
      for (const template of await client.listResourceTemplates(timeout)) {
        out.push({ server: name, template });
      }
    }
    return out;
  }

  /** Read one resource by exact URI. NEVER throws (formats failures). */
  async readResource(server: string, uri: string): Promise<string> {
    try {
      const { client, timeout } = this.liveClient(server, "resources");
      const contents = await client.readResource(uri, timeout);
      return formatResourceContents(uri, contents);
    } catch (e) {
      const msg = errorText(e);
      return msg.startsWith("Error: ") ? msg : `Error: ${msg}`;
    }
  }

  async listPrompts(server?: string): Promise<Array<{ server: string; prompt: Record<string, unknown> }>> {
    const out: Array<{ server: string; prompt: Record<string, unknown> }> = [];
    const targets = server
      ? [server]
      : [...this.servers.keys()].filter((n) => {
          const s = this.servers.get(n)!;
          return s.status.status === "connected" && s.caps.prompts;
        });
    for (const name of targets) {
      const { client, timeout } = this.liveClient(name, "prompts");
      for (const prompt of await client.listPrompts(timeout)) {
        out.push({ server: name, prompt });
      }
    }
    return out;
  }

  /** Fetch one prompt with string arguments. NEVER throws. */
  async getPrompt(server: string, name: string, args: Record<string, unknown>): Promise<string> {
    try {
      const { client, timeout } = this.liveClient(server, "prompts");
      const stringArgs: Record<string, string> = {};
      for (const [key, value] of Object.entries(args)) {
        if (typeof value !== "string") {
          return `Error: prompt argument "${key}" for prompt "${name}" must be a string`;
        }
        stringArgs[key] = value;
      }
      const result = await client.getPrompt(name, stringArgs, timeout);
      return formatPromptResult(name, result);
    } catch (e) {
      const msg = errorText(e);
      return msg.startsWith("Error: ") ? msg : `Error: ${msg}`;
    }
  }

  private async executeResourceOp(entry: McpToolEntry, args: Record<string, unknown>): Promise<string> {
    const server = optionalText(args["server"]);
    try {
      if (entry.op === "list_resources") {
        const items = await this.listResources(server);
        if (items.length === 0) return "MCP resources: none.";
        const lines = items.map(({ server: s, resource }) => {
          const uri = typeof resource["uri"] === "string" ? (resource["uri"] as string) : "(no uri)";
          const label =
            typeof resource["name"] === "string"
              ? (resource["name"] as string)
              : typeof resource["title"] === "string"
                ? (resource["title"] as string)
                : "";
          return `${s}: ${uri}${label ? ` — ${label}` : ""}`;
        });
        return `MCP resources (${items.length}):\n${lines.join("\n")}`;
      }
      if (entry.op === "list_templates") {
        const items = await this.listResourceTemplates(server);
        if (items.length === 0) return "MCP resource templates: none.";
        const lines = items.map(({ server: s, template }) => {
          const uri = typeof template["uriTemplate"] === "string" ? (template["uriTemplate"] as string) : "(no uriTemplate)";
          const label = typeof template["name"] === "string" ? (template["name"] as string) : "";
          return `${s}: ${uri}${label ? ` — ${label}` : ""}`;
        });
        return `MCP resource templates (${items.length}):\n${lines.join("\n")}`;
      }
      if (entry.op === "list_prompts") {
        const items = await this.listPrompts(server);
        if (items.length === 0) return "MCP prompts: none.";
        const lines = items.map(({ server: s, prompt }) => {
          const name = typeof prompt["name"] === "string" ? (prompt["name"] as string) : "(no name)";
          const desc = typeof prompt["description"] === "string" ? (prompt["description"] as string) : "";
          return `${s}: ${name}${desc ? ` — ${desc}` : ""}`;
        });
        return `MCP prompts (${items.length}):\n${lines.join("\n")}`;
      }
      if (entry.op === "get_prompt") {
        const promptServer = optionalText(args["server"]);
        const promptName = optionalText(args["name"]);
        if (!promptServer) return 'Error: field "server" for tool "get_mcp_prompt" must be a non-empty string';
        if (!promptName) return 'Error: field "name" for tool "get_mcp_prompt" must be a non-empty string';
        const promptArgs = isRecord(args["arguments"]) ? (args["arguments"] as Record<string, unknown>) : {};
        // Enforce string-valued arguments here so the error surfaces as a
        // model-visible validation message, not a silent truncation.
        for (const [k, v] of Object.entries(promptArgs)) {
          if (typeof v !== "string") {
            return `Error: prompt argument "${k}" for prompt "${promptName}" must be a string`;
          }
        }
        return await this.getPrompt(promptServer, promptName, promptArgs);
      }
      const readServer = optionalText(args["server"]);
      const uri = optionalText(args["uri"]);
      if (!readServer) return 'Error: field "server" for tool "read_mcp_resource" must be a non-empty string';
      if (!uri) return 'Error: field "uri" for tool "read_mcp_resource" must be a non-empty string';
      return await this.readResource(readServer, uri);
    } catch (e) {
      const msg = errorText(e);
      return msg.startsWith("Error: ") ? msg : `Error: ${msg}`;
    }
  }

  private async startLocal(
    config: McpServerConfig & { type: "local" },
    baseDir: string
  ): Promise<StdioTransport> {
    const cwd = resolveLocalCwd(config.cwd, baseDir);
    const transport = new StdioTransport(config.command, {
      cwd,
      env: { ...process.env, ...config.environment } as Record<string, string>,
    });
    transport.onExit = () => {
      this.dropTransport(transport, "MCP server process exited");
    };
    await transport.start();
    return transport;
  }

  /** Evict one server after a dropped connection: failed status plus tool withdrawal. */
  private dropTransport(transport: StdioTransport | HttpTransport, error: string): void {
    const key = this.findServerKey(transport);
    if (!key) return;
    const live = this.servers.get(key);
    if (!live || live.transport !== transport) return;
    live.client = null;
    live.transport = null;
    live.status = { status: "failed", error };
    for (const [toolName, entry] of this.tools) {
      if (entry.server === key) this.tools.delete(toolName);
    }
  }

  /**
   * Re-list one server's tools after a tools/list_changed notification.
   * Keeps the stale catalog on failure; a dead server surfaces via
   * onExit/onClose eviction instead, never here.
   */
  async refreshServerTools(name: string): Promise<void> {
    const live = this.servers.get(name);
    if (!live || !live.client || live.status.status !== "connected") return;
    try {
      const defs = await live.client.listTools(live.timeout);
      for (const [toolName, entry] of [...this.tools]) {
        if (entry.server === name) this.tools.delete(toolName);
      }
      const claimed = new Set([...this.tools.keys()]);
      let count = 0;
      for (const def of defs) {
        const visible = mcpToolName(name, def.name);
        if (claimed.has(visible)) {
          console.warn(`MCP: dropping tool "${name}.${def.name}" — sanitized name "${visible}" already claimed`);
          continue;
        }
        claimed.add(visible);
        this.tools.set(visible, {
          name: visible,
          server: name,
          tool: def.name,
          description: def.description ?? "",
          parameters: toolParameters(def.inputSchema),
          kind: "tool",
        });
        count++;
      }
      live.status = { status: "connected", tools: count };
    } catch {
      // keep the stale catalog; eviction handles dead servers
    }
  }

  private findServerKey(transport: StdioTransport | HttpTransport): string | null {
    for (const [key, live] of this.servers) {
      if (live.transport === transport) return key;
    }
    return null;
  }

  /** Execute one cached MCP tool. NEVER throws — see module header. */
  async execute(name: string, args: Record<string, unknown>, cwd: string = process.cwd()): Promise<string> {
    try {
      await this.ensureReady(cwd);
    } catch (e) {
      return `Error: ${errorText(e)}`;
    }
    const entry = this.tools.get(name);
    if (!entry) {
      return `Error: unknown tool "${name}". Available: ${this.catalogHint()}`;
    }
    // Synthetic cross-server ops carry no owning server (server: "") — they
    // resolve their targets themselves, so they must branch before the
    // single-server connection check below.
    if (entry.kind === "resourceOp") return this.executeResourceOp(entry, args);
    const live = this.servers.get(entry.server);
    if (!live || !live.client) {
      const status = live?.status;
      if (status?.status === "needs_auth") {
        return `Error: MCP server "${entry.server}" needs authentication — run atom --mcp-auth ${entry.server}`;
      }
      return `Error: MCP server "${entry.server}" is not connected`;
    }
    try {
      const result = await live.client.callTool(entry.tool, args, live.timeout);
      return formatCallResult(name, result.content, result.isError === true, result.structuredContent);
    } catch (e) {
      if (e instanceof McpTimeout) {
        return `Error: MCP tool "${name}" on server "${entry.server}" timed out after ${live.timeout}ms`;
      }
      return `Error: ${errorText(e)}`;
    }
  }

  private catalogHint(): string {
    const names = this.names();
    return names.length > 0 ? names.join(", ") : "(no MCP tools connected)";
  }

  /** Best-effort shutdown of every spawned server process. */
  async shutdown(): Promise<void> {
    const live = [...this.servers.values()];
    this.servers.clear();
    this.tools.clear();
    await Promise.all(
      live.map(async (s) => {
        try {
          await s.client?.close();
        } catch {
          // shutdown is best-effort by definition
        }
      })
    );
  }

  /** Test seam: shutdown + forget every cached value. */
  async resetForTests(): Promise<void> {
    await this.shutdown();
    this.refreshedFor = null;
  }

  /**
   * Build an HTTP transport for a remote server, attaching a stored OAuth
   * Bearer token when one is valid (refreshing inline when expired and a
   * refresh token exists). Auth-store or refresh failures never block the
   * plain connection attempt — the server's 401 then maps to needs_auth.
   */
  private async startRemote(
    name: string,
    config: McpRemoteConfig,
    timeout: number
  ): Promise<HttpTransport> {
    const headers = { ...(config.headers ?? {}) };
    if (config.oauth !== false) {
      try {
        const file = loadAuthFile();
        const entry = getEntryForUrl(file, name, config.url);
        let tokens = entry?.tokens;
        if (tokens && isTokenExpired(tokens)) {
          tokens = await this.tryRefresh(name, config, entry?.clientInfo, tokens, headers, timeout);
        }
        if (tokens && !isTokenExpired(tokens)) {
          headers["Authorization"] = `Bearer ${tokens.accessToken}`;
        }
      } catch {
        // Fall through to the unauthenticated attempt.
      }
    }
    return new HttpTransport(config.url, headers);
  }

  private async tryRefresh(
    name: string,
    config: McpRemoteConfig,
    stored: McpClientInfo | undefined,
    tokens: McpTokens,
    headers: Record<string, string>,
    timeout: number
  ): Promise<McpTokens | undefined> {
    if (!tokens.refreshToken) return undefined;
    const configured: McpOAuthConfig = typeof config.oauth === "object" ? config.oauth : {};
    const client: McpClientInfo | undefined =
      stored ??
      (configured.clientId
        ? {
            clientId: configured.clientId,
            ...(configured.clientSecret ? { clientSecret: configured.clientSecret } : {}),
          }
        : undefined);
    if (!client) return undefined;
    const { endpoints } = await discoverEndpoints(config.url, headers, timeout);
    const fresh = await refreshTokens(
      endpoints.tokenEndpoint,
      client,
      tokens.refreshToken,
      tokens.scope ?? configured.scope,
      timeout
    );
    const file = loadAuthFile();
    setTokens(file, name, fresh, config.url);
    saveAuthFile(file);
    return fresh;
  }

  /** TUI/CLI-facing auth state for one server (tickets 05/06). */
  getAuthStatus(name: string, cwd?: string): "authenticated" | "expired" | "not_authenticated" {
    const dir = cwd ?? this.refreshedFor ?? process.cwd();
    let raw: McpServerConfig | undefined;
    try {
      raw = loadAtomConfig(dir).config.mcp?.[name];
    } catch {
      return "not_authenticated";
    }
    if (!raw || raw.type !== "remote" || raw.oauth === false) return "not_authenticated";
    const entry = getEntryForUrl(loadAuthFile(), name, raw.url);
    if (!entry?.tokens) return "not_authenticated";
    return isTokenExpired(entry.tokens) ? "expired" : "authenticated";
  }

  /**
   * Run the browser OAuth flow for a remote server, persist credentials,
   * and reconnect. NEVER throws: failures return failed status.
   */
  async authenticate(
    name: string,
    opts?: { onRedirect?: (url: string) => void; openBrowser?: boolean; callbackTimeoutMs?: number; cwd?: string }
  ): Promise<McpStatus> {
    const cwd = opts?.cwd ?? this.refreshedFor ?? process.cwd();
    let raw: McpServerConfig | undefined;
    try {
      raw = loadAtomConfig(cwd).config.mcp?.[name];
    } catch (e) {
      return { status: "failed", error: errorText(e) };
    }
    if (!raw) return { status: "failed", error: `MCP server not found: ${name}` };
    if (raw.type !== "remote") return { status: "failed", error: `MCP server "${name}" is not a remote server` };
    if (raw.oauth === false) return { status: "failed", error: `MCP server "${name}" has OAuth disabled` };
    const timeout = raw.timeout ?? MCP_DEFAULT_TIMEOUT_MS;
    const oauthCfg: McpOAuthConfig = typeof raw.oauth === "object" ? raw.oauth : {};
    try {
      const file = loadAuthFile();
      const entry = getEntryForUrl(file, name, raw.url);
      const { tokens, clientInfo } = await runOAuthFlow({
        serverName: name,
        serverUrl: raw.url,
        headers: raw.headers ?? {},
        oauth: oauthCfg,
        storedClient: entry?.clientInfo,
        timeout,
        callbackTimeoutMs: opts?.callbackTimeoutMs,
        onRedirect: opts?.onRedirect,
        openBrowser: opts?.openBrowser,
      });
      const next = loadAuthFile();
      setTokens(next, name, tokens, raw.url);
      if (clientInfo) setClientInfo(next, name, clientInfo, raw.url);
      saveAuthFile(next);
    } catch (e) {
      return { status: "failed", error: `OAuth failed: ${errorText(e)}` };
    }
    await this.refresh(cwd);
    return this.servers.get(name)?.status ?? { status: "failed", error: "reconnect failed" };
  }

  /** Drop stored credentials for one server. Returns true when any existed. */
  async removeAuth(name: string): Promise<boolean> {
    try {
      const file = loadAuthFile();
      const removed = removeEntry(file, name);
      if (removed) saveAuthFile(file);
      return removed;
    } catch {
      return false;
    }
  }

  /**
   * Persist an enable/disable toggle for one server and reconnect.
   * Writes a project-level atom.json override carrying the server's full
   * effective entry (so global-defined servers toggle without losing their
   * config). atom.json is strict JSON — no comments exist to preserve.
   * Returns the fresh status, or null when the server is unknown or the
   * file cannot be written.
   */
  async setServerEnabled(name: string, enabled: boolean, projectDir?: string): Promise<McpStatus | null> {
    const cwd = projectDir ?? this.refreshedFor ?? process.cwd();
    let effective: McpServerConfig | undefined;
    try {
      effective = loadAtomConfig(cwd).config.mcp?.[name];
    } catch {
      return null;
    }
    if (!effective) return null;
    try {
      const file = projectConfigPath(cwd);
      let doc: Record<string, unknown> = {};
      let haveFile = false;
      try {
        const raw = fs.readFileSync(file, "utf8");
        haveFile = true;
        const parsed: unknown = JSON.parse(raw);
        // Refuse to clobber: an existing but invalid project config keeps
        // failing loudly at load time instead of being silently replaced.
        if (!isRecord(parsed)) return null;
        doc = parsed;
      } catch {
        if (haveFile) return null;
        doc = {};
      }
      const mcp = isRecord(doc["mcp"]) ? { ...(doc["mcp"] as Record<string, unknown>) } : {};
      const sanitized = { ...effective, enabled } as Record<string, unknown>;
      if (isRecord(sanitized["headers"])) {
        const headers = { ...(sanitized["headers"] as Record<string, unknown>) };
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "authorization") delete headers[key];
        }
        if (Object.keys(headers).length === 0) delete sanitized["headers"];
        else sanitized["headers"] = headers;
      }
      if (isRecord(sanitized["oauth"])) {
        const oauth = { ...(sanitized["oauth"] as Record<string, unknown>) };
        delete oauth["clientSecret"];
        if (Object.keys(oauth).length === 0) delete sanitized["oauth"];
        else sanitized["oauth"] = oauth;
      }
      mcp[name] = sanitized;
      doc["mcp"] = mcp;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    } catch {
      return null;
    }
    await this.refresh(cwd);
    return this.servers.get(name)?.status ?? null;
  }

  private installExitHook(): void {
    // Module-level once: every manager instance (including per-test ones)
    // shares the single process hook instead of stacking listeners.
    if (mcpExitHookInstalled) return;
    mcpExitHookInstalled = true;
    // Synchronous kill only: the event loop is draining, so async close()
    // cannot run. Best-effort — orphans are still possible on SIGKILL.
    process.on("exit", () => {
      for (const live of this.servers.values()) {
        const t = live.transport;
        if (t && t instanceof StdioTransport) {
          const pid = t.pid;
          if (typeof pid === "number") {
            try {
              process.kill(pid);
            } catch {
              // already gone
            }
          }
        }
      }
    });
  }
}

function formatCallResult(name: string, content: unknown[], isError: boolean, structured: unknown): string {
  const texts: string[] = [];
  let nonText = 0;
  for (const item of content) {
    if (isRecordWithType(item, "text") && typeof (item as Record<string, unknown>)["text"] === "string") {
      const text = (item as Record<string, unknown>)["text"] as string;
      if (text.trim().length > 0) texts.push(text);
    } else {
      nonText++;
    }
  }
  if (texts.length === 0 && structured !== undefined && structured !== null) {
    try {
      texts.push(JSON.stringify(structured));
    } catch {
      // fall through to the omission note
    }
  }
  if (texts.length === 0) {
    return nonText > 0
      ? `[MCP tool returned ${nonText} non-text content item(s) with no text]`
      : "[MCP tool returned no content]";
  }
  let body = texts.join("\n\n");
  if (nonText > 0) body += `\n\n[${nonText} non-text content item(s) omitted]`;
  if (isError) body = `Error: ${body}`;
  // Same truncation idiom as every other tool: 64KB head plus a followable
  // overflow pointer, so a runaway server can never blow the context.
  if (body.length > READ_CHAR_CAP) {
    const t = truncateHead(body, READ_CHAR_CAP, `\n[truncated: mcp ${name} output exceeded 64KB]`);
    return appendOverflow(t.head, t.note, `mcp ${name} output`, body);
  }
  return body;
}

const PROMPT_OPS: Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  op: "list_prompts" | "get_prompt";
}> = [
  {
    name: "list_mcp_prompts",
    description:
      "List prompts offered by connected MCP servers. " +
      "Pass server to scope to one server; otherwise lists everywhere.",
    parameters: {
      type: "object",
      properties: { server: { type: "string", description: "MCP server name to scope the listing." } },
      additionalProperties: false,
    },
    op: "list_prompts",
  },
  {
    name: "get_mcp_prompt",
    description:
      "Fetch one MCP prompt by name from a server, optionally with string arguments. " +
      "Use list_mcp_prompts to discover available prompts.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name, exactly as listed." },
        name: { type: "string", description: "Prompt name, exactly as listed." },
        arguments: {
          type: "object",
          description: "Prompt arguments (string values only).",
          additionalProperties: { type: "string" },
        },
      },
      required: ["server", "name"],
      additionalProperties: false,
    },
    op: "get_prompt",
  },
];

const RESOURCE_OPS: Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  op: "list_resources" | "list_templates" | "read_resource";
}> = [
  {
    name: "list_mcp_resources",
    description:
      "List resources (files, schemas, app context) offered by connected MCP servers. " +
      "Pass server to scope to one server; otherwise lists everywhere.",
    parameters: {
      type: "object",
      properties: { server: { type: "string", description: "MCP server name to scope the listing." } },
      additionalProperties: false,
    },
    op: "list_resources",
  },
  {
    name: "list_mcp_resource_templates",
    description:
      "List parameterized resource templates offered by connected MCP servers. " +
      "Fill a template's URI to read it with read_mcp_resource.",
    parameters: {
      type: "object",
      properties: { server: { type: "string", description: "MCP server name to scope the listing." } },
      additionalProperties: false,
    },
    op: "list_templates",
  },
  {
    name: "read_mcp_resource",
    description:
      "Read one MCP resource by its exact URI from list_mcp_resources. " +
      "The URI is an opaque server identifier, not necessarily a file path or URL.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name, exactly as listed." },
        uri: { type: "string", description: "Exact resource URI from list_mcp_resources." },
      },
      required: ["server", "uri"],
      additionalProperties: false,
    },
    op: "read_resource",
  },
];

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}

function base64Size(value: string): number {
  const trimmed = value.replace(/\s/g, "");
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${Math.ceil(value / (1024 * 1024))} MB`;
}

function truncateMcpOutput(label: string, body: string): string {
  if (body.length <= READ_CHAR_CAP) return body;
  const t = truncateHead(body, READ_CHAR_CAP, `\n[truncated: ${label} exceeded 64KB]`);
  return appendOverflow(t.head, t.note, label, body);
}

function formatResourceContents(uri: string, contents: unknown[]): string {
  const parts: string[] = [];
  for (const item of contents) {
    if (!isRecord(item)) continue;
    const itemUri = typeof item["uri"] === "string" ? (item["uri"] as string) : uri;
    const mime = typeof item["mimeType"] === "string" ? (item["mimeType"] as string) : "application/octet-stream";
    if (typeof item["text"] === "string") {
      parts.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item["text"] as string}`);
      continue;
    }
    if (typeof item["blob"] === "string") {
      const size = base64Size(item["blob"] as string);
      parts.push(
        `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not readable as text]`
      );
      continue;
    }
    parts.push(`[MCP resource item without text or blob: ${itemUri}]`);
  }
  const body = parts.join("\n\n") || `MCP resource ${uri} returned no contents.`;
  return truncateMcpOutput("mcp resource output", body);
}

function formatPromptResult(name: string, result: unknown): string {
  if (!isRecord(result)) return `Error: MCP prompt "${name}" returned a malformed result`;
  const lines: string[] = [];
  if (typeof result["description"] === "string" && (result["description"] as string).length > 0) {
    lines.push(result["description"] as string);
  }
  const messages = result["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      const role = typeof message["role"] === "string" ? (message["role"] as string) : "unknown";
      const content = message["content"];
      const texts: string[] = [];
      const items = Array.isArray(content) ? content : [content];
      for (const item of items) {
        if (isRecord(item) && item["type"] === "text" && typeof item["text"] === "string") {
          texts.push(item["text"] as string);
        }
      }
      if (texts.length > 0) lines.push(`${role}: ${texts.join("\n")}`);
    }
  }
  const body = lines.join("\n\n") || `MCP prompt "${name}" returned no messages.`;
  return truncateMcpOutput("mcp prompt output", body);
}

export const mcpManager = new McpManager();

let mcpExitHookInstalled = false;

// Registry-facing module functions (the registry imports these — never the
// reverse). All synchronous snapshots except refresh/execute.
export function mcpNames(): string[] {
  return mcpManager.names();
}

export function isMcpToolName(name: string): boolean {
  return mcpManager.isMcpTool(name);
}

export function mcpDefinitions(): McpToolEntry[] {
  return mcpManager.definitions();
}

export function mcpValidateArgs(name: string, args: Record<string, unknown>): string | null {
  return mcpManager.validateArgs(name, args);
}

export function mcpStatus(): Record<string, McpStatus> {
  return mcpManager.status();
}

export function refreshMcpTools(cwd?: string): Promise<void> {
  return mcpManager.refresh(cwd);
}

export function mcpExecute(name: string, args: Record<string, unknown>, cwd?: string): Promise<string> {
  return mcpManager.execute(name, args, cwd);
}

export function shutdownMcp(): Promise<void> {
  return mcpManager.shutdown();
}

export function mcpAuthenticate(
  name: string,
  opts?: { onRedirect?: (url: string) => void; openBrowser?: boolean; callbackTimeoutMs?: number; cwd?: string }
): Promise<McpStatus> {
  return mcpManager.authenticate(name, opts);
}

export function mcpRemoveAuth(name: string): Promise<boolean> {
  return mcpManager.removeAuth(name);
}

export function mcpAuthStatus(name: string, cwd?: string): "authenticated" | "expired" | "not_authenticated" {
  return mcpManager.getAuthStatus(name, cwd);
}

export function mcpSetServerEnabled(name: string, enabled: boolean, projectDir?: string): Promise<McpStatus | null> {
  return mcpManager.setServerEnabled(name, enabled, projectDir);
}
