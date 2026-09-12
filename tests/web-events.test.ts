// WebUI event protocol: serialization round-trips, SSE framing, heartbeats.
// Pure module — no I/O, no loop imports.
import { describe, expect, test } from "vitest";
import {
  createWebEvent,
  eventsAfter,
  formatSSE,
  parseSSEFrame,
  sseHeaders,
  sseHeartbeat,
} from "../src/web/events.js";

describe("createWebEvent", () => {
  test("carries seq, kind, data, and an ISO timestamp", () => {
    const evt = createWebEvent(7, "token", { text: "hi" });
    expect(evt.seq).toBe(7);
    expect(evt.kind).toBe("token");
    expect(evt.data).toEqual({ text: "hi" });
    expect(Number.isNaN(Date.parse(evt.at))).toBe(false);
  });

  test("defaults to an empty data object", () => {
    expect(createWebEvent(1, "done").data).toEqual({});
  });
});

describe("formatSSE / parseSSEFrame", () => {
  test("round-trips every event kind", () => {
    const kinds = [
      "token",
      "thinking",
      "phase",
      "tool_delta",
      "tool_started",
      "tool_finished",
      "tool_call",
      "tool_activity",
      "tool_result",
      "file_diff",
      "usage",
      "reasoning",
      "warning",
      "approval_request",
      "approval_resolved",
      "question_request",
      "question_resolved",
      "message",
      "error",
      "done",
      "cancelled",
    ] as const;
    for (const kind of kinds) {
      const evt = createWebEvent(3, kind, { n: 1 });
      const frame = formatSSE(evt);
      expect(frame.startsWith(`id: 3\nevent: ${kind}\ndata: `)).toBe(true);
      expect(frame.endsWith("\n\n")).toBe(true);
      expect(parseSSEFrame(frame)).toEqual(evt);
    }
  });

  test("never throws on garbage (heartbeats, truncations, non-JSON)", () => {
    expect(parseSSEFrame(": ping\n\n")).toBeNull();
    expect(parseSSEFrame("")).toBeNull();
    expect(parseSSEFrame("data: not-json\n\n")).toBeNull();
    expect(parseSSEFrame("data: 42\n\n")).toBeNull();
    expect(parseSSEFrame("data: {\"kind\": \"done\"}\n\n")).toBeNull();
  });
});

describe("eventsAfter (reconnect replay)", () => {
  const log = [1, 2, 3].map((seq) => createWebEvent(seq, "token", { text: "t" }));
  test("returns only newer events, oldest first", () => {
    expect(eventsAfter(log, 1).map((e) => e.seq)).toEqual([2, 3]);
    expect(eventsAfter(log, 3)).toEqual([]);
  });

  test("absent/garbage ids replay nothing (fresh clients render GET state)", () => {
    expect(eventsAfter(log, undefined)).toEqual([]);
    expect(eventsAfter(log, Number.NaN)).toEqual([]);
  });
});

describe("sseHeaders / sseHeartbeat", () => {
  test("streams without caching", () => {
    const h = sseHeaders();
    expect(h["Content-Type"]).toContain("text/event-stream");
    expect(h["Cache-Control"]).toBe("no-store");
  });

  test("heartbeat is a comment frame (no dispatch, no seq)", () => {
    expect(sseHeartbeat()).toBe(": ping\n\n");
    expect(parseSSEFrame(sseHeartbeat())).toBeNull();
  });
});
