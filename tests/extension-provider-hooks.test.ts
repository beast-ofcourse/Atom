// Provider request/response hooks (ticket 08): outgoing-context transform,
// pre-request payload/header replacement with explicit deletion semantics,
// post-response observation that never breaks the turn, deterministic
// load-order chaining with fail-open degradation, all-provider coverage
// (openai-chat, anthropic-messages, gemini-generate), and the ticket-01
// stale-generation rule for the new API methods. Pure unit tests — tmpdir
// files for extension loading, mocked fetch only, no TUI, no network.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadExtensions, type ExtensionAPI } from "../src/extensions.js";
import {
  chatCompletion,
  chatCompletionForProvider,
  type ChatMessage,
} from "../src/zen.js";
import {
  applyBeforeRequest,
  applyContextTransform,
  afterResponseObservers,
  beforeRequestInterceptors,
  clearProviderHooks,
  contextTransformers,
  notifyAfterResponse,
  registerAfterResponse,
  registerBeforeRequest,
  registerContextTransform,
  snapshotResponseHeaders,
} from "../src/tools.js";

const realFetch = globalThis.fetch;

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "atom-ext-08-"));
}

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  roots = [];
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
  clearProviderHooks();
  for (const key of ["__capP", "__freshP"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

function writeExt(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  if (!roots.includes(root)) roots.push(root);
  return abs;
}

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ];
}

// Non-streaming openai-chat mock: captures the request, answers one line.
function mockOpenAIChat(seen: Array<{ url: unknown; init: RequestInit; body: Record<string, unknown> }>, reply = "z") {
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
    seen.push({ url, init: (init ?? {}) as RequestInit, body });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "x-request-id": "req-1" }),
      json: async () => ({ choices: [{ message: { content: reply } }] }),
    };
  }) as unknown as typeof fetch;
}

describe("context transform (pure apply)", () => {
  test("handlers chain in load order; each sees the previous output", async () => {
    const order: string[] = [];
    const out = await applyContextTransform(
      [
        {
          owner: "a",
          handler: (msgs) => {
            order.push("a");
            return [...msgs, { role: "user", content: "from-a" }];
          },
        },
        {
          owner: "b",
          handler: (msgs) => {
            order.push("b");
            expect(msgs[msgs.length - 1]).toMatchObject({ content: "from-a" });
            return msgs.map((m) =>
              m.role === "user" && m.content === "hi" ? { ...m, content: "redacted" } : m
            );
          },
        },
      ],
      baseHistory()
    );
    expect(order).toEqual(["a", "b"]);
    expect(out).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "redacted" },
      { role: "user", content: "from-a" },
    ]);
  });

  test("throwing transformer degrades to the untransformed value", async () => {
    const out = await applyContextTransform(
      [
        { owner: "a", handler: () => { throw new Error("boom-ctx"); } },
        { owner: "b", handler: (msgs) => [...msgs, { role: "user", content: "b-lived" }] },
      ],
      baseHistory()
    );
    expect(out).toEqual([...baseHistory(), { role: "user", content: "b-lived" }]);
  });

  test("malformed returns and void pass through untouched", async () => {
    const out = await applyContextTransform(
      [
        { owner: "a", handler: () => undefined },
        // Non-array and bad-role arrays are ignored, never committed.
        { owner: "b", handler: () => "nope" as unknown as ChatMessage[] },
        { owner: "c", handler: () => [{ role: "bogus", content: "x" }] as unknown as ChatMessage[] },
      ],
      baseHistory()
    );
    expect(out).toEqual(baseHistory());
  });
});

describe("pre-request (pure apply)", () => {
  test("payload replacement + header set/delete merge; deletions honored", async () => {
    const out = await applyBeforeRequest(
      [
        {
          owner: "trace",
          handler: () => ({ headers: { "x-trace": "1", "x-drop-me": null } }),
        },
        {
          owner: "route",
          handler: ({ payload, headers }) => {
            expect(headers["x-trace"]).toBe("1");
            expect("x-drop-me" in headers).toBe(false);
            return { payload: { ...payload, model: "rerouted" } };
          },
        },
      ],
      {
        provider: "openai",
        model: "m",
        url: "https://x",
        payload: { model: "m" },
        headers: { "Content-Type": "application/json", "x-drop-me": "gone" },
      }
    );
    expect(out.payload).toMatchObject({ model: "rerouted" });
    expect(out.headers).toEqual({ "Content-Type": "application/json", "x-trace": "1" });
  });

  test("throwing pre-request handler is skipped fail-open; non-record payload ignored", async () => {
    const out = await applyBeforeRequest(
      [
        { owner: "flaky", handler: () => { throw new Error("boom-pre"); } },
        { owner: "bad", handler: () => ({ payload: 42 as unknown as Record<string, unknown> }) },
        { owner: "good", handler: () => ({ headers: { "x-ok": "yes", "x-num": 7 as unknown as string } }) },
      ],
      { provider: "p", model: "m", url: "u", payload: { a: 1 }, headers: { h: "v" } }
    );
    expect(out.payload).toEqual({ a: 1 });
    // Non-string header values are ignored (never silently stringified).
    expect(out.headers).toEqual({ h: "v", "x-ok": "yes" });
  });
});

describe("post-response (pure apply)", () => {
  test("observers see status + headers; throws never break the turn", async () => {
    const seen: unknown[] = [];
    await notifyAfterResponse(
      [
        { owner: "boom", handler: () => { throw new Error("boom-post"); } },
        { owner: "log", handler: (info) => { seen.push(info); } },
      ],
      { provider: "p", model: "m", url: "u", status: 200, ok: true, headers: { a: "b" } }
    );
    expect(seen).toEqual([{ provider: "p", model: "m", url: "u", status: 200, ok: true, headers: { a: "b" } }]);
  });

  test("snapshotResponseHeaders never throws on odd shapes", () => {
    expect(snapshotResponseHeaders(null)).toEqual({});
    expect(snapshotResponseHeaders({})).toEqual({});
    expect(snapshotResponseHeaders({ headers: { get: () => "x" } })).toEqual({});
    expect(snapshotResponseHeaders({ headers: new Headers({ "X-A": "1" }) })).toEqual({ "x-a": "1" });
  });
});

describe("live openai-chat turn", () => {
  test("context handler transforms outgoing messages; model gets the transformed version", async () => {
    registerContextTransform(
      (msgs) => msgs.map((m) => (m.role === "user" ? { ...m, content: "redacted" } : m)),
      "scrubber"
    );
    const seen: Array<{ url: unknown; init: RequestInit; body: Record<string, unknown> }> = [];
    mockOpenAIChat(seen);
    const history = baseHistory();
    const result = await chatCompletion("https://example.test/v1/chat/completions", "k", "m", history, {
      sleep: async () => {},
    });
    expect(result.content).toBe("z");
    const sent = seen[0]!.body["messages"] as Array<{ role: string; content: string }>;
    expect(sent.find((m) => m.role === "user")).toMatchObject({ content: "redacted" });
    // The loop transcript itself is never mutated.
    expect(history).toEqual(baseHistory());
  });

  test("mutating handler cannot corrupt the loop transcript (deep copy)", async () => {
    registerContextTransform((msgs) => {
      msgs.push({ role: "user", content: "injected" });
      const first = msgs[0] as { content?: unknown };
      if (first && typeof first === "object") first.content = "smashed";
      return msgs;
    }, "vandal");
    const seen: Array<{ url: unknown; init: RequestInit; body: Record<string, unknown> }> = [];
    mockOpenAIChat(seen);
    const history = baseHistory();
    await chatCompletion("https://example.test/v1/chat/completions", "k", "m", history, {
      sleep: async () => {},
    });
    expect(history).toEqual(baseHistory());
  });

  test("pre-request replaces payload and mutates headers with deletions honored", async () => {
    registerBeforeRequest(
      () => ({
        payload: { model: "m", messages: [], stream: true, routed: true },
        headers: { "x-trace": "t-1", Authorization: undefined },
      }),
      "router"
    );
    const seen: Array<{ url: unknown; init: RequestInit; body: Record<string, unknown> }> = [];
    mockOpenAIChat(seen);
    await chatCompletion("https://example.test/v1/chat/completions", "secret-key", "m", baseHistory(), {
      sleep: async () => {},
    });
    expect(seen[0]!.body).toMatchObject({ routed: true, messages: [] });
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["x-trace"]).toBe("t-1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect("Authorization" in headers).toBe(false);
  });

  test("post-response observes status and headers without breaking the turn when it throws", async () => {
    const seen: unknown[] = [];
    registerAfterResponse(() => { throw new Error("boom-observe"); }, "flaky");
    registerAfterResponse((info) => { seen.push({ status: info.status, ok: info.ok, headers: info.headers }); }, "log");
    const reqs: Array<{ url: unknown; init: RequestInit; body: Record<string, unknown> }> = [];
    mockOpenAIChat(reqs);
    const result = await chatCompletion("https://example.test/v1/chat/completions", "k", "m", baseHistory(), {
      sleep: async () => {},
    });
    expect(result.content).toBe("z");
    expect(seen).toEqual([{ status: 200, ok: true, headers: { "x-request-id": "req-1" } }]);
  });

  test("pre-request handlers chain in load order; throwing transformer degrades", async () => {
    const order: string[] = [];
    registerBeforeRequest(() => { order.push("first"); return { headers: { "x-n": "1" } }; }, "first");
    registerBeforeRequest(() => { order.push("boom"); throw new Error("boom"); }, "boom");
    registerBeforeRequest(({ headers }) => {
      order.push("third");
      expect(headers["x-n"]).toBe("1");
      return { headers: { "x-n": "3" } };
    }, "third");
    registerContextTransform(() => { throw new Error("boom-ctx"); }, "flaky-ctx");
    const seen: Array<{ url: unknown; init: RequestInit; body: Record<string, unknown> }> = [];
    mockOpenAIChat(seen);
    await chatCompletion("https://example.test/v1/chat/completions", "k", "m", baseHistory(), {
      sleep: async () => {},
    });
    expect(order).toEqual(["first", "boom", "third"]);
    expect((seen[0]!.init.headers as Record<string, string>)["x-n"]).toBe("3");
    // Degraded context still sends the original user text.
    const sent = seen[0]!.body["messages"] as Array<{ content: string }>;
    expect(sent.map((m) => m.content)).toContain("hi");
  });
});

describe("all-provider coverage", () => {
  function mockProviderChat() {
    const bodies: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
      bodies.push({ url: u, body, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
      if (u.includes("anthropic")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "x-rid": "a" }),
          json: async () => ({
            content: [{ type: "text", text: "a-hi" }],
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "x-rid": "g" }),
        json: async () => ({
          candidates: [{ content: { role: "model", parts: [{ text: "g-hi" }] } }],
        }),
      };
    }) as unknown as typeof fetch;
    return bodies;
  }

  test("anthropic: context + pre-request + post-response all fire with provider attribution", async () => {
    const observed: string[] = [];
    registerContextTransform(
      (msgs) => msgs.map((m) => (m.role === "user" ? { ...m, content: "scrubbed" } : m)),
      "scrub"
    );
    registerBeforeRequest((input) => {
      observed.push(`pre:${input.provider}`);
      return { headers: { "x-ext": "1" } };
    }, "pre");
    registerAfterResponse((info) => {
      observed.push(`post:${info.provider}:${info.status}:${info.headers["x-rid"]}`);
    }, "post");
    const bodies = mockProviderChat();
    const result = await chatCompletionForProvider("anthropic", "k", "claude-sonnet-4-5", baseHistory(), {
      sleep: async () => {},
    });
    expect(result.content).toBe("a-hi");
    expect(observed).toEqual(["pre:anthropic", "post:anthropic:200:a"]);
    expect(JSON.stringify(bodies[0]!.body)).toContain("scrubbed");
    expect(bodies[0]!.headers["x-ext"]).toBe("1");
  });

  test("gemini: context + pre-request + post-response all fire with provider attribution", async () => {
    const observed: string[] = [];
    registerContextTransform(
      (msgs) => msgs.map((m) => (m.role === "user" ? { ...m, content: "scrubbed" } : m)),
      "scrub"
    );
    registerBeforeRequest((input) => {
      observed.push(`pre:${input.provider}`);
    }, "pre");
    registerAfterResponse((info) => {
      observed.push(`post:${info.provider}:${info.status}:${info.headers["x-rid"]}`);
    }, "post");
    const bodies = mockProviderChat();
    const result = await chatCompletionForProvider("google-gemini", "k", "gemini-2.5-flash", baseHistory(), {
      sleep: async () => {},
    });
    expect(result.content).toBe("g-hi");
    expect(observed).toEqual(["pre:google-gemini", "post:google-gemini:200:g"]);
    expect(JSON.stringify(bodies[0]!.body)).toContain("scrubbed");
  });

  test("openai-chat dispatcher attributes the real provider id", async () => {
    const providers: string[] = [];
    registerBeforeRequest((input) => { providers.push(input.provider); }, "who");
    const seen: Array<{ url: unknown; init: RequestInit; body: Record<string, unknown> }> = [];
    mockOpenAIChat(seen);
    await chatCompletionForProvider("openai", "k", "gpt-x", baseHistory(), { sleep: async () => {} });
    expect(providers).toEqual(["openai"]);
  });
});

describe("lifecycle", () => {
  test("stale-generation rule covers the new API methods", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(
          root,
          "cap.js",
          `module.exports = function (api) { globalThis.__capP = api; api.on("session_start", (fresh) => { globalThis.__freshP = fresh; }); };`
        ),
      ],
    });
    expect(runtime.loaded).toHaveLength(1);
    const captured = (globalThis as Record<string, unknown>).__capP as ExtensionAPI;
    runtime.invalidate("stale after test switch");
    expect(() => captured.onTransformContext(() => {})).toThrow("stale after test switch");
    expect(() => captured.onBeforeRequest(() => {})).toThrow("stale after test switch");
    expect(() => captured.onAfterResponse(() => {})).toThrow("stale after test switch");
    await runtime.emit("session_start", { reason: "switch" });
    const fresh = (globalThis as Record<string, unknown>).__freshP as ExtensionAPI;
    const offCtx = fresh.onTransformContext(() => {});
    const offPre = fresh.onBeforeRequest(() => {});
    const offPost = fresh.onAfterResponse(() => {});
    expect(contextTransformers()).toHaveLength(1);
    expect(beforeRequestInterceptors()).toHaveLength(1);
    expect(afterResponseObservers()).toHaveLength(1);
    offCtx();
    offPre();
    offPost();
    expect(contextTransformers()).toHaveLength(0);
    expect(beforeRequestInterceptors()).toHaveLength(0);
    expect(afterResponseObservers()).toHaveLength(0);
    // Unregister closures honor staleness like registerTool's (ticket-02 pattern).
    const offStale = fresh.onBeforeRequest(() => {});
    runtime.invalidate("second switch");
    expect(() => offStale()).toThrow("second switch");
  });

  test("activation is atomic: factory that registers then throws leaves no provider hook behind", async () => {
    const root = makeTempRoot();
    const entry = writeExt(
      root,
      "flaky.js",
      `module.exports = function (api) { api.onTransformContext((m) => m); api.onBeforeRequest(() => {}); api.onAfterResponse(() => {}); throw new Error("boom-after-hooks"); };`
    );
    const runtime = await loadExtensions({ entryPaths: [entry] });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors.some((e) => e.error.includes("boom-after-hooks"))).toBe(true);
    expect(contextTransformers()).toHaveLength(0);
    expect(beforeRequestInterceptors()).toHaveLength(0);
    expect(afterResponseObservers()).toHaveLength(0);
  });

  test("non-function handler fails activation loudly", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(root, "bad-pre.js", `module.exports = function (api) { api.onBeforeRequest(123); };`),
        writeExt(root, "bad-post.js", `module.exports = function (api) { api.onAfterResponse(null); };`),
        writeExt(root, "bad-ctx.js", `module.exports = function (api) { api.onTransformContext("x"); };`),
      ],
    });
    expect(runtime.loaded).toEqual([]);
    expect(runtime.errors).toHaveLength(3);
    expect(runtime.errors.every((e) => e.error.includes("must be a function"))).toBe(true);
  });

  test("extension-registered hooks fire end to end on a live POST", async () => {
    const root = makeTempRoot();
    const runtime = await loadExtensions({
      entryPaths: [
        writeExt(
          root,
          "e2e.js",
          `module.exports = function (api) {
            api.onTransformContext((msgs) => msgs.map((m) => (m.role === "user" ? { ...m, content: m.content + "!" } : m)));
            api.onBeforeRequest(() => ({ headers: { "x-e2e": "yes" } }));
            api.onAfterResponse((info) => { globalThis.__e2eStatus = info.status; });
          };`
        ),
      ],
    });
    expect(runtime.loaded).toHaveLength(1);
    const seen: Array<{ url: unknown; init: RequestInit; body: Record<string, unknown> }> = [];
    mockOpenAIChat(seen);
    await chatCompletion("https://example.test/v1/chat/completions", "k", "m", baseHistory(), {
      sleep: async () => {},
    });
    const sent = seen[0]!.body["messages"] as Array<{ role: string; content: string }>;
    expect(sent.find((m) => m.role === "user")).toMatchObject({ content: "hi!" });
    expect((seen[0]!.init.headers as Record<string, string>)["x-e2e"]).toBe("yes");
    expect((globalThis as Record<string, unknown>).__e2eStatus).toBe(200);
    delete (globalThis as Record<string, unknown>).__e2eStatus;
  });
});
