// Ticket 02: mid-turn token tick on the core path.
//
// The AgentCore path dropped per-POST usage (its onUsage sink was a no-op),
// so the status bar only ticked at turn end — unlike the legacy loop path,
// whose onUsage fires per reporting POST. Core now forwards each report as
// a `usage.reported` event and App accumulates it exactly like the legacy
// path, so the token segment updates between tool rounds, not just after
// the turn. Network is ALWAYS mocked; temp HOME via ATOM_HOME.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App.js";
import { AgentCore } from "../src/agent/core.js";
import type { AgentEvent } from "../src/agent/events.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

let homes: string[] = [];

async function cleanEnv(): Promise<string> {
  for (const k of [
    "OPENCODE_ZEN_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ]) {
    delete process.env[k];
  }
  const home = await mkdtemp(join(tmpdir(), "atom-core-usage-"));
  homes.push(home);
  process.env.ATOM_HOME = home;
  return home;
}

async function seedKeys(home: string) {
  const { saveAuth, setStoredKey, emptyAuth } = await import("../src/auth.js");
  let auth = emptyAuth();
  auth = setStoredKey(auth, "opencode-zen", "test-key");
  saveAuth(auth, home);
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
});

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 15000
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

// Two reporting POSTs in one turn (tool round + final answer). big-pickle is
// deliberately used: absent from CONTEXT_WINDOWS, so the segment renders the
// bare `token: NK` form — NK = round(total/1024).
const U1 = { prompt_tokens: 1500, completion_tokens: 100, total_tokens: 1600 };
const U2 = { prompt_tokens: 2500, completion_tokens: 200, total_tokens: 2700 };

function mockTwoPosts(usage1: unknown, usage2: unknown) {
  const posts: Array<{ messages?: unknown }> = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: unknown };
    posts.push(body);
    const usage = posts.length === 1 ? usage1 : usage2;
    const message =
      posts.length === 1
        ? {
            content: null,
            tool_calls: [
              {
                id: "t1",
                type: "function",
                function: { name: "glob", arguments: JSON.stringify({ pattern: "*.ts" }) },
              },
            ],
          }
        : { content: "final answer" };
    return { ok: true, json: async () => ({ choices: [{ message }], usage }) } as Response;
  }) as unknown as typeof fetch;
  return posts;
}

describe("core-path per-POST usage (ticket 02)", () => {
  test("core forwards each POST's usage as usage.reported, genuinely mid-turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atom-core-usage-unit-"));
    homes.push(dir);
    const posts = mockTwoPosts(U1, U2);
    const events: AgentEvent[] = [];
    let sawFirstReport = false;
    let releaseFirstReport: () => void = () => {};
    const firstReport = new Promise<void>((r) => {
      releaseFirstReport = () => {
        if (!sawFirstReport) {
          sawFirstReport = true;
          r();
        }
      };
    });
    const agent = new AgentCore({
      provider: "opencode-zen",
      model: "big-pickle",
      effort: "auto",
      mode: "normal",
      apiKey: "test-key",
      baseURL: ENDPOINT,
      cwd: dir,
      history: [{ role: "system", content: "s" }],
    });
    agent.onEvent((e) => {
      events.push(e);
      if (e.type === "usage.reported") releaseFirstReport();
    });
    const send = agent.send("list ts files");
    // The tick must arrive while the turn is still running: the first
    // report lands BEFORE the second POST is even made (deterministic
    // mid-turn proof, no timing race).
    await firstReport;
    expect(posts).toHaveLength(1);
    const report1 = events.find((e) => e.type === "usage.reported");
    expect(report1).toMatchObject({ type: "usage.reported", usage: U1 });
    await send;
    const reports = events.filter((e) => e.type === "usage.reported");
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ type: "usage.reported", usage: U2 });
    const completedAt = events.findIndex((e) => e.type === "agent.completed");
    expect(reports.map((r) => events.indexOf(r)).every((i) => i < completedAt)).toBe(true);
    expect(await send).toContain("final answer");
  });

  test("POSTs that report no usage emit no usage.reported (reported-only)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atom-core-usage-silent-"));
    homes.push(dir);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "no usage here" } }] }),
    })) as unknown as typeof fetch;
    const events: AgentEvent[] = [];
    const agent = new AgentCore({
      provider: "opencode-zen",
      model: "big-pickle",
      effort: "auto",
      mode: "normal",
      apiKey: "test-key",
      baseURL: ENDPOINT,
      cwd: dir,
      history: [{ role: "system", content: "s" }],
    });
    agent.onEvent((e) => events.push(e));
    await agent.send("plain");
    expect(events.some((e) => e.type === "usage.reported")).toBe(false);
  });

  test("dock token pill ticks between tool rounds on the core path", async () => {
    const home = await cleanEnv();
    await seedKeys(home);
    // Pin the dock path (cleanEnv snapshots the ambient env; the file-level
    // afterEach restores it, so the override never leaks to other suites).
    process.env.ATOM_DOCK = "1";
    // Gate POST 2 so the intermediate frame (POST 1's usage painted by the
    // dock) is observable deterministically.
    let releasePost2: () => void = () => {};
    const post2Gate = new Promise<void>((r) => {
      releasePost2 = r;
    });
    const posts: Array<{ messages?: unknown }> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        // Mount model list.
        return {
          ok: true,
          json: async () => ({ data: [{ id: "big-pickle", family: "chat" }] }),
        } as Response;
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: unknown };
      posts.push(body);
      if (posts.length === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "t1",
                      type: "function",
                      function: { name: "glob", arguments: JSON.stringify({ pattern: "*.ts" }) },
                    },
                  ],
                },
              },
            ],
            usage: U1,
          }),
        } as Response;
      }
      await post2Gate;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "final answer" } }], usage: U2 }),
      } as Response;
    }) as unknown as typeof fetch;
    // No initialModels: normal chat takes the AgentCore path.
    const app = render(
      <App apiKey="test-key" endpoint={ENDPOINT} initialProvider="opencode-zen" initialModel="big-pickle" />
    );
    try {
      app.stdin.write("tick please");
      app.stdin.write("\r");
      // POST 1 reported 1600 total tokens → `token: 2K` painted MID-TURN
      // (POST 2 is still gated, so the turn has not finished).
      await waitForFrame(app, "token: 2K");
      // Dock busy proof (POST 2 still gated): dock frame + elapsed pill +
      // reasoning pill beside the ticked token pill.
      const midFrame = app.lastFrame() ?? "";
      expect(midFrame).toContain("┌");
      expect(midFrame).toContain("elapsed:");
      expect(midFrame).toContain("reasoning: auto");
      releasePost2();
      // POST 2 reported 2700 → cumulative 4300 → `token: 4K`, with the
      // final answer in the transcript.
      await waitForFrame(app, "final answer");
      await waitForFrame(app, "token: 4K");
      expect(app.lastFrame()).toContain("┌");
    } finally {
      app.unmount();
    }
  });
});
