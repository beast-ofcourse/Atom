// Namespaced skill invocation (/skill:name), slash-menu skill entries, the
// /context visibility command, and the auto-invoke flood regression.
// Skills live in temp dirs via the skillDirs prop. Model scripted, net mocked.
import React from "react";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
const ESC = "";

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-skill-slash-"));
  dirs.push(d);
  return d;
}

async function writeSkill(root: string, name: string, front: string, body: string): Promise<void> {
  const dir = path.join(root, ".claude", "skills", name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "SKILL.md"), `---\n${front}\n---\n\n${body}\n`, "utf8");
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

function mockChatScript(messages: unknown[]) {
  const posts: Array<{ messages: unknown }> = [];
  const queue = [...messages];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: unknown };
    posts.push({ messages: body.messages });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { ok: true, json: async () => ({ choices: [{ message: next }] }) } as Response;
  });
  return posts;
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

function baseProps(skillDirs: { projectDir: string; homeDir: string }) {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
    skillDirs,
  };
}

describe("/skill:name invocation", () => {
  test("namespaced form loads; bare form shows usage; unknown lists /skill: names", async () => {
    const project = await tmpDir();
    await writeSkill(project, "deploy", "description: Ship it.", "Deploy body here.");
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await tmpDir() })} />);
    try {
      app.stdin.write("/skill:deploy");
      app.stdin.write("\r");
      await waitForFrame(app, "deploy loaded");
      expect(app.lastFrame()).not.toContain("Deploy body here.");

      // Bare /skill with the menu open would run highlighted /skills, so
      // dismiss first: exact submit then shows usage.
      app.stdin.write("/skill");
      await waitForFrame(app, "Atom commands");
      app.stdin.write(ESC);
      await new Promise((r) => setTimeout(r, 60));
      app.stdin.write("\r");
      await waitForFrame(app, "usage: /skill:<name>");

      app.stdin.write("/skill:nope");
      app.stdin.write("\r");
      await waitForFrame(app, 'Unknown skill "/skill:nope". Available: /skill:deploy');
    } finally {
      app.unmount();
    }
  });
});

describe("slash-menu skill entries", () => {
  test("menu stages skill picks for confirm; second Enter loads, nothing auto-sends", async () => {
    const project = await tmpDir();
    await writeSkill(project, "deploy", "description: Ship it.", "Deploy body here.");
    const posts = mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await tmpDir() })} />);
    try {
      app.stdin.write("/dep");
      await waitForFrame(app, "/skill:deploy");
      // First Enter stages the exact command — nothing loads or sends.
      app.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 250));
      expect(app.lastFrame()).not.toContain("deploy loaded");
      expect(posts).toHaveLength(0);
      // Second Enter on the exact staged text runs it.
      app.stdin.write("\r");
      await waitForFrame(app, "deploy loaded");
    } finally {
      app.unmount();
    }
  });

  test("fully typed skill name runs on first Enter (unambiguous)", async () => {
    const project = await tmpDir();
    await writeSkill(project, "deploy", "description: Ship it.", "Deploy body here.");
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await tmpDir() })} />);
    try {
      // Legacy exact form: loads whether the menu snapshot has landed
      // (menu exact rule) or not (plain submit path) — deterministic either way.
      app.stdin.write("/deploy");
      app.stdin.write("\r");
      await waitForFrame(app, "deploy loaded");
    } finally {
      app.unmount();
    }
  });

  test("skill rows cap with a more-line; commands stay first", async () => {
    const project = await tmpDir();
    for (let i = 0; i < 10; i++) {
      await writeSkill(project, `capskill-${i}`, "description: Cap skill.", "Body.");
    }
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await tmpDir() })} />);
    try {
      app.stdin.write("/capskill");
      await waitForFrame(app, "/skill:capskill-0");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("more skill");
      expect(frame).not.toContain("/skill:capskill-9");
    } finally {
      app.unmount();
    }
  });
});

describe("/skills picker", () => {
  test("filters, stages on Enter without sending, confirms on second Enter", async () => {
    const project = await tmpDir();
    await writeSkill(project, "deploy", "description: Ship it.", "Deploy body here.");
    await writeSkill(project, "ship", "description: Boat it.", "Ship body here.");
    const posts = mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await tmpDir() })} />);
    try {
      app.stdin.write("/skills");
      app.stdin.write("\r");
      await waitForFrame(app, "Skills (2)");
      // Rows are names only — no descriptions in the TUI.
      expect(app.lastFrame()).not.toContain("Ship it.");
      // Filter narrows; Enter stages (closes picker, fills input, loads nothing).
      app.stdin.write("dep");
      await waitForFrame(app, "Skills (1 of 2");
      app.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 250));
      expect(app.lastFrame()).not.toContain("deploy loaded");
      expect(posts).toHaveLength(0);
      // Second Enter on the staged exact command loads it.
      app.stdin.write("\r");
      await waitForFrame(app, "deploy loaded");
    } finally {
      app.unmount();
    }
  });

  test("Esc cancels without loading; arrows reach every windowed row", async () => {
    const project = await tmpDir();
    // Zero-padded names: discovery sorts lexicographically, so padding keeps
    // arrow index == numeric suffix (wskill-10 would otherwise sort second).
    const pad = (i: number) => `wskill-${String(i).padStart(2, "0")}`;
    for (let i = 0; i < 12; i++) {
      await writeSkill(project, pad(i), "description: W skill.", "Body.");
    }
    const posts = mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await tmpDir() })} />);
    try {
      app.stdin.write("/skills");
      app.stdin.write("\r");
      await waitForFrame(app, "Skills (12)");
      // Esc closes with nothing loaded and nothing staged.
      app.stdin.write(ESC);
      await new Promise((r) => setTimeout(r, 150));
      expect(app.lastFrame()).not.toContain("loaded");
      // Reopen and walk past the first window to the tail, waiting for each
      // highlight step (rapid arrows can coalesce under load).
      app.stdin.write("/skills");
      app.stdin.write("\r");
      await waitForFrame(app, "Skills (12)");
      for (let i = 1; i <= 11; i++) {
        app.stdin.write(`${ESC}[B`);
        await waitForFrame(app, `❯ /skill:${pad(i)}`);
      }
      // Enter stages the tail entry (still nothing sent).
      app.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 250));
      expect(app.lastFrame()).not.toContain("wskill-11 loaded");
      expect(posts).toHaveLength(0);
      app.stdin.write("\r");
      await waitForFrame(app, "wskill-11 loaded");
    } finally {
      app.unmount();
    }
  }, 25000);
});

describe("auto-invoke flood regression", () => {
  test("generic messages do not auto-load vaguely related skills", async () => {
    const project = await tmpDir();
    await writeSkill(project, "tester", "description: Run the test suite.", "Test body.");
    mockChatScript([{ content: "done-xyz" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await tmpDir() })} />);
    try {
      app.stdin.write("run the tests please");
      app.stdin.write("\r");
      await waitForFrame(app, "done-xyz");
      expect(app.lastFrame()).not.toContain("tester loaded");
    } finally {
      app.unmount();
    }
  });
});

describe("/context command", () => {
  test("shows the per-source breakdown, zero fetches", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch call (/context must be zero-fetch)");
    });
    globalThis.fetch = fetchMock;
    const app = render(
      <App {...baseProps({ projectDir: await tmpDir(), homeDir: await tmpDir() })} />
    );
    try {
      app.stdin.write("/context");
      app.stdin.write("\r");
      await waitForFrame(app, "Context (model big-pickle)");
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain("system:");
      expect(frame).toContain("tools: 13 defs");
      expect(frame).toContain("history:");
      expect(frame).toContain("config: atom.json (none, defaults)");
      expect(frame).toContain("allowance:");
      // Prefix-cache instrumentation: sizes + support mode, reported-only hits.
      // The frame wraps long lines at terminal width, so normalize whitespace
      // before asserting multi-word phrases.
      const flat = frame.replace(/\s+/g, " ");
      expect(flat).toContain("cache: ");
      expect(flat).toContain("stable/cacheable");
      expect(flat).toContain("implicit prefix");
      expect(flat).toContain("not reported by provider");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      app.unmount();
    }
  });
});
