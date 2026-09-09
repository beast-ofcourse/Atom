// Local observability webUI: a tiny read-only HTTP server over the same
// telemetry store the static dashboard reads. The static `--dashboard` file
// is untouched — this is a convenience live view for the browser.
//
// Design (production-quality, minimal blast radius):
// - `node:http` builtin only. No new dependencies.
// - Loopback-only by default (`127.0.0.1`). Traces hold scrubbed previews,
//   never keys — but they still describe your machine, so the server never
//   binds a LAN interface unless explicitly asked (`host` option).
// - Read-only: GET only (anything else is 405), no request body is ever
//   read, nothing is ever written. Every handler is guarded — a bad request
//   or a corrupt store yields a status code, never a crash.
// - Live data: every request re-reads the store, so the page and the JSON
//   API always reflect the latest flushed turn. Responses carry
//   `Cache-Control: no-store`.
// - Same honesty rules as the static page: the HTML comes from the shared
//   `buildDashboardHtml` builder (plus a meta refresh), and the JSON API
//   only carries reported values with `usageReported`-style flags — absent
//   stays absent, never zero-filled.
//
// Routes:
// - `GET /` → live dashboard HTML (auto-refreshes every 5s)
// - `GET /api/health` → `{ok, version, sessions, turns, service}`
// - `GET /api/aggregates` → `summarizeTelemetry(sessions)` as JSON
// - `GET /api/sessions` → per-session summaries (counts + reported usage)
// - `GET /api/sessions/:id` → one full stored session, or 404
// - anything else → 404; non-GET → 405.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  TELEMETRY_VERSION,
  loadTelemetrySessions,
  summarizeTelemetry,
  telemetryDir,
  type TelemetrySession,
  type TokenUsage,
  type TurnOutcome,
} from "./telemetry.js";
import { buildDashboardHtml } from "./telemetry-dashboard.js";

export const TELEMETRY_SERVER_DEFAULT_HOST = "127.0.0.1";
// Ephemeral by default (port 0): zero collision failures, the real URL is
// printed on start. Pin with --port / ATOM_TELEMETRY_PORT when bookmarkable
// matters.
export const TELEMETRY_SERVER_DEFAULT_PORT = 0;
export const TELEMETRY_SERVER_REFRESH_SECONDS = 5;
export const TELEMETRY_SERVER_PORT_ENV = "ATOM_TELEMETRY_PORT";

export type TelemetryServerOptions = {
  home?: string;
  host?: string;
  port?: number;
  refreshSeconds?: number;
};

export type TelemetryServer = {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
};

export type TelemetrySessionSummary = {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  provider: string;
  model: string;
  project: string | null;
  turns: number;
  modelCalls: number;
  toolCalls: number;
  succeededToolCalls: number;
  failedToolCalls: number;
  usageReported: boolean;
  usage: TokenUsage;
  outcomes: Record<TurnOutcome, number>;
  retries: number;
};

// Parse a port candidate (CLI flag or env). Returns the port when it is an
// integer in range, else null (caller falls through to the next source).
export function parseTelemetryPort(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

// Precedence: explicit CLI value > ATOM_TELEMETRY_PORT > ephemeral (0).
export function resolveTelemetryPort(
  env: NodeJS.ProcessEnv = process.env,
  cliValue?: unknown
): number {
  return (
    parseTelemetryPort(cliValue) ??
    parseTelemetryPort(env[TELEMETRY_SERVER_PORT_ENV]) ??
    TELEMETRY_SERVER_DEFAULT_PORT
  );
}

function emptyOutcomes(): Record<TurnOutcome, number> {
  return {
    completed: 0,
    blocked: 0,
    unverified: 0,
    "budget-exceeded": 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
  };
}

export function summarizeSession(s: TelemetrySession): TelemetrySessionSummary {
  const summary: TelemetrySessionSummary = {
    sessionId: s.sessionId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    provider: s.provider,
    model: s.model,
    project: s.project,
    turns: s.turns.length,
    modelCalls: 0,
    toolCalls: 0,
    succeededToolCalls: 0,
    failedToolCalls: 0,
    usageReported: false,
    usage: {},
    outcomes: emptyOutcomes(),
    retries: 0,
  };
  try {
    for (const t of s.turns) {
      if (t.outcome in summary.outcomes) summary.outcomes[t.outcome] += 1;
      summary.retries += typeof t.retryCount === "number" ? t.retryCount : 0;
      summary.modelCalls += Array.isArray(t.modelCalls) ? t.modelCalls.length : 0;
      if (t.usageReported) {
        (["prompt_tokens", "completion_tokens", "total_tokens", "cacheReadTokens", "cacheWriteTokens"] as const).forEach(
          (k) => {
            // Reported-only accumulation: a turn that reported nothing
            // contributes nothing (never zero-filled).
            if (t.usage[k] !== undefined) {
              summary.usageReported = true;
              summary.usage[k] = (summary.usage[k] ?? 0) + (t.usage[k] as number);
            }
          }
        );
      }
      if (Array.isArray(t.toolCalls)) {
        for (const c of t.toolCalls) {
          summary.toolCalls += 1;
          if (c.success) summary.succeededToolCalls += 1;
          else summary.failedToolCalls += 1;
        }
      }
    }
  } catch {
    // summaries are best-effort; return what accumulated
  }
  return summary;
}

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

function sendHtml(res: ServerResponse, status: number, html: string): void {
  try {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": Buffer.byteLength(html),
    });
    res.end(html);
  } catch {
    try {
      res.end();
    } catch {
      // never throw out of a handler
    }
  }
}

const SESSION_ID_RE = /^[A-Za-z0-9_.-]+$/;

function handleRequest(req: IncomingMessage, res: ServerResponse, home: string | undefined, refreshSeconds: number): void {
  try {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed (read-only GET server)" });
      return;
    }
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }

    if (pathname === "/") {
      const { sessions, corrupt } = loadTelemetrySessions(home);
      const html = buildDashboardHtml(sessions, {
        sourceDir: telemetryDir(home),
        corruptFiles: corrupt,
        refreshSeconds,
      });
      sendHtml(res, 200, html);
      return;
    }
    if (pathname === "/api/health") {
      const { sessions } = loadTelemetrySessions(home);
      sendJson(res, 200, {
        ok: true,
        service: "atom-observability",
        version: TELEMETRY_VERSION,
        sessions: sessions.length,
        turns: sessions.reduce((n, s) => n + s.turns.length, 0),
      });
      return;
    }
    if (pathname === "/api/aggregates") {
      const { sessions } = loadTelemetrySessions(home);
      sendJson(res, 200, summarizeTelemetry(sessions));
      return;
    }
    if (pathname === "/api/sessions") {
      const { sessions } = loadTelemetrySessions(home);
      sendJson(res, 200, sessions.map(summarizeSession));
      return;
    }
    if (pathname.startsWith("/api/sessions/")) {
      const raw = pathname.slice("/api/sessions/".length);
      let id = "";
      try {
        id = decodeURIComponent(raw);
      } catch {
        sendJson(res, 400, { error: "bad session id" });
        return;
      }
      // Sessions are looked up in the loaded list (never by path), but an
      // invalid id is still a 404 without touching the store twice.
      if (!SESSION_ID_RE.test(id)) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      const { sessions } = loadTelemetrySessions(home);
      const found = sessions.find((s) => s.sessionId === id);
      if (!found) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      sendJson(res, 200, found);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch {
    sendJson(res, 500, { error: "internal error" });
  }
}

export function startTelemetryServer(opts: TelemetryServerOptions = {}): Promise<TelemetryServer> {
  const host = typeof opts.host === "string" && opts.host.length > 0 ? opts.host : TELEMETRY_SERVER_DEFAULT_HOST;
  const port =
    typeof opts.port === "number" && Number.isSafeInteger(opts.port) && opts.port >= 0 && opts.port <= 65535
      ? opts.port
      : TELEMETRY_SERVER_DEFAULT_PORT;
  const refreshSeconds =
    typeof opts.refreshSeconds === "number" && Number.isFinite(opts.refreshSeconds) && opts.refreshSeconds > 0
      ? Math.floor(opts.refreshSeconds)
      : TELEMETRY_SERVER_REFRESH_SECONDS;
  const home = opts.home;

  return new Promise((resolve, reject) => {
    let server: Server;
    try {
      server = createServer((req, res) => handleRequest(req, res, home, refreshSeconds));
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    // Track sockets so close() never hangs on keep-alive connections.
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
