// Zen free-model client identity: `*-free` promo models are gated upstream
// on official-client headers (verified live 2026-09-12: UA alone → 429,
// UA without session → 400 MissingSessionID, UA + `x-opencode-session`
// → 200). Fully mocked — never hits the real API.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ZEN_CLIENT_UA,
  validateProviderKey,
  zenHeaders,
  zenRequestId,
  zenSessionId,
} from "../src/adapters.js";
import {
  chatCompletionForProvider,
  fetchModelsWithStatus,
  type ChatMessage,
} from "../src/zen.js";
import {
  clearProviderHooks,
  registerBeforeRequest,
} from "../src/tools/provider-hooks.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  clearProviderHooks();
});

const noSleep = { sleep: async () => {} };
const history = (): ChatMessage[] => [
  { role: "system", content: "s" },
  { role: "user", content: "hi" },
];

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

describe("zenHeaders", () => {
  test("pinned official UA + session/request identity; keyed sends Bearer", () => {
    expect(ZEN_CLIENT_UA).toBe("opencode/1.18.16");
    const h = zenHeaders("k");
    expect(h).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer k",
      "User-Agent": "opencode/1.18.16",
    });
    expect(h["x-opencode-session"]).toMatch(/^ses_[A-Za-z0-9]{24}$/);
    expect(h["x-opencode-request"]).toMatch(/^msg_[A-Za-z0-9]{24}$/);
  });

  test("anonymous omits Authorization entirely (never empty Bearer)", () => {
    const h = zenHeaders("");
    expect(h["User-Agent"]).toBe("opencode/1.18.16");
    expect(h["x-opencode-session"]).toMatch(/^ses_/);
    expect("Authorization" in h).toBe(false);
    expect(JSON.stringify(h)).not.toContain("Bearer");
  });

  test("session is stable per process, request is fresh per call", () => {
    expect(zenSessionId()).toBe(zenSessionId());
    expect(zenHeaders("k")["x-opencode-session"]).toBe(zenSessionId());
    expect(zenRequestId()).toMatch(/^msg_/);
    expect(zenHeaders("k")["x-opencode-request"]).not.toBe(zenHeaders("k")["x-opencode-request"]);
  });

  test("explicit ids override the generated ones", () => {
    const h = zenHeaders("k", { sessionId: "ses_x", requestId: "msg_y" });
    expect(h["x-opencode-session"]).toBe("ses_x");
    expect(h["x-opencode-request"]).toBe("msg_y");
  });
});

describe("zen chat POST identity", () => {
  test("opencode-zen sends UA + session/request (keyed)", async () => {
    let headers: unknown;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      headers = (init as { headers?: unknown })?.headers;
      return sseResponse([sse({ choices: [{ delta: { content: "hi" } }] }), "data: [DONE]\n\n"]);
    });
    await chatCompletionForProvider("opencode-zen", "z-key", "big-pickle", history(), noSleep);
    expect(headers).toMatchObject({
      Authorization: "Bearer z-key",
      "User-Agent": "opencode/1.18.16",
    });
    const h = headers as Record<string, string>;
    expect(h["x-opencode-session"]).toMatch(/^ses_[A-Za-z0-9]{24}$/);
    expect(h["x-opencode-request"]).toMatch(/^msg_[A-Za-z0-9]{24}$/);
  });

  test("opencode-zen anonymous sends identity with no Authorization", async () => {
    let headers: unknown;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      headers = (init as { headers?: unknown })?.headers;
      return sseResponse([sse({ choices: [{ delta: { content: "hi" } }] }), "data: [DONE]\n\n"]);
    });
    await chatCompletionForProvider("opencode-zen", "", "big-pickle", history(), noSleep);
    expect(headers).toMatchObject({ "User-Agent": "opencode/1.18.16" });
    expect((headers as Record<string, string>)["x-opencode-session"]).toMatch(/^ses_/);
    expect(JSON.stringify(headers)).not.toContain("Bearer");
    expect("Authorization" in (headers as Record<string, string>)).toBe(false);
  });

  test("non-zen providers keep legacy shape (no Zen identity)", async () => {
    let headers: unknown;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      headers = (init as { headers?: unknown })?.headers;
      return sseResponse([sse({ choices: [{ delta: { content: "hi" } }] }), "data: [DONE]\n\n"]);
    });
    await chatCompletionForProvider("openai", "o-key", "gpt-x", history(), noSleep);
    expect(headers).toMatchObject({ Authorization: "Bearer o-key" });
    expect((headers as Record<string, string>)["User-Agent"]).toBeUndefined();
    expect((headers as Record<string, string>)["x-opencode-session"]).toBeUndefined();
    expect((headers as Record<string, string>)["x-opencode-request"]).toBeUndefined();
  });

  test("before-request hook can override/delete identity headers (fail-open)", async () => {
    registerBeforeRequest(
      () => ({ headers: { "User-Agent": undefined, "x-opencode-session": "ses_custom" } }),
      "strip-ua"
    );
    let headers: unknown;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      headers = (init as { headers?: unknown })?.headers;
      return sseResponse([sse({ choices: [{ delta: { content: "hi" } }] }), "data: [DONE]\n\n"]);
    });
    await chatCompletionForProvider("opencode-zen", "z-key", "big-pickle", history(), noSleep);
    expect("User-Agent" in (headers as Record<string, string>)).toBe(false);
    expect((headers as Record<string, string>)["x-opencode-session"]).toBe("ses_custom");
    // Auth still rides along — only the deleted keys changed.
    expect(headers).toMatchObject({ Authorization: "Bearer z-key" });
  });
});

describe("zen models GET identity", () => {
  test("fetchModelsWithStatus sends UA + session", async () => {
    let headers: unknown;
    // Capture via the fetch mock's init arg.
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      headers = (init as { headers?: unknown })?.headers;
      return { ok: true, json: async () => ({ data: [{ id: "big-pickle" }] }) } as Response;
    });
    const res = await fetchModelsWithStatus("https://opencode.ai/zen/v1/chat/completions", "z-key");
    expect(res.ok).toBe(true);
    expect(headers).toMatchObject({
      Authorization: "Bearer z-key",
      "User-Agent": "opencode/1.18.16",
    });
    expect((headers as Record<string, string>)["x-opencode-session"]).toMatch(/^ses_/);
  });

  test("validateProviderKey for zen sends UA + session", async () => {
    let headers: unknown;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      headers = (init as { headers?: unknown })?.headers;
      return { ok: true } as Response;
    });
    const res = await validateProviderKey("opencode-zen", "z-key");
    expect(res.ok).toBe(true);
    expect(headers).toMatchObject({ "User-Agent": "opencode/1.18.16" });
    expect((headers as Record<string, string>)["x-opencode-session"]).toMatch(/^ses_/);
  });
});
