// Streaming polish tests: partial markdown never leaks markers, the stream
// converges byte-for-byte to the committed render, throttled bursts stay
// paint-bounded, and very long drafts render head-to-tail.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import {
  MarkdownStream,
  MarkdownText,
  closeStreamingMarkers,
} from "../src/ui/markdown.js";
import { createDraftThrottler } from "../src/App.js";
import { LiveTail } from "../src/ui/live-tail.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("closeStreamingMarkers", () => {
  test("auto-closes trailing openers", () => {
    expect(closeStreamingMarkers("a **bold")).toBe("a **bold**");
    expect(closeStreamingMarkers("use `code")).toBe("use `code`");
    expect(closeStreamingMarkers("__it")).toBe("__it__");
  });
  test("leaves balanced text and literals alone", () => {
    expect(closeStreamingMarkers("a **b** c")).toBe("a **b** c");
    expect(closeStreamingMarkers("a ** b")).toBe("a ** b");
    expect(closeStreamingMarkers("my_var")).toBe("my_var");
    expect(closeStreamingMarkers("plain")).toBe("plain");
  });
});

describe("MarkdownStream partials", () => {
  test("no marker leakage mid-stream", () => {
    const fence = frameOf(<MarkdownStream text={"```ts\ncode()\nmore"} />);
    expect(fence).toContain("code()");
    expect(fence).toContain("more");
    expect(fence).not.toContain("```");
    const bold = frameOf(<MarkdownStream text={"done **half"} />);
    expect(bold).toContain("half");
    expect(bold).not.toContain("**");
    const code = frameOf(<MarkdownStream text={"run `cmd"} />);
    expect(code).toContain("cmd");
    expect(code).not.toContain("`");
  });
  test("converges to the committed render (cursor aside)", () => {
    const full = "## Head\n\n- **bold** item\n\n```ts\ncode()\n```\n\nSee [docs](http://x).";
    const stream = frameOf(<MarkdownStream text={full} />).replace(/▍/g, "");
    const committed = frameOf(<MarkdownText text={full} />);
    expect(stream).toBe(committed);
  });
  test("draft + tool hint coexist in the live tail", () => {
    const frame = frameOf(
      <LiveTail
        isEmpty={false}
        sessionHint={false}
        draft={"partial **answer"}
        thinking={null}
        busy
        toolHint="read"
        toolElapsedSecs={null}
        elapsedSecs={5}
      />
    );
    expect(frame).toContain("ATOM>");
    expect(frame).toContain("answer");
    expect(frame).not.toContain("**");
    expect(frame).toContain("◉ Reading");
  });
});

describe("paint bounds under burst", () => {
  test("500 pushes over 5s stay throttle-bounded", () => {
    let nowMs = 0;
    const timers = new Map<number, { cb: () => void; at: number }>();
    let seq = 1;
    const setTimeoutFn = ((cb: (...args: unknown[]) => void, ms?: number) => {
      const id = seq++;
      timers.set(id, { cb: () => cb(), at: nowMs + (ms ?? 0) });
      return id as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;
    const clearTimeoutFn = ((id: unknown) => {
      timers.delete(id as number);
    }) as unknown as typeof clearTimeout;
    const advance = (ms: number) => {
      nowMs += ms;
      for (;;) {
        let next: number | null = null;
        let at = Number.POSITIVE_INFINITY;
        for (const [id, t] of timers) {
          if (t.at <= nowMs && t.at < at) {
            at = t.at;
            next = id;
          }
        }
        if (next === null) return;
        const cb = timers.get(next)!.cb;
        timers.delete(next);
        cb();
      }
    };
    let paints = 0;
    let latest = "";
    const th = createDraftThrottler({
      now: () => nowMs,
      setTimeoutFn,
      clearTimeoutFn,
      onFlush: (t) => {
        paints += 1;
        latest = t;
      },
    });
    for (let i = 0; i < 500; i++) {
      th.push(`token-${i}`);
      advance(10);
    }
    th.flush();
    // ~64ms window over 5000ms ⇒ ≤ ~80 paints + slack; final converges exact.
    expect(paints).toBeLessThanOrEqual(90);
    expect(latest).toBe("token-499");
  });
});

describe("very long draft", () => {
  test("5000-line markdown renders head-to-tail", () => {
    const body = Array.from(
      { length: 5000 },
      (_, i) => (i % 10 === 0 ? `## Section ${i}` : `- item ${i} with **bold** and \`code\``)
    ).join("\n");
    const started = Date.now();
    const frame = frameOf(<MarkdownStream text={body} />);
    const elapsed = Date.now() - started;
    expect(frame).toContain("Section 0");
    expect(frame).toContain("item 4999");
    expect(frame).not.toContain("**");
    // Generous bound: proves linear single-parse, not quadratic blowup.
    expect(elapsed).toBeLessThan(15000);
  }, 30000);
});
