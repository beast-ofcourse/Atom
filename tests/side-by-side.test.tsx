// Side-by-side diff tests: the BEFORE/AFTER presentation for write/edit
// results (ui/side-by-side over the ui/diff engine). Covers the required
// matrix: single edit, multi-region edits, create, overwrite, no-op,
// large diffs, long lines, narrow terminals, consecutive edits.
// Network ALWAYS mocked — never hit live APIs.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { computeSideBySide } from "../src/ui/diff.js";
import { SideBySideDiffView } from "../src/ui/side-by-side.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("computeSideBySide builder", () => {
  test("paired change shares one row with both line numbers", () => {
    const r = computeSideBySide("line1\nOLD\nline3", "line1\nNEW\nline3");
    if (r.kind !== "diff") throw new Error(`expected diff, got ${r.kind}`);
    expect(r.adds).toBe(1);
    expect(r.dels).toBe(1);
    const change = r.rows.find((x) => x.kind === "change");
    if (change?.kind !== "change") throw new Error("expected a change row");
    expect(change.oldNo).toBe(2);
    expect(change.newNo).toBe(2);
    expect(change.oldText).toBe("OLD");
    expect(change.newText).toBe("NEW");
    // Context lines flank on both sides with matching numbers.
    const ctx = r.rows.filter((x) => x.kind === "context");
    expect(ctx.map((x) => (x.kind === "context" ? x.oldNo : -1))).toEqual([1, 3]);
  });
  test("separated regions stay in hunks with context between", () => {
    const oldT = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const newT = Array.from({ length: 20 }, (_, i) =>
      i === 2 || i === 17 ? `CHANGED${i + 1}` : `line${i + 1}`
    ).join("\n");
    const r = computeSideBySide(oldT, newT);
    if (r.kind !== "diff") throw new Error(`expected diff, got ${r.kind}`);
    expect(r.adds).toBe(2);
    expect(r.dels).toBe(2);
    // Whole file untouched regions are NOT all shown (hunks only).
    expect(r.rows.length).toBeLessThan(20);
    const changes = r.rows.filter((x) => x.kind === "change");
    const first = r.rows.indexOf(changes[0]!);
    const last = r.rows.indexOf(changes[changes.length - 1]!);
    const between = r.rows.slice(first + 1, last);
    expect(between.some((x) => x.kind === "context")).toBe(true);
  });
  test("null old renders a create (right-only rows)", () => {
    const r = computeSideBySide(null, "a\nb");
    if (r.kind !== "diff") throw new Error(`expected diff, got ${r.kind}`);
    expect(r.isNewFile).toBe(true);
    expect(r.rows.every((x) => x.kind === "change")).toBe(true);
  });
  test("identical texts report no-op", () => {
    expect(computeSideBySide("same\ntext", "same\ntext")).toEqual({ kind: "same" });
  });
  test("binary input reports binary, never textual rows", () => {
    const nul = String.fromCharCode(0);
    expect(computeSideBySide(`a${nul}b`, "c")).toEqual({ kind: "binary" });
  });
  test("giant change renders whole (no row cap)", () => {
    const oldT = Array.from({ length: 500 }, (_, i) => `old-${i}`).join("\n");
    const newT = Array.from({ length: 500 }, (_, i) => `new-${i}`).join("\n");
    const r = computeSideBySide(oldT, newT);
    if (r.kind !== "diff") throw new Error(`expected diff, got ${r.kind}`);
    expect(r.truncated).toBe(false);
    const changed = r.rows.filter((x) => x.kind === "change").length;
    expect(changed).toBe(500);
  });
  test("pure addition aligns new lines against an empty left", () => {
    const r = computeSideBySide("a\nb", "a\nNEW\nb");
    if (r.kind !== "diff") throw new Error(`expected diff, got ${r.kind}`);
    const add = r.rows.find((x) => x.kind === "change");
    if (add?.kind !== "change") throw new Error("expected a change row");
    expect(add.oldText).toBeNull();
    expect(add.newText).toBe("NEW");
    expect(add.newNo).toBe(2);
  });
});

describe("SideBySideDiffView rendering", () => {
  test("BEFORE/AFTER panes with aligned content", () => {
    const frame = stripAnsi(
      frameOf(<SideBySideDiffView oldText="keep\nOLD\nkeep" newText="keep\nNEW\nkeep" lang={null} />)
    );
    expect(frame).toContain("BEFORE");
    expect(frame).toContain("AFTER");
    expect(frame).toContain("OLD");
    expect(frame).toContain("NEW");
    expect(frame).toContain("+1");
    expect(frame).toContain("−1");
  });
  test("create shows new-file marker with right-side rows", () => {
    const frame = stripAnsi(frameOf(<SideBySideDiffView oldText={null} newText="hello" />));
    expect(frame).toContain("new file");
    expect(frame).toContain("hello");
  });
  test("no-op renders the unchanged notice, never an empty diff", () => {
    const frame = stripAnsi(frameOf(<SideBySideDiffView oldText="same" newText="same" />));
    expect(frame).toContain("no changes");
    expect(frame).not.toContain("BEFORE");
  });
  test("binary renders the compact notice", () => {
    const nul = String.fromCharCode(0);
    const frame = stripAnsi(
      frameOf(<SideBySideDiffView oldText={`a${nul}b`} newText="c" />)
    );
    expect(frame).toContain("binary file changed");
  });
  test("narrow terminals degrade to stacked unified", () => {
    const frame = stripAnsi(
      frameOf(
        <SideBySideDiffView oldText="a\nOLD" newText="a\nNEW" lang={null} columns={60} />
      )
    );
    expect(frame).toContain("@@");
    expect(frame).not.toContain("BEFORE");
  });
  test("long lines truncate per pane without breaking layout", () => {
    const long = `x = "${"a".repeat(200)}"`;
    const frame = stripAnsi(
      frameOf(<SideBySideDiffView oldText={long} newText={`${long} # c`} lang="py" />)
    );
    expect(frame).not.toContain("a".repeat(200));
    expect(frame).toContain("…");
    // Every rendered row still fits a narrow-enough width.
    for (const line of frame.split("\n")) {
      expect([...line].length).toBeLessThanOrEqual(100);
    }
  });
  test("maxRows collapses the tail with a trailer", () => {
    const oldT = Array.from({ length: 10 }, (_, i) => `same-${i}`).join("\n");
    const newT = `${oldT}\nEXTRA1\nEXTRA2\nEXTRA3`;
    const frame = stripAnsi(
      frameOf(<SideBySideDiffView oldText={oldT} newText={newT} maxRows={4} />)
    );
    expect(frame).toContain("more row");
    expect(frame).not.toContain("EXTRA3");
  });
});

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

function toolMsg(id: string, name: string, args: Record<string, unknown>) {
  return {
    message: {
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
  };
}
function textMsg(content: string) {
  return { message: { content } };
}
function mockChatScriptMessages(messages: unknown[]) {
  const queue = [...messages];
  globalThis.fetch = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { ok: true, json: async () => ({ choices: [next] }) } as Response;
  });
}
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
function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
  };
}
async function cleanProbes(...probes: string[]) {
  const { rm } = await import("node:fs/promises");
  for (const p of probes) {
    try {
      await rm(p, { force: true });
    } catch {
      // ignore
    }
  }
}

describe("side-by-side transcript commits", () => {
  test("overwrite write shows full BEFORE and AFTER panes", async () => {
    const probe = "sbs-probe-overwrite.txt";
    await cleanProbes(probe);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(probe, "v1 alpha\nv1 beta");
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "v2 alpha\nv2 beta\nextra" }),
      textMsg("done-overwrite"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("overwrite it");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("\r");
      await waitForFrame(app, "done-overwrite");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("BEFORE");
      expect(frame).toContain("AFTER");
      expect(frame).toContain("v1 alpha");
      expect(frame).toContain("v2 alpha");
      expect(frame).toContain("extra");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
  test("no-op edit reports unchanged instead of an empty diff", async () => {
    const probe = "sbs-probe-noop.txt";
    await cleanProbes(probe);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(probe, "same");
    mockChatScriptMessages([
      toolMsg("c1", "edit", { path: probe, oldString: "same", newString: "same" }),
      textMsg("done-noop"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("noop edit");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("\r");
      await waitForFrame(app, "done-noop");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("⚙ edit");
      expect(frame).toContain("no changes");
      expect(frame).not.toContain("BEFORE");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
  test("consecutive edits render independently with correct panes", async () => {
    const p1 = "sbs-probe-multi1.txt";
    const p2 = "sbs-probe-multi2.txt";
    await cleanProbes(p1, p2);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(p1, "AAA-old");
    await writeFile(p2, "BBB-old");
    mockChatScriptMessages([
      toolMsg("c1", "edit", { path: p1, oldString: "AAA-old", newString: "AAA-new" }),
      toolMsg("c2", "edit", { path: p2, oldString: "BBB-old", newString: "BBB-new" }),
      textMsg("done-both"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("edit both");
      app.stdin.write("\r");
      await waitForFrame(app, "AAA-new"); // first approval modal preview
      app.stdin.write("\r");
      await waitForFrame(app, "BBB-new"); // second approval modal preview
      app.stdin.write("\r");
      await waitForFrame(app, "done-both");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("AAA-old");
      expect(frame).toContain("AAA-new");
      expect(frame).toContain("BBB-old");
      expect(frame).toContain("BBB-new");
    } finally {
      app.unmount();
      await cleanProbes(p1, p2);
    }
  });
});
