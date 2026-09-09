// Local observability webUI: loopback HTTP server over the telemetry store.
// Real HTTP to 127.0.0.1 with ephemeral ports; no external network. Servers
// are always closed (afterEach) so the suite never hangs.
import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetryRecorder } from "../src/telemetry.js";
import { buildDashboardHtml } from "../src/telemetry-dashboard.js";
import {
  parseTelemetryPort,
  resolveTelemetryPort,
  startTelemetryServer,
  summarizeSession,
  type TelemetryServer,
} from "../src/telemetry-server.js";

const savedEnv = { ...process.env };
let homes: string[] = [];
let servers: TelemetryServer[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "atom-telemetry-srv-"));
  homes.push(home);
  return home;
}

async function start(opts: Parameters<typeof startTelemetryServer>[0]): Promise<TelemetryServer> {
  const s = await startTelemetryServer(opts);
  servers.push(s);
  return s;
}

afterEach(async () => {
  for (const s of servers) {
    try {
      await s.close();
    } catch {
      // close is best-effort in teardown
    }
  }
  servers = [];
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
});

// One flushed turn with reported usage, so routes serve non-empty data.
async function seedHome(home: string): Promise<string> {
  const rec = createTelemetryRecorder({ enabled: true, home });
  const turnId = rec.startTurn("hi", { provider: "opencode-zen", model: "big-pickle", effort: "default", mode: "normal" });
  const t0 = new Date().toISOString();
  rec.recordModelCall(turnId, {
    step: 0,
    startedAt: t0,
    endedAt: t0,
    durationMs: 11,
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    usageReported: true,
    toolCallCount: 0,
    finishReason: "final",
  });
  rec.endTurn(turnId, "completed", "hello");
  expect(rec.flush()).toBe(true);
  return rec.sessionId;
}

describe("parseTelemetryPort / resolveTelemetryPort", () => {
  test("validates range, rejects garbage", () => {
    expect(parseTelemetryPort("8080")).toBe(8080);
    expect(parseTelemetryPort(" 3000 ")).toBe(3000);
    expect(parseTelemetryPort(0)).toBeNull();
    expect(parseTelemetryPort(70000)).toBeNull();
    expect(parseTelemetryPort("abc")).toBeNull();
    expect(parseTelemetryPort("12.5")).toBeNull();
    expect(parseTelemetryPort(undefined)).toBeNull();
  });

  test("precedence: CLI > env > ephemeral", () => {
    expect(resolveTelemetryPort({ ATOM_TELEMETRY_PORT: "9001" } as NodeJS.ProcessEnv, "9002")).toBe(9002);
    expect(resolveTelemetryPort({ ATOM_TELEMETRY_PORT: "9001" } as NodeJS.ProcessEnv, "junk")).toBe(9001);
    expect(resolveTelemetryPort({ ATOM_TELEMETRY_PORT: "junk" } as NodeJS.ProcessEnv, undefined)).toBe(0);
    expect(resolveTelemetryPort({} as NodeJS.ProcessEnv, undefined)).toBe(0);
  });
});

describe("buildDashboardHtml refreshSeconds", () => {
  test("absent by default (static output unchanged); live mode adds meta + pill", () => {
    const plain = buildDashboardHtml([]);
    expect(plain).not.toContain("http-equiv=\"refresh\"");
    expect(plain).not.toContain("refreshes every");
    const live = buildDashboardHtml([], { refreshSeconds: 5 });
    expect(live).toContain("<meta http-equiv=\"refresh\" content=\"5\">");
    expect(live).toContain("live · refreshes every 5s");
  });
});

describe("summarizeSession", () => {
  test("counts with reported-only usage (never zero-filled)", async () => {
    const home = await tempHome();
    const sessionId = await seedHome(home);
    const { loadTelemetrySessions } = await import("../src/telemetry.js");
    const { sessions } = loadTelemetrySessions(home);
    expect(sessions).toHaveLength(1);
    const sum = summarizeSession(sessions[0]!);
    expect(sum.sessionId).toBe(sessionId);
    expect(sum.turns).toBe(1);
    expect(sum.modelCalls).toBe(1);
    expect(sum.outcomes.completed).toBe(1);
    expect(sum.usageReported).toBe(true);
    expect(sum.usage).toMatchObject({ prompt_tokens: 8, total_tokens: 10 });
  });
});

describe("telemetry HTTP server", () => {
  test("serves live HTML with refresh meta on loopback ephemeral port", async () => {
    const home = await tempHome();
    await seedHome(home);
    const s = await start({ home, port: 0 });
    expect(s.host).toBe("127.0.0.1");
    expect(s.port).toBeGreaterThan(0);
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/`);
    const res = await fetch(s.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("ATOM Observability");
    expect(html).toContain("<meta http-equiv=\"refresh\" content=\"5\">");
    expect(html).toContain("hello");
  });

  test("empty store serves the honest empty page, not an error", async () => {
    const home = await tempHome();
    const s = await start({ home, port: 0 });
    const res = await fetch(s.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No sessions recorded yet");
  });

  test("JSON API: health, aggregates, session list + detail", async () => {
    const home = await tempHome();
    const sessionId = await seedHome(home);
    const s = await start({ home, port: 0 });

    const health = await (await fetch(`${s.url}api/health`)).json();
    expect(health).toMatchObject({ ok: true, service: "atom-observability", sessions: 1, turns: 1 });

    const agg = await (await fetch(`${s.url}api/aggregates`)).json();
    expect(agg.turns).toBe(1);
    expect(agg.modelCalls).toBe(1);
    expect(agg.usage).toMatchObject({ prompt_tokens: 8 });
    expect(agg.costUsd).toBeNull();

    const list = await (await fetch(`${s.url}api/sessions`)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId, turns: 1, usageReported: true });

    const one = await (await fetch(`${s.url}api/sessions/${sessionId}`)).json();
    expect(one.sessionId).toBe(sessionId);
    expect(one.turns).toHaveLength(1);
    expect(one.turns[0].outcome).toBe("completed");

    const missing = await fetch(`${s.url}api/sessions/does-not-exist`);
    expect(missing.status).toBe(404);
    const badId = await fetch(`${s.url}api/sessions/..%2F..%2Fetc`);
    expect(badId.status).toBe(404);
  });

  test("unknown paths 404, non-GET 405, store always re-read (live)", async () => {
    const home = await tempHome();
    const s = await start({ home, port: 0 });
    expect((await fetch(`${s.url}nope`)).status).toBe(404);
    expect((await fetch(s.url, { method: "POST" })).status).toBe(405);
    await expect((await fetch(`${s.url}api/sessions`)).json()).resolves.toEqual([]);
    // Data flushed after startup shows up without restarting the server.
    await seedHome(home);
    const list = await (await fetch(`${s.url}api/sessions`)).json();
    expect(list).toHaveLength(1);
  });

  test("close() stops the server", async () => {
    const home = await tempHome();
    const s = await start({ home, port: 0 });
    expect((await fetch(s.url)).status).toBe(200);
    servers.splice(servers.indexOf(s), 1);
    await s.close();
    await expect(fetch(s.url)).rejects.toThrow();
  });
});
