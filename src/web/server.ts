// ATOM WebUI server: a local frontend for the existing ATOM runtime.
//
// Design (same posture as src/telemetry-server.ts):
// - `node:http` + `node:fs` builtins only. No new dependencies.
// - Loopback-only by default (`127.0.0.1`); never binds a LAN interface
//   unless explicitly asked (`host` option).
// - Serves the dependency-free frontend (src/web/ui, copied to dist/web/ui
//   by scripts/copy-web-ui.mjs) plus a JSON API over the WebRuntime.
// - Every handler is guarded — a bad request or a failing store yields a
//   status code, never a crash. Responses carry `Cache-Control: no-store`
//   on API routes (the static UI is immutable per version and may cache).
// - Realtime is SSE per session (GET /api/sessions/:id/events): the runtime
//   fans out turn events; the server frames them (see src/web/events.ts),
//   replays missed events via Last-Event-ID, and heartbeats idle streams.
//
// Routes:
// - GET /, /app.js, /styles.css → frontend
// - GET /api/health → {ok, service, version, sessions}
// - GET /api/providers → provider catalog (hasKey booleans only —
//   keys/secrets never cross the API)
// - GET /api/tools → tool catalog (name, description, needsApproval)
// - GET /api/sessions → session summaries (most recent first)
// - POST /api/sessions → create ({title?, provider?, model?, effort?, mode?})
// - GET /api/sessions/:id → full record + busy + pending approval/question
// - PATCH /api/sessions/:id → settings ({provider?, model?, effort?, mode?,
//   title?}; 409 while busy)
// - POST /api/sessions/:id/messages → start a turn ({content, ...overrides});
//   202 accepted; 400 validation/start failure; 404 unknown; 409 busy
// - GET /api/sessions/:id/events → SSE stream (replay + heartbeat)
// - POST /api/sessions/:id/cancel → {cancelled}
// - POST /api/sessions/:id/approve → {resolved} ({id, decision})
// - POST /api/sessions/:id/answer → {resolved} ({id, answer})
// - anything else → 404; wrong method on a known route → 405.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatSSE, sseHeartbeat, type WebEvent } from "./events.js";
import { validateSendBody, WebRuntime } from "./runtime.js";
import type { ProviderId } from "../providers.js";
import type { ApprovalDecision, PermissionMode, ReasoningEffort } from "../zen.js";
import type { Session } from "../sessions.js";

export const WEB_SERVER_DEFAULT_HOST = "127.0.0.1";
export const WEB_SERVER_DEFAULT_PORT = 0;
export const WEB_SERVER_PORT_ENV = "ATOM_WEB_PORT";
export const WEB_SERVICE = "atom-web";
export const WEB_VERSION = 1;
const HEARTBEAT_MS = 15_000;
const BODY_CAP_BYTES = 1_000_000;

export type WebServerOptions = {
  home?: string;
  host?: string;
  port?: number;
  runtime?: WebRuntime;
};

export type WebServer = {
  url: string;
  host: string;
  port: number;
  runtime: WebRuntime;
  close: () => Promise<void>;
};

export function parseWebPort(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

export function resolveWebPort(env: NodeJS.ProcessEnv = process.env, cliValue?: unknown): number {
  return (
    parseWebPort(cliValue) ??
    parseWebPort(env[WEB_SERVER_PORT_ENV]) ??
    WEB_SERVER_DEFAULT_PORT
  );
}

// UI directory: the compiled server lives in dist/web/, the UI beside it at
// dist/web/ui/ (see scripts/copy-web-ui.mjs); under tsx/vitest it is
// src/web/ui/. Probe the adjacent dir first, then the caller's checkout.
function resolveUiDir(): string | null {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, "ui"));
  } catch {
    // import.meta.url unavailable — fall through to the checkout probe
  }
  candidates.push(path.join(process.cwd(), "src", "web", "ui"));
  for (const dir of candidates) {
    try {
      if (existsSync(path.join(dir, "index.html"))) return dir;
    } catch {
      // probe next
    }
  }
  return null;
}

const UI_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  } catch {
    try {
      res.end();
    } catch {
      // never throw out of a handler
    }
  }
}

function readJsonBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > BODY_CAP_BYTES) {
        failed = true;
        resolve({ ok: false as const, error: "request body too large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({ ok: true as const, body: {} });
        return;
      }
      try {
        resolve({ ok: true as const, body: JSON.parse(text) });
      } catch {
        resolve({ ok: false as const, error: "body must be valid JSON" });
      }
    });
    req.on("error", () => resolve({ ok: false as const, error: "failed to read request body" }));
  });
}

// Summaries stay light: histories ride the item route only, so listing
// hundreds of sessions never dumps megabytes of transcripts.
function sessionSummary(s: Session): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    cwd: s.cwd,
    provider: s.provider,
    model: s.model,
    effort: s.effort,
    mode: s.mode,
    turnCount: s.turns.length,
  };
}

const SESSION_ID_RE = /^[A-Za-z0-9_.-]+$/;

function isSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && SESSION_ID_RE.test(id);
}

export function startWebServer(opts: WebServerOptions = {}): Promise<WebServer> {
  const host =
    typeof opts.host === "string" && opts.host.length > 0 ? opts.host : WEB_SERVER_DEFAULT_HOST;
  const port =
    typeof opts.port === "number" && Number.isSafeInteger(opts.port) && opts.port >= 0 && opts.port <= 65535
      ? opts.port
      : WEB_SERVER_DEFAULT_PORT;
  const runtime = opts.runtime ?? new WebRuntime(opts.home);
  const uiDir = resolveUiDir();

  function serveUiFile(res: ServerResponse, name: string): void {
    try {
      if (!uiDir) {
        sendJson(res, 500, { error: "frontend assets unavailable" });
        return;
      }
      const file = name === "/" ? "index.html" : name.slice(1);
      if (file.includes("..") || file.includes("\\") || !/^(index\.html|app\.js|styles\.css)$/.test(file)) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const full = path.join(uiDir, file);
      let raw: Buffer;
      try {
        raw = readFileSync(full);
      } catch {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const ext = path.extname(file);
      res.writeHead(200, {
        "Content-Type": UI_CONTENT_TYPES[ext] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": raw.length,
      });
      res.end(raw);
    } catch {
      sendJson(res, 500, { error: "internal error" });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET";
      let pathname = "/";
      try {
        pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        sendJson(res, 400, { error: "bad request" });
        return;
      }

      // Static frontend.
      if ((pathname === "/" || pathname === "/app.js" || pathname === "/styles.css") && method === "GET") {
        serveUiFile(res, pathname);
        return;
      }

      // Session SSE stream (headers + replay + heartbeat + cleanup).
      const eventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (eventsMatch) {
        const id = decodeURIComponent(eventsMatch[1] ?? "");
        if (!isSessionId(id) || !runtime.getSessionRecord(id)) {
          sendJson(res, 404, { error: "session not found" });
          return;
        }
        if (method !== "GET") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        let lastEventId: number | undefined;
        try {
          const rawHeader = req.headers["last-event-id"];
          const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
          if (typeof raw === "string" && raw.trim().length > 0) {
            const n = Number(raw.trim());
            if (Number.isFinite(n)) lastEventId = Math.floor(n);
          }
        } catch {
          lastEventId = undefined;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          Connection: "keep-alive",
        });
        const write = (frame: string): boolean => {
          try {
            return res.write(frame);
          } catch {
            return false;
          }
        };
        const onEvent = (event: WebEvent): void => {
          write(formatSSE(event));
        };
        let unsubscribe: (() => void) | null = null;
        try {
          unsubscribe = runtime.subscribe(id, onEvent, lastEventId);
        } catch {
          sendJson(res, 404, { error: "session not found" });
          return;
        }
        const heartbeat = setInterval(() => {
          if (!write(sseHeartbeat())) {
            try {
              clearInterval(heartbeat);
            } catch {
              // ignore
            }
          }
        }, HEARTBEAT_MS);
        try {
          (heartbeat as unknown as { unref?: () => void }).unref?.();
        } catch {
          // ignore
        }
        const cleanup = () => {
          try {
            clearInterval(heartbeat);
          } catch {
            // ignore
          }
          try {
            unsubscribe?.();
          } catch {
            // ignore
          }
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
        return;
      }

      // Session item routes.
      const itemMatch = pathname.match(/^\/api\/sessions\/([^/]+)(\/[^/]+)?$/);
      if (itemMatch) {
        const id = decodeURIComponent(itemMatch[1] ?? "");
        const suffix = itemMatch[2] ?? "";
        if (!isSessionId(id)) {
          sendJson(res, 404, { error: "session not found" });
          return;
        }
        // GET /api/sessions/:id (live view: persisted identity + in-memory
        // turn state, so a fresh client sees the running turn too)
        if (suffix === "" && method === "GET") {
          const live = runtime.getLiveSession(id);
          if (!live) {
            sendJson(res, 404, { error: "session not found" });
            return;
          }
          sendJson(res, 200, live);
          return;
        }
        // PATCH /api/sessions/:id
        if (suffix === "" && method === "PATCH") {
          if (runtime.isBusy(id)) {
            sendJson(res, 409, { error: "session is busy (another turn is running)" });
            return;
          }
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const updated = runtime.updateWebSession(id, (parsed.body ?? {}) as never);
          if (!updated) {
            sendJson(res, 404, { error: "session not found" });
            return;
          }
          sendJson(res, 200, updated);
          return;
        }
        // POST /api/sessions/:id/messages
        if (suffix === "/messages" && method === "POST") {
          const record = runtime.getSessionRecord(id);
          if (!record) {
            sendJson(res, 404, { error: "session not found" });
            return;
          }
          if (runtime.isBusy(id)) {
            sendJson(res, 409, { error: "session is busy (another turn is running)" });
            return;
          }
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const problem = validateSendBody(parsed.body);
          if (problem) {
            sendJson(res, 400, { error: problem });
            return;
          }
          const body = parsed.body as {
            content: string;
            provider?: unknown;
            model?: unknown;
            effort?: unknown;
            mode?: unknown;
          };
          const turnOpts = {
            provider: body["provider"] as ProviderId | undefined,
            model: typeof body["model"] === "string" ? body["model"] : undefined,
            effort: body["effort"] as ReasoningEffort | undefined,
            mode: body["mode"] as PermissionMode | undefined,
          };
          try {
            // Synchronous start-gate (validateTurnStart is await-free, so it
            // throws instead of rejecting — the only honest 400/409 source).
            runtime.validateTurnStart(id, body.content, turnOpts);
          } catch (e) {
            // Start failures only (unknown session, busy, validation, missing
            // key): the turn never started, so 400/409 is honest.
            const message = e instanceof Error ? e.message : String(e);
            const status = /busy|waiting/i.test(message) ? 409 : 400;
            sendJson(res, status, { error: message });
            return;
          }
          // Fire-and-forget: progress arrives as SSE events. Awaiting here
          // would hold the HTTP request for the whole turn.
          void runtime.sendMessage(id, body.content, turnOpts).catch(() => {
            // In-turn failures surface as SSE error/cancelled events —
            // never as unhandled rejections.
          });
          sendJson(res, 202, { accepted: true });
          return;
        }
        // POST /api/sessions/:id/cancel
        if (suffix === "/cancel" && method === "POST") {
          if (!runtime.getSessionRecord(id)) {
            sendJson(res, 404, { error: "session not found" });
            return;
          }
          sendJson(res, 200, { cancelled: runtime.cancelTurn(id) });
          return;
        }
        // POST /api/sessions/:id/approve
        if (suffix === "/approve" && method === "POST") {
          if (!runtime.getSessionRecord(id)) {
            sendJson(res, 404, { error: "session not found" });
            return;
          }
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const b = (parsed.body ?? {}) as Record<string, unknown>;
          if (typeof b["id"] !== "string" || (b["decision"] !== "once" && b["decision"] !== "always" && b["decision"] !== "no")) {
            sendJson(res, 400, { error: 'body must be {id: string, decision: "once"|"always"|"no"}' });
            return;
          }
          sendJson(res, 200, {
            resolved: runtime.resolveApproval(id, b["id"] as string, b["decision"] as ApprovalDecision),
          });
          return;
        }
        // POST /api/sessions/:id/answer
        if (suffix === "/answer" && method === "POST") {
          if (!runtime.getSessionRecord(id)) {
            sendJson(res, 404, { error: "session not found" });
            return;
          }
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          const b = (parsed.body ?? {}) as Record<string, unknown>;
          if (typeof b["id"] !== "string" || typeof b["answer"] !== "string" || b["answer"].length === 0) {
            sendJson(res, 400, { error: "body must be {id: string, answer: non-empty string}" });
            return;
          }
          sendJson(res, 200, {
            resolved: runtime.answerQuestion(id, b["id"] as string, b["answer"] as string),
          });
          return;
        }
        sendJson(res, method === "GET" || method === "PATCH" || method === "POST" ? 404 : 405, {
          error: "not found",
        });
        return;
      }

      // Collection + catalog routes.
      if (pathname === "/api/sessions" && method === "GET") {
        sendJson(res, 200, runtime.listSessions().map(sessionSummary));
        return;
      }
      if (pathname === "/api/sessions" && method === "POST") {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        const b = (parsed.body ?? {}) as Record<string, unknown>;
        try {
          const created = runtime.createWebSession({
            title: typeof b["title"] === "string" ? b["title"] : undefined,
            provider: b["provider"] as ProviderId | undefined,
            model: typeof b["model"] === "string" ? b["model"] : undefined,
            effort: b["effort"] as ReasoningEffort | undefined,
            mode: b["mode"] as PermissionMode | undefined,
          });
          sendJson(res, 201, created);
        } catch (e) {
          sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (pathname === "/api/sessions" && method !== "GET" && method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (pathname === "/api/providers" && method === "GET") {
        sendJson(res, 200, runtime.listProviders());
        return;
      }
      if (pathname === "/api/tools" && method === "GET") {
        sendJson(res, 200, runtime.listTools());
        return;
      }
      if (pathname === "/api/health" && method === "GET") {
        sendJson(res, 200, {
          ok: true,
          service: WEB_SERVICE,
          version: WEB_VERSION,
          sessions: runtime.listSessions().length,
        });
        return;
      }
      if (
        pathname === "/api/health" ||
        pathname === "/api/providers" ||
        pathname === "/api/tools"
      ) {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch {
      sendJson(res, 500, { error: "internal error" });
    }
  }

  return new Promise((resolve, reject) => {
    let server: Server;
    try {
      server = createServer((req, res) => {
        void handle(req, res);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const sockets = new Set<Socket>();
    try {
      server.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
      });
    } catch {
      // observer wiring must never break startup
    }
    const onError = (e: unknown): void => {
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      let actual = port;
      try {
        const addr = server.address();
        if (addr !== null && typeof addr === "object") actual = addr.port;
      } catch {
        // keep the requested port in the URL on introspection failure
      }
      resolve({
        url: `http://${host}:${actual}/`,
        host,
        port: actual,
        runtime,
        close: () =>
          new Promise<void>((done) => {
            try {
              for (const s of sockets) {
                try {
                  s.destroy();
                } catch {
                  // ignore per-socket failures
                }
              }
              server.close(() => done());
            } catch {
              done();
            }
          }),
      });
    });
  });
}
