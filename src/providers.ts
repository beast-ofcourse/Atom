// Provider registry for Atom (mirrors opencode /connect, manual-key only).
// No OAuth, no browser flow. Credentials live in ~/.atom/auth.json;
// env vars win when set (see src/auth.ts).
//
// Curated fallback model lists were picked at BUILD time (2026-09-07)
// from each vendor's docs (tool-capable chat models preferred, 3-6 ids):
// - opencode-zen: existing FALLBACK_MODELS in src/zen.ts (verified from
//   https://opencode.ai/docs/zen). Re-listed here for the picker.
// - openai: https://platform.openai.com/docs/models — flagship chat models
//   with function calling (GPT-6 Astra, GPT-5.6 Sol/Terra/Luna).
// - anthropic: https://docs.anthropic.com/en/docs/about-claude/models —
//   Claude Sonnet/Opus/Haiku with tool use (Messages API).
// - deepseek: https://api-docs.deepseek.com/quick_start/pricing —
//   deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp
//   (all list Tool Calls support; OpenAI-compatible base https://api.deepseek.com).
// - mistral: https://docs.mistral.ai/inference/models — generalist
//   tool-capable models via *-latest aliases (large/medium/small + nemo).
// - google-gemini: https://ai.google.dev/gemini-api/docs/models —
//   Gemini 2.5/2.0/1.5 Flash/Pro with function calling.
// - openai-compatible: generic OpenAI-shape ids (custom baseURL); the live
//   /models list is authoritative, these are just offline placeholders.

export type ProviderId =
  | "opencode-zen"
  | "openai"
  | "anthropic"
  | "deepseek"
  | "mistral"
  | "google-gemini"
  | "openai-compatible";

export type ProviderKind =
  | "openai-chat"
  | "anthropic-messages"
  | "gemini-generate";

export type ProviderDef = {
  id: ProviderId;
  name: string;
  kind: ProviderKind;
  // Fixed chat endpoint for first-party providers; undefined for
  // openai-compatible (stored baseURL supplies it).
  chatEndpoint?: string;
  consoleURL: string;
  // Env var names in precedence order; empty = stored key only.
  envVars: string[];
  defaultModel: string;
  fallbackModels: string[];
  notes: string;
};

export const DEFAULT_PROVIDER: ProviderId = "opencode-zen";

export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    kind: "openai-chat",
    chatEndpoint: "https://opencode.ai/zen/v1/chat/completions",
    consoleURL: "https://opencode.ai/auth",
    envVars: ["OPENCODE_ZEN_API_KEY"],
    // Task 5: strong tool-reliable default (live-list + docs verified
    // 2026-09-08, see DEFAULT_MODEL in src/zen.ts). Free big-pickle stays
    // listed as a fallback, selectable via /model. kimi-k2.6 / minimax-m2.7
    // replace kimi-k2.5 / minimax-m2.5 (both deprecated upstream 2026-08-05).
    defaultModel: "deepseek-v4-pro",
    fallbackModels: [
      "deepseek-v4-pro",
      "kimi-k2.6",
      "glm-5.2",
      "minimax-m2.7",
      "big-pickle",
    ],
    notes: "OpenAI-compatible chat/completions. reasoning_effort only here.",
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai-chat",
    chatEndpoint: "https://api.openai.com/v1/chat/completions",
    consoleURL: "https://platform.openai.com/api-keys",
    envVars: ["OPENAI_API_KEY"],
    defaultModel: "gpt-5.6-terra",
    fallbackModels: [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ],
    notes: "OpenAI-compatible chat/completions. reasoning_effort never sent.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic-messages",
    chatEndpoint: "https://api.anthropic.com/v1/messages",
    consoleURL: "https://console.anthropic.com/settings/keys",
    envVars: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-5",
    fallbackModels: [
      "claude-sonnet-4-5",
      "claude-opus-4-1",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
    notes: "Messages API with tool_use blocks. max_tokens 4096.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai-chat",
    chatEndpoint: "https://api.deepseek.com/chat/completions",
    consoleURL: "https://platform.deepseek.com/api_keys",
    envVars: ["DEEPSEEK_API_KEY"],
    defaultModel: "deepseek-chat",
    fallbackModels: [
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ],
    notes: "OpenAI-compatible (no /v1 prefix). reasoning_effort never sent.",
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "openai-chat",
    chatEndpoint: "https://api.mistral.ai/v1/chat/completions",
    consoleURL: "https://console.mistral.ai/api-keys",
    envVars: ["MISTRAL_API_KEY"],
    defaultModel: "mistral-medium-latest",
    fallbackModels: [
      "mistral-large-latest",
      "mistral-medium-latest",
      "mistral-small-latest",
      "open-mistral-nemo",
    ],
    notes: "OpenAI-compatible chat/completions. reasoning_effort never sent.",
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    kind: "gemini-generate",
    // {model} is interpolated per POST; see adapters.geminiChatUrl().
    chatEndpoint:
      "https://generativelanguage.googleapis.com/v1beta/models",
    consoleURL: "https://aistudio.google.com/apikey",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    defaultModel: "gemini-2.5-flash",
    fallbackModels: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
    ],
    notes: "streamGenerateContent SSE; :generateContent fallback.",
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible (custom)",
    kind: "openai-chat",
    chatEndpoint: undefined,
    consoleURL: "",
    envVars: [],
    defaultModel: "gpt-3.5-turbo",
    fallbackModels: [
      "gpt-3.5-turbo",
      "gpt-4o",
      "llama-3.1-70b-versatile",
      "mixtral-8x7b-32768",
    ],
    notes: "Stored baseURL + stored key only. Live /models authoritative.",
  },
];

const BY_ID: Record<ProviderId, ProviderDef> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p])
) as Record<ProviderId, ProviderDef>;

export function getProvider(id: string): ProviderDef | undefined {
  return (BY_ID as Record<string, ProviderDef>)[id];
}

export function isProviderId(id: string): id is ProviderId {
  return getProvider(id) !== undefined;
}

export function providerKind(id: ProviderId): ProviderKind {
  return getProvider(id)!.kind;
}

// Display label for errors/status (e.g. "Anthropic HTTP 401").
export function providerLabel(id: ProviderId): string {
  const def = getProvider(id);
  if (!def) return String(id);
  if (id === "opencode-zen") return "Zen";
  if (id === "openai-compatible") return "Provider";
  return def.name;
}

// Normalize a custom baseURL: trim whitespace/trailing slashes.
export function normalizeBaseURL(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

// openai-compatible chat endpoint: stored baseURL + /chat/completions
// appended iff missing, trailing slashes trimmed.
export function openaiCompatibleChatEndpoint(baseURL: string): string {
  const base = normalizeBaseURL(baseURL);
  return base.endsWith("/chat/completions")
    ? base
    : `${base}/chat/completions`;
}

// Chat endpoint for a provider (openai-compatible needs stored baseURL).
export function chatEndpointFor(
  id: ProviderId,
  storedBaseURL?: string
): string {
  const def = getProvider(id)!;
  if (id === "openai-compatible") {
    return openaiCompatibleChatEndpoint(storedBaseURL ?? "");
  }
  return def.chatEndpoint ?? "";
}

// Derive the models URL from a chat/completions endpoint
// (mirrors zen.modelsUrl for OpenAI-kind providers).
export function modelsUrlForEndpoint(endpoint: string): string {
  const suffix = "/chat/completions";
  if (endpoint.endsWith(suffix)) {
    return endpoint.slice(0, -suffix.length) + "/models";
  }
  return endpoint.replace(/\/+$/, "") + "/models";
}

// Models (validation/list) URL per provider.
export function modelsUrlForProvider(
  id: ProviderId,
  storedBaseURL?: string
): string {
  if (id === "anthropic") return "https://api.anthropic.com/v1/models";
  if (id === "google-gemini")
    return "https://generativelanguage.googleapis.com/v1beta/models";
  return modelsUrlForEndpoint(chatEndpointFor(id, storedBaseURL));
}

// Mask a key for display: "…1234". Never the full key.
export function maskKey(key: string): string {
  if (!key) return "(no key)";
  const last4 = key.slice(-4);
  return `…${last4}`;
}

// Validate a custom baseURL: must be http(s). Returns error or null.
export function validateBaseURL(raw: string): string | null {
  const s = raw.trim();
  if (!s) return "baseURL must be a non-empty string";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return `invalid URL: ${s}`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `unsupported URL scheme (only http/https allowed): ${u.protocol}`;
  }
  return null;
}
