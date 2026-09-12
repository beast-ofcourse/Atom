// Local model auto-discovery: Ollama / LM Studio / llama.cpp.
//
// Unit level: per-runtime probing with mocked HTTP (never touch loopback),
// malformed/timeout isolation, refresh + staleness, env overrides.
// Integration level: discovered models flow through the EXISTING production
// path — zen model-list routing, the AgentRuntime loop, and the App TUI
// (picker grouping, select/switch, submit, /model refresh).
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, modelPickerEntries, modelsCacheKey } from "../src/App.js";
import {
  createLocalDiscovery,
  discoverLlamaCpp,
  discoverLMStudio,
  discoverLocalProvider,
  discoverOllama,
  discoveryBaseURL,
  emptyLocalSnapshot,
  parseOllamaTagsPayload,
  parseOpenAIModelsPayload,
  summarizeLocalSnapshot,
  type LocalDiscovery,
  type LocalSnapshot,
} from "../src/local-discovery.js";
import {
  chatEndpointFor,
  isLocalProviderId,
  localBaseURLFor,
  localChatEndpoint,
  modelsUrlForProvider,
  providerNeedsKey,
} from "../src/providers.js";
import {
  fetchModelsForProviderWithStatus,
  runAgenticLoopForProvider,
  type ChatMessage,
} from "../src/zen.js";

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let homes: string[] = [];

const LOCAL_ENVS = ["ATOM_OLLAMA_URL", "ATOM_LMSTUDIO_URL", "ATOM_LLAMACPP_URL"];
const KEY_ENVS = [
  "OPENCODE_ZEN_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

async function cleanEnv(): Promise<string> {
  for (const k of [...KEY_ENVS, ...LOCAL_ENVS]) delete process.env[k];
  const home = await mkdtemp(join(tmpdir(), "atom-local-"));
  homes.push(home);
  process.env.ATOM_HOME = home;
  return home;
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

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => data,
  } as unknown as Response;
}

function sseResponse(text: string): Response {
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body);
}

const OLLAMA_TAGS = {
  models: [
    {
      name: "qwen3:8b",
      model: "qwen3:8b",
      modified_at: "2026-01-01T00:00:00Z",
      size: 5235200000,
      digest: "sha256:abc",
      details: {
        format: "gguf",
        family: "qwen3",
        families: ["qwen3"],
        parameter_size: "8.2B",
        quantization_level: "Q4_K_M",
      },
    },
    { name: "llama3.2:3b", model: "llama3.2:3b", size: 2000000000, details: {} },
  ],
};

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 10000
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

describe("local registry surface", () => {
  test("local ids, keyless routing, endpoint derivations", () => {
    expect(isLocalProviderId("ollama")).toBe(true);
    expect(isLocalProviderId("lmstudio")).toBe(true);
    expect(isLocalProviderId("llamacpp")).toBe(true);
    expect(isLocalProviderId("openai")).toBe(false);
    expect(providerNeedsKey("ollama")).toBe(false);
    expect(providerNeedsKey("openai")).toBe(true);
    expect(localBaseURLFor("ollama")).toBe("http://127.0.0.1:11434");
    expect(localBaseURLFor("lmstudio")).toBe("http://127.0.0.1:1234");
    expect(localBaseURLFor("llamacpp")).toBe("http://127.0.0.1:8080");
    expect(localChatEndpoint("http://127.0.0.1:11434")).toBe(
      "http://127.0.0.1:11434/v1/chat/completions"
    );
    expect(chatEndpointFor("ollama", "")).toBe(
      "http://127.0.0.1:11434/v1/chat/completions"
    );
    expect(modelsUrlForProvider("lmstudio", "")).toBe("http://127.0.0.1:1234/v1/models");
    expect(modelsCacheKey("ollama", "http://127.0.0.1:11434")).toBe(
      "ollama|http://127.0.0.1:11434"
    );
  });

  test("endpoint env overrides win over defaults", async () => {
    await cleanEnv();
    process.env.ATOM_OLLAMA_URL = "http://127.0.0.1:9999";
    expect(discoveryBaseURL("ollama")).toBe("http://127.0.0.1:9999");
    expect(localBaseURLFor("ollama")).toBe("http://127.0.0.1:9999");
    expect(chatEndpointFor("ollama", "")).toBe(
      "http://127.0.0.1:9999/v1/chat/completions"
    );
  });
});

describe("response parsers", () => {
  test("ollama tags: ids + metadata preserved, bad entries skipped", () => {
    const parsed = parseOllamaTagsPayload(OLLAMA_TAGS);
    expect(parsed?.map((m) => m.id)).toEqual(["qwen3:8b", "llama3.2:3b"]);
    expect(parsed?.[0]?.parameterSize).toBe("8.2B");
    expect(parsed?.[0]?.family).toBe("qwen3");
    expect(parsed?.[0]?.sizeBytes).toBe(5235200000);
    // Capabilities stay unknown (never fabricated).
    expect(parsed?.[0]?.capabilities).toEqual({});
  });

  test("ollama tags: garbage shapes are null, empty list is valid", () => {
    expect(parseOllamaTagsPayload({ nope: 1 })).toBeNull();
    expect(parseOllamaTagsPayload(null)).toBeNull();
    expect(parseOllamaTagsPayload({ models: [] })).toEqual([]);
    expect(parseOllamaTagsPayload({ models: [{}, { name: "" }, { name: "ok:1" }] })?.map((m) => m.id)).toEqual([
      "ok:1",
    ]);
  });

  test("openai-shape: ids parsed, llama.cpp meta context kept", () => {
    const parsed = parseOpenAIModelsPayload({
      object: "list",
      data: [
        {
          id: "../models/Meta-Llama-3.1-8B-Q4_K_M.gguf",
          object: "model",
          owned_by: "llamacpp",
          meta: { n_ctx_train: 131072, n_params: 8030261312 },
        },
      ],
    });
    expect(parsed?.map((m) => m.id)).toEqual(["../models/Meta-Llama-3.1-8B-Q4_K_M.gguf"]);
    expect(parsed?.[0]?.contextLength).toBe(131072);
    expect(parseOpenAIModelsPayload({ data: [] })).toEqual([]);
    expect(parseOpenAIModelsPayload({ garbage: true })).toBeNull();
    expect(parseOpenAIModelsPayload(null)).toBeNull();
  });
});

describe("per-runtime discovery (mocked HTTP)", () => {
  test("ollama detected with multiple models via native tags", async () => {
    await cleanEnv();
    const seen: string[] = [];
    const res = await discoverOllama({
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return jsonResponse(OLLAMA_TAGS);
      }) as never,
    });
    expect(res.ok).toBe(true);
    expect(res.baseURL).toBe("http://127.0.0.1:11434");
    expect(res.models.map((m) => m.id)).toEqual(["qwen3:8b", "llama3.2:3b"]);
    expect(seen).toEqual(["http://127.0.0.1:11434/api/tags"]);
  });

  test("ollama falls back to /v1/models when native tags 404", async () => {
    await cleanEnv();
    const seen: string[] = [];
    const res = await discoverOllama({
      fetchImpl: (async (url: string) => {
        seen.push(url);
        if (url.endsWith("/api/tags")) return jsonResponse({}, false, 404);
        return jsonResponse({ data: [{ id: "fallback-model" }] });
      }) as never,
    });
    expect(res.ok).toBe(true);
    expect(res.models.map((m) => m.id)).toEqual(["fallback-model"]);
    expect(seen).toEqual([
      "http://127.0.0.1:11434/api/tags",
      "http://127.0.0.1:11434/v1/models",
    ]);
  });

  test("ollama unavailable (connection refused) is ok:false, never throws", async () => {
    await cleanEnv();
    const res = await discoverOllama({
      fetchImpl: (async () => {
        throw new Error("fetch failed");
      }) as never,
    });
    expect(res.ok).toBe(false);
    expect(res.models).toEqual([]);
    expect(res.error).toBeTruthy();
  });

  test("ollama malformed on both endpoints is ok:false", async () => {
    await cleanEnv();
    const res = await discoverOllama({
      fetchImpl: (async () => jsonResponse({ garbage: true })) as never,
    });
    expect(res.ok).toBe(false);
    expect(res.models).toEqual([]);
  });

  test("lm studio detected with multiple models", async () => {
    await cleanEnv();
    const res = await discoverLMStudio({
      fetchImpl: (async (url: string) => {
        expect(url).toBe("http://127.0.0.1:1234/v1/models");
        return jsonResponse({
          data: [{ id: "qwen/qwen3-8b" }, { id: "deepseek-r1-distill-qwen-7b" }],
        });
      }) as never,
    });
    expect(res.ok).toBe(true);
    expect(res.models.map((m) => m.id)).toEqual(["qwen/qwen3-8b", "deepseek-r1-distill-qwen-7b"]);
  });

  test("lm studio malformed response is isolated ok:false", async () => {
    await cleanEnv();
    const res = await discoverLMStudio({
      fetchImpl: (async () => jsonResponse("not-an-object")) as never,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  test("llama.cpp exposes the single running model", async () => {
    await cleanEnv();
    const res = await discoverLlamaCpp({
      fetchImpl: (async (url: string) => {
        expect(url).toBe("http://127.0.0.1:8080/v1/models");
        return jsonResponse({
          object: "list",
          data: [
            {
              id: "local-model",
              object: "model",
              owned_by: "llamacpp",
              meta: { n_ctx_train: 8192 },
            },
          ],
        });
      }) as never,
    });
    expect(res.ok).toBe(true);
    expect(res.models.map((m) => m.id)).toEqual(["local-model"]);
    expect(res.models[0]?.contextLength).toBe(8192);
  });

  test("connection timeout is ok:false, never hangs", async () => {
    await cleanEnv();
    const res = await discoverLMStudio({
      timeoutMs: 25,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })) as never,
    });
    expect(res.ok).toBe(false);
  });
});

describe("multi-provider discovery lifecycle", () => {
  test("simultaneous providers resolve concurrently; failures isolated", async () => {
    await cleanEnv();
    const fetchImpl = (async (url: string) => {
      if (url.includes(":11434")) return jsonResponse(OLLAMA_TAGS);
      if (url.includes(":1234"))
        return jsonResponse({ data: [{ id: "lms-a" }, { id: "lms-b" }] });
      throw new Error("connection refused");
    }) as never;
    const d = createLocalDiscovery({ fetchImpl });
    const snap = await d.refresh();
    expect(snap.version).toBe(1);
    expect(snap.results.ollama.ok).toBe(true);
    expect(snap.results.lmstudio.models.map((m) => m.id)).toEqual(["lms-a", "lms-b"]);
    expect(snap.results.llamacpp.ok).toBe(false);
    expect(snap.results.llamacpp.models).toEqual([]);
    expect(summarizeLocalSnapshot(snap)).toContain("Ollama: 2 models");
    expect(summarizeLocalSnapshot(snap)).toContain("llama.cpp: unavailable");
  });

  test("all providers unavailable is a valid empty snapshot", async () => {
    await cleanEnv();
    const d = createLocalDiscovery({
      fetchImpl: (async () => {
        throw new Error("down");
      }) as never,
    });
    const snap = await d.refresh();
    expect(snap.results.ollama.ok).toBe(false);
    expect(snap.results.lmstudio.ok).toBe(false);
    expect(snap.results.llamacpp.ok).toBe(false);
  });

  test("duplicate model ids stay namespaced per provider", async () => {
    await cleanEnv();
    const fetchImpl = (async (url: string) => {
      if (url.includes(":11434")) return jsonResponse({ models: [{ name: "shared" }] });
      return jsonResponse({ data: [{ id: "shared" }] });
    }) as never;
    const d = createLocalDiscovery({ fetchImpl });
    const snap = await d.refresh();
    expect(snap.results.ollama.models.map((m) => m.id)).toEqual(["shared"]);
    expect(snap.results.lmstudio.models.map((m) => m.id)).toEqual(["shared"]);
  });

  test("refresh rediscovers new models; disappearance marks stale", async () => {
    await cleanEnv();
    let v = 1;
    const fetchImpl = (async (url: string) => {
      if (!url.includes(":11434")) throw new Error("down");
      if (v === 1) return jsonResponse({ models: [{ name: "a" }] });
      return jsonResponse({ models: [{ name: "a" }, { name: "b-new" }] });
    }) as never;
    const d = createLocalDiscovery({ fetchImpl });
    const first = await d.refresh("ollama");
    expect(first.results.ollama.models.map((m) => m.id)).toEqual(["a"]);
    v = 2;
    const second = await d.refresh("ollama");
    expect(second.results.ollama.models.map((m) => m.id)).toEqual(["a", "b-new"]);
    expect(second.version).toBe(first.version + 1);
  });

  test("server disappearing flips to ok:false with empty models", async () => {
    await cleanEnv();
    let up = true;
    const fetchImpl = (async () => {
      if (!up) throw new Error("gone");
      return jsonResponse({ data: [{ id: "m" }] });
    }) as never;
    const d = createLocalDiscovery({ fetchImpl });
    const first = await d.refresh("lmstudio");
    expect(first.results.lmstudio.ok).toBe(true);
    up = false;
    const second = await d.refresh("lmstudio");
    expect(second.results.lmstudio.ok).toBe(false);
    expect(second.results.lmstudio.models).toEqual([]);
  });

  test("concurrent refreshes share one probe set (no duplicates)", async () => {
    await cleanEnv();
    let calls = 0;
    // All three succeed first-try (Ollama's /v1 fallback would add a second
    // probe only when native /api/tags fails — covered above).
    const fetchImpl = (async (url: string) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      if (url.includes(":11434")) return jsonResponse({ models: [] });
      return jsonResponse({ data: [] });
    }) as never;
    const d = createLocalDiscovery({ fetchImpl });
    const [a, b] = await Promise.all([d.refresh(), d.refresh()]);
    expect(a).toBe(b);
    expect(calls).toBe(3);
  });
});

describe("existing production routing for discovered models", () => {
  test("fetchModelsForProviderWithStatus routes local ids through discovery", async () => {
    await cleanEnv();
    globalThis.fetch = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe("http://127.0.0.1:11434/api/tags");
      return jsonResponse(OLLAMA_TAGS);
    }) as unknown as typeof fetch;
    const res = await fetchModelsForProviderWithStatus("ollama", "", "http://127.0.0.1:11434");
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(["qwen3:8b", "llama3.2:3b"]);
  });

  test("a discovered model runs the production AgentRuntime loop", async () => {
    await cleanEnv();
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:11434/v1/chat/completions");
      expect((init as RequestInit)?.method).toBe("POST");
      const body = JSON.parse(String((init as RequestInit)?.body));
      expect(body.model).toBe("qwen3:8b");
      expect(body.stream).toBe(true);
      expect(Array.isArray(body.tools)).toBe(true);
      return sseResponse("local hello");
    }) as unknown as typeof fetch;
    const history: ChatMessage[] = [{ role: "user", content: "hi" }];
    let executed = 0;
    const reply = await runAgenticLoopForProvider("ollama", "", "qwen3:8b", history, {
      execute: async () => {
        executed += 1;
        return "unused";
      },
      sleep: async () => {},
    });
    expect(reply).toContain("local hello");
    expect(executed).toBe(0);
  });
});

describe("picker entries for local providers", () => {
  test("discovered local models join without any key; undiscovered add nothing", () => {
    const withLocal = modelPickerEntries({
      activeProvider: "opencode-zen",
      activeModels: ["z"],
      cached: (id) => (id === "ollama" ? ["qwen3:8b"] : undefined),
      keyFor: () => "",
      baseURLFor: (id) => (id === "ollama" ? "http://127.0.0.1:11434" : ""),
    });
    expect(withLocal).toContainEqual({ providerId: "ollama", model: "qwen3:8b", local: true });
    const undiscovered = modelPickerEntries({
      activeProvider: "opencode-zen",
      activeModels: ["z"],
      cached: () => undefined,
      keyFor: () => "",
      baseURLFor: () => "",
    });
    expect(undiscovered.some((e) => e.providerId === "ollama")).toBe(false);
    expect(undiscovered.some((e) => e.providerId === "lmstudio")).toBe(false);
    expect(undiscovered.some((e) => e.providerId === "llamacpp")).toBe(false);
  });
});

// ---- App TUI integration (mocked HTTP + injected discovery) ----------------

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";

function cannedSnapshot(): LocalSnapshot {
  return {
    version: 1,
    results: {
      ollama: {
        provider: "ollama",
        baseURL: "http://127.0.0.1:11434",
        ok: true,
        models: [
          { id: "qwen3:8b", capabilities: {} },
          { id: "llama3.2:3b", capabilities: {} },
        ],
      },
      lmstudio: {
        provider: "lmstudio",
        baseURL: "http://127.0.0.1:1234",
        ok: false,
        models: [],
      },
      llamacpp: {
        provider: "llamacpp",
        baseURL: "http://127.0.0.1:8080",
        ok: false,
        models: [],
      },
    },
  };
}

// Deferred fake: refresh() pends until fire() — models discovery that
// finishes after first paint. Dedupes concurrent refresh calls like prod.
function deferredDiscovery() {
  let current = emptyLocalSnapshot();
  let inFlight: Promise<LocalSnapshot> | null = null;
  const calls: number[] = [];
  const fake: LocalDiscovery = {
    snapshot: () => current,
    refresh: () => {
      if (inFlight) return inFlight;
      calls.push(1);
      inFlight = new Promise<LocalSnapshot>((resolve) => {
        const fire = () => {
          current = cannedSnapshot();
          inFlight = null;
          resolve(current);
        };
        queue.push(fire);
      });
      return inFlight;
    },
  };
  const queue: Array<() => void> = [];
  const fire = () => {
    for (const fn of queue.splice(0)) fn();
  };
  return { fake, fire, calls, queued: queue };
}

describe("local discovery in the App TUI", () => {
  test("late discovery updates the picker; select + switch + chat run normally", async () => {
    await cleanEnv();
    const { fake, fire } = deferredDiscovery();
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u === ZEN_MODELS_URL) return jsonResponse({ data: [] }, false, 500);
      if (u === "http://127.0.0.1:11434/v1/chat/completions" && method === "POST") {
        return sseResponse("local session hi");
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }) as unknown as typeof fetch;
    const app = render(
      <App
        apiKey="test-key"
        endpoint="https://opencode.ai/zen/v1/chat/completions"
        // Pinned: entry counts assume the zen fallback list (see tests/kilo.test.ts).
        initialProvider="opencode-zen"
        localDiscovery={fake}
      />
    );
    try {
      // Picker before discovery lands: 19 zen fallback models + the
      // keyless Kilo row, no locals.
      app.stdin.write("/model");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model (20)");
      expect(app.lastFrame()).not.toContain("Ollama");
      // Discovery lands after paint: entries grow to 22 (2 local models join
      // below the window fold — long lists are windowed, so filter to see them).
      fire();
      await waitForFrame(app, "Select model (22)");
      // Filter narrows to the discovered model with its Local group header.
      app.stdin.write("qwen3");
      await waitForFrame(app, "Ollama");
      expect(app.lastFrame()).toContain("Local");
      expect(app.lastFrame()).toContain("qwen3:8b");
      // Pick it: provider switches, model sticks.
      app.stdin.write("\r");
      await waitForFrame(app, "provider: ollama");
      // A completely normal session runs against the local endpoint.
      app.stdin.write("hi local");
      app.stdin.write("\r");
      await waitForFrame(app, "local session hi");
    } finally {
      app.unmount();
    }
  });

  test("refresh command reports the snapshot summary", async () => {
    await cleanEnv();
    let calls = 0;
    const fake: LocalDiscovery = {
      snapshot: () => cannedSnapshot(),
      refresh: async () => {
        calls += 1;
        return cannedSnapshot();
      },
    };
    globalThis.fetch = vi.fn(async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch;
    const app = render(
      <App
        apiKey="test-key"
        endpoint="https://opencode.ai/zen/v1/chat/completions"
        // Pinned: /model refresh covers local discovery on non-Kilo
        // providers (Kilo actives refresh the gateway catalog instead).
        initialProvider="opencode-zen"
        initialModels={["big-pickle"]}
        localDiscovery={fake}
      />
    );
    try {
      app.stdin.write("/model refresh");
      app.stdin.write("\r");
      await waitForFrame(app, "Ollama: 2 models");
      expect(calls).toBe(1);
      expect(app.lastFrame()).toContain("llama.cpp: unavailable");
    } finally {
      app.unmount();
    }
  });

  test("using a disappeared local model is a clear error, no crash", async () => {
    await cleanEnv();
    const down: LocalSnapshot = {
      version: 1,
      results: {
        ollama: {
          provider: "ollama",
          baseURL: "http://127.0.0.1:11434",
          ok: false,
          models: [],
          error: "fetch failed",
        },
        lmstudio: {
          provider: "lmstudio",
          baseURL: "http://127.0.0.1:1234",
          ok: false,
          models: [],
        },
        llamacpp: {
          provider: "llamacpp",
          baseURL: "http://127.0.0.1:8080",
          ok: false,
          models: [],
        },
      },
    };
    const fake: LocalDiscovery = {
      snapshot: () => down,
      refresh: async () => down,
    };
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const app = render(
      <App
        apiKey="test-key"
        endpoint="https://opencode.ai/zen/v1/chat/completions"
        initialProvider="ollama"
        initialModel="qwen3:8b"
        localDiscovery={fake}
      />
    );
    try {
      app.stdin.write("hi");
      app.stdin.write("\r");
      await waitForFrame(app, "unreachable at http://127.0.0.1:11434");
      expect(app.lastFrame()).toContain("/model refresh");
    } finally {
      app.unmount();
    }
  });

  test("unified /model: filter text pre-filters the picker; retired /models explains", async () => {
    await cleanEnv();
    const fake: LocalDiscovery = {
      snapshot: () => emptyLocalSnapshot(),
      refresh: async () => emptyLocalSnapshot(),
    };
    globalThis.fetch = vi.fn(async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch;
    const app = render(
      <App
        apiKey="test-key"
        endpoint="https://opencode.ai/zen/v1/chat/completions"
        initialProvider="opencode-zen"
        initialModels={["big-pickle", "kimi-k2.6"]}
        localDiscovery={fake}
      />
    );
    try {
      app.stdin.write("/model kimi");
      app.stdin.write("\r");
      await waitForFrame(app, "Select model");
      expect(app.lastFrame()).toContain("kimi-k2.6");
      expect(app.lastFrame()).not.toContain("big-pickle");
      app.stdin.write("\u001B"); // Esc closes picker
      await new Promise((r) => setTimeout(r, 150));
      // Retired twin explains the merge instead of probing.
      app.stdin.write("/models");
      app.stdin.write("\r");
      await waitForFrame(app, "(merged — use /model to pick, /model refresh to re-probe local servers)");
    } finally {
      app.unmount();
    }
  });
});
