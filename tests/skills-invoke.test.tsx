// Skill invocation tests (tickets 03/04/06): manual /skill-name loading,
// auto-invoke on description match, and turn-scoped allowed-tools grants.
// Skills live in temp dirs injected via the skillDirs prop, so the suite
// never reads the real ~/.claude/skills. Model is scripted; network mocked.
import React from "react";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-skill-invoke-"));
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

// Script the chat POST path with a queue of assistant messages; returns the
// captured POST bodies so tests can assert what the model actually saw.
function mockChatScript(messages: unknown[]) {
  const posts: Array<{ messages: any }> = [];
  const queue = [...messages];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: any };
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

async function emptyHome(): Promise<string> {
  return tmpDir();
}

describe("manual /skill-name invocation", () => {
  test("loads the body into history + transcript, then the model sees it", async () => {
    const project = await tmpDir();
    await writeSkill(project, "deploy", "description: Ship it.", "Run deploy steps now.");
    const posts = mockChatScript([{ content: "deploying" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await emptyHome() })} />);
    try {
      app.stdin.write("/deploy");
      app.stdin.write("\r");
      await waitForFrame(app, "deploy loaded");
      // Progressive disclosure: the transcript carries one plain line (never
      // the body — the TUI stays calm); the full body still reaches the model.
      expect(app.lastFrame()).not.toContain("Run deploy steps now.");
      // The skill body reaches the model on the next turn.
      app.stdin.write("go");
      app.stdin.write("\r");
      await waitForFrame(app, "deploying");
      const posted = (posts[0]?.messages ?? []) as Array<{ content?: unknown }>;
      const skillMsgs = posted.filter(
        (m) => typeof m.content === "string" && (m.content as string).includes('[skill "deploy" loaded')
      );
      expect(skillMsgs).toHaveLength(1);
      expect(skillMsgs[0]?.content).toContain("Run deploy steps now.");
    } finally {
      app.unmount();
    }
  });

  test("unknown names get a helpful error, no POST", async () => {
    const project = await tmpDir();
    await writeSkill(project, "deploy", "description: Ship it.", "Body.");
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch call");
    });
    globalThis.fetch = fetchMock;
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await emptyHome() })} />);
    try {
      app.stdin.write("/nope");
      app.stdin.write("\r");
      await waitForFrame(app, 'Unknown skill "/skill:nope". Available: /skill:deploy');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      app.unmount();
    }
  });

  test("model-only skills refuse manual invocation", async () => {
    const project = await tmpDir();
    await writeSkill(project, "bg", "description: Lore.\nuser-invocable: false", "Lore body.");
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch call");
    });
    globalThis.fetch = fetchMock;
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await emptyHome() })} />);
    try {
      app.stdin.write("/bg");
      app.stdin.write("\r");
      await waitForFrame(app, "model-invoked only");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      app.unmount();
    }
  });
});

describe("auto-invoke on description match", () => {
  test("matching task loads the skill; unrelated chat stays clean", async () => {
    const project = await tmpDir();
    await writeSkill(
      project,
      "deploy",
      "description: Ship the application to production servers.",
      "Deployment runbook steps."
    );
    const posts = mockChatScript([{ content: "shipped" }, { content: "hi back" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await emptyHome() })} />);
    try {
      app.stdin.write("please ship the application to production");
      app.stdin.write("\r");
      await waitForFrame(app, "deploy loaded");
      await waitForFrame(app, "shipped");
      expect(JSON.stringify(posts[0]?.messages ?? [])).toContain("Deployment runbook steps.");
      // Unrelated message: the skill must not load again — turn 2's POST
      // still carries exactly the one copy from turn 1.
      app.stdin.write("hello there");
      app.stdin.write("\r");
      await waitForFrame(app, "hi back");
      const secondTurn = (posts[1]?.messages ?? []) as Array<{ content?: unknown }>;
      const echoes = secondTurn.filter(
        (m) => typeof m.content === "string" && (m.content as string).includes('[skill "deploy" loaded')
      );
      expect(echoes).toHaveLength(1);
    } finally {
      app.unmount();
    }
  });

  test("disable-model-invocation skills never auto-load", async () => {
    const project = await tmpDir();
    await writeSkill(
      project,
      "quiet",
      "description: Ship quiet releases.\ndisable-model-invocation: true",
      "Quiet body."
    );
    mockChatScript([{ content: "ok" }]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await emptyHome() })} />);
    try {
      app.stdin.write("ship quiet releases now please");
      app.stdin.write("\r");
      await waitForFrame(app, "ok");
      expect(app.lastFrame()).not.toContain("quiet loaded");
    } finally {
      app.unmount();
    }
  });
});

describe("turn-scoped allowed-tools grants", () => {
  test("granted tool skips approval this turn; next turn asks again", async () => {
    const project = await tmpDir();
    const probe = path.join(await tmpDir(), "grant-probe.txt");
    await writeSkill(
      project,
      "writer",
      "description: Write project files on request.\nallowed-tools: write",
      "Write whatever the user asked."
    );
    const writeArgs = JSON.stringify({ path: probe, content: "granted" });
    mockChatScript([
      { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: writeArgs } }] },
      { content: "written" },
      { content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "write", arguments: writeArgs } }] },
      { content: "denied-ok" },
    ]);
    const app = render(<App {...baseProps({ projectDir: project, homeDir: await emptyHome() })} />);
    try {
      // Manual load arms the grant; the turn's write must not prompt.
      app.stdin.write("/writer");
      app.stdin.write("\r");
      await waitForFrame(app, "pre-approved this turn: write");
      app.stdin.write("write the file please");
      app.stdin.write("\r");
      await waitForFrame(app, "written");
      expect(app.lastFrame()).not.toContain("allow this tool");
      expect(await fsp.readFile(probe, "utf8")).toBe("granted");
      // Next user message: grant expired, approval modal returns.
      app.stdin.write("write it again please");
      app.stdin.write("\r");
      await waitForFrame(app, "allow this tool");
      app.stdin.write("n");
      await waitForFrame(app, "denied-ok");
    } finally {
      app.unmount();
    }
  });
});
