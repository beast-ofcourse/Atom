// Local observability: recorder, store, aggregates, dashboard, loop sink.
// No network anywhere here except the TUI test's mocked fetch.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import { runLoopWithChat, type ChatMessage, type ChatResult } from "../src/zen.js";
import {
  TELEMETRY_VERSION,
  classifyToolResult,
  classifyTurnOutcome,
  cleanUsage,
  createTelemetryRecorder,
  loadTelemetrySessions,
  parseRetryDetail,
  pruneTelemetrySessions,
  resolveTelemetryEnabled,
  saveTelemetrySession,
  summarizeTelemetry,
  telemetryEnvOverride,
  telemetrySessionsDir,
  type TelemetrySession,
} from "../src/telemetry.js";
import {
  buildDashboardHtml,
  escapeHtml,
  writeTelemetryDashboard,
} from "../src/telemetry-dashboard.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "atom-telemetry-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
});

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 8000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitForFile(cond: () => boolean, timeout = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      if (cond()) return;
    } catch {
      // store unreadable yet — keep polling
    }
    if (Date.now() - start > timeout) throw new Error("timed out waiting for telemetry file");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function emptySession(sessionId: string): TelemetrySession {
  return {
    version: TELEMETRY_VERSION,
    sessionId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    atomVersion: null,
    project: null,
    provider: "opencode-zen",
    model: "big-pickle",
    turns: [],
    subagents: [],
    events: [],
    compactionUsage: {},
    compactionReported: false,
  };
}

describe("cleanUsage (reported-only, never synthesized)", () => {
  test("keeps reported fields, floors fractions, drops negatives", () => {
    expect(cleanUsage({ prompt_tokens: 3.7, completion_tokens: 2, total_tokens: 6 })).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 6,
    });
    expect(cleanUsage({ prompt_tokens: -1 })).toBeUndefined();
    expect(cleanUsage({ prompt_tokens: Number.NaN })).toBeUndefined();
    expect(cleanUsage({ cacheReadTokens: 4 })).toEqual({ cacheReadTokens: 4 });
  });

  test("empty/unusable payloads yield undefined (absent, not zero)", () => {
    expect(cleanUsage({})).toBeUndefined();
    expect(cleanUsage(null)).toBeUndefined();
    expect(cleanUsage("usage")).toBeUndefined();
    expect(cleanUsage({ prompt_tokens: "lots" })).toBeUndefined();
  });
});

describe("classifyToolResult", () => {
  test("success rule matches the loop (no Error prefix = success)", () => {
    expect(classifyToolResult("ok")).toEqual({ success: true });
    expect(classifyToolResult("")).toEqual({ success: true });
    expect(classifyToolResult("Error: something failed")).toEqual({ success: false, errorKind: "tool-error" });
  });

  test("model-mistake and denial kinds", () => {
    expect(classifyToolResult('Error: unknown tool "nope". Available: read')).toEqual({
      success: false,
      errorKind: "unknown-tool",
    });
    expect(classifyToolResult("Error: invalid call: bad args. Fix the arguments and retry.")).toEqual({
      success: false,
      errorKind: "invalid-args",
    });
    expect(classifyToolResult("Error: denied by user: bash")).toEqual({ success: false, errorKind: "denied" });
  });

  test("cancelled/throwing flags", () => {
    expect(classifyToolResult("aborted", { cancelled: true })).toEqual({ success: false, errorKind: "cancelled" });
    expect(classifyToolResult("boom", { threw: true })).toEqual({ success: false, errorKind: "transport-error" });
  });
});

describe("classifyTurnOutcome", () => {
  test("maps control flow and the loop's own end labels", () => {
    expect(classifyTurnOutcome("done")).toBe("completed");
    expect(classifyTurnOutcome("x", { cancelled: true })).toBe("cancelled");
    expect(classifyTurnOutcome("", { error: "boom" })).toBe("failed");
    expect(classifyTurnOutcome("partial\n(blocked: 2 open todo(s) — resolve before ending)")).toBe("blocked");
    expect(classifyTurnOutcome("edits\n(unverified: a.ts changed without a passing run)")).toBe("unverified");
    expect(classifyTurnOutcome("base\n(stopped: too many tool steps) (limit is 30; raise it)")).toBe("budget-exceeded");
  });
});

describe("parseRetryDetail", () => {
  test("parses the loop's retry strings, tolerates anything else", () => {
    expect(parseRetryDetail("attempt 1/2 after 1000ms (HTTP 429)")).toEqual({ attempt: 1, delayMs: 1000, status: 429 });
    expect(parseRetryDetail("attempt 2/2 after 2000ms (connection reset)")).toEqual({
      attempt: 2,
      delayMs: 2000,
      status: null,
    });
    expect(parseRetryDetail("garbage")).toEqual({ attempt: null, delayMs: null, status: null });
  });
});

describe("enablement", () => {
  test("env override wins; config next; default on", () => {
    expect(telemetryEnvOverride({ ATOM_TELEMETRY: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(telemetryEnvOverride({ ATOM_TELEMETRY: "off" } as NodeJS.ProcessEnv)).toBe(false);
    expect(telemetryEnvOverride({ ATOM_TELEMETRY: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(telemetryEnvOverride({ ATOM_TELEMETRY: "yes" } as NodeJS.ProcessEnv)).toBe(true);
    expect(telemetryEnvOverride({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveTelemetryEnabled({ ATOM_TELEMETRY: "0" } as NodeJS.ProcessEnv, true)).toBe(false);
    expect(resolveTelemetryEnabled({ ATOM_TELEMETRY: "1" } as NodeJS.ProcessEnv, false)).toBe(true);
    expect(resolveTelemetryEnabled({} as NodeJS.ProcessEnv, false)).toBe(false);
    expect(resolveTelemetryEnabled({} as NodeJS.ProcessEnv, undefined)).toBe(true);
  });
});

describe("recorder lifecycle", () => {
  test("disabled recorder is a full no-op that never throws", () => {
    const rec = createTelemetryRecorder({ enabled: false });
    expect(rec.isEnabled()).toBe(false);
    expect(rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "normal" })).toBeNull();
    expect(() => {
      rec.recordUsage(null, { prompt_tokens: 1 });
      rec.recordRetry(null, "attempt 1/2 after 1ms (HTTP 500)");
      rec.recordModelCall(null, {
        step: 0,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 1,
        usageReported: false,
        toolCallCount: 0,
        finishReason: "final",
      });
      rec.recordToolCall(null, {
        step: 0,
        toolCallId: "x",
        name: "read",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 1,
        argsJson: "{}",
        result: "ok",
        batchIndex: 0,
        batchSize: 1,
      });
      rec.recordCompactionUsage({ prompt_tokens: 1 });
      rec.recordEvent("clear", "x");
      rec.recordSubagent({ name: "explore", status: "completed" });
      rec.endTurn(null, "completed", "done");
      rec.endSession();
    }).not.toThrow();
    expect(rec.flush()).toBe(false);
    expect(rec.getSnapshot().turns).toEqual([]);
  });

  test("turn spans iterations derived from model/tool records; usage accumulates reported-only", () => {
    const rec = createTelemetryRecorder({ enabled: true });
    const turnId = rec.startTurn("do things", { provider: "opencode-zen", model: "big-pickle", effort: "default", mode: "normal" });
    expect(turnId).toBe("t1");
    const t0 = new Date().toISOString();
    rec.recordModelCall(turnId, {
      step: 0,
      startedAt: t0,
      endedAt: t0,
      durationMs: 12,
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      usageReported: true,
      toolCallCount: 1,
      finishReason: "tool_calls",
    });
    rec.recordToolCall(turnId, {
      step: 0,
      toolCallId: "call_1",
      name: "read",
      startedAt: t0,
      endedAt: t0,
      durationMs: 3,
      argsJson: JSON.stringify({ path: "a.txt" }),
      result: "file contents",
      batchIndex: 0,
      batchSize: 1,
    });
    rec.recordModelCall(turnId, {
      step: 1,
      startedAt: t0,
      endedAt: t0,
      durationMs: 9,
      usageReported: false,
      toolCallCount: 0,
      finishReason: "final",
    });
    rec.endTurn(turnId, "completed", "all done");
    const snap = rec.getSnapshot();
    expect(snap.turns).toHaveLength(1);
    const turn = snap.turns[0]!;
    expect(turn.outcome).toBe("completed");
    expect(turn.modelCalls).toHaveLength(2);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]!.success).toBe(true);
    expect(turn.toolCalls[0]!.providerToolCallId).toBe("call_1");
    expect(turn.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(turn.usageReported).toBe(true);
    expect(turn.iterations.map((i) => i.step)).toEqual([0, 1]);
    expect(turn.iterations[0]!.modelCallId).toBe("m1");
    expect(turn.iterations[0]!.toolCallIds).toEqual(["c1"]);
    expect(turn.iterations[1]!.modelCallId).toBe("m2");
    expect(turn.endedAt).not.toBeNull();
    expect(turn.durationMs).not.toBeNull();
  });

  test("retries buffer until their model call completes", () => {
    const rec = createTelemetryRecorder({ enabled: true });
    const turnId = rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "normal" });
    rec.recordRetry(turnId, "attempt 1/2 after 1000ms (HTTP 429)");
    rec.recordRetry(turnId, "attempt 2/2 after 2000ms (HTTP 503)");
    const t0 = new Date().toISOString();
    rec.recordModelCall(turnId, {
      step: 0,
      startedAt: t0,
      endedAt: t0,
      durationMs: 3000,
      usageReported: false,
      toolCallCount: 0,
      finishReason: "final",
    });
    const turn = rec.getSnapshot().turns[0]!;
    expect(turn.retryCount).toBe(2);
    expect(turn.modelCalls[0]!.retries).toHaveLength(2);
    expect(turn.modelCalls[0]!.retries[0]).toMatchObject({ attempt: 1, delayMs: 1000, status: 429 });
  });

  test("previews truncate with sizes; secrets scrubbed; snapshot is a copy", () => {
    const rec = createTelemetryRecorder({ enabled: true, secrets: () => ["s3cr3t-value-long"] });
    const turnId = rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "normal" });
    const t0 = new Date().toISOString();
    rec.recordToolCall(turnId, {
      step: 0,
      toolCallId: "c",
      name: "bash",
      startedAt: t0,
      endedAt: t0,
      durationMs: 1,
      argsJson: JSON.stringify({ command: "echo s3cr3t-value-long and " + "x".repeat(3000) }),
      result: "leaked s3cr3t-value-long here",
      batchIndex: 0,
      batchSize: 1,
    });
    const snap = rec.getSnapshot();
    const call = snap.turns[0]!.toolCalls[0]!;
    expect(call.argsPreview).toContain("[redacted]");
    expect(call.argsPreview).not.toContain("s3cr3t-value-long");
    expect(call.resultPreview).toContain("[redacted]");
    expect(call.argsTruncated).toBe(true);
    expect(call.argsChars).toBeGreaterThan(2000);
    expect(call.argsPreview).toHaveLength(2000);
    // Mutating the snapshot must not affect the recorder.
    snap.turns[0]!.toolCalls[0]!.name = "mutated";
    expect(rec.getSnapshot().turns[0]!.toolCalls[0]!.name).toBe("bash");
  });

  test("compaction spend stays session-level; events and subagents record", () => {
    const rec = createTelemetryRecorder({ enabled: true });
    rec.recordCompactionUsage({ prompt_tokens: 100, total_tokens: 150 }, "auto");
    rec.recordCompactionUsage({} as unknown);
    rec.recordEvent("clear", "wiped");
    rec.recordSubagent({ name: "explore", status: "completed", summary: "found 3 files" });
    const snap = rec.getSnapshot();
    expect(snap.compactionUsage).toMatchObject({ prompt_tokens: 100, total_tokens: 150 });
    expect(snap.compactionReported).toBe(true);
    expect(snap.events.map((e) => e.kind)).toContain("compact");
    expect(snap.events.map((e) => e.kind)).toContain("clear");
    expect(snap.subagents).toHaveLength(1);
    expect(snap.subagents[0]).toMatchObject({ name: "explore", status: "completed" });
  });
});

describe("telemetry store", () => {
  test("empty session flushes nothing (no phantom files)", async () => {
    const home = await tempHome();
    const rec = createTelemetryRecorder({ enabled: true, home });
    expect(rec.isEmpty()).toBe(true);
    rec.endSession();
    expect(rec.flush()).toBe(false);
    expect(loadTelemetrySessions(home)).toEqual({ sessions: [], corrupt: 0 });
    // One event is enough to make the session worth persisting.
    rec.recordEvent("clear", "wiped");
    expect(rec.isEmpty()).toBe(false);
    expect(rec.flush()).toBe(true);
    expect(loadTelemetrySessions(home).sessions).toHaveLength(1);
  });

  test("round-trip save/load; corrupt files counted, never thrown", async () => {
    const home = await tempHome();
    const rec = createTelemetryRecorder({ enabled: true, home });
    const turnId = rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "normal" });
    rec.endTurn(turnId, "completed", "done");
    expect(rec.flush()).toBe(true);
    await writeFile(join(telemetrySessionsDir(home), "garbage.json"), "{not json", "utf8");
    const { sessions, corrupt } = loadTelemetrySessions(home);
    expect(corrupt).toBe(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.turns).toHaveLength(1);
    expect(sessions[0]!.turns[0]!.outcome).toBe("completed");
  });

  test("missing store loads empty; unknown versions rejected", async () => {
    const home = await tempHome();
    expect(loadTelemetrySessions(home)).toEqual({ sessions: [], corrupt: 0 });
    await mkdir(telemetrySessionsDir(home), { recursive: true });
    await writeFile(
      join(telemetrySessionsDir(home), "future.json"),
      JSON.stringify({ version: 999, sessionId: "x", startedAt: new Date().toISOString(), turns: [] }),
      "utf8"
    );
    const loaded = loadTelemetrySessions(home);
    expect(loaded.sessions).toHaveLength(0);
    expect(loaded.corrupt).toBe(1);
  });

  test("prune keeps newest N files and drops aged-out files", async () => {
    const home = await tempHome();
    for (let i = 0; i < 5; i++) {
      const s = emptySession(`s${i}`);
      s.startedAt = new Date(Date.now() - i * 1000).toISOString();
      expect(saveTelemetrySession(s, home)).toBe(true);
    }
    // Deterministic recency by mtime: s4 ancient (aged out), s2/s3 older,
    // s0/s1 newest — cap 2 keeps s0/s1.
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    utimesSync(join(telemetrySessionsDir(home), "s4.json"), new Date(0), new Date(0));
    utimesSync(join(telemetrySessionsDir(home), "s3.json"), new Date(now - 10 * day), new Date(now - 10 * day));
    utimesSync(join(telemetrySessionsDir(home), "s2.json"), new Date(now - 5 * day), new Date(now - 5 * day));
    utimesSync(join(telemetrySessionsDir(home), "s1.json"), new Date(now - 2000), new Date(now - 2000));
    utimesSync(join(telemetrySessionsDir(home), "s0.json"), new Date(now - 1000), new Date(now - 1000));
    const removed = pruneTelemetrySessions(home, 2, 90);
    expect(removed).toBe(3); // 1 aged-out + 2 over the cap
    const { sessions } = loadTelemetrySessions(home);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["s0", "s1"]);
  });
});

describe("summarizeTelemetry (measured only — no fake metrics)", () => {
  function sessionWithTrace(): TelemetrySession {
    const rec = createTelemetryRecorder({ enabled: true });
    const t1 = rec.startTurn("a", { provider: "opencode-zen", model: "m1", effort: "default", mode: "normal" });
    const t0 = new Date().toISOString();
    rec.recordModelCall(t1, {
      step: 0, startedAt: t0, endedAt: t0, durationMs: 100,
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      usageReported: true, toolCallCount: 2, finishReason: "tool_calls",
    });
    rec.recordRetry(t1, "attempt 1/2 after 1000ms (HTTP 429)");
    rec.recordToolCall(t1, {
      step: 0, toolCallId: "a", name: "read", startedAt: t0, endedAt: t0, durationMs: 10,
      argsJson: "{}", result: "ok", batchIndex: 0, batchSize: 1,
    });
    rec.recordToolCall(t1, {
      step: 0, toolCallId: "b", name: "bash", startedAt: t0, endedAt: t0, durationMs: 30,
      argsJson: "{}", result: "Error: exit 1", batchIndex: 1, batchSize: 2,
    });
    rec.endTurn(t1, "completed", "done");
    const t2 = rec.startTurn("b", { provider: "openai", model: "m2", effort: "low", mode: "yolo" });
    rec.recordModelCall(t2, {
      step: 0, startedAt: t0, endedAt: t0, durationMs: 50,
      usageReported: false, toolCallCount: 0, finishReason: "final",
    });
    rec.endTurn(t2, "failed", "boom");
    return rec.getSnapshot();
  }

  test("counts, rates, usage, retries, per-tool splits", () => {
    const agg = summarizeTelemetry([sessionWithTrace(), emptySession("empty")]);
    expect(agg.sessions).toBe(2);
    expect(agg.turns).toBe(2);
    expect(agg.modelCalls).toBe(2);
    expect(agg.toolCalls).toBe(2);
    expect(agg.succeededToolCalls).toBe(1);
    expect(agg.failedToolCalls).toBe(1);
    expect(agg.toolSuccessRate).toBe(0.5);
    expect(agg.usageReported).toBe(true);
    expect(agg.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
    expect(agg.retries).toBe(1);
    expect(agg.outcomes.completed).toBe(1);
    expect(agg.outcomes.failed).toBe(1);
    expect(agg.byTool.map((t) => t.name).sort()).toEqual(["bash", "read"]);
    expect(agg.avgModelLatencyMs).toBe(75);
    expect(agg.avgToolDurationMs).toBe(20);
  });

  test("unavailable stays unavailable: null rate, null cost with note", () => {
    const agg = summarizeTelemetry([emptySession("e")]);
    expect(agg.toolSuccessRate).toBeNull();
    expect(agg.usageReported).toBe(false);
    expect(agg.avgModelLatencyMs).toBeNull();
    expect(agg.costUsd).toBeNull();
    expect(agg.costNote).toContain("not reported");
  });
});

describe("dashboard HTML", () => {
  test("escapeHtml neutralizes markup", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  test("empty store renders an honest empty state", () => {
    const html = buildDashboardHtml([]);
    expect(html).toContain("ATOM Observability");
    expect(html).toContain("No sessions recorded yet");
    expect(html).toContain("n/a");
    expect(html).toContain("not reported");
  });

  test("synthetic session drills down with escaped content and honest n/a", () => {
    const rec = createTelemetryRecorder({ enabled: true, sessionId: "ses-inject" });
    const turnId = rec.startTurn(`hi <script>alert(1)</script>`, {
      provider: "opencode-zen",
      model: "big-pickle",
      effort: "default",
      mode: "normal",
    });
    const t0 = new Date().toISOString();
    rec.recordModelCall(turnId, {
      step: 0, startedAt: t0, endedAt: t0, durationMs: 42,
      usageReported: false, toolCallCount: 0, finishReason: "final",
    });
    rec.endTurn(turnId, "completed", "done");
    const html = buildDashboardHtml([rec.getSnapshot()]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("data-session");
    expect(html).toContain("No subagents recorded");
    expect(html).toContain("Cost is not reported");
    expect(html).toContain('id="q"');
  });

  test("writeTelemetryDashboard writes next to the store", async () => {
    const home = await tempHome();
    const first = writeTelemetryDashboard(home);
    expect(first).not.toBeNull();
    expect(await readFile(first!, "utf8")).toContain("No sessions recorded yet");
    const rec = createTelemetryRecorder({ enabled: true, home, sessionId: "ses-abc" });
    const turnId = rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "normal" });
    rec.endTurn(turnId, "completed", "done");
    expect(rec.flush()).toBe(true);
    const second = writeTelemetryDashboard(home);
    expect(await readFile(second!, "utf8")).toContain("ses-abc");
  });
});

describe("runLoopWithChat telemetry sink", () => {
  function history(): ChatMessage[] {
    return [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
    ];
  }

  function toolResult(toolCalls: ChatResult["tool_calls"], usage?: ChatResult["usage"]): ChatResult {
    return { content: "working", tool_calls: toolCalls, ...(usage ? { usage } : {}) };
  }

  test("tools + final answer record iterations, durations, usage, success", async () => {
    let calls = 0;
    const chat = async (): Promise<ChatResult> => {
      calls += 1;
      if (calls === 1) {
        return toolResult(
          [
            { id: "c1", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } },
            { id: "c2", function: { name: "grep", arguments: JSON.stringify({ pattern: "x" }) } },
          ],
          { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
        );
      }
      return { content: "done", usage: { prompt_tokens: 6, completion_tokens: 1, total_tokens: 7 } };
    };
    const rec = createTelemetryRecorder({ enabled: true });
    const turnId = rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "normal" });
    const reply = await runLoopWithChat(chat, history(), {
      execute: async () => "ok",
      telemetry: {
        onModelCall: (i) => rec.recordModelCall(turnId, i),
        onToolCall: (i) => rec.recordToolCall(turnId, i),
      },
    });
    expect(reply).toBe("done");
    rec.endTurn(turnId, "completed", reply);
    const turn = rec.getSnapshot().turns[0]!;
    expect(turn.modelCalls).toHaveLength(2);
    expect(turn.modelCalls[0]).toMatchObject({ toolCallCount: 2, finishReason: "tool_calls", usageReported: true });
    expect(turn.toolCalls).toHaveLength(2);
    expect(turn.toolCalls.every((c) => c.success)).toBe(true);
    expect(turn.toolCalls.map((c) => c.providerToolCallId).sort()).toEqual(["c1", "c2"]);
    for (const c of turn.toolCalls) {
      expect(c.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(c.startedAt))).toBe(false);
    }
    expect(turn.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
    expect(turn.iterations.map((i) => i.step)).toEqual([0, 1]);
    expect(turn.iterations[0]!.toolCallIds).toHaveLength(2);
  });

  test("unknown tools and bad JSON classify without stopping the turn", async () => {
    let calls = 0;
    const chat = async (): Promise<ChatResult> => {
      calls += 1;
      if (calls === 1) {
        return toolResult([
          { id: "u1", function: { name: "nope", arguments: "{}" } },
          { id: "u2", function: { name: "read", arguments: "{oops" } },
        ]);
      }
      return { content: "recovered" };
    };
    const rec = createTelemetryRecorder({ enabled: true });
    const turnId = rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "normal" });
    const reply = await runLoopWithChat(chat, history(), {
      execute: async () => "must not run",
      telemetry: {
        onModelCall: (i) => rec.recordModelCall(turnId, i),
        onToolCall: (i) => rec.recordToolCall(turnId, i),
      },
    });
    expect(reply).toBe("recovered");
    const kinds = rec.getSnapshot().turns[0]!.toolCalls.map((c) => c.errorKind).sort();
    expect(kinds).toEqual(["invalid-args", "unknown-tool"]);
  });

  test("failed POST records an error model call and rethrows", async () => {
    const chat = async (): Promise<ChatResult> => {
      throw new Error("connection reset");
    };
    const rec = createTelemetryRecorder({ enabled: true });
    const turnId = rec.startTurn("hi", { provider: "p", model: "m", effort: "default", mode: "normal" });
    await expect(
      runLoopWithChat(chat, history(), {
        execute: async () => "ok",
        telemetry: {
          onModelCall: (i) => rec.recordModelCall(turnId, i),
          onToolCall: (i) => rec.recordToolCall(turnId, i),
        },
      })
    ).rejects.toThrow("connection reset");
    const call = rec.getSnapshot().turns[0]!.modelCalls[0]!;
    expect(call.finishReason).toBe("error");
    expect(call.error).toContain("connection reset");
  });

  test("a throwing sink never breaks the turn", async () => {
    const reply = await runLoopWithChat(async () => ({ content: "fine" }), history(), {
      execute: async () => "ok",
      telemetry: {
        onModelCall: () => {
          throw new Error("sink boom");
        },
        onToolCall: () => {
          throw new Error("sink boom");
        },
      },
    });
    expect(reply).toBe("fine");
  });
});

describe("atom.json telemetry knob", () => {
  test("enabled parses; invalid values warn and are ignored", async () => {
    const home = await tempHome();
    await mkdir(join(home, ".atom"), { recursive: true });
    const { loadAtomConfig } = await import("../src/config.js");
    await writeFile(join(home, ".atom", "atom.json"), JSON.stringify({ telemetry: { enabled: false } }), "utf8");
    expect(loadAtomConfig(join(home, "proj"), home).config.telemetry).toEqual({ enabled: false });
    await writeFile(join(home, ".atom", "atom.json"), JSON.stringify({ telemetry: { enabled: "yes" } }), "utf8");
    const bad = loadAtomConfig(join(home, "proj"), home);
    expect(bad.config.telemetry).toBeUndefined();
    expect(bad.warnings.join(" ")).toContain("telemetry.enabled");
    await writeFile(join(home, ".atom", "atom.json"), JSON.stringify({ telemetry: 7 }), "utf8");
    const worse = loadAtomConfig(join(home, "proj"), home);
    expect(worse.config.telemetry).toBeUndefined();
    expect(worse.warnings.join(" ")).toContain('"telemetry"');
  });
});

describe("TUI end-to-end trace", () => {
  function mockChatQueue(turns: Array<{ reply: string; usage?: unknown }>) {
    const queue = [...turns];
    globalThis.fetch = vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: next.reply } }],
          ...(next.usage !== undefined ? { usage: next.usage } : {}),
        }),
      } as Response;
    });
  }

  test("a completed turn lands in the store; /telemetry and /dashboard report it", async () => {
    const home = await tempHome();
    process.env.ATOM_HOME = home;
    // Fresh conversation each launch; the save from setup.ts's home must not leak in.
    mockChatQueue([{ reply: "hello there", usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }]);
    const app = render(
      React.createElement(App, {
        apiKey: "test-key",
        endpoint: ENDPOINT,
        // Pinned: this trace asserts the zen provider label.
        initialProvider: "opencode-zen",
        initialModel: "big-pickle",
        initialModels: ["big-pickle"],
      })
    );
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "hello there");
      await waitForFile(() => loadTelemetrySessions(home).sessions.some((s) => s.turns.length === 1));
      const { sessions } = loadTelemetrySessions(home);
      expect(sessions).toHaveLength(1);
      const turn = sessions[0]!.turns[0]!;
      expect(turn.outcome).toBe("completed");
      expect(turn.provider).toBe("opencode-zen");
      expect(turn.model).toBe("big-pickle");
      expect(turn.usageReported).toBe(true);
      expect(turn.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
      expect(turn.modelCalls).toHaveLength(1);
      expect(turn.modelCalls[0]!.finishReason).toBe("final");
      // /telemetry summarizes the stored trace.
      app.stdin.write("/telemetry");
      app.stdin.write("\r");
      await waitForFrame(app, "Telemetry: on");
      expect(app.lastFrame()).toContain("1 turn(s)");
      // /dashboard writes the drill-down page next to the store.
      app.stdin.write("/dashboard");
      app.stdin.write("\r");
      await waitForFrame(app, "dashboard written to");
      const html = await readFile(join(home, ".atom", "telemetry", "dashboard.html"), "utf8");
      expect(html).toContain("ATOM Observability");
      expect(html).toContain("hello there");
    } finally {
      app.unmount();
    }
  });
});
