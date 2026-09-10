// Per-turn environment block tests (Task 6, plans/tasks.md). Network is
// never touched; git is only invoked against temp dirs / the repo cwd via
// the real (cheap, timeout-guarded) implementation — missing git / non-repo
// cwd must shrink the block, never throw.
import React from "react";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { SYSTEM_PROMPT } from "../src/zen.js";
import {
  ENV_BLOCK_CHAR_CAP,
  buildEnvBlock,
  getEnvBlock,
  stripEnvBlock,
  withEnvBlock,
} from "../src/env-block.js";

const realAgentsPath = process.env.OPENCODE_AGENTS_PATH;

afterEach(() => {
  vi.restoreAllMocks();
  if (realAgentsPath === undefined) delete process.env.OPENCODE_AGENTS_PATH;
  else process.env.OPENCODE_AGENTS_PATH = realAgentsPath;
});

describe("buildEnvBlock", () => {
  test("contains cwd, node, and timestamp; git parts only when present", () => {
    const full = buildEnvBlock({
      cwd: "/repo",
      branch: "main",
      status: "clean",
      nodeVersion: "v22.0.0",
      timestamp: "2026-09-08T00:00:00.000Z",
    });
    expect(full.startsWith("[env ")).toBe(true);
    expect(full).toContain("cwd=/repo");
    expect(full).toContain("branch=main");
    expect(full).toContain("status=clean");
    expect(full).toContain("node=v22.0.0");
    expect(full).toContain("time=2026-09-08T00:00:00.000Z");
    expect(full.length).toBeLessThanOrEqual(ENV_BLOCK_CHAR_CAP);

    const shrunk = buildEnvBlock({
      cwd: "/tmp/no-git",
      branch: null,
      status: null,
      nodeVersion: "v22.0.0",
      timestamp: "2026-09-08T00:00:00.000Z",
    });
    expect(shrunk).toContain("cwd=/tmp/no-git");
    expect(shrunk).not.toContain("branch=");
    expect(shrunk).not.toContain("status=");
  });

  test("operating context rides along when provided, omitted otherwise", () => {
    const withMachine = buildEnvBlock({
      cwd: "/repo",
      branch: null,
      status: null,
      nodeVersion: "v22.0.0",
      timestamp: "2026-09-08T00:00:00.000Z",
      os: "win32",
      shell: "cmd.exe",
      user: "dev",
    });
    expect(withMachine).toContain("os=win32");
    expect(withMachine).toContain("shell=cmd.exe");
    expect(withMachine).toContain("user=dev");
    expect(withMachine.length).toBeLessThanOrEqual(ENV_BLOCK_CHAR_CAP);
    const without = buildEnvBlock({
      cwd: "/repo",
      branch: null,
      status: null,
      nodeVersion: "v22.0.0",
      timestamp: "2026-09-08T00:00:00.000Z",
    });
    expect(without).not.toContain("os=");
    expect(without).not.toContain("shell=");
    expect(without).not.toContain("user=");
  });

  test("live block names the real platform shell and user", () => {
    const block = getEnvBlock(process.cwd());
    expect(block).toContain(`os=${process.platform}`);
    expect(block).toContain(process.platform === "win32" ? "shell=cmd.exe" : "shell=sh");
    // user= is always present (best-effort "unknown" in sandboxes).
    expect(block).toContain("user=");
  });

  test("caps at ~500 chars even with a pathological cwd", () => {
    const block = buildEnvBlock({
      cwd: `/${"d".repeat(1000)}`,
      branch: "main",
      status: "clean",
      nodeVersion: "v22.0.0",
      timestamp: "2026-09-08T00:00:00.000Z",
    });
    expect(block.length).toBeLessThanOrEqual(ENV_BLOCK_CHAR_CAP);
    // Time/node survive the cap (cwd is what gets truncated).
    expect(block).toContain("node=");
    expect(block).toContain("time=");
  });
});

describe("getEnvBlock (git-missing repos unaffected)", () => {
  test("temp dir without .git shrinks the block, never throws", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-no-git-"));
    try {
      let block = "";
      expect(() => {
        block = getEnvBlock(dir);
      }).not.toThrow();
      expect(block.startsWith("[env ")).toBe(true);
      expect(block).toContain(`cwd=${dir}`);
      expect(block).toContain("node=");
      expect(block).toContain("time=");
      expect(block).not.toContain("branch=");
      expect(block.length).toBeLessThanOrEqual(ENV_BLOCK_CHAR_CAP);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("repo cwd never throws and stays capped", () => {
    let block = "";
    expect(() => {
      block = getEnvBlock(process.cwd());
    }).not.toThrow();
    expect(block.startsWith("[env ")).toBe(true);
    expect(block.length).toBeLessThanOrEqual(ENV_BLOCK_CHAR_CAP);
  });
});

describe("withEnvBlock / stripEnvBlock", () => {
  test("pins to the system message and preserves the base wording", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-env-sys-"));
    try {
      const out = withEnvBlock(SYSTEM_PROMPT, dir);
      expect(out.startsWith(SYSTEM_PROMPT)).toBe(true);
      expect(out).toContain("[env ");
      expect(out.length).toBeLessThanOrEqual(
        SYSTEM_PROMPT.length + 2 + ENV_BLOCK_CHAR_CAP
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("refresh is idempotent: no stacked blocks across turns", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-env-idem-"));
    try {
      const once = withEnvBlock(SYSTEM_PROMPT, dir);
      const twice = withEnvBlock(once, dir);
      const occurrences = twice.split("[env ").length - 1;
      expect(occurrences).toBe(1);
      expect(twice.startsWith(SYSTEM_PROMPT)).toBe(true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("stripEnvBlock removes only the trailing block", () => {
    const withBlock = `${SYSTEM_PROMPT}\n\n[env cwd=/x node=v1 time=t]`;
    expect(stripEnvBlock(withBlock)).toBe(SYSTEM_PROMPT);
    // No trailing block → untouched (even with an "[env " mid-string).
    expect(stripEnvBlock(`${SYSTEM_PROMPT} [env not-a-block`)).toBe(
      `${SYSTEM_PROMPT} [env not-a-block`
    );
  });

  test("never throws and never touches user content shape", () => {
    const user = { role: "user", content: "hi" };
    expect(() => withEnvBlock(user.content, os.tmpdir())).not.toThrow();
    expect(user).toEqual({ role: "user", content: "hi" });
  });
});

describe("App POST pins the block to SYSTEM, never user content", () => {
  async function waitForFrame(
    app: { lastFrame: () => string | undefined },
    needle: string,
    timeout = 8000
  ): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (app.lastFrame()?.includes(needle)) return;
      if (Date.now() - start > timeout) {
        throw new Error(`timed out waiting for ${JSON.stringify(needle)}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  test("fresh turn POSTs system = base + env block; user message stays clean", async () => {
    // Deterministic base: no AGENTS.md overlay (repo AGENTS.md state varies).
    process.env.OPENCODE_AGENTS_PATH = path.join(
      os.tmpdir(),
      "atom-env-does-not-exist.md"
    );
    const posts: Array<{ messages: unknown }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: unknown;
      };
      posts.push({ messages: body.messages });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok-env-block-xyz" } }] }),
      } as Response;
    }) as typeof fetch;
    const app = render(
      React.createElement(App, {
        apiKey: "test-key",
        endpoint: "https://opencode.ai/zen/v1/chat/completions",
        initialModel: "big-pickle",
        initialModels: ["big-pickle"],
      })
    );
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      // NOTE: needle must be unique — "ok" matches the "token: n/a" status
      // line on mount. The submit pipeline (SUBMIT_PIPELINE_STAGES,
      // tests/submit-order.test.ts) refreshes the env block + discovers
      // skills before the first POST, so wait for the loop-entry reply.
      await waitForFrame(app, "ok-env-block-xyz");
      const messages = posts[0]?.messages as Array<{
        role: string;
        content: string;
      }>;
      // Stable-prefix split (prompt-cache architecture): the stable head
      // carries the base with NO env tail (byte-identical across POSTs); the
      // env block rides as its own trailing system message (consecutive
      // system messages concatenate on every OpenAI-protocol server).
      expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
      expect(messages[1]?.role).toBe("system");
      expect(messages[1]?.content).toContain("[env ");
      expect(messages[1]?.content.length).toBeLessThanOrEqual(ENV_BLOCK_CHAR_CAP + 16);
      expect(messages.at(-1)).toEqual({ role: "user", content: "hi" });
    } finally {
      app.unmount();
      globalThis.fetch = realFetch;
    }
  });
});
