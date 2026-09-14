// 07 paste hardening (G3): long-paste collapse, filepath attach, image attach.
// Full pasted content must survive in the submitted payload, never only the summary.
import React from "react";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  expandPastedSummaries,
  extractPastedPathCandidates,
  pasteSummaryToken,
  prunePastedChunks,
  shouldCollapsePaste,
} from "../src/ui/paste.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function textMsg(content: string) {
  return { message: { content } };
}

function mockChatCapture(bodies: unknown[], replies: unknown[]) {
  const queue = [...replies];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    try {
      bodies.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
    } catch {}
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { ok: true, json: async () => ({ choices: [next] }) } as Response;
  });
}

function lastUserContent(bodies: unknown[]): string | null {
  const all = userPayloads(bodies);
  return all.length > 0 ? all[all.length - 1]! : null;
}

// All user-role message contents across every captured POST (skill
// auto-injection may add its own user POST after ours — never assume ours
// is last; search for the marker instead, like tests/mentions.test.tsx).
function userPayloads(bodies: unknown[]): string[] {
  const out: string[] = [];
  for (const b of bodies) {
    const msgs = (b as { messages?: { role?: string; content?: string }[] })?.messages;
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (m?.role === "user" && typeof m?.content === "string") out.push(m.content);
    }
  }
  return out;
}

function findPayload(bodies: unknown[], needle: string): string | null {
  for (const c of userPayloads(bodies)) {
    if (c.includes(needle)) return c;
  }
  return null;
}

async function waitForFrame(app: { lastFrame: () => string | undefined }, needle: string, timeout = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function baseProps() {
  return { apiKey: "test-key", endpoint: ENDPOINT, initialModel: "big-pickle", initialModels: ["big-pickle"] };
}

function bracketed(s: string): string {
  return "\u001B[200~" + s + "\u001B[201~";
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atom-paste-"));
}

// --- pure helpers ---

describe("paste helpers", () => {
  test("shouldCollapsePaste: >=3 lines or >150 chars", () => {
    expect(shouldCollapsePaste("a\nb")).toBe(false);
    expect(shouldCollapsePaste("a\nb\nc")).toBe(true);
    expect(shouldCollapsePaste("x".repeat(150))).toBe(false);
    expect(shouldCollapsePaste("x".repeat(151))).toBe(true);
  });

  test("summary token is one line and unique per live set", () => {
    expect(pasteSummaryToken("a\nb\nc")).toBe("[Pasted ~3 lines]");
    expect(pasteSummaryToken("a\nb\nc", ["[Pasted ~3 lines]"])).toBe("[Pasted ~3 lines #2]");
    expect(pasteSummaryToken("a\nb\nc").includes("\n")).toBe(false);
  });

  test("prune + expand round-trip restores full text", () => {
    const chunks = [{ token: "[Pasted ~3 lines]", full: "a\nb\nc" }];
    expect(expandPastedSummaries("see [Pasted ~3 lines] ok", chunks)).toBe("see a\nb\nc ok");
    expect(prunePastedChunks("see ok", chunks)).toHaveLength(0);
    expect(prunePastedChunks("see [Pasted ~3 lines] ok", chunks)).toHaveLength(1);
  });

  test("path candidates include whole blob and per-line", () => {
    const cands = extractPastedPathCandidates("hello\npackage.json");
    expect(cands).toContain("package.json");
  });
});

// --- ink-driven integration ---

describe("long paste collapse", () => {
  test("5-line paste collapses to [Pasted ~5 lines] and never submits; payload keeps full text", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("paste-ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      const full = ["paste-line-0", "paste-line-1", "paste-line-2", "paste-line-3", "paste-line-4"].join("\n");
      app.stdin.write(bracketed(full));
      await waitForFrame(app, "[Pasted ~5 lines]");
      await new Promise((r) => setTimeout(r, 150));
      expect(bodies.length).toBe(0);
      const frame = app.lastFrame() ?? "";
      expect(frame).not.toContain("paste-line-3");
      app.stdin.write("\r");
      await waitForFrame(app, "paste-ok");
      const payload = findPayload(bodies, "paste-line-0") ?? "";
      for (let i = 0; i < 5; i++) expect(payload).toContain(`paste-line-${i}`);
      expect(payload).not.toContain("[Pasted ~");
    } finally {
      app.unmount();
    }
  });

  test("long single line (>150 chars) collapses; payload keeps all chars", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("long-ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      const full = `Z${"y".repeat(199)}`;
      app.stdin.write(bracketed(full));
      await waitForFrame(app, "[Pasted ~1 lines]");
      await new Promise((r) => setTimeout(r, 150));
      expect(bodies.length).toBe(0);
      app.stdin.write("\r");
      await waitForFrame(app, "long-ok");
      expect(findPayload(bodies, full.slice(0, 24))).toContain(full);
    } finally {
      app.unmount();
    }
  });

  test("short paste stays verbatim (no summary)", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write(bracketed("hi there"));
      await waitForFrame(app, "hi there");
      await new Promise((r) => setTimeout(r, 150));
      expect(app.lastFrame()).not.toContain("[Pasted ~");
    } finally {
      app.unmount();
    }
  });

  test("deleting the summary drops the hidden text (no leak into next submit)", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("after-delete-ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write(bracketed("gone-0\ngone-1\ngone-2"));
      await waitForFrame(app, "[Pasted ~3 lines]");
      app.stdin.write(String.fromCharCode(27)); // Esc clears the draft, pruning the chunk
      await new Promise((r) => setTimeout(r, 120));
      app.stdin.write("fresh");
      await waitForFrame(app, "fresh");
      app.stdin.write("\r");
      await waitForFrame(app, "after-delete-ok");
      const payloads = userPayloads(bodies);
      expect(payloads).toContain("fresh");
      for (const p of payloads) expect(p).not.toContain("gone-1");
    } finally {
      app.unmount();
    }
  });
});

describe("pasted filepath attach", () => {
  test("pasting an existing text file path attaches (draft shows path, payload carries <file path> block)", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "note.txt");
    fs.writeFileSync(file, "PASTEFILE-HELLO-123");
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("file-ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write(bracketed(file));
      await waitForFrame(app, "note.txt");
      await new Promise((r) => setTimeout(r, 200));
      expect(bodies.length).toBe(0);
      // Draft shows the path, not a dump of the content.
      expect(app.lastFrame()).not.toContain("PASTEFILE-HELLO-123");
      app.stdin.write("\r");
      await waitForFrame(app, "file-ok");
      const payload = findPayload(bodies, "PASTEFILE-HELLO-123") ?? "";
      expect(payload).toContain("<file path=");
      expect(payload).toContain("PASTEFILE-HELLO-123");
    } finally {
      app.unmount();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pasting a missing path stays verbatim and never attaches", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write(bracketed("definitely-not-a-real-file-xyz123.txt"));
      await waitForFrame(app, "definitely-not-a-real-file-xyz123.txt");
      await new Promise((r) => setTimeout(r, 150));
      expect(app.lastFrame()).not.toContain("[Pasted ~");
      expect(app.lastFrame()).not.toContain("[Image ");
    } finally {
      app.unmount();
    }
  });
});

describe("pasted image attach", () => {
  test("pasting an existing image path shows [Image N]; payload carries the reference, not binary", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "shot.png");
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("img-ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write(bracketed(file));
      await waitForFrame(app, "[Image 1]");
      await new Promise((r) => setTimeout(r, 200));
      expect(bodies.length).toBe(0);
      app.stdin.write("\r");
      await waitForFrame(app, "img-ok");
      const payload = findPayload(bodies, "[Image 1]") ?? "";
      expect(payload).toContain("[Image 1]");
      expect(payload).toContain("<file path=");
    } finally {
      app.unmount();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("raw binary paste shows [Image N] and never submits mid-paste; payload preserves bytes", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("bin-ok")]);
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write(bracketed("BINMARKER-ABC\x00TAIL"));
      await waitForFrame(app, "[Image 1]");
      await new Promise((r) => setTimeout(r, 150));
      expect(bodies.length).toBe(0);
      app.stdin.write("\r");
      await waitForFrame(app, "bin-ok");
      expect(findPayload(bodies, "BINMARKER-ABC")).toContain("BINMARKER-ABC");
    } finally {
      app.unmount();
    }
  });
});
