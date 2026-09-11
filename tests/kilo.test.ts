// Kilo Gateway provider tests. Fully mocked — never hits the real API.
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  KILO_AUTO_MODEL,
  KILO_CHAT_ENDPOINT,
  KILO_FALLBACK_MODELS,
  KILO_MODELS_URL,
  clearKiloModelsCache,
  fetchKiloModelsWithStatus,
  isFreeKiloModel,
  kiloErrorMessage,
  kiloHeaders,
  normalizeKiloChatError,
  parseKiloModelEntry,
  parseKiloModelInfos,
  parseKiloModelsList,
  preferFreeKiloModel,
} from "../src/kilo.js";
import {
  DEFAULT_PROVIDER,
  chatEndpointFor,
  getProvider,
  isProviderId,
  modelsUrlForProvider,
  providerNeedsKey,
} from "../src/providers.js";
import { maskKey } from "../src/providers.js";
import {
  chatCompletionForProvider,
  fetchModelsForProvider,
  fetchModelsForProviderWithStatus,
} from "../src/zen.js";

const savedFetch = globalThis.fetch;
const noSleep = { sleep: async () => {} };

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

const CATALOG = {
  data: [
    {
      id: "kilo-auto/free",
      display_name: "Kilo Auto (free)",
      context_length: 200000,
      capabilities: ["tools", "streaming"],
      pricing: { prompt: 0, completion: 0 },
      tools_supported: true,
    },
    { id: "moonshot/kimi-k2:free", contextLength: 262144, pricing: { prompt: "0", completion: "0" } },
    {
      id: "anthropic/claude-sonnet-4-5",
      name: "anthropic/claude-sonnet-4-5",
      max_context_length: 1000000,
      supported_parameters: ["tools", "streaming"],
      pricing: { prompt: 0.003, completion: 0.015 },
      supportsTools: true,
    },
  ],
};

beforeEach(() => {
  clearKiloModelsCache();
  for (const k of [
    "KILO_API_KEY",
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
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  clearKiloModelsCache();
  vi.unstubAllEnvs();
});

describe("registration + defaults", () => {
  test("kilo is the default provider with gateway endpoints", () => {
    expect(DEFAULT_PROVIDER).toBe("kilo");
    expect(isProviderId("kilo")).toBe(true);
    const def = getProvider("kilo")!;
    expect(def.kind).toBe("openai-chat");
    expect(def.envVars).toEqual(["KILO_API_KEY"]);
    expect(def.defaultModel).toBe("kilo-auto/free");
    expect(chatEndpointFor("kilo")).toBe(KILO_CHAT_ENDPOINT);
    expect(chatEndpointFor("kilo")).toBe("https://api.kilo.ai/api/gateway/chat/completions");
    expect(modelsUrlForProvider("kilo")).toBe(KILO_MODELS_URL);
    expect(modelsUrlForProvider("kilo")).toBe("https://api.kilo.ai/api/gateway/models");
  });

  test("kilo needs no key; keyed providers unchanged", () => {
    expect(providerNeedsKey("kilo")).toBe(false);
    expect(providerNeedsKey("openai")).toBe(true);
    expect(providerNeedsKey("opencode-zen")).toBe(true);
    expect(providerNeedsKey("anthropic")).toBe(true);
  });

  test("no static catalog: only the routing placeholder ships offline", () => {
    expect(KILO_FALLBACK_MODELS).toEqual(["kilo-auto/free"]);
    expect(KILO_AUTO_MODEL).toBe("kilo-auto/free");
  });
});

describe("free-model detection", () => {
  test(":free suffix (incl. kilo-auto/free) is free; paid ids are not", () => {
    expect(isFreeKiloModel("kilo-auto/free")).toBe(true);
    expect(isFreeKiloModel("moonshot/kimi-k2:free")).toBe(true);
    expect(isFreeKiloModel("anthropic/claude-sonnet-4-5")).toBe(false);
    expect(isFreeKiloModel("gpt-5")).toBe(false);
    expect(isFreeKiloModel("")).toBe(false);
  });

  test("preferFreeKiloModel: auto > other free > first live > fallback", () => {
    expect(preferFreeKiloModel(["paid/a", "kilo-auto/free", "b:free"])).toBe("kilo-auto/free");
    expect(preferFreeKiloModel(["paid/a", "b:free", "c:free"])).toBe("b:free");
    expect(preferFreeKiloModel(["paid/a", "paid/b"])).toBe("paid/a");
    expect(preferFreeKiloModel([])).toBe("kilo-auto/free");
    expect(preferFreeKiloModel([], "x")).toBe("x");
  });
});

describe("catalog parsing", () => {
  test("preserves id/provider/name/context/capabilities/pricing/tools", () => {
    const infos = parseKiloModelInfos(CATALOG);
    expect(infos.map((m) => m.id)).toEqual([
      "kilo-auto/free",
      "moonshot/kimi-k2:free",
      "anthropic/claude-sonnet-4-5",
    ]);
    const auto = infos[0]!;
    expect(auto.displayName).toBe("Kilo Auto (free)");
    expect(auto.provider).toBe("kilo-auto");
    expect(auto.contextLength).toBe(200000);
    expect(auto.capabilities).toEqual(["tools", "streaming"]);
    expect(auto.pricing).toEqual({ prompt: 0, completion: 0 });
    expect(auto.free).toBe(true);
    expect(auto.toolsSupported).toBe(true);
    const kimi = infos[1]!;
    expect(kimi.contextLength).toBe(262144); // camelCase accepted
    expect(kimi.free).toBe(true);
    const paid = infos[2]!;
    expect(paid.free).toBe(false);
    expect(paid.contextLength).toBe(1000000);
    expect(paid.toolsSupported).toBe(true);
  });

  test("zero pricing marks free even without :free suffix", () => {
    const infos = parseKiloModelInfos({ data: [{ id: "x/y", pricing: { prompt: 0, completion: 0 } }] });
    expect(infos[0]!.free).toBe(true);
  });

  test("plain string ids parse; bare array shape accepted", () => {
    expect(parseKiloModelsList(["a:free", "b/c"])).toEqual(["a:free", "b/c"]);
    expect(parseKiloModelsList(CATALOG)).toEqual([
      "kilo-auto/free",
      "moonshot/kimi-k2:free",
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  test("malformed payloads fall back (never throw)", () => {
    for (const bad of [{}, { data: [] }, { data: [{ nope: 1 }] }, null, undefined, "str", 42]) {
      expect(parseKiloModelsList(bad)).toEqual(["kilo-auto/free"]);
      expect(parseKiloModelInfos(bad)).toEqual([]);
    }
    expect(parseKiloModelEntry(null)).toBeNull();
    expect(parseKiloModelEntry({})).toBeNull();
  });
});

describe("discovery via zen dispatcher", () => {
  test("live catalog returns ids with ok:true; anonymous sends no Authorization", async () => {
    const seen: Array<{ url: unknown; headers: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({ url, headers: (init as { headers?: unknown })?.headers });
      return { ok: true, json: async () => CATALOG } as Response;
    });
    const res = await fetchModelsForProviderWithStatus("kilo", "");
    expect(res.ok).toBe(true);
    expect(res.models).toEqual([
      "kilo-auto/free",
      "moonshot/kimi-k2:free",
      "anthropic/claude-sonnet-4-5",
    ]);
    expect(String(seen[0]!.url)).toBe("https://api.kilo.ai/api/gateway/models");
    expect(seen[0]!.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.stringify(seen[0]!.headers)).not.toContain("Bearer");
  });

  test("authenticated discovery sends Bearer", async () => {
    let headers: unknown;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      headers = (init as { headers?: unknown })?.headers;
      return { ok: true, json: async () => CATALOG } as Response;
    });
    const res = await fetchKiloModelsWithStatus("secret-key");
    expect(res.ok).toBe(true);
    expect(headers).toMatchObject({ Authorization: "Bearer secret-key" });
  });

  test("HTTP failure / malformed JSON fall back with ok:false", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    expect(await fetchModelsForProviderWithStatus("kilo", "")).toEqual({
      models: ["kilo-auto/free"],
      ok: false,
    });
    clearKiloModelsCache();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async (): Promise<unknown> => {
        throw new Error("bad json");
      },
    }) as unknown as Response);
    expect(await fetchModelsForProvider("kilo", "")).toEqual(["kilo-auto/free"]);
  });

  test("network failure falls back (never throws)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    expect(await fetchModelsForProviderWithStatus("kilo", "")).toEqual({
      models: ["kilo-auto/free"],
      ok: false,
    });
  });

  test("cache: second discovery hits no network; clear refreshes", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => CATALOG }) as Response);
    globalThis.fetch = fetchMock;
    await fetchKiloModelsWithStatus("");
    await fetchKiloModelsWithStatus("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearKiloModelsCache();
    await fetchKiloModelsWithStatus("");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("anon and authed catalogs cache separately", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => CATALOG }) as Response);
    globalThis.fetch = fetchMock;
    await fetchKiloModelsWithStatus("");
    await fetchKiloModelsWithStatus("k");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("chat completions", () => {
  const history = () => [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ];

  test("anonymous request sends no Authorization header", async () => {
    let headers: unknown;
    let body: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      headers = (init as { headers?: unknown })?.headers;
      body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}"));
      return sseResponse([sse({ choices: [{ delta: { content: "hello" } }] }), "data: [DONE]\n\n"]);
    });
    const res = await chatCompletionForProvider("kilo", "", "kilo-auto/free", history() as never, noSleep);
    expect(res.content).toBe("hello");
    expect(headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.stringify(headers)).not.toContain("Bearer");
    expect(body["model"]).toBe("kilo-auto/free");
    expect(Array.isArray(body["tools"])).toBe(true);
    expect(body["stream"]).toBe(true);
  });

  test("authenticated request sends Bearer", async () => {
    let headers: unknown;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      headers = (init as { headers?: unknown })?.headers;
      return sseResponse([sse({ choices: [{ delta: { content: "hi" } }] }), "data: [DONE]\n\n"]);
    });
    await chatCompletionForProvider("kilo", "k-key", "x/y", history() as never, noSleep);
    expect(headers).toMatchObject({ Authorization: "Bearer k-key" });
  });

  test("streaming content deltas accumulate; usage passes through", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        sse({ choices: [{ delta: { content: "he" } }] }),
        sse({ choices: [{ delta: { content: "llo" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
        "data: [DONE]\n\n",
      ])
    );
    const tokens: string[] = [];
    const res = await chatCompletionForProvider("kilo", "", "kilo-auto/free", history() as never, {
      ...noSleep,
      onToken: (t) => tokens.push(t),
    });
    expect(res.content).toBe("hello");
    expect(tokens).toEqual(["he", "hello"]);
    expect(res.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 2 });
  });

  test("streamed tool calls reconstruct across chunks (split name + args)", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "rea", arguments: '{"pat' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "d", arguments: 'h":"src"}' } }] } }] }),
        "data: [DONE]\n\n",
      ])
    );
    const res = await chatCompletionForProvider("kilo", "", "kilo-auto/free", history() as never, noSleep);
    expect(res.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"src"}' } },
    ]);
  });

  test("malformed stream (no [DONE]) throws truncation", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([sse({ choices: [{ delta: { content: "partial" } }] })])
    );
    await expect(
      chatCompletionForProvider("kilo", "", "kilo-auto/free", history() as never, noSleep)
    ).rejects.toThrow(/Truncated stream/);
  });

  test("network failure surfaces (gateway wording available)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(
      chatCompletionForProvider("kilo", "", "kilo-auto/free", history() as never, noSleep)
    ).rejects.toThrow();
  });
});

describe("error normalization", () => {
  test.each([
    [401, true, "Kilo: API key is invalid."],
    [401, false, "Kilo: API key is invalid."],
    [403, true, "Kilo: access forbidden for this model or key."],
    [404, true, "Kilo: model is unavailable."],
    [404, false, "Kilo: model is unavailable."],
    [429, false, "Kilo: anonymous free-model rate limit reached."],
    [429, true, "Kilo: rate limit reached — wait a moment, then resend."],
    [500, true, "Kilo: gateway temporarily unavailable."],
    [502, false, "Kilo: gateway temporarily unavailable."],
    [503, true, "Kilo: gateway temporarily unavailable."],
  ])("status %i (key=%s) → %s", (status, hasKey, expected) => {
    expect(kiloErrorMessage(status as number, hasKey as boolean)).toBe(expected);
  });

  test("HTTP failures reframe; non-HTTP errors pass through untouched", async () => {
    for (const [status, expected] of [
      [401, "Kilo: API key is invalid."],
      [403, "Kilo: access forbidden for this model or key."],
      [404, "Kilo: model is unavailable."],
      [429, "Kilo: anonymous free-model rate limit reached."],
      [500, "Kilo: gateway temporarily unavailable."],
    ] as const) {
      globalThis.fetch = vi.fn(async () => ({ ok: false, status, text: async () => "raw-body" }) as Response);
      await expect(
        chatCompletionForProvider("kilo", "", "kilo-auto/free", [{ role: "user", content: "hi" }] as never, noSleep)
      ).rejects.toThrow(expected);
    }
    // No raw HTTP dump leaks into the TUI message.
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => "upstream blob" }) as Response);
    const err: Error = await chatCompletionForProvider(
      "kilo",
      "",
      "m",
      [{ role: "user", content: "hi" }] as never,
      noSleep
    ).then(
      () => new Error("expected throw"),
      (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
    );
    expect(err.message).not.toContain("upstream blob");
    expect(err.message).not.toContain("HTTP 404:");
    // Non-HTTP shapes pass through.
    const trunc = new Error("Truncated stream from model (connection aborted before [DONE]).");
    expect(normalizeKiloChatError(trunc, "")).toBe(trunc);
    expect(normalizeKiloChatError("str", "")).toBe("str");
  });
});

describe("keyless session restore", () => {
  test("a saved kilo session restores without a key (other providers do not)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveSession, loadPrefs } = await import("../src/session.js");
    const { emptyAuth } = await import("../src/auth.js");
    void emptyAuth;
    const home = await mkdtemp(join(tmpdir(), "atom-kilo-prefs-"));
    try {
      const snapshot = {
        provider: "kilo" as const,
        model: "kilo-auto/free",
        effort: "auto" as const,
        mode: "normal" as const,
        usageTotals: null,
        history: [
          { role: "system", content: "sys" },
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
        ],
        turns: [
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
        ],
      };
      saveSession(snapshot as never, home);
      // No keys anywhere: kilo restores (anonymous free models)…
      const prefs = loadPrefs(home, "https://opencode.ai/zen/v1/chat/completions");
      expect(prefs?.provider).toBe("kilo");
      expect(prefs?.model).toBe("kilo-auto/free");
      expect(prefs?.apiKey).toBe("");
      expect(prefs?.endpoint).toBe("https://api.kilo.ai/api/gateway/chat/completions");
      // …while a keyed provider without a key does not.
      saveSession({ ...snapshot, provider: "openai" } as never, home);
      expect(loadPrefs(home, "https://opencode.ai/zen/v1/chat/completions")).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("TUI bootstrap (fresh install, no key)", () => {
  const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

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

  // Gateway mock: live catalog on GET, streaming reply on POST. Records
  // request headers per call for the auth assertions.
  function mockGateway(reply = "kilo hello") {
    const seen: Array<{ url: string; method: string; headers: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      seen.push({ url: u, method, headers: (init as { headers?: unknown })?.headers });
      if (method === "GET" && u.endsWith("/models")) {
        return { ok: true, json: async () => CATALOG } as Response;
      }
      if (method === "POST" && u.endsWith("/chat/completions")) {
        return sseResponse([sse({ choices: [{ delta: { content: reply } }] }), "data: [DONE]\n\n"]);
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    });
    return seen;
  }

  test("fresh start selects Kilo, discovers models, chats anonymously", async () => {
    const seen = mockGateway();
    const app = render(React.createElement(App, { apiKey: "", endpoint: ENDPOINT }));
    try {
      // Kilo auto-selected on the free routing model, no key required.
      await waitForFrame(app, "kilo/kilo-auto/free");
      // Discovered models appear in the picker with the free badge.
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      expect(app.lastFrame()).toContain("kilo-auto/free");
      expect(app.lastFrame()).toContain("(free)");
      app.stdin.write("\u001B"); // close picker
      await waitForFrame(app, "›");
      // Anonymous chat works immediately (no /provider detour).
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "kilo hello");
      const posts = seen.filter((s) => s.method === "POST");
      expect(posts).toHaveLength(1);
      expect(JSON.stringify(posts[0]!.headers)).not.toContain("Authorization");
    } finally {
      app.unmount();
    }
  });

  test("/models refresh re-fetches the gateway catalog", async () => {
    const seen = mockGateway();
    const app = render(React.createElement(App, { apiKey: "", endpoint: ENDPOINT }));
    try {
      await waitForFrame(app, "kilo/kilo-auto/free");
      const gets = () => seen.filter((s) => s.method === "GET" && s.url.endsWith("/models")).length;
      expect(gets()).toBe(1);
      app.stdin.write("/models refresh");
      app.stdin.write("\r");
      await waitForFrame(app, "Kilo models refreshed: 3 available.");
      expect(gets()).toBe(2);
    } finally {
      app.unmount();
    }
  });

  test("kilo key prompt is optional: empty Enter continues anonymously", async () => {
    mockGateway();
    const app = render(
      React.createElement(App, { apiKey: "", endpoint: ENDPOINT, initialModels: ["kilo-auto/free"] })
    );
    try {
      await waitForFrame(app, "kilo/kilo-auto/free");
      app.stdin.write("/provider");
      app.stdin.write("\r");
      await waitForFrame(app, "Select provider");
      app.stdin.write("\r"); // kilo is index 0, no key -> optional prompt
      await waitForFrame(app, "API key for kilo");
      expect(app.lastFrame()).toContain("Optional: free models");
      app.stdin.write("\r"); // empty Enter -> anonymous switch
      await waitForFrame(app, "provider: kilo");
      expect(app.lastFrame()).toContain("kilo/kilo-auto/free");
    } finally {
      app.unmount();
    }
  });
});

describe("key secrecy + isolation", () => {
  test("kiloHeaders omits auth when keyless; maskKey never leaks", () => {
    expect(kiloHeaders("")).toEqual({ "Content-Type": "application/json" });
    expect(kiloHeaders("k")).toEqual({ "Content-Type": "application/json", Authorization: "Bearer k" });
    expect(maskKey("super-secret-key")).not.toContain("super-secret");
    // Normalized errors never echo key material.
    expect(kiloErrorMessage(401, true)).not.toContain("Bearer");
  });

  test("other providers unchanged: auth header still sent, labels intact", async () => {
    let headers: unknown;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      headers = (init as { headers?: unknown })?.headers;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) } as Response;
    });
    await chatCompletionForProvider(
      "openai",
      "o-key",
      "gpt-5.6-terra",
      [{ role: "user", content: "hi" }] as never,
      noSleep
    );
    expect(headers).toMatchObject({ Authorization: "Bearer o-key" });
    // Zen still requires Bearer (keyed path behavior preserved).
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => "nope" }) as Response);
    await expect(
      chatCompletionForProvider("opencode-zen", "z-key", "big-pickle", [{ role: "user", content: "hi" }] as never, noSleep)
    ).rejects.toThrow(/^Zen HTTP 401/);
  });
});
