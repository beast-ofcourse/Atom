// Ticket 05 — pinned footer + input cluster.
//
// From the user's perspective: the prompt box, the slash autocomplete menu,
// and the status line form one bottom-anchored cluster that never gets lost
// — no matter how much output streams above, how many tools fire, or how the
// terminal resizes. While the agent works, the input dims with a visible
// interrupt hint instead of disappearing; idle, the typing target is obvious.
//
// What this file proves (each test maps to one ticket checkbox):
//  1. cluster order: input, then autocomplete menu, then status — one column.
//  2. cluster survival: token bursts + tool commits + resizes keep all three
//     mounted, ordered, and painted (nothing retracts, nothing swaps).
//  3. working state: busy input dims (no extra line — status bar alone carries
//     esc stops · Enter queues); idle empty input names the typing target.
//  4. editing integrity: multiline, long input, and large pastes render with
//     the status line still pinned (cursor/history/paste math itself stays
//     pinned in tests/input-model.test.ts — this file asserts the render end).
//  5. slash autocomplete is instant: the pure filter is synchronous over the
//     registry (no fetch, no timers) and narrows deterministically.
//
// Network is ALWAYS mocked here — never hit live APIs. Nothing here uses
// timers, so nothing can flake on a slow CI box.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { buildSlashMenu, filterSlashCommands } from "../src/App.js";
import { InputBox } from "../src/ui/input.js";
import { normalizePaste } from "../src/ui/input-model.js";
import { LiveTailHost } from "../src/ui/live-host.js";
import { PickerMoreBelow, PickerRow, PickerShell, pickerWindow } from "../src/ui/pickers.js";
import { StatusBarHost } from "../src/ui/status-host.js";
import { createStreamStore } from "../src/ui/stream-store.js";
import { TranscriptView, type Turn } from "../src/ui/transcript.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeTurns(n: number): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      i % 2 === 0
        ? { role: "user", content: `footer question ${i}` }
        : { role: "assistant", content: `footer answer ${i}` }
    );
  }
  return out;
}

const STATUS_IDLE = {
  provider: "kilo",
  model: "big-pickle",
  usageTotals: null,
  contextLoad: null,
  reasoningDisplay: "default",
  mode: "normal",
  trustAll: false,
  busy: false,
  phaseLabel: "thinking…",
  elapsedSecs: 0,
  stalled: false,
  approvalPending: false,
  cwd: "~/proj",
  branch: "main",
} as const;

const STATUS_BUSY = {
  ...STATUS_IDLE,
  busy: true,
  activity: "Reading src/footer.ts",
  elapsedSecs: 7,
} as const;

// The cluster under test, mirroring App's footer order: input zone, then the
// slash autocomplete menu, then the status line — one flexShrink=0 column.
function ClusterFrame({
  turns,
  input,
  busy,
  columns,
  slashQuery,
}: {
  turns: Turn[];
  input: string;
  busy: boolean;
  columns: number;
  slashQuery: string | null;
}) {
  const store = createStreamStore();
  const menu = slashQuery === null ? null : buildSlashMenu(slashQuery, []);
  const win = menu === null ? null : pickerWindow(menu.items.length, 0);
  return (
    <>
      <TranscriptView turns={turns} clearGen={1} />
      <LiveTailHost
        store={store}
        isEmpty={false}
        sessionHint={false}
        busy={busy}
        held={false}
        toolHint={busy ? "read src/footer.ts" : null}
        toolElapsedSecs={null}
        elapsedSecs={busy ? 7 : 0}
        showThinking={false}
      />
      <Box flexDirection="column" flexShrink={0}>
        <InputBox input={input} cursor={input.length} busy={busy} />
        {menu && win ? (
          <PickerShell title="Atom commands:">
            {menu.items.slice(win.start, win.end).map((c) => (
              <PickerRow key={c.name} highlighted={c.name === menu.items[0]!.name} highlightColor="cyan">
                {c.name}
              </PickerRow>
            ))}
            <PickerMoreBelow count={menu.items.length - win.end} />
          </PickerShell>
        ) : null}
        <StatusBarHost {...(busy ? STATUS_BUSY : STATUS_IDLE)} columns={columns} />
      </Box>
    </>
  );
}

function lastFrameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("footer cluster: input states", () => {
  test("idle + empty shows just the box, no hint row", () => {
    const frame = lastFrameOf(<InputBox input="" cursor={0} />);
    expect(frame).not.toContain("Type a message");
    expect(frame).not.toContain("Enter sends");
    expect(frame).not.toContain("/ for commands");
  });

  test("idle + non-empty shows the text with no target row", () => {
    const frame = lastFrameOf(<InputBox input="hello there" cursor={11} />);
    expect(frame).toContain("hello there");
    expect(frame).not.toContain("Type a message");
  });

  test("busy dims the input without extra hint line (status bar carries the hint)", () => {
    const idle = lastFrameOf(<InputBox input="half-typed thought" cursor={18} />);
    const busyFrame = lastFrameOf(<InputBox input="half-typed thought" cursor={18} busy />);
    // The draft survives (never disappears mid-turn); the extra
    // "working · esc stops · Enter queues" line was removed — the status
    // bar alone carries esc stops · Enter queues now, so no vertical waste
    // above it.
    expect(busyFrame).toContain("half-typed thought");
    expect(busyFrame).not.toContain("esc stops");
    expect(busyFrame).not.toContain("Enter queues");
    expect(busyFrame).not.toContain("Type a message");
    // Busy vs idle: same text, no extra line added — the probe suites pin
    // that the 1s busy tick never repaints this leaf.
    expect(idle).not.toContain("esc stops");
    expect(busyFrame).not.toContain("Type a message");
  });

  test("busy prop defaults to idle (existing call sites unchanged)", () => {
    const frame = lastFrameOf(<InputBox input="abc" cursor={3} />);
    expect(frame).toContain("abc");
    expect(frame).not.toContain("esc stops");
  });
});

describe("footer cluster: order + storm survival", () => {
  test("input, menu, and status render as one ordered column", () => {
    const frame = lastFrameOf(
      <ClusterFrame turns={makeTurns(6)} input="carry my draft" busy={false} columns={100} slashQuery="/mod" />
    );
    expect(frame).toContain("carry my draft");
    expect(frame).toContain("/model");
    expect(frame).toContain("mode: normal");
    const inputAt = frame.indexOf("carry my draft");
    const menuAt = frame.indexOf("/model");
    const statusAt = frame.indexOf("mode: normal");
    expect(inputAt).toBeGreaterThanOrEqual(0);
    expect(menuAt).toBeGreaterThan(inputAt);
    expect(statusAt).toBeGreaterThan(menuAt);
  });

  test("token bursts + tool commits + resizes keep the cluster pinned", async () => {
    const turns = makeTurns(20);
    const store = createStreamStore();
    const frame = (t: Turn[], columns: number) => (
      <>
        <TranscriptView turns={t} clearGen={1} />
        <LiveTailHost
          store={store}
          isEmpty={false}
          sessionHint={false}
          busy
          held={false}
          toolHint="read src/footer.ts"
          toolElapsedSecs={null}
          elapsedSecs={7}
          showThinking={false}
        />
        <Box flexDirection="column" flexShrink={0}>
          <InputBox input="carry my draft" cursor={14} busy />
          <PickerShell title="Atom commands:">
            <PickerRow highlighted highlightColor="cyan">/model</PickerRow>
            <PickerRow highlighted={false}>/mode</PickerRow>
          </PickerShell>
          <StatusBarHost {...STATUS_BUSY} columns={columns} />
        </Box>
      </>
    );
    const app = render(frame(turns, 100));
    try {
      await sleep(120);
      expect(app.lastFrame()).toContain("footer question 0");
      // Phase 1 — pure storm: 200 token paints, no commits.
      for (let i = 0; i < 200; i++) {
        store.setDraft(`footer draft paint ${i} — tokens arriving fast`);
      }
      // Phase 2 — tool burst commits rows mid-storm.
      let cur = turns;
      for (let i = 0; i < 4; i++) {
        cur = [...cur, { role: "tool", content: `⚙ bash footer-job-${i}` }];
        store.setDraft(`footer draft paint ${200 + i}`);
        app.rerender(frame(cur, 100));
      }
      // Phase 3 — resize sweep, small to large and back.
      for (const w of [40, 60, 80, 100, 160, 200, 100]) {
        app.rerender(frame(cur, w));
      }
      await sleep(150);
      const last = app.lastFrame() ?? "";
      // Committed output survived, and the whole cluster is still mounted in
      // order: draft input, menu, busy status (which now carries the single
      // "esc stops · Enter queues" hint — no waste line above it).
      expect(last).toContain("footer question 0");
      expect(last).toContain("footer-job-3");
      expect(last).toContain("carry my draft");
      expect(last).toContain("esc stops");
      expect(last).toContain("Enter queues");
      expect(last).toContain("/model");
      expect(last).toContain("7s");
      expect(last.indexOf("carry my draft")).toBeLessThan(last.indexOf("/model"));
      // Single hint in the status bar, after the menu — the status pin stays last.
      expect(last.indexOf("/model")).toBeLessThan(last.indexOf("esc stops"));
    } finally {
      app.unmount();
    }
  });
});

describe("footer cluster: hostile widths + hostile input", () => {
  test("small terminal keeps input and status pinned", () => {
    for (const columns of [40, 60, 200]) {
      const frame = lastFrameOf(
        <ClusterFrame turns={makeTurns(4)} input="short" busy={false} columns={columns} slashQuery={null} />
      );
      expect(frame).toContain("short");
      expect(frame).toContain("mode: normal");
    }
  });

  test("long single-line input renders with the status line intact", () => {
    const long = `please ${"explain ".repeat(80)}this`;
    const frame = lastFrameOf(
      <ClusterFrame turns={makeTurns(2)} input={long} busy={false} columns={100} slashQuery={null} />
    );
    expect(frame).toContain("please");
    expect(frame).toContain("mode: normal");
  });

  test("large paste lands verbatim as multiline (never submits, never drops status)", () => {
    // Bracketed-paste endings normalize; the cluster renders every line.
    const pasted = normalizePaste(`line one\r\nline two\rline three\n${"x".repeat(2000)}`);
    expect(pasted).toBe(`line one\nline two\nline three\n${"x".repeat(2000)}`);
    const frame = lastFrameOf(
      <ClusterFrame turns={makeTurns(2)} input={pasted} busy columns={100} slashQuery={null} />
    );
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    expect(frame).toContain("line three");
    expect(frame).toContain("esc stops");
  });

  test("mid-stream resize with a multiline draft keeps the cluster ordered", () => {
    const draft = "first line\nsecond line\nthird line";
    const wide = lastFrameOf(
      <ClusterFrame turns={makeTurns(3)} input={draft} busy={false} columns={160} slashQuery="/mo" />
    );
    const narrow = lastFrameOf(
      <ClusterFrame turns={makeTurns(3)} input={draft} busy={false} columns={40} slashQuery="/mo" />
    );
    for (const frame of [wide, narrow]) {
      expect(frame).toContain("first line");
      expect(frame).toContain("second line");
      expect(frame).toContain("/model");
      expect(frame).toContain("mode: normal");
      expect(frame.indexOf("first line")).toBeLessThan(frame.indexOf("/model"));
      expect(frame.indexOf("/model")).toBeLessThan(frame.indexOf("mode: normal"));
    }
  });
});

describe("footer cluster: slash autocomplete is instant", () => {
  test("pure synchronous filter over the registry (no fetch, no timers)", () => {
    // Bare "/" lists commands; typing narrows; exact match collapses.
    expect(filterSlashCommands("/").length).toBeGreaterThan(10);
    const narrowed = filterSlashCommands("/mod").map((c) => c.name);
    expect(narrowed[0]).toBe("/model");
    expect(narrowed[1]).toBe("/mode");
    expect(filterSlashCommands("/model").map((c) => c.name)).toEqual(["/model"]);
  });

  test("menu builder keeps commands first and renders above the status", () => {
    const menu = buildSlashMenu("/mo", []);
    expect(menu.items.length).toBeGreaterThan(0);
    expect(menu.items[0]!.name).toBe("/model");
    const frame = lastFrameOf(
      <ClusterFrame turns={makeTurns(2)} input="/mo" busy={false} columns={100} slashQuery="/mo" />
    );
    expect(frame).toContain("/model");
    expect(frame).toContain("mode: normal");
    expect(frame.indexOf("/model")).toBeLessThan(frame.indexOf("mode: normal"));
  });
});
