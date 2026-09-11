// Commit-frontier tests: <Static> monotonic admission, follow/freeze
// modes, scroll actions, the new-output indicator, and long-session
// performance. Committed turns print to terminal scrollback ONCE and are
// never rewritten (no fullscreen flicker); the frontier (end) only gates
// FUTURE commits — PgUp freezes new output, End resumes the backlog.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import {
  ATOM_ART,
  TranscriptView,
  admitStaticBatch,
  applyScrollAction,
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

describe("admitStaticBatch", () => {
  test("follow commits the whole record with stable keys", () => {
    const ts = turns(500);
    const batch = admitStaticBatch(ts, 0, 500, true);
    expect(batch.next).toBe(500);
    expect(batch.items).toHaveLength(500);
    expect(batch.items[0]!.id).toBe("turn-0");
    expect(batch.items[499]!.id).toBe("turn-499");
  });
  test("frozen frontier admits nothing new (never retracts printed rows)", () => {
    const ts = turns(500);
    const first = admitStaticBatch(ts, 0, 500, true);
    expect(first.next).toBe(500);
    // PgUp below the committed count: empty batch, frontier unchanged.
    const held = admitStaticBatch(ts, first.next, 450, true);
    expect(held.items).toEqual([]);
    expect(held.next).toBe(500);
  });
  test("resume commits the backlog as a suffix", () => {
    const ts = turns(500);
    const frozen = admitStaticBatch(ts, 0, 450, true);
    expect(frozen.next).toBe(450);
    const resumed = admitStaticBatch(ts, frozen.next, 500, true);
    expect(resumed.items).toHaveLength(50);
    expect(resumed.items[0]!.id).toBe("turn-450");
    expect(resumed.next).toBe(500);
  });
  test("hidden thinking skips permanently (forward-only toggle)", () => {
    const ts: Turn[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "musing", thinking: true },
      { role: "assistant", content: "done" },
    ];
    const hidden = admitStaticBatch(ts, 0, 3, false);
    expect(hidden.items.map((i) => i.id)).toEqual(["turn-0", "turn-2"]);
    expect(hidden.next).toBe(3);
    // Toggling on later never backfills the skipped round…
    const later = admitStaticBatch(ts, hidden.next, 3, true);
    expect(later.items).toEqual([]);
    // …but newly admitted thinking rounds do show.
    const more: Turn[] = [...ts, { role: "assistant", content: "musing 2", thinking: true }];
    const tail = admitStaticBatch(more, hidden.next, 4, true);
    expect(tail.items.map((i) => i.id)).toEqual(["turn-3"]);
  });
  test("pairs merge within the admitted batch; split pairs degrade lone", () => {
    const ts: Turn[] = [
      ...turns(10),
      { role: "tool", content: "⚙ read f" },
      { role: "tool", content: "  ↳ Error: x", error: true },
    ];
    const whole = admitStaticBatch(ts, 0, 12, true);
    const pair = whole.items[whole.items.length - 1]!;
    expect(pair.turn?.error).toBe(true);
    expect(pair.label?.content).toBe("⚙ read f");
    // Label admitted while its detail sits beyond the frontier: the lone
    // label prints now, the lone detail later (both render gracefully).
    const labelOnly = admitStaticBatch(ts, 10, 11, true);
    expect(labelOnly.items).toHaveLength(1);
    expect(labelOnly.items[0]!.label).toBeUndefined();
    const detailOnly = admitStaticBatch(ts, 11, 12, true);
    expect(detailOnly.items).toHaveLength(1);
    expect(detailOnly.items[0]!.turn?.error).toBe(true);
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
    // A number (even === len) is manual mode: the frontier is frozen, new
    // turns accumulate as pending, and the live tail stops growing.
    const end = applyScrollAction(null, 5, { kind: "pageUp" });
    expect(end).not.toBeNull();
    // PgDn from the held bottom re-follows.
    expect(applyScrollAction(end, 7, { kind: "pageDown" })).toBe(null);
  });
});

describe("TranscriptView static commits", () => {
  test("short transcripts render whole (follow default)", () => {
    const frame = frameOf(<TranscriptView turns={turns(5)} clearGen={1} />);
    expect(frame).toContain("t-0");
    expect(frame).toContain("t-4");
    expect(frame).not.toContain("new — End");
  });
  test("long transcripts commit everything (terminal scrollback holds overflow)", () => {
    const frame = frameOf(<TranscriptView turns={turns(500)} clearGen={1} />);
    expect(frame).toContain("t-499");
    expect(frame).toContain("t-400");
    expect(frame).toContain("t-0");
    expect(frame).not.toContain("new — End");
  });
  test("frozen frontier holds new commits with a pending indicator", () => {
    const frame = frameOf(<TranscriptView turns={turns(500)} clearGen={1} end={450} />);
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
  test("banner prints once on fresh mounts, never on replacements", () => {
    const fresh = frameOf(<TranscriptView turns={turns(5)} clearGen={0} />);
    expect(fresh).toContain(ATOM_ART[0]!);
    expect(fresh).toContain("t-0");
    const replaced = frameOf(<TranscriptView turns={turns(5)} clearGen={1} />);
    expect(replaced).not.toContain(ATOM_ART[0]!);
    expect(replaced).toContain("t-0");
  });
  test("error pairing commits at admission", () => {
    const ts: Turn[] = [
      ...turns(200, "q"),
      { role: "tool", content: "⚙ read f" },
      { role: "tool", content: "  ↳ Error: x", error: true },
    ];
    const frame = frameOf(<TranscriptView turns={ts} clearGen={1} />);
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
  test("5000 turns commit once and stay out of the rewrite path", () => {
    const ts = turns(5000, "w");
    const started = Date.now();
    const frame = frameOf(<TranscriptView turns={ts} clearGen={1} />);
    const elapsed = Date.now() - started;
    // Static commits print the whole record once; later keystrokes rewrite
    // only the small dynamic frame (see static-frame.test.tsx for the byte
    // proof), so full sessions stay responsive.
    expect(frame).toContain("w-4999");
    expect(frame).toContain("w-0");
    expect(elapsed).toBeLessThan(15000);
  }, 30000);
});
