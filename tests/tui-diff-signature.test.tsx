// Ticket 02 — diff preview signature look.
//
// Pins the one quiet, recognizable diff design shared by the approval
// modal, the committed transcript, and the session-changes review:
//  1. single-line summary header (counts, path, line range), no banner;
//  2. separator column aligned for varying lengths, tabs, wide chars;
//  3. approval modal keeps allow/deny on screen for large diffs;
//  4. narrow terminals degrade to stacked unified, never crushed panes;
//  5. unchanged rows stay subordinate (dim) to changed rows.
//
// Network is ALWAYS mocked here — never hit live APIs.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { computeDiff, hunksRange, rangeLabel, sbsRange, computeSideBySide } from "../src/ui/diff.js";
import { DiffView } from "../src/ui/diff-view.js";
import { SideBySideDiffView, SBS_NARROW_COLUMNS } from "../src/ui/side-by-side.js";
import { ApprovalBox } from "../src/ui/modals.js";
import { DiffPanel, groupSessionDiffs } from "../src/ui/diff-panel.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Independent terminal-cell width (standard East-Asian wide ranges —
// deliberately NOT imported from the component, so the test pins the
// contract rather than the implementation).
function cellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  )
    return 2;
  return 1;
}

function cellIndexOfSep(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === "│") return w;
    w += cellWidth(ch);
  }
  return -1;
}

describe("signature header: one line, counts + path + range", () => {
  test("side-by-side header names counts, path, and line range on one line", () => {
    const frame = stripAnsi(
      frameOf(
        <SideBySideDiffView
          oldText={"keep\nOLD\nkeep"}
          newText={"keep\nNEW\nkeep"}
          lang={null}
          path="src/x.ts"
          columns={100}
        />
      )
    );
    expect(frame).not.toContain("BEFORE");
    expect(frame).not.toContain("AFTER");
    const header = frame.split("\n").find((l) => l.includes("+1"));
    expect(header).toBeDefined();
    expect(header).toContain("−1");
    expect(header).toContain("src/x.ts");
    expect(header).toContain("L2");
  });
  test("unified header carries the same signature (narrow-view parity)", () => {
    const frame = stripAnsi(
      frameOf(<DiffView oldText={"a\nOLD\nb"} newText={"a\nNEW\nb"} path="src/x.ts" />)
    );
    const header = frame.split("\n").find((l) => l.includes("+1"));
    expect(header).toBeDefined();
    expect(header).toContain("−1");
    expect(header).toContain("src/x.ts");
    expect(header).toContain("L2");
  });
  test("new files mark instead of ranging", () => {
    const frame = stripAnsi(
      frameOf(<SideBySideDiffView oldText={null} newText={"a\nb"} path="new.ts" columns={100} />)
    );
    expect(frame).toContain("new file");
    expect(frame).toContain("+2");
    expect(frame).toContain("new.ts");
  });
  test("range helpers: single line collapses, spans expand, one-sided degrades", () => {
    expect(rangeLabel({ oldMin: 2, oldMax: 2, newMin: 2, newMax: 2 })).toBe("L2");
    expect(rangeLabel({ oldMin: 2, oldMax: 20, newMin: 2, newMax: 21 })).toBe(
      "L2–20 → L2–21"
    );
    expect(rangeLabel({ oldMin: null, oldMax: null, newMin: 5, newMax: 7 })).toBe("L5–7");
    // Engine parity: unified hunks and side-by-side rows agree.
    const oldT = ["1", "2", "3", "4", "5", "OLD", "7", "8", "9", "10", "11"].join("\n");
    const newT = ["1", "2", "3", "4", "5", "NEW", "7", "8", "9", "10", "11"].join("\n");
    const hunks = computeDiff(oldT, newT).hunks;
    const sbs = computeSideBySide(oldT, newT);
    if (sbs.kind !== "diff") throw new Error("expected diff");
    expect(rangeLabel(hunksRange(hunks))).toBe(rangeLabel(sbsRange(sbs.rows)));
    expect(rangeLabel(hunksRange(hunks))).toBe("L6");
  });
});

describe("separator column stability", () => {
  test("varying lengths, tabs, and wide chars keep one separator column", () => {
    const oldT = [
      "x",
      "\tindented with tab",
      "日本語の行 wide characters here",
      `a very long line ${"z".repeat(60)}`,
      "short",
      "OLD",
    ].join("\n");
    const newT = [
      "x",
      "\tindented with tab!",
      "日本語の行 wide characters here!",
      `a very long line ${"z".repeat(60)}!`,
      "short",
      "NEW",
    ].join("\n");
    const frame = stripAnsi(
      frameOf(<SideBySideDiffView oldText={oldT} newText={newT} lang={null} columns={100} />)
    );
    const rows = frame.split("\n").filter((l) => l.includes("│"));
    // Several data rows render (header carries no │ by design).
    expect(rows.length).toBeGreaterThan(4);
    const cols = rows.map(cellIndexOfSep);
    for (const c of cols) expect(c).toBeGreaterThan(0);
    expect(new Set(cols).size).toBe(1);
  });
  test("unpaired add/del rows pad the empty cell, separator unmoved", () => {
    const frame = stripAnsi(
      frameOf(
        <SideBySideDiffView oldText={"a\nb"} newText={"a\nNEW1\nNEW2\nb"} lang={null} columns={100} />
      )
    );
    const rows = frame.split("\n").filter((l) => l.includes("│"));
    expect(rows.length).toBeGreaterThan(2);
    expect(new Set(rows.map(cellIndexOfSep)).size).toBe(1);
  });
});

describe("approval modal keeps allow/deny on screen", () => {
  test("large diff windows the body with a trailer above the options", () => {
    const oldT = Array.from({ length: 200 }, (_, i) => `old-${i}`).join("\n");
    const newT = Array.from({ length: 200 }, (_, i) => `new-${i}`).join("\n");
    const frame = stripAnsi(
      frameOf(
        <ApprovalBox
          toolName="write"
          description="⚙ write big-file.txt"
          selected={0}
          diff={{ oldText: oldT, newText: newT, lang: null, path: "big-file.txt" }}
        />
      )
    );
    // Windowed body + remainder trailer (never pushes options off screen).
    expect(frame).toContain("more row");
    expect(frame).toContain("Full diff renders in the transcript on approve.");
    // Allow/deny options still render below the preview.
    expect(frame).toContain("[y]es once");
    expect(frame).toContain("[n]o — deny this call");
    expect(frame).toContain("❯ [y]es once");
    expect(frame).toContain("big-file.txt");
  });
});

describe("narrow terminals degrade to stacked unified", () => {
  test("below the threshold there are no panes, only @@ hunks", () => {
    const frame = stripAnsi(
      frameOf(
        <SideBySideDiffView
          oldText={"a\nOLD"}
          newText={"a\nNEW"}
          lang={null}
          path="src/x.ts"
          columns={SBS_NARROW_COLUMNS - 10}
        />
      )
    );
    expect(frame).toContain("@@");
    expect(frame).not.toContain("│");
    expect(frame).not.toContain("BEFORE");
    // The signature header survives the degrade (counts + path + range).
    expect(frame).toContain("+1");
    expect(frame).toContain("src/x.ts");
  });
  test("at/above the threshold panes render", () => {
    const frame = stripAnsi(
      frameOf(
        <SideBySideDiffView
          oldText={"a\nOLD"}
          newText={"a\nNEW"}
          lang={null}
          columns={SBS_NARROW_COLUMNS}
        />
      )
    );
    expect(frame).toContain("│");
  });
});

describe("unchanged rows stay subordinate", () => {
  test("context rows render verbatim with no change chrome", () => {
    const frame = stripAnsi(
      frameOf(
        <SideBySideDiffView
          oldText={"keep\nOLD\nkeep"}
          newText={"keep\nNEW\nkeep"}
          lang={null}
          columns={100}
        />
      )
    );
    const lines = frame.split("\n");
    // Header is the only chrome: one quiet line, no banner, no hunk headers.
    expect(lines.filter((l) => l.includes("+1"))).toHaveLength(1);
    expect(frame).not.toContain("@@");
    // Changed content present on both panes; unchanged context verbatim.
    expect(frame).toContain("OLD");
    expect(frame).toContain("NEW");
    expect(lines.filter((l) => l.includes("keep")).length).toBeGreaterThanOrEqual(2);
    // Engine marks unchanged rows as context — the view renders those dim
    // by construction (subordinate), changed rows with +/- identity.
    const built = computeSideBySide("keep\nOLD\nkeep", "keep\nNEW\nkeep");
    if (built.kind !== "diff") throw new Error("expected diff");
    expect(built.rows.map((r) => r.kind)).toEqual(["context", "change", "context"]);
  });
});

describe("/diff review shares the signature", () => {
  test("expanded panel renders the one-line header, no rule chrome", () => {
    const files = groupSessionDiffs([
      { diff: { oldText: "keep\nOLD\nkeep", newText: "keep\nNEW\nkeep", lang: null, path: "src/x.ts" } },
    ]);
    expect(files).toHaveLength(1);
    const frame = stripAnsi(frameOf(<DiffPanel files={files} index={0} expanded />));
    expect(frame).toContain("+1");
    expect(frame).toContain("−1");
    expect(frame).toContain("src/x.ts");
    expect(frame).not.toContain("BEFORE");
    expect(frame).not.toContain("────");
  });
});
