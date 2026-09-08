// Provider registry + auth store tests. Fully mocked / temp-dirs only.
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  PROVIDERS,
  getProvider,
  isProviderId,
  maskKey,
  validateBaseURL,
  chatEndpointFor,
  modelsUrlForProvider,
  openaiCompatibleChatEndpoint,
} from "../src/providers.js";
import {
  emptyAuth,
  loadAuth,
  saveAuth,
  resolveApiKey,
  hasKey,
  setStoredKey,
  getStoredBaseURL,
  getEnvKey,
} from "../src/auth.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedEnv = { ...process.env };
let dirs: string[] = [];

async function tempHome(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "atom-prov-"));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  for (const k of [
    "OPENCODE_ZEN_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "ATOM_HOME",
  ]) {
    delete process.env[k];
  }
});

afterEach(async () => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

describe("registry shape", () => {
  test("7 providers with kind/endpoint/env/default/fallback", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      "opencode-zen",
      "openai",
      "anthropic",
      "deepseek",
      "mistral",
      "google-gemini",
      "openai-compatible",
    ]);
    for (const p of PROVIDERS) {
      expect(["openai-chat", "anthropic-messages", "gemini-generate"]).toContain(p.kind);
      expect(typeof p.consoleURL).toBe("string");
      expect(Array.isArray(p.envVars)).toBe(true);
      expect(typeof p.defaultModel).toBe("string");
      expect(p.fallbackModels.length).toBeGreaterThanOrEqual(3);
      expect(p.fallbackModels.length).toBeLessThanOrEqual(6);
      // Zen 5-item subset still within 3-6 (full 19-model list lives in zen FALLBACK_MODELS).
      expect(getProvider(p.id)?.id).toBe(p.id);
      expect(isProviderId(p.id)).toBe(true);
    }
    expect(isProviderId("nope")).toBe(false);
    expect(getProvider("openai")?.kind).toBe("openai-chat");
    expect(getProvider("anthropic")?.kind).toBe("anthropic-messages");
    expect(getProvider("google-gemini")?.kind).toBe("gemini-generate");
    expect(getProvider("openai")?.envVars).toEqual(["OPENAI_API_KEY"]);
    expect(getProvider("google-gemini")?.envVars).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    expect(getProvider("openai-compatible")?.envVars).toEqual([]);
  });

  test("endpoints per spec (deepseek has no /v1)", () => {
    expect(chatEndpointFor("opencode-zen")).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(chatEndpointFor("openai")).toBe("https://api.openai.com/v1/chat/completions");
    expect(chatEndpointFor("deepseek")).toBe("https://api.deepseek.com/chat/completions");
    expect(chatEndpointFor("mistral")).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(openaiCompatibleChatEndpoint("https://x.example/v1/")).toBe("https://x.example/v1/chat/completions");
    expect(openaiCompatibleChatEndpoint("https://x.example/v1/chat/completions")).toBe(
      "https://x.example/v1/chat/completions"
    );
    expect(modelsUrlForProvider("anthropic")).toBe("https://api.anthropic.com/v1/models");
    expect(modelsUrlForProvider("google-gemini")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models"
    );
    expect(modelsUrlForProvider("openai")).toBe("https://api.openai.com/v1/models");
  });

  test("mask + baseURL validation never leak keys", () => {
    expect(maskKey("test-key")).toBe("…-key");
    expect(maskKey("")).toBe("(no key)");
    expect(maskKey("test-key")).not.toContain("test-");
    expect(validateBaseURL("https://x.example/v1")).toBeNull();
    expect(validateBaseURL("http://localhost:11434/v1")).toBeNull();
    expect(validateBaseURL("ftp://x/y")).toMatch(/scheme/);
    expect(validateBaseURL("not a url")).toMatch(/invalid URL/);
    expect(validateBaseURL("")).toMatch(/non-empty/);
  });
});

describe("auth store", () => {
  test("save/load roundtrip in temp HOME (0600 best-effort, no throw)", async () => {
    const home = await tempHome();
    expect(loadAuth(home)).toEqual(emptyAuth());
    const next = setStoredKey(emptyAuth(), "openai", "test-key");
    saveAuth(next, home);
    const raw = await readFile(join(home, ".atom", "auth.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ version: 1, providers: { openai: { apiKey: "test-key" } } });
    expect(loadAuth(home).providers["openai"]?.apiKey).toBe("test-key");
    // baseURL preserved across key replace
    const withBase = setStoredKey(loadAuth(home), "openai-compatible", "test-key", "https://x.example/v1");
    saveAuth(withBase, home);
    expect(getStoredBaseURL(loadAuth(home), "openai-compatible")).toBe("https://x.example/v1");
  });

  test("env wins over stored; openai-compatible stored-only; alias accepted", async () => {
    const home = await tempHome();
    const auth = setStoredKey(emptyAuth(), "openai", "test-key");
    expect(resolveApiKey("openai", auth)).toBe("test-key");
    process.env.OPENAI_API_KEY = "env-key";
    expect(getEnvKey("openai")).toBe("env-key");
    expect(resolveApiKey("openai", auth)).toBe("env-key");
    expect(hasKey("openai", auth)).toBe(true);
    delete process.env.OPENAI_API_KEY;
    // gemini alias
    process.env.GOOGLE_API_KEY = "env-g";
    expect(resolveApiKey("google-gemini", emptyAuth())).toBe("env-g");
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = "env-g2";
    expect(resolveApiKey("google-gemini", emptyAuth())).toBe("env-g2");
    delete process.env.GEMINI_API_KEY;
    // openai-compatible ignores env
    process.env.OPENAI_API_KEY = "env-key";
    const compat = setStoredKey(emptyAuth(), "openai-compatible", "test-key", "https://x.example/v1");
    expect(resolveApiKey("openai-compatible", compat)).toBe("test-key");
    delete process.env.OPENAI_API_KEY;
  });
});
