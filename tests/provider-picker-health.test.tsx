// /provider picker rows: live health segments (Task 1.3) and the OAuth
// subscription line (Task 2.5). Pure formatters first, then real picker
// frames — fetch is ALWAYS mocked (gated/failed), temp ATOM_HOME, seeded
// zen key fixture. Never a live network call.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  App,
  providerHealthApplies,
  providerHealthStamp,
  providerHealthText,
  providerPickerKeyMark,
  providerPickerSubscription,
} from "../src/App.js";
import { emptyAuth, saveAuth, setSubscriptionAuth } from "../src/auth.js";
import {
  forgetSubscriptionStatus,
  recordSubscriptionStatus,
} from "../src/subscription-status.js";
import { theme } from "../src/ui/theme.js";
import { waitForFrame, waitForFrameAbsent } from "./helpers/wait-for-frame.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const MODELS = ["big-pickle", "kimi-k2.5"];
// Esc key byte for stdin (written as code so no literal control byte lands
// in this source file).
const ESC = String.fromCharCode(27);

// Eligible providers on a clean home with only the seeded zen key:
// 3 local runtimes + opencode-zen. The 3 stubs answer without the network,
// the 17 unkeyed remotes are skipped entirely — so exactly 4 fetches fire.
const ELIGIBLE_FETCHES = 4;

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let homes: string[] = [];

async function cleanEnv(): Promise<string> {
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
  const home = await mkdtemp(join(tmpdir(), "atom-picker-health-"));
  homes.push(home);
  process.env.ATOM_HOME = home;
  return home;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  forgetSubscriptionStatus("openai");
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of homes) await rm(d, { recursive: true, force: true });
  homes = [];
});

function renderTui() {
  return render(
    <App
      apiKey="test-key"
      endpoint={ENDPOINT}
      initialProvider="opencode-zen"
      initialModel="big-pickle"
      initialModels={MODELS}
    />,
  );
}

async function openPicker(app: { stdin: { write(s: string): void } }) {
  app.stdin.write("/provider");
  app.stdin.write("\r");
  await waitForFrame(app as never, "Select provider");
}

async function closePicker(app: { stdin: { write(s: string): void } }) {
  app.stdin.write(ESC); // Esc closes the picker
  await waitForFrameAbsent(app as never, "Select provider");
}

// waitForFrame for a pattern (frame needles are literal strings elsewhere).
async function waitForFrameMatch(
  app: { lastFrame: () => string | undefined },
  pattern: RegExp,
  timeout = 8000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const frame = app.lastFrame() ?? "";
    if (pattern.test(frame)) return frame;
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${pattern}:\n${frame}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("provider picker formatters (pure)", () => {
  test("health applies to keyed remotes, locals and stubs — never unkeyed remotes", () => {
    expect(providerHealthApplies("openai", true)).toBe(true);
    expect(providerHealthApplies("ollama", false)).toBe(true);
    expect(providerHealthApplies("azure-openai", false)).toBe(true);
    expect(providerHealthApplies("openai", false)).toBe(false);
    // Kilo needs no key but is remote: its row says "key optional", no check.
    expect(providerHealthApplies("kilo", false)).toBe(false);
  });

  test("health stamp reads the recorded time for both entry states", () => {
    expect(providerHealthStamp({ state: "checking", startedAt: 11 })).toBe(11);
    expect(
      providerHealthStamp({
        state: "done",
        result: { ok: true, latencyMs: 5 },
        checkedAt: 22,
      }),
    ).toBe(22);
  });

  test("health text: none, pending, ok with latency, fail with reason", () => {
    expect(providerHealthText(undefined)).toBe("");
    expect(providerHealthText({ state: "checking", startedAt: 0 })).toBe(
      `${theme.symbol.running} checking${theme.symbol.ellipsis}`,
    );
    expect(
      providerHealthText({
        state: "done",
        result: { ok: true, latencyMs: 120 },
        checkedAt: 0,
      }),
    ).toBe(`${theme.symbol.toolOk} 120ms`);
    expect(
      providerHealthText({
        state: "done",
        result: { ok: false, latencyMs: 3, error: "HTTP 401" },
        checkedAt: 0,
      }),
    ).toBe(`${theme.symbol.toolFail} HTTP 401`);
  });

  test("long failure reasons cap so one row cannot wrap its box", () => {
    const long = "X".repeat(200);
    const text = providerHealthText({
      state: "done",
      result: { ok: false, latencyMs: 0, error: long },
      checkedAt: 0,
    });
    expect(text.startsWith(`${theme.symbol.toolFail} `)).toBe(true);
    expect(text.endsWith(theme.symbol.ellipsis)).toBe(true);
    // Mirrors PROVIDER_HEALTH_REASON_CHARS (App.tsx): reason + "✕ " caps at 34.
    expect(text.length).toBeLessThanOrEqual(3 + 32);
  });

  test("key mark precedence: key, local, kilo optional, no key; subscription drops it", () => {
    expect(providerPickerKeyMark("openai", true, "")).toBe(
      `${theme.symbol.keyPresent} key`,
    );
    expect(providerPickerKeyMark("ollama", false, "")).toBe(
      `local ${theme.symbol.descSeparator} no key needed`,
    );
    expect(providerPickerKeyMark("kilo", false, "")).toBe(
      `${theme.symbol.descSeparator} key optional — free models need none`,
    );
    expect(providerPickerKeyMark("openai", false, "")).toBe(
      `${theme.symbol.descSeparator} no key`,
    );
    expect(
      providerPickerKeyMark("openai", false, "subscription pro · 45% used"),
    ).toBe("");
  });

  test("subscription segment matches /login status wording", () => {
    const empty = emptyAuth();
    expect(providerPickerSubscription(empty, "openai")).toBe("");

    const loggedIn = setSubscriptionAuth(empty, "openai", {
      type: "oauth",
      accessToken: "tok-secret",
      plan: "pro",
    });
    expect(providerPickerSubscription(loggedIn, "openai")).toBe(
      "subscription pro",
    );
    expect(
      providerPickerSubscription(loggedIn, "openai", {
        plan: "pro",
        usage: { used: 45, limit: 100, unit: "%" },
      }),
    ).toBe("subscription pro · 45% used");

    const noPlan = setSubscriptionAuth(empty, "openai", {
      type: "oauth",
      accessToken: "tok-secret",
    });
    expect(providerPickerSubscription(noPlan, "openai")).toBe(
      "subscription oauth",
    );
  });
});

describe("/provider live rows", () => {
  test("opens into pending rows, checks only eligible providers, then shows ok latency", async () => {
    await cleanEnv();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      await gate;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const app = renderTui();
    try {
      await openPicker(app);
      const pending = await waitForFrame(
        app,
        `checking${theme.symbol.ellipsis}`,
      );
      // Unkeyed remotes never fire and never show a health segment.
      expect(pending).toContain("Anthropic (anthropic) — no key");
      expect(pending).not.toMatch(/Anthropic \(anthropic\) — no key [◌✓✕]/);
      expect(urls.length).toBe(ELIGIBLE_FETCHES);

      release();
      const ok = await waitForFrameMatch(app, /✓ \d+ms/);
      expect(ok).toMatch(/\(opencode-zen\) ✓ key ✓ \d+ms/);
      expect(ok).toContain(
        `Ollama (ollama) local ${theme.symbol.descSeparator} no key needed`,
      );
      // Stubs resolve immediately with their not-implemented notice.
      expect(ok).toContain("not usable yet");
      expect(urls.length).toBe(ELIGIBLE_FETCHES);
    } finally {
      app.unmount();
    }
  });

  test("failing rows show the short reason; reopening within the TTL sends no new requests", async () => {
    await cleanEnv();
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return {
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const app = renderTui();
    try {
      await openPicker(app);
      await waitForFrameMatch(
        app,
        new RegExp(`${theme.symbol.toolFail} HTTP 401`),
      );
      expect(urls.length).toBe(ELIGIBLE_FETCHES);

      await closePicker(app);
      await openPicker(app);
      // Rows repaint straight from the cache — no refire inside the TTL.
      expect(
        new RegExp(`${theme.symbol.toolFail} HTTP 401`).test(
          app.lastFrame() ?? "",
        ),
      ).toBe(true);
      expect(urls.length).toBe(ELIGIBLE_FETCHES);
    } finally {
      app.unmount();
    }
  });

  test("a result landing after Esc is cached for the next open, not re-fired", async () => {
    await cleanEnv();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      await gate;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const app = renderTui();
    try {
      await openPicker(app);
      expect(urls.length).toBe(ELIGIBLE_FETCHES);
      // Esc while checks are still in flight; the result lands while closed.
      await closePicker(app);
      release();
      await new Promise((r) => setTimeout(r, 50));

      await openPicker(app);
      await waitForFrameMatch(app, /✓ \d+ms/);
      expect(urls.length).toBe(ELIGIBLE_FETCHES);
    } finally {
      app.unmount();
    }
  });

  test("a result landing after unmount writes nothing (no crash)", async () => {
    await cleanEnv();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = vi.fn(async () => {
      await gate;
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const app = renderTui();
    await openPicker(app);
    app.unmount();
    release();
    // An async throw here (setState on an unmounted tree) fails the run.
    await new Promise((r) => setTimeout(r, 100));
  });

  test("OAuth login shows plan + usage and never the token", async () => {
    const home = await cleanEnv();
    const auth = setSubscriptionAuth(emptyAuth(), "openai", {
      type: "oauth",
      accessToken: "tok-secret",
      plan: "pro",
    });
    saveAuth(auth, home);
    recordSubscriptionStatus("openai", {
      plan: "pro",
      usage: { used: 45, limit: 100, unit: "%" },
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const app = renderTui();
    try {
      await openPicker(app);
      const frame = await waitForFrame(
        app as never,
        "subscription pro · 45% used",
      );
      // The subscription IS the credential: no misleading "no key" marker.
      expect(frame).toContain(
        `OpenAI (openai) ${theme.symbol.separator} subscription pro · 45% used`,
      );
      expect(frame).not.toContain("(openai) — no key");
      expect(frame).not.toContain("tok-secret");
    } finally {
      app.unmount();
    }
  });
});
