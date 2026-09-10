// Scrollback-viewport tests: windowing bounds, follow/manual modes,
// scroll actions, the new-output indicator, and long-session performance.
// The viewport replaces <Static> (which has no scroll API) while keeping
// follow-by-default byte-compatible for short transcripts.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import {
  TranscriptView,
  applyScrollAction,
  resolveViewport,
  type Turn,
} from "../src/ui/transcript.js";
import { LiveTail } from "../src/ui/live-tail.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function turns(n: number, tag = "t"): Turn[] {
  return Array.from({ length: n }, (_, i) => ({ role: "assistant", content: `${tag}-${i}` }));
}

describe("resolveViewport", () => {
  test("follow shows the tail window with zero pending", () => {
    expect(resolveViewport(500, null, 100)).toEqual({ start: 400, end: 500, pending: 0, follow: true });
    expect(resolveViewport(50, undefined, 100)).toEqual({ start: 0, end: 50, pending: 0, follow: true });
  });
  test("manual freezes the end and counts pending", () => {
    expect(resolveViewport(500, 450, 100)).toEqual({ start: 350, end: 450, pending: 50, follow: false });
  });
  test("clamps past-the-end back to follow (clear/resume/new)", () => {
    expect(resolveViewport(10, 999, 100)).toEqual({ start: 0, end: 10, pending: 0, follow: true });
    expect(resolveViewport(0, null, 100)).toEqual({ start: 0, end: 0, pending: 0, follow: true });
  });
});

describe("applyScrollAction", () => {
  test("page up/down move by page, down re-follows at the bottom", () => {
    expect(applyScrollAction(null, 500, { kind: "pageUp" })).toBe(490);
    expect(applyScrollAction(490, 500, { kind: "pageDown" })).toBe(null);
    expect(applyScrollAction(100, 500, { kind: "pageDown" })).toBe(110);
  });
  test("home jumps to the top window, end re-follows", () => {
    expect(applyScrollAction(null, 500, { kind: "home" })).toBe(300);
    expect(applyScrollAction(300, 500, { kind: "end" })).toBe(null);
    expect(applyScrollAction(null, 50, { kind: "home" })).toBe(50);
  });
  test("short lists stay put", () => {
    expect(applyScrollAction(null, 5, { kind: "pageUp" })).toBe(5);
    // PageDown at the bottom is already follow (null), not a number.
    expect(applyScrollAction(null, 5, { kind: "pageDown" })).toBe(null);
  });
  test("pageUp on a short list freezes at the bottom (hold), not follow", () => {
    // A number (even === len) is manual mode: the window is frozen, new
    // turns accumulate as pending, and the live tail stops growing.
    const end = applyScrollAction(null, 5, { kind: "pageUp" });
    expect(end).not.toBeNull();
    expect(resolveViewport(5, end, 100)).toEqual({ start: 0, end: 5, pending: 0, follow: true });
    expect(resolveViewport(7, end, 100)).toEqual({ start: 0, end: 5, pending: 2, follow: false });
    // PgDn from the held bottom re-follows.
    expect(applyScrollAction(end, 7, { kind: "pageDown" })).toBe(null);
  });
});

describe("TranscriptView viewport", () => {
  test("short transcripts render whole (follow default)", () => {
    const frame = frameOf(<TranscriptView turns={turns(5)} clearGen={1} />);
    expect(frame).toContain("t-0");
    expect(frame).toContain("t-4");
    expect(frame).not.toContain("new — End");
  });
  test("long transcripts window to the tail", () => {
    const frame = frameOf(<TranscriptView turns={turns(500)} clearGen={1} windowSize={100} />);
    expect(frame).toContain("t-499");
    expect(frame).toContain("t-400");
    expect(frame).not.toContain("t-399");
  });
  test("manual end freezes with a pending indicator", () => {
    const frame = frameOf(<TranscriptView turns={turns(500)} clearGen={1} windowSize={100} end={450} />);
    expect(frame).toContain("t-449");
    expect(frame).not.toContain("t-450");
    expect(frame).toContain("↓ 50 new — End for latest");
  });
  test("held shows a resume hint when nothing is pending", () => {
    const frame = frameOf(<TranscriptView turns={turns(5)} clearGen={1} end={5} held />);
    expect(frame).toContain("t-4");
    expect(frame).toContain("held — End to follow");
    const following = frameOf(<TranscriptView turns={turns(5)} clearGen={1} end={5} />);
    expect(following).not.toContain("held — End to follow");
  });
  test("banner shows only when the window touches the top", () => {
    const top = frameOf(<TranscriptView turns={turns(500)} clearGen={0} windowSize={100} end={100} />);
    expect(top).toContain("t-0");
    const scrolled = frameOf(<TranscriptView turns={turns(500)} clearGen={0} windowSize={100} end={450} />);
    expect(scrolled).not.toContain("t-0");
  });
  test("error pairing survives windowing", () => {
    const ts: Turn[] = [
      ...turns(200, "q"),
      { role: "tool", content: "⚙ read f" },
      { role: "tool", content: "  ↳ Error: x", error: true },
    ];
    const frame = frameOf(<TranscriptView turns={ts} clearGen={1} windowSize={100} />);
    expect(frame).toContain("Read failed");
  });
});

describe("LiveTail held", () => {
  function tail(over: Partial<React.ComponentProps<typeof LiveTail>> = {}) {
    return frameOf(
      <LiveTail
        isEmpty={false}
        sessionHint={false}
        draft={null}
        thinking={null}
        busy={false}
        toolHint={null}
        toolElapsedSecs={null}
        elapsedSecs={0}
        {...over}
      />
    );
  }
  test("held + busy collapses growing blocks to one static line", () => {
    const frame = tail({ busy: true, held: true, draft: "streaming words here", thinking: "hmm", elapsedSecs: 3 });
    expect(frame).toContain("held — turn running");
    expect(frame).not.toContain("streaming words here");
    expect(frame).not.toContain("hmm");
  });
  test("held + idle renders nothing extra; unheld busy streams normally", () => {
    const idle = tail({ busy: false, held: true });
    expect(idle).not.toContain("held — turn running");
    const live = tail({ busy: true, draft: "streaming words here" });
    expect(live).toContain("streaming words here");
    expect(live).not.toContain("held — turn running");
  });
  test("one-line tool hint survives the hold (same line, no growth)", () => {
    const frame = tail({ busy: true, held: true, toolHint: "read" });
    expect(frame).toContain("held — turn running");
    expect(frame).toContain("Reading");
  });
});

describe("App held view mid-turn", () => {
  const realFetch = globalThis.fetch;

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

  test("PgUp mid-stream freezes the draft; End resumes it", async () => {
    const { App } = await import("../src/App.js");
    const { vi } = await import("vitest");
    // Open stream: one chunk lands, then the turn stays busy (never closes).
    const enc = new TextEncoder();
    globalThis.fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "held-marker-xyz" } }] })}\n\n`)
          );
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const app = render(
      <App
        apiKey="test-key"
        endpoint="https://opencode.ai/zen/v1/chat/completions"
        initialProvider="opencode-zen"
        initialModel="big-pickle"
        initialModels={["big-pickle"]}
      />
    );
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "held-marker-xyz");
      // PgUp holds the view: the growing draft collapses to a static line.
      app.stdin.write("\u001B[5~");
      await waitForFrame(app, "held — turn running");
      expect(app.lastFrame()).not.toContain("held-marker-xyz");
      // End resumes follow: the accumulated draft is back, turn still busy.
      app.stdin.write("\u001B[F");
      await waitForFrame(app, "held-marker-xyz");
      expect(app.lastFrame()).not.toContain("held — turn running");
    } finally {
      app.unmount();
      globalThis.fetch = realFetch;
    }
  });
});

describe("very long sessions", () => {
  test("5000 turns render bounded and fast", () => {
    const ts = turns(5000, "w");
    const started = Date.now();
    const frame = frameOf(<TranscriptView turns={ts} clearGen={1} />);
    const elapsed = Date.now() - started;
    expect(frame).toContain("w-4999");
    expect(frame).not.toContain("w-0");
    expect(elapsed).toBeLessThan(15000);
  }, 30000);
});
