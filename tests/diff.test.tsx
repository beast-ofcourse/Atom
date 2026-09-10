// Approval + transcript diff tests: zero-dep unified engine (line +
// word-level, Claude-parity limits) + the Ink DiffView + the ApprovalBox
// preview wiring + the registry preview-data helper + the committed
// transcript diff (pending-slot → onToolActivity). Network ALWAYS mocked.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "../src/App.js";
import { CHANGE_THRESHOLD, computeDiff } from "../src/ui/diff.js";
import { DiffView } from "../src/ui/diff-view.js";
import { ApprovalBox } from "../src/ui/modals.js";
import { previewDiffForApproval, previewLangFromPath } from "../src/tools.js";
import { highlightLine } from "../src/ui/highlight.js";

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

describe("computeDiff engine", () => {
  test("paired edit lines highlight changed words only", () => {
    const d = computeDiff("const TOKEN_EXPIRY = 3600;", "const TOKEN_EXPIRY = 7200;");
    expect(d.hunks).toHaveLength(1);
    expect(d.adds).toBe(1);
    expect(d.dels).toBe(1);
    const del = d.hunks[0]!.lines.find((l) => l.kind === "del");
    const add = d.hunks[0]!.lines.find((l) => l.kind === "add");
    expect(del?.kind).toBe("del");
    expect(add?.kind).toBe("add");
    if (del?.kind === "del" && add?.kind === "add") {
      const changedDel = del.runs.filter((r) => r.changed).map((r) => r.text);
      const changedAdd = add.runs.filter((r) => r.changed).map((r) => r.text);
      expect(changedDel).toContain("3600;");
      expect(changedAdd).toContain("7200;");
      // Unchanged words stay flat (runs coalesce, so match by inclusion).
      expect(del.runs.some((r) => !r.changed && r.text.includes("const"))).toBe(true);
    }
  });
  test("totally rewritten lines fall back to line-level (threshold)", () => {
    expect(CHANGE_THRESHOLD).toBe(0.4);
    const d = computeDiff("alpha beta gamma delta", "one two three four five six seven eight");
    const del = d.hunks[0]!.lines.find((l) => l.kind === "del");
    if (del?.kind === "del") {
      expect(del.runs.every((r) => !r.changed)).toBe(true);
    }
  });
  test("new file renders all additions", () => {
    const d = computeDiff(null, "line1\nline2");
    expect(d.isNewFile).toBe(true);
    expect(d.adds).toBe(2);
    expect(d.dels).toBe(0);
    expect(d.hunks[0]!.lines.every((l) => l.kind === "add")).toBe(true);
  });
  test("identical texts render no hunks", () => {
    const d = computeDiff("same\ntext", "same\ntext");
    expect(d.hunks).toHaveLength(0);
  });
  test("context lines surround the change (3 each side)", () => {
    const oldT = ["1", "2", "3", "4", "5", "OLD", "7", "8", "9", "10", "11"].join("\n");
    const newT = ["1", "2", "3", "4", "5", "NEW", "7", "8", "9", "10", "11"].join("\n");
    const d = computeDiff(oldT, newT);
    expect(d.hunks).toHaveLength(1);
    const kinds = d.hunks[0]!.lines.map((l) => l.kind);
    expect(kinds.filter((k) => k === "context")).toHaveLength(6);
  });
  test("far-apart changes split into two hunks", () => {
    const oldT = ["A", "1", "2", "3", "4", "5", "6", "7", "8", "B"].join("\n");
    const newT = ["A!", "1", "2", "3", "4", "5", "6", "7", "8", "B!"].join("\n");
    const d = computeDiff(oldT, newT);
    expect(d.hunks).toHaveLength(2);
  });
  test("binary content skips with a reason", () => {
    const nul = String.fromCharCode(0);
    const d = computeDiff(`a${nul}b`, "c");
    expect(d.skipped).toContain("binary");
    expect(d.hunks).toHaveLength(0);
  });
  test("giant change truncates at 400 changed lines", () => {
    const oldT = Array.from({ length: 500 }, (_, i) => `old-${i}`).join("\n");
    const newT = Array.from({ length: 500 }, (_, i) => `new-${i}`).join("\n");
    const d = computeDiff(oldT, newT);
    expect(d.truncated).toBe(true);
    const shown = d.hunks.reduce(
      (t, h) => t + h.lines.filter((l) => l.kind !== "context").length,
      0
    );
    expect(shown).toBeLessThanOrEqual(400);
  });
});

describe("DiffView rendering", () => {
  test("hunk header, +/- lines, and stats", () => {
    const frame = frameOf(<DiffView oldText="a\nOLD\nb" newText="a\nNEW\nb" />);
    expect(frame).toContain("@@");
    expect(frame).toContain("OLD");
    expect(frame).toContain("NEW");
    expect(frame).toContain("+1");
    expect(frame).toContain("−1");
  });
  test("new file shows additions with a new-file marker", () => {
    const frame = frameOf(<DiffView oldText={null} newText="hello" />);
    expect(frame).toContain("new file");
    expect(frame).toContain("hello");
  });
  test("maxLines collapses the tail with a trailer", () => {
    const oldT = Array.from({ length: 30 }, (_, i) => `same-${i}`).join("\n");
    const newT = Array.from({ length: 30 }, (_, i) => `same-${i}`).join("\n") + "\nEXTRA";
    const full = frameOf(<DiffView oldText={oldT} newText={newT} />);
    expect(full).toContain("EXTRA");
    const capped = frameOf(<DiffView oldText={oldT} newText={newT} maxLines={2} />);
    expect(capped).toContain("more line");
  });
  test("skipped diffs render the reason, never a crash", () => {
    const nul = String.fromCharCode(0);
    const frame = frameOf(<DiffView oldText={`a${nul}b`} newText="c" />);
    expect(frame).toContain("binary");
  });
});

describe("ApprovalBox diff preview", () => {
  test("absent diff keeps the legacy one-line layout", () => {
    const frame = frameOf(
      <ApprovalBox toolName="bash" description="⚙ bash pnpm test" selected={0} />
    );
    expect(frame).toContain("pnpm test");
    expect(frame).not.toContain("@@");
  });
  test("edit diff renders the replaced block inline", () => {
    const frame = frameOf(
      <ApprovalBox
        toolName="edit"
        description="⚙ edit src/x.ts"
        selected={0}
        diff={{
          oldText: "const TOKEN_EXPIRY = 3600;",
          newText: "const TOKEN_EXPIRY = 7200;",
          lang: "c",
          path: "src/x.ts",
        }}
      />
    );
    expect(frame).toContain("3600;");
    expect(frame).toContain("7200;");
    expect(frame).toContain("❯ [y]es once");
  });
  test("syntax-colored diff keeps every source char (ANSI-stripped)", () => {
    const oldT = "const TOKEN_EXPIRY = 3600; // seconds";
    const newT = "const TOKEN_EXPIRY = 7200; // seconds";
    const frame = frameOf(<DiffView oldText={oldT} newText={newT} lang="c" />);
    const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain(oldT);
    expect(plain).toContain(newT);
  });
  test("unknown lang keeps the legacy red/green wash", () => {
    const frame = frameOf(<DiffView oldText="aaa" newText="bbb" lang={null} />);
    expect(frame).toContain("aaa");
    expect(frame).toContain("bbb");
  });
});

describe("highlightLine tokenizer", () => {
  const kinds = (line: string, lang: "c" | "py" | "sh" | "data") =>
    highlightLine(line, lang).map((r) => [r.text, r.kind] as const);
  test("c keywords, strings, numbers, comments", () => {
    const runs = kinds('const x = 42; // set x', "c");
    expect(runs).toContainEqual(["const", "keyword"]);
    expect(runs).toContainEqual(["42", "number"]);
    expect(runs).toContainEqual(["// set x", "comment"]);
    const str = kinds('const s = "a // b";', "c");
    expect(str.some(([t, k]) => k === "comment")).toBe(false);
    expect(str).toContainEqual(['"a // b"', "string"]);
  });
  test("keyword substrings stay plain; runs rejoin byte-identical", () => {
    const line = "const constant = `tick ${t}`;";
    const runs = highlightLine(line, "c");
    expect(runs.find((r) => r.text === "constant")?.kind).toBe("plain");
    expect(runs.map((r) => r.text).join("")).toBe(line);
    // Offsets tile without gaps or overlaps.
    let pos = 0;
    for (const r of runs) {
      expect(r.start).toBe(pos);
      pos = r.end;
    }
    expect(pos).toBe(line.length);
  });
  test("py hash comments; sh keywords; data has no keywords", () => {
    expect(kinds("x = 1 # done", "py")).toContainEqual(["# done", "comment"]);
    expect(kinds("if true; then", "sh")).toContainEqual(["if", "keyword"]);
    expect(kinds('{"for": 1}', "data").some(([, k]) => k === "keyword")).toBe(false);
    expect(kinds('{"for": 1}', "data")).toContainEqual(['"for"', "string"]);
  });
  test("unknown lang degrades to one plain run", () => {
    expect(highlightLine("const x = 1;", null)).toEqual([
      { text: "const x = 1;", kind: "plain", start: 0, end: 12 },
    ]);
    expect(highlightLine("const x = 1;", "rust-never")).toHaveLength(1);
  });
});

describe("previewDiffForApproval", () => {
  test("edit returns the arg block pair (no disk read)", () => {
    const d = previewDiffForApproval("edit", { oldString: "a", newString: "b" });
    expect(d).toEqual({ oldText: "a", newText: "b", lang: null, path: null });
  });
  test("edit with missing strings returns null", () => {
    expect(previewDiffForApproval("edit", { oldString: "a" })).toBeNull();
  });
  test("edit derives lang from the path", () => {
    const d = previewDiffForApproval("edit", {
      path: "src/app.ts",
      oldString: "a",
      newString: "b",
    });
    expect(d).toEqual({ oldText: "a", newText: "b", lang: "c", path: "src/app.ts" });
  });
  test("write to a missing file previews as new (null old)", () => {
    const d = previewDiffForApproval(
      "write",
      { path: "definitely-not-here-12345.txt", content: "hi" },
      os.tmpdir()
    );
    expect(d).toEqual({ oldText: null, newText: "hi", lang: null, path: "definitely-not-here-12345.txt" });
  });
  test("write to an existing file pairs disk content vs new content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-diff-"));
    const p = path.join(dir, "f.txt");
    fs.writeFileSync(p, "old content");
    try {
      const d = previewDiffForApproval("write", { path: "f.txt", content: "new content" }, dir);
      expect(d).toEqual({ oldText: "old content", newText: "new content", lang: null, path: "f.txt" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  test("write to a .ts file carries the highlight lang", () => {
    const d = previewDiffForApproval(
      "write",
      { path: "brand-new-module-12345.ts", content: "const x = 1;" },
      os.tmpdir()
    );
    expect(d?.lang).toBe("c");
  });
  test("non-file tools return null; never throws", () => {
    expect(previewDiffForApproval("bash", { command: "ls" })).toBeNull();
    expect(previewDiffForApproval("write", null as unknown as Record<string, unknown>)).toBeNull();
  });
});

describe("previewLangFromPath", () => {
  test("known extensions map to families; unknown/dotfiles bare names → null", () => {
    expect(previewLangFromPath("src/app.ts")).toBe("c");
    expect(previewLangFromPath("main.PY")).toBe("py");
    expect(previewLangFromPath("run.sh")).toBe("sh");
    expect(previewLangFromPath("data.json")).toBe("data");
    expect(previewLangFromPath("notes.txt")).toBeNull();
    expect(previewLangFromPath("Makefile")).toBeNull();
    expect(previewLangFromPath(".gitignore")).toBeNull();
    expect(previewLangFromPath("noext")).toBeNull();
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

describe("transcript diff (pending slot → activity commit)", () => {
  test("approved write commits its diff under the audit line", async () => {
    const probe = "diff-probe-write.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "hello diff" }),
      textMsg("done-writing"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write it");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      // The modal itself previews the new file…
      expect(app.lastFrame()).toContain("new file");
      app.stdin.write("\r"); // [y]es once
      await waitForFrame(app, "done-writing");
      // …and the committed transcript keeps the side-by-side diff under ⚙ write.
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("⚙ write");
      expect(frame).toContain("BEFORE");
      expect(frame).toContain("AFTER");
      expect(frame).toContain("hello diff");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
  test("approved edit commits -OLD/+NEW under the audit line", async () => {
    const probe = "diff-probe-edit.txt";
    await cleanProbes(probe);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(probe, "keep\nOLD\nkeep");
    mockChatScriptMessages([
      toolMsg("c1", "edit", { path: probe, oldString: "OLD", newString: "NEW" }),
      textMsg("done-editing"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("edit it");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("\r"); // [y]es once
      await waitForFrame(app, "done-editing");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("⚙ edit");
      expect(frame).toContain("OLD");
      expect(frame).toContain("NEW");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
  test("denied write commits no diff (slot cleared on deny)", async () => {
    const probe = "diff-probe-deny.txt";
    await cleanProbes(probe);
    mockChatScriptMessages([
      toolMsg("c1", "write", { path: probe, content: "never" }),
      textMsg("understood, denied"),
    ]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("write it");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool?");
      app.stdin.write("n"); // deny this call
      await waitForFrame(app, "understood, denied");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("denied by user: write");
      expect(frame).not.toContain("BEFORE");
    } finally {
      app.unmount();
      await cleanProbes(probe);
    }
  });
});
