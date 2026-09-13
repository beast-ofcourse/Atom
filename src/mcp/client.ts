// Minimal MCP (Model Context Protocol) JSON-RPC client on node builtins
// only (tickets 01+02): stdio transport for local servers, StreamableHTTP
// (+ legacy SSE fallback) for remote servers. Speaks just enough of the
// protocol for tool use: initialize, tools/list (paginated), tools/call.
// OAuth (401 flows) is ticket 05 — a 401 surfaces as McpAuthNeeded so the
// manager can report needs_auth instead of a generic failure.
//
// Errors are thrown as Error with server/tool context; the manager converts
// them to model-visible `Error:` strings at the tool boundary, so nothing
// here ever formats user-facing output.

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_CLIENT_NAME = "atom";

export class McpError extends Error {}
export class McpAuthNeeded extends McpError {}
export class McpTimeout extends McpError {}

type JsonRpcId = number;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpTimeout(`${what} timed out after ${ms}ms`)), ms);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface McpTransport {
  request(method: string, params: Record<string, unknown> | undefined, timeout: number): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  close(): Promise<void>;
}

// --- stdio transport (local servers) ---

const MAX_STDIO_LINE_BYTES = 32 * 1024 * 1024;

export class StdioTransport implements McpTransport {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private buffer = "";
  private exited: { code: number | null } | null = null;
  private startError: Error | null = null;
  onExit: (() => void) | null = null;
  /** Fired for protocol notifications (messages without an id). */
  onNotification: ((method: string) => void) | null = null;

  constructor(
    private readonly command: string[],
    private readonly opts: { cwd: string; env: Record<string, string> }
  ) {}

  async start(): Promise<void> {
    const [cmd, ...args] = this.command;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      try {
        this.proc = spawn(cmd!, args, {
          cwd: this.opts.cwd,
          env: this.opts.env,
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.proc.on("error", (e) => {
        this.startError = e instanceof Error ? e : new Error(String(e));
        this.failAll(this.startError);
        done(() => reject(this.startError!));
      });
      this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
      this.proc.on("exit", (code) => {
        this.exited = { code };
        const remaining = [...this.pending.values()];
        this.pending.clear();
        for (const p of remaining) {
          clearTimeout(p.timer);
          p.reject(new McpError(`MCP server process exited (code ${code})`));
        }
        if (!settled) {
          settled = true;
          resolve(); // process may exit after serving; first request decides
        }
        this.onExit?.();
      });
      // Give spawn errors one tick to surface; a missing binary rejects here
      // instead of hanging the first request until its timeout.
      setImmediate(() => done(() => resolve()));
    });
    if (this.startError) throw this.startError;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > MAX_STDIO_LINE_BYTES + 1024) {
      this.failAll(new McpError("MCP server sent an overlong line (>32MB)"));
      this.buffer = "";
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray stdout chatter is ignored, not fatal
    }
    if (!isRecord(msg) || msg["jsonrpc"] !== "2.0") return;
    const id = msg["id"];
    if (typeof id !== "number" && typeof id !== "string") {
      // Server notification (e.g. notifications/tools/list_changed): route
      // to the hook; a throwing hook must never break the reader loop.
      if (typeof msg["method"] === "string") {
        try {
          this.onNotification?.(msg["method"] as string);
        } catch {
          // ignore hook failures
        }
      }
      return;
    }
    const p = this.pending.get(id as JsonRpcId);
    if (!p) return;
    this.pending.delete(id as JsonRpcId);
    clearTimeout(p.timer);
    if (isRecord(msg["error"])) {
      const e = msg["error"] as Record<string, unknown>;
      p.reject(new McpError(`MCP error ${String(e["code"] ?? "?")}: ${String(e["message"] ?? "unknown")}`));
      return;
    }
    p.resolve(msg["result"] ?? null);
  }

  private failAll(error: Error): void {
    const remaining = [...this.pending.values()];
    this.pending.clear();
    for (const p of remaining) {
      clearTimeout(p.timer);
      p.reject(error);
    }
  }

  request(method: string, params: Record<string, unknown> | undefined, timeout: number): Promise<unknown> {
    if (!this.proc || this.exited) {
      return Promise.reject(new McpError("MCP server process is not running"));
    }
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTimeout(`MCP request "${method}" timed out after ${timeout}ms`));
      }, timeout);
      if (typeof timer === "object" && "unref" in timer && typeof (timer as unknown as { unref?: unknown }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.proc!.stdin!.write(line, (e) => {
          if (e) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc || this.exited) return;
    try {
      // Callback form: write errors (EPIPE on a dying child) route to the
      // callback instead of surfacing as unhandled stream errors.
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, () => {});
    } catch {
      // notifications are best-effort by definition
    }
  }

  async close(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.failAll(new McpError("MCP transport closed"));
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      proc.once("exit", done);
      try {
        proc.kill();
      } catch {
        done();
        return;
      }
      setTimeout(done, 2000).unref?.();
    });
  }
}

// --- HTTP transport (remote servers): StreamableHTTP with SSE fallback ---

function parseSsePayloads(body: string): unknown[] {
  const out: unknown[] = [];
  for (const chunk of body.split("\n\n")) {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      try {
        out.push(JSON.parse(data));
      } catch {
        // keep scanning: a progress event we don't understand is not fatal
      }
    }
  }
  return out;
}

function pickResponse(payloads: unknown[], id: JsonRpcId): Record<string, unknown> | null {
  let fallback: Record<string, unknown> | null = null;
  for (const p of payloads) {
    if (!isRecord(p) || p["jsonrpc"] !== "2.0") continue;
    if (p["id"] === id) {
      if (isRecord(p["error"])) {
        const e = p["error"] as Record<string, unknown>;
        throw new McpError(`MCP error ${String(e["code"] ?? "?")}: ${String(e["message"] ?? "unknown")}`);
      }
      fallback = p; // last matching response wins (progress then result)
    }
  }
  return fallback;
}

export class HttpTransport implements McpTransport {
  private nextId = 1;
  private sessionId: string | undefined;
  private closed = false;
  /** Fired for protocol notifications arriving on the SSE stream. */
  onNotification: ((method: string) => void) | null = null;
  /** Fired when the SSE stream ends unexpectedly (not on close()). */
  onClose: (() => void) | null = null;
  // Legacy-SSE fallback state: persistent GET reader routing by id.
  private sseEndpoint: string | undefined;
  private ssePending = new Map<JsonRpcId, Pending>();
  private sseReader: Promise<void> | null = null;
  private sseStreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>
  ) {}

  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  async request(method: string, params: Record<string, unknown> | undefined, timeout: number): Promise<unknown> {
    if (this.closed) throw new McpError("MCP HTTP transport is closed");
    // Once the legacy-SSE endpoint is known, all traffic uses it.
    if (this.sseEndpoint) return this.requestViaSse(method, params, timeout);
    const id = this.nextId++;
    let res: Response;
    try {
      res = await withTimeout(
        fetch(this.url, {
          method: "POST",
          headers: this.baseHeaders(),
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
        }),
        timeout,
        `MCP request "${method}"`
      );
    } catch (e) {
      if (e instanceof McpTimeout || e instanceof McpAuthNeeded) throw e;
      throw new McpError(`MCP request "${method}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (res.status === 401) {
      // Drain so the socket can be reused, then report auth cleanly.
      try {
        await res.arrayBuffer();
      } catch {
        // ignore
      }
      throw new McpAuthNeeded(`MCP server requires authentication (HTTP 401 for "${method}")`);
    }
    if ((res.status === 404 || res.status === 405) && !this.sseEndpoint) {
      return this.requestViaSse(method, params, timeout, id);
    }
    if (!res.ok) {
      throw new McpError(`MCP request "${method}" failed: HTTP ${res.status}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    const body = await res.text();
    if (contentType.includes("text/event-stream")) {
      const picked = pickResponse(parseSsePayloads(body), id);
      if (!picked) throw new McpError(`MCP request "${method}" got no response object`);
      return picked["result"] ?? null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new McpError(`MCP request "${method}" returned non-JSON`);
    }
    if (!isRecord(parsed) || parsed["jsonrpc"] !== "2.0") {
      throw new McpError(`MCP request "${method}" returned a malformed envelope`);
    }
    if (isRecord(parsed["error"])) {
      const e = parsed["error"] as Record<string, unknown>;
      throw new McpError(`MCP error ${String(e["code"] ?? "?")}: ${String(e["message"] ?? "unknown")}`);
    }
    return parsed["result"] ?? null;
  }

  // Legacy SSE fallback: GET the event stream, learn the message endpoint,
  // POST there, route the reply off the still-open stream by id.
  private async requestViaSse(
    method: string,
    params: Record<string, unknown> | undefined,
    timeout: number,
    presetId?: JsonRpcId
  ): Promise<unknown> {
    await this.ensureSseEndpoint(timeout);
    const id = presetId ?? this.nextId++;
    const endpoint = this.sseEndpoint!;
    const pending = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ssePending.delete(id);
        reject(new McpTimeout(`MCP request "${method}" timed out after ${timeout}ms`));
      }, timeout);
      if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
      this.ssePending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
    // Guard: early exits below (401, transport errors, direct-JSON replies)
    // abandon this promise — without a handler its later timer rejection
    // would surface as an unhandled rejection. The caller still awaits the
    // original and observes its own outcome.
    pending.catch(() => {});
    let res: Response;
    try {
      res = await withTimeout(
        fetch(endpoint, {
          method: "POST",
          headers: this.baseHeaders(),
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
        }),
        timeout,
        `MCP request "${method}"`
      );
    } catch (e) {
      this.ssePending.delete(id);
      if (e instanceof McpTimeout || e instanceof McpAuthNeeded) throw e;
      throw new McpError(`MCP request "${method}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 401) {
      this.ssePending.delete(id);
      throw new McpAuthNeeded(`MCP server requires authentication (HTTP 401 for "${method}")`);
    }
    // A 4xx/5xx here is the server refusing the message (the stream will
    // carry no reply): fail fast instead of waiting out the full timeout.
    // 2xx (including empty 202 acknowledgements) still resolves on-stream.
    if (res.status >= 400) {
      const pending = this.ssePending.get(id);
      if (pending) {
        this.ssePending.delete(id);
        clearTimeout(pending.timer);
      }
      throw new McpError(`MCP request "${method}" failed: HTTP ${res.status}`);
    }
    // Some servers answer the POST directly with JSON — take it when valid.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const parsed: unknown = await res.json();
        if (isRecord(parsed) && parsed["id"] === id && parsed["jsonrpc"] === "2.0") {
          this.ssePending.delete(id);
          if (isRecord(parsed["error"])) {
            const e = parsed["error"] as Record<string, unknown>;
            throw new McpError(`MCP error ${String(e["code"] ?? "?")}: ${String(e["message"] ?? "unknown")}`);
          }
          return parsed["result"] ?? null;
        }
      } catch (e) {
        if (e instanceof McpError) throw e;
        // fall through to the stream-routed reply
      }
    } else {
      try {
        await res.arrayBuffer();
      } catch {
        // ignore
      }
    }
    return pending;
  }

  private async ensureSseEndpoint(timeout: number): Promise<void> {
    if (this.sseEndpoint) return;
    let res: Response;
    try {
      res = await withTimeout(
        fetch(this.url, { method: "GET", headers: { Accept: "text/event-stream", ...this.headers } }),
        timeout,
        "MCP SSE endpoint discovery"
      );
    } catch (e) {
      if (e instanceof McpTimeout) throw e;
      throw new McpError(`MCP SSE fallback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 401) throw new McpAuthNeeded("MCP server requires authentication (HTTP 401)");
    if (!res.ok || !res.body) {
      throw new McpError(`MCP server speaks neither StreamableHTTP nor SSE (HTTP ${res.status})`);
    }
    const endpointPromise = this.watchSseStream(res.body, timeout);
    this.sseEndpoint = await endpointPromise;
  }

  private async watchSseStream(body: ReadableStream<Uint8Array>, timeout: number): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + timeout;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        try {
          reader.cancel();
        } catch {
          // ignore
        }
        throw new McpTimeout("MCP SSE endpoint discovery timed out");
      }
      const chunk = await withTimeout(reader.read(), left, "MCP SSE endpoint discovery");
      if (chunk.done) throw new McpError("MCP SSE stream ended before advertising an endpoint");
      text += decoder.decode(chunk.value, { stream: true });
      const endpoint = extractSseEndpoint(text);
      if (endpoint) {
        this.sseReader = this.pumpSseReader(reader);
        return new URL(endpoint, this.url).toString();
      }
    }
  }

  private async pumpSseReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    this.sseStreamReader = reader;
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
        const events = text.split("\n\n");
        text = events.pop() ?? "";
        for (const event of events) {
          for (const line of event.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            let payload: unknown;
            try {
              payload = JSON.parse(trimmed.slice(5).trim());
            } catch {
              continue;
            }
            if (!isRecord(payload) || payload["jsonrpc"] !== "2.0") continue;
            if (typeof payload["id"] !== "number" && typeof payload["id"] !== "string") {
              if (typeof payload["method"] === "string") {
                try {
                  this.onNotification?.(payload["method"] as string);
                } catch {
                  // ignore hook failures
                }
              }
              continue;
            }
            const id = payload["id"] as JsonRpcId;
            const p = this.ssePending.get(id);
            if (!p) continue;
            this.ssePending.delete(id);
            clearTimeout(p.timer);
            if (isRecord(payload["error"])) {
              const e = payload["error"] as Record<string, unknown>;
              p.reject(new McpError(`MCP error ${String(e["code"] ?? "?")}: ${String(e["message"] ?? "unknown")}`));
            } else {
              p.resolve(payload["result"] ?? null);
            }
          }
        }
      }
    } catch {
      // stream errors fail pending requests below
    } finally {
      this.sseStreamReader = null;
      const remaining = [...this.ssePending.values()];
      this.ssePending.clear();
      for (const p of remaining) {
        clearTimeout(p.timer);
        p.reject(new McpError("MCP SSE stream closed"));
      }
      // Unexpected end (explicit close() sets closed first and skips this):
      // the manager treats it as a dropped connection.
      if (!this.closed) {
        try {
          this.onClose?.();
        } catch {
          // ignore hook failures
        }
      }
    }
  }

  notify(_method: string, _params: Record<string, unknown>): void {
    // Notifications over plain HTTP POSTs have no delivery channel worth
    // holding open; servers treat a missing `notifications/initialized` as
    // optional. Best-effort fire-and-forget.
    if (this.closed || this.sseEndpoint) return;
    void fetch(this.url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method: _method, params: _params }),
    }).catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    const remaining = [...this.ssePending.values()];
    this.ssePending.clear();
    for (const p of remaining) {
      clearTimeout(p.timer);
      p.reject(new McpError("MCP transport closed"));
    }
    // Break the pump out of its read: without this, close() waits forever
    // on servers that keep the event stream open.
    const reader = this.sseStreamReader;
    this.sseStreamReader = null;
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // already closed or cancelled
      }
    }
    if (this.sseReader) {
      await this.sseReader.catch(() => {});
      this.sseReader = null;
    }
  }
}

function extractSseEndpoint(text: string): string | null {
  for (const chunk of text.split("\n\n")) {
    let event = "";
    let data = "";
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("event:")) event = trimmed.slice(6).trim();
      else if (trimmed.startsWith("data:")) data += trimmed.slice(5).trim();
    }
    if (event === "endpoint" && data.length > 0) return data;
  }
  return null;
}

// --- protocol client over any transport ---

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type McpCallResult = {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
};

const MAX_LIST_PAGES = 100;

export class McpClient {
  constructor(private readonly transport: McpTransport) {}

  async connect(version: string = MCP_PROTOCOL_VERSION, timeout = 30_000): Promise<void> {
    await this.transport.request(
      "initialize",
      {
        protocolVersion: version,
        capabilities: { roots: {} },
        clientInfo: { name: MCP_CLIENT_NAME, version },
      },
      timeout
    );
    this.transport.notify("notifications/initialized", {});
  }

  async listTools(timeout: number): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params: Record<string, unknown> = {};
      if (cursor !== undefined) params["cursor"] = cursor;
      const result = (await this.transport.request("tools/list", params, timeout)) as unknown;
      if (!isRecord(result) || !Array.isArray(result["tools"])) {
        throw new McpError("MCP tools/list returned a malformed result");
      }
      for (const t of result["tools"] as unknown[]) {
        if (!isRecord(t) || typeof t["name"] !== "string") continue;
        tools.push({
          name: t["name"] as string,
          description: typeof t["description"] === "string" ? (t["description"] as string) : undefined,
          inputSchema: isRecord(t["inputSchema"]) ? (t["inputSchema"] as Record<string, unknown>) : {},
        });
      }
      const next = result["nextCursor"];
      if (typeof next !== "string") return tools;
      if (seen.has(next)) throw new McpError(`MCP tools/list returned duplicate cursor: ${next}`);
      seen.add(next);
      cursor = next;
    }
    throw new McpError(`MCP tools/list exceeded ${MAX_LIST_PAGES} pages`);
  }

  async callTool(name: string, args: Record<string, unknown>, timeout: number): Promise<McpCallResult> {
    const result = (await this.transport.request("tools/call", { name, arguments: args }, timeout)) as unknown;
    if (!isRecord(result) || !Array.isArray(result["content"])) {
      throw new McpError(`MCP tools/call "${name}" returned a malformed result`);
    }
    return {
      content: result["content"] as unknown[],
      isError: result["isError"] === true,
      structuredContent: result["structuredContent"],
    };
  }

  // Paginated `resources/list`, `resources/templates/list`, `prompts/list`.
  // A server without the capability answers with a method-not-found error,
  // which surfaces as McpError for the manager to interpret (never throws
  // across the tool boundary — the manager converts).
  private async listPaginated(listMethod: string, itemKey: string, timeout: number): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params: Record<string, unknown> = {};
      if (cursor !== undefined) params["cursor"] = cursor;
      const result = (await this.transport.request(listMethod, params, timeout)) as unknown;
      if (!isRecord(result) || !Array.isArray(result[itemKey])) {
        throw new McpError(`MCP ${listMethod} returned a malformed result`);
      }
      for (const item of result[itemKey] as unknown[]) {
        if (isRecord(item)) items.push(item);
      }
      const next = result["nextCursor"];
      if (typeof next !== "string") return items;
      if (seen.has(next)) throw new McpError(`MCP ${listMethod} returned duplicate cursor: ${next}`);
      seen.add(next);
      cursor = next;
    }
    throw new McpError(`MCP ${listMethod} exceeded ${MAX_LIST_PAGES} pages`);
  }

  async listResources(timeout: number): Promise<Record<string, unknown>[]> {
    return this.listPaginated("resources/list", "resources", timeout);
  }

  async listResourceTemplates(timeout: number): Promise<Record<string, unknown>[]> {
    return this.listPaginated("resources/templates/list", "resourceTemplates", timeout);
  }

  async readResource(uri: string, timeout: number): Promise<unknown[]> {
    const result = (await this.transport.request("resources/read", { uri }, timeout)) as unknown;
    if (!isRecord(result) || !Array.isArray(result["contents"])) {
      throw new McpError("MCP resources/read returned a malformed result");
    }
    return result["contents"] as unknown[];
  }

  async listPrompts(timeout: number): Promise<Record<string, unknown>[]> {
    return this.listPaginated("prompts/list", "prompts", timeout);
  }

  async getPrompt(name: string, args: Record<string, string>, timeout: number): Promise<unknown> {
    const params: Record<string, unknown> = { name };
    if (Object.keys(args).length > 0) params["arguments"] = args;
    const result = (await this.transport.request("prompts/get", params, timeout)) as unknown;
    if (!isRecord(result)) throw new McpError(`MCP prompts/get "${name}" returned a malformed result`);
    return result;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

export function resolveLocalCwd(cwd: string | undefined, baseDir: string): string {
  if (!cwd) return baseDir;
  return path.isAbsolute(cwd) ? cwd : path.resolve(baseDir, cwd);
}
