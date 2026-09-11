// Render-cache tests: expensive work must run once per unique input, never
// per unrelated render. Covers: streaming Markdown skips timer ticks,
// transcript rows skip unrelated App renders, and the bounded caches
// (markdown parse, highlight) return identical refs for identical inputs.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { sameSkillMenuSnapshot } from "../src/App.js";
import { LiveTail } from "../src/ui/live-tail.js";
import {
  parseMarkdownCached,
  streamParseProbe,
} from "../src/ui/markdown.js";
import {
  highlightCacheSize,
  highlightLine,
} from "../src/ui/highlight.js";
import {
  TranscriptView,
  transcriptRenderProbe,
  transcriptRowRenderProbe,
  type Turn,
} from "../src/ui/transcript.js";

describe("streaming markdown parse isolation", () => {
  function tail(over: Partial<React.ComponentProps<typeof LiveTail>> = {}) {
    return (
      <LiveTail
        isEmpty={false}
        sessionHint={false}
        draft={null}
        thinking={null}
        busy
        toolHint={null}
        toolElapsedSecs={null}
        elapsedSecs={0}
        {...over}
      />
    );
  }

  test("timer ticks with identical draft text never reparse", () => {
    const app = render(tail({ draft: "streaming **bold** answer", elapsedSecs: 3 }));
    try {
      const before = streamParseProbe.count;
      // 1s busy tick: only the clock changes, the draft text is identical.
      app.rerender(tail({ draft: "streaming **bold** answer", elapsedSecs: 4 }));
      expect(streamParseProbe.count).toBe(before);
      expect(app.lastFrame()).toContain("bold");
      expect(app.lastFrame()).not.toContain("**");
      // Changed text re-parses (markers still close safely mid-stream).
      app.rerender(tail({ draft: "streaming **bold** answer plus `code", elapsedSecs: 4 }));
      expect(streamParseProbe.count).toBeGreaterThan(before);
      expect(app.lastFrame()).toContain("code");
      expect(app.lastFrame()).not.toContain("`");
    } finally {
      app.unmount();
    }
  });
});

describe("transcript row cache hits", () => {
  test("new turns array with identical refs mounts nothing new", () => {
    const turns: Turn[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1 with **bold**" },
      { role: "tool", content: "⚙ read f.ts" },
    ];
    const app = render(<TranscriptView turns={turns} clearGen={0} />);
    try {
      const rowsBefore = transcriptRowRenderProbe.count;
      // Unrelated App render: fresh array identity, same turn refs
      // (e.g. a tick or keystroke that rebuilt the parent).
      app.rerender(<TranscriptView turns={[...turns]} clearGen={0} />);
      expect(transcriptRenderProbe.count).toBeGreaterThan(0);
      // Every row bails via item-identity compare — no markdown reparse,
      // no diff recompute, no highlight walk for unchanged rows.
      expect(transcriptRowRenderProbe.count).toBe(rowsBefore);
      expect(app.lastFrame()).toContain("a1");
    } finally {
      app.unmount();
    }
  });
});

describe("bounded cache identity", () => {
  test("identical markdown input returns the identical block ref", () => {
    const text = "## Head\n\n- item with `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const first = parseMarkdownCached(text);
    expect(parseMarkdownCached(text)).toBe(first);
    expect(parseMarkdownCached(`${text}\nmore`)).not.toBe(first);
  });

  test("highlight keys on lang + line and stays bounded", () => {    const line = "const x = fetch(url); // call it";
    const first = highlightLine(line, "c");
    expect(highlightLine(line, "c")).toBe(first);
    // Different language, different tokenization — must not collide.
    expect(highlightLine(line, "py")).not.toBe(first);
    for (let i = 0; i < 3000; i++) {
      highlightLine(`const unique_line_${i} = ${i};`, "c");
    }
    expect(highlightCacheSize()).toBeLessThanOrEqual(2000);
  });

  test("skill-menu refresh with identical discoveries keeps array identity", () => {
    const a = [{ name: "x", description: "d" }];
    const b = [{ name: "x", description: "d" }];
    expect(sameSkillMenuSnapshot(a, b)).toBe(true);
    expect(sameSkillMenuSnapshot(a, [...b, { name: "y", description: "e" }])).toBe(false);
    expect(sameSkillMenuSnapshot(a, [{ name: "x", description: "changed" }])).toBe(false);
    expect(sameSkillMenuSnapshot([], [])).toBe(true);
  });
});
