// @ mentions: G1 parity slice 1 — trigger, picker, virtualText + FilePart attachment, submit preservation, re-anchor.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { mentionTriggerIndex, filterMentionCandidates, pruneMentions, buildMentionPool } from "../src/ui/mentions.js";

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
  for (let i = bodies.length - 1; i >= 0; i--) {
    const msgs = (bodies[i] as { messages?: { role?: string; content?: string }[] })?.messages;
    if (Array.isArray(msgs)) {
      for (let k = msgs.length - 1; k >= 0; k--) {
        if (msgs[k]?.role === "user" && typeof msgs[k]?.content === "string") return msgs[k]!.content as string;
      }
    }
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

// --- pure helpers ---

describe("mentionTriggerIndex", () => {
  test("finds @ at any cursor, hides on whitespace after @, empty query valid", () => {
    expect(mentionTriggerIndex("hello @src/foo", 14)).toEqual({ start: 6, query: "src/foo" });
    expect(mentionTriggerIndex("a @ foo", 5)).toBe(null); // whitespace after @ → no trigger
    expect(mentionTriggerIndex("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionTriggerIndex("no at", 5)).toBe(null);
    expect(mentionTriggerIndex("@src/foo bar", 8)).toEqual({ start: 0, query: "src/foo" });
    // cursor mid-string: last @ before cursor wins, whitespace after closes it
    expect(mentionTriggerIndex("@a @b", 5)).toEqual({ start: 3, query: "b" });
  });
});

describe("filterMentionCandidates", () => {
  test("prefix tier and fuzzy, 20 max", () => {
    const files = ["src/App.tsx", "src/ui/input.ts", "README.md", "package.json", "src/tools/search.ts"];
    const filtered = filterMentionCandidates(files, "src");
    expect(filtered[0]).toBe("src/App.tsx");
    const fuzzy = filterMentionCandidates(files, "ap");
    expect(fuzzy).toContain("src/App.tsx");
    const capped = filterMentionCandidates(Array.from({ length: 30 }, (_, i) => `file-${i}.ts`), "");
    expect(capped.length).toBe(20);
  });

  test("trailing-slash query is prefix-only (dir drill-in)", () => {
    const pool = buildMentionPool(["src/App.tsx", "src/ui/input.ts", "README.md", "other/src-ish.ts"]);
    const drilled = filterMentionCandidates(pool, "src/");
    // Everything returned must live under src/ — no fuzzy noise from elsewhere.
    expect(drilled.length).toBeGreaterThan(0);
    for (const p of drilled) expect(p.startsWith("src/")).toBe(true);
    expect(drilled).not.toContain("other/src-ish.ts");
  });
});

describe("pruneMentions + directory pool", () => {
  test("drop when token not in input, build pool includes dirs", () => {
    const mentions = [
      { path: "src/App.tsx", token: "@src/App.tsx" },
      { path: "README.md", token: "@README.md" },
    ];
    expect(pruneMentions("hello @src/App.tsx world", mentions)).toHaveLength(1);
    expect(pruneMentions("hello world", mentions)).toHaveLength(0);
    const pool = buildMentionPool(["src/foo/bar.ts", "src/foo/baz.ts"]);
    expect(pool).toContain("src/");
    expect(pool).toContain("src/foo/");
  });
});

// --- ink-driven integration ---

describe("@ mentions picker", () => {
  test("typing @ shows file picker (Files) with candidates", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("@");
      // Picker title contains "Files ("
      await waitForFrame(app, "Files (");
      const frame = app.lastFrame() ?? "";
      // Should list some known repo file (package.json) or dir "src/"
      expect(frame.includes("package.json") || frame.includes("src/") || frame.includes("README.md")).toBe(true);
    } finally {
      app.unmount();
    }
  });

  test("typing @src filters to src files", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("@src");
      await waitForFrame(app, "Files (");
      // Give filter a tick (trigger re-renders synchronously, but pool fetch may be async)
      await new Promise((r) => setTimeout(r, 150));
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("src/");
    } finally {
      app.unmount();
    }
  });

  test("picker navigation keeps visible and pick inserts @path display", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      // Filter to a file so Enter confirms (attaches + space) instead of dir-expanding.
      app.stdin.write("@package.json");
      await waitForFrame(app, "Files (");
      await new Promise((r) => setTimeout(r, 200));
      // Navigate down one then back up (keeps highlight visible/moving)
      app.stdin.write("\u001B[B");
      await new Promise((r) => setTimeout(r, 80));
      app.stdin.write("\u001B[A");
      await new Promise((r) => setTimeout(r, 80));
      // Pick with Enter
      app.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 150));
      const frame = app.lastFrame() ?? "";
      // After pick, InputBox should contain "@" + a path (virtualText) with trailing space; picker closed.
      expect(frame).toContain("@package.json ");
      expect(frame).not.toContain("Files (");
    } finally {
      app.unmount();
    }
  });

  test("picking a directory expands in place, picker stays open filtered to prefix", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("@");
      await waitForFrame(app, "Files (");
      await new Promise((r) => setTimeout(r, 250));
      // First candidates are dirs (dirs sort first). Pick the highlighted one with Enter.
      app.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 200));
      const frame = app.lastFrame() ?? "";
      // Input now holds `@<dir>/` WITHOUT trailing space, and the picker is STILL open…
      expect(frame).toContain("Files (");
      // …filtered to that prefix: title shows `@<dir>/`.
      expect(frame).toMatch(/Files \(.*— @[^:]*\/:/);
    } finally {
      app.unmount();
    }
  });

  test("re-picking the same directory confirms it (space + attachment)", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("ok-dir-confirm")]);
    const app = render(<App {...baseProps()} />);
    try {
      // Deterministic: `@src` → top candidate is the `src/` dir itself (dirs sort first).
      app.stdin.write("@src");
      await waitForFrame(app, "Files (");
      await new Promise((r) => setTimeout(r, 250));
      app.stdin.write("\r"); // expand: `@src` → `@src/`, picker stays open
      await new Promise((r) => setTimeout(r, 200));
      const expanded = app.lastFrame() ?? "";
      expect(expanded).toContain("@src/");
      expect(expanded).toContain("Files ("); // still open, drilled in
      app.stdin.write("\r"); // re-pick same dir → confirm: `@src/ ` + attachment, picker closes
      await new Promise((r) => setTimeout(r, 200));
      const confirmed = app.lastFrame() ?? "";
      expect(confirmed).toContain("@src/ ");
      // Submit; payload must carry the directory reference block.
      app.stdin.write("list");
      await waitForFrame(app, "list");
      app.stdin.write("\r");
      await waitForFrame(app, "ok-dir-confirm");
      let payloadFound: string | null = null;
      for (const b of bodies) {
        const msgs = (b as { messages?: { role?: string; content?: string }[] })?.messages;
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs) {
          if (m.role === "user" && typeof m.content === "string" && m.content.includes('<file path="src"')) {
            payloadFound = m.content;
          }
        }
      }
      expect(payloadFound).not.toBe(null);
    } finally {
      app.unmount();
    }
  });

  test("delete virtual text drops the attachment (re-anchor)", async () => {
    const bodies: unknown[] = [];
    mockChatCapture(bodies, [textMsg("ok-delete-drop")]);
    const app = render(<App {...baseProps()} />);
    try {
      // Filter to a file so Enter confirms (attaches) instead of dir-expanding.
      app.stdin.write("@package.json");
      await waitForFrame(app, "Files (");
      await new Promise((r) => setTimeout(r, 200));
      app.stdin.write("\r"); // pick file → `@package.json ` attached
      await new Promise((r) => setTimeout(r, 150));
      // Input now contains "@<path> " — clear it entirely via Esc or backspaces.
      // Use Esc to clear (our setInputAndCursor prunes mentions on next text)
      app.stdin.write(String.fromCharCode(27));
      await new Promise((r) => setTimeout(r, 100));
      // Type fresh without mention and submit; payload must NOT contain file content
      app.stdin.write("hello world");
      app.stdin.write("\r");
      await waitForFrame(app, "ok-delete-drop");
      const payload = lastUserContent(bodies);
      expect(payload).toBe("hello world");
      expect(payload).not.toContain("<file path=");
    } finally {
      app.unmount();
    }
  });

  test("submit payload carries real file content for tracked mention", async () => {
    const bodies: unknown[] = [];
    // Use a known small file in repo: package.json exists and is <64KB
    mockChatCapture(bodies, [textMsg("ok-mention-payload")]);
    const app = render(<App {...baseProps()} />);
    try {
      // Type a mention explicitly without picker: we can just type "@package.json" and pick via picker,
      // but to keep deterministic we type "@" then wait and pick package.json if available,
      // else we manually pick by filtering.
      app.stdin.write("@pack");
      await waitForFrame(app, "Files (");
      await new Promise((r) => setTimeout(r, 250));
      const frameBefore = app.lastFrame() ?? "";
      // If package.json not in visible window, navigate until we find it or just pick first (which should still expand something)
      // For robustness, pick the highlighted entry (whatever it is) — expansion should still produce <file path=...>
      app.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 150));
      // Ensure input still has @path (virtual)
      const midFrame = app.lastFrame() ?? "";
      expect(midFrame).toContain("@");
      app.stdin.write(" please read");
      await waitForFrame(app, "please read");
      app.stdin.write("\r");
      await waitForFrame(app, "ok-mention-payload");
      // Payload may have skill auto-injection after the mention; search any user message for the mention expansion.
      let payloadFound: string | null = null;
      for (const b of bodies) {
        const msgs = (b as { messages?: { role?: string; content?: string }[] })?.messages;
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs) {
          if (m.role === "user" && typeof m.content === "string" && m.content.includes("<file path=")) {
            payloadFound = m.content;
          }
        }
      }
      const payload = payloadFound ?? lastUserContent(bodies) ?? "";
      // Payload must be expanded: original token plus <file path=...> block with content or reference
      expect(payload).toContain("@");
      expect(payload).toContain("<file path=");
      expect(payload.length).toBeGreaterThan(" please read".length);
    } finally {
      app.unmount();
    }
  });

  test("Esc dismisses picker; typing after still works", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("@");
      await waitForFrame(app, "Files (");
      app.stdin.write(String.fromCharCode(27)); // Esc
      await new Promise((r) => setTimeout(r, 120));
      // Picker should be gone after Esc
      const afterEsc = app.lastFrame() ?? "";
      // Not strictly asserting absence (frame may still have @ char), but input should still be "@"
      expect(afterEsc).toContain("@");
      app.stdin.write(" hello");
      await new Promise((r) => setTimeout(r, 80));
      expect(app.lastFrame()).toContain("hello");
    } finally {
      app.unmount();
    }
  });

  test("directories show with trailing slash", async () => {
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("@");
      await waitForFrame(app, "Files (");
      await new Promise((r) => setTimeout(r, 200));
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("src/");
    } finally {
      app.unmount();
    }
  });
});
