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
// - groq: https://console.groq.com/docs/models + /docs/openai —
//   production tool-capable chat models (Llama 3.3 70B, GPT-OSS 120B/20B,
//   Llama 3.1 8B). OpenAI-compatible base https://api.groq.com/openai/v1.
// - xai: https://docs.x.ai/docs/models + /docs/guides/chat-completions —
//   grok-4.6/4.5/4.3 (xAI recommends Grok 4.6 for code). Base
//   https://api.x.ai/v1, Bearer XAI_API_KEY.
// - zai: https://docs.z.ai/api-reference/introduction — OpenAI-compatible
//   base https://api.z.ai/api/paas/v4, Bearer ZAI_API_KEY, current flagship
//   glm-5.3 (older glm-5.2/5.1 route to 5.3, glm-4.7 to 5.3-flash server-side).
// - openrouter: https://openrouter.ai/docs/quickstart + live
//   GET https://openrouter.ai/api/v1/models — aggregator (org/model slugs,
//   e.g. anthropic/claude-sonnet-4.6). Bearer OPENROUTER_API_KEY; the
//   HTTP-Referer/X-Title ranking headers are optional and not sent.
// - cerebras: https://inference-docs.cerebras.ai/quickstart +
//   /models/overview — only 2 public models (gpt-oss-120b, qwen-3.8-27b).
//   Bearer CEREBRAS_API_KEY.
// - openai-compatible: generic OpenAI-shape ids (custom baseURL); the live
//   /models list is authoritative, these are just offline placeholders.

export type ProviderId =
  | "kilo"
  | "opencode-zen"
  | "openai"
  | "anthropic"
  | "deepseek"
  | "mistral"
  | "google-gemini"
  | "groq"
  | "xai"
  | "zai"
  | "openrouter"
  | "cerebras"
  | "azure-openai"
  | "cohere"
  | "perplexity"
  | "nvidia"
  | "together"
  | "fireworks"
  | "bedrock"
  | "vertex-ai"
  | "openai-compatible"
  | "ollama"
  | "lmstudio"
  | "llamacpp";

// Local runtimes (auto-discovered loopback servers). They are full provider
// citizens (picker sections, chat routing) but need no API key and resolve
// their baseURL from env overrides, else loopback defaults.
export type LocalProviderId = "ollama" | "lmstudio" | "llamacpp";

export const LOCAL_PROVIDER_IDS: readonly LocalProviderId[] = [
  "ollama",
  "lmstudio",
  "llamacpp",
];

export function isLocalProviderId(id: string): id is LocalProviderId {
  return (LOCAL_PROVIDER_IDS as readonly string[]).includes(id);
}

export type ProviderKind =
  | "openai-chat"
  | "anthropic-messages"
  | "gemini-generate";

import type { CacheSupport } from "./prompt-cache.js";

export type ProviderCapabilities = {
  streaming: boolean;
  vision: boolean;
  tools: boolean;
  jsonMode: boolean;
  contextWindow: number;
  maxOutputTokens: number;
};

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
  // Declared prompt-caching support (see providerCacheSupport): what the
  // harness may assume about this provider. Behavior lives in the
  // kind-dispatched adapters; this table is the single declaration point.
  cache: CacheSupport;
  // Feature support flags for this provider.
  capabilities: ProviderCapabilities;
  // Local runtimes only: loopback default + env override for the server
  // baseURL. Absent for remote providers.
  local?: {
    defaultBaseURL: string;
    baseURLEnvVar: string;
  };
};

export const DEFAULT_PROVIDER: ProviderId = "kilo";

export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: "kilo",
    name: "Kilo",
    kind: "openai-chat",
    chatEndpoint: "https://api.kilo.ai/api/gateway/chat/completions",
    consoleURL: "https://kilo.ai",
    envVars: ["KILO_API_KEY"],
    // Offline placeholder only: the live /models catalog is authoritative.
    // kilo-auto/free is Kilo's dynamic free routing model, preferred when no
    // API key is configured (see preferFreeKiloModel in src/kilo.ts).
    defaultModel: "kilo-auto/free",
    fallbackModels: ["kilo-auto/free"],
    notes: "Kilo Gateway (OpenAI-compatible). Free :free models work without a key; key unlocks the full catalog.",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "server-dependent; stable serialization only, usage passes through when reported",
    },
    capabilities: {
      streaming: true,
      vision: true,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    kind: "openai-chat",
    chatEndpoint: "https://opencode.ai/zen/v1/chat/completions",
    consoleURL: "https://opencode.ai/auth",
    envVars: ["OPENCODE_ZEN_API_KEY"],
    // Task 5: strong tool-reliable default (live-list + docs verified
    // 2026-09-08, see DEFAULT_MODEL in src/zen.ts). Free models ride along
    // as fallbacks, selectable via /model (chat family + responses family;
    // kimi-k2.6 / minimax-m2.7 replace kimi-k2.5 / minimax-m2.5, both
    // deprecated upstream 2026-08-05).
    defaultModel: "deepseek-v4-pro",
    fallbackModels: [
      "deepseek-v4-pro",
      "kimi-k2.6",
      "glm-5.2",
      "minimax-m2.7",
      "big-pickle",
      "mimo-v2.5-free",
      "ling-3.0-flash-fin-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
      "deepseek-v4-flash-free",
      "muse-spark-1.3-contributor-free",
      "muse-spark-1.2-contributor-free",
    ],
    notes: "OpenAI-compatible chat/completions. /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: true,
      notes: "upstream-dependent prefix behavior; usage cache fields pass through when reported",
    },
    capabilities: {
      streaming: true,
      vision: true,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
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
    notes: "OpenAI-compatible chat/completions. /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: true,
      notes: "automatic prefix caching; usage.prompt_tokens_details.cached_tokens",
    },
    capabilities: {
      streaming: true,
      vision: true,
      tools: true,
      jsonMode: true,
      contextWindow: 128000,
      maxOutputTokens: 16384,
    },
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
    notes: "Messages API with tool_use blocks. max_tokens 4096. /effort maps to the thinking budget (Auto omits it).",
    cache: {
      explicitBreakpoints: true,
      implicitPrefix: true,
      usageCacheFields: true,
      notes: "cache_control {type:ephemeral} on stable system block + last tool (5m default TTL); usage.cache_read/cache_creation_input_tokens",
    },
    capabilities: {
      streaming: true,
      vision: true,
      tools: true,
      jsonMode: false,
      contextWindow: 200000,
      maxOutputTokens: 4096,
    },
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
    notes: "OpenAI-compatible (no /v1 prefix). /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: true,
      notes: "automatic on-disk context caching; usage.prompt_cache_hit_tokens (+miss informational)",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
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
    notes: "OpenAI-compatible chat/completions. /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: false,
      usageCacheFields: false,
      notes: "no verified caching contract — stable serialization only",
    },
    capabilities: {
      streaming: true,
      vision: true,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
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
    notes: "streamGenerateContent SSE; :generateContent fallback. /effort maps to thinkingLevel (Auto omits it; Max rides high).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: true,
      notes: "implicit caching by default (stable content first); usageMetadata.cachedContentTokenCount",
    },
    capabilities: {
      streaming: true,
      vision: true,
      tools: true,
      jsonMode: false,
      contextWindow: 1000000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "groq",
    name: "Groq",
    kind: "openai-chat",
    chatEndpoint: "https://api.groq.com/openai/v1/chat/completions",
    consoleURL: "https://console.groq.com/keys",
    envVars: ["GROQ_API_KEY"],
    defaultModel: "llama-3.3-70b-versatile",
    fallbackModels: [
      "llama-3.3-70b-versatile",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "llama-3.1-8b-instant",
    ],
    notes: "OpenAI-compatible (base https://api.groq.com/openai/v1). /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "no verified caching contract — stable serialization only",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "xai",
    name: "xAI",
    kind: "openai-chat",
    chatEndpoint: "https://api.x.ai/v1/chat/completions",
    consoleURL: "https://console.x.ai",
    envVars: ["XAI_API_KEY"],
    defaultModel: "grok-4.6",
    fallbackModels: ["grok-4.6", "grok-4.5", "grok-4.3"],
    notes: "OpenAI-compatible (base https://api.x.ai/v1). /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: true,
      notes: "usage.prompt_tokens_details.cached_tokens",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "zai",
    name: "Z.ai",
    kind: "openai-chat",
    chatEndpoint: "https://api.z.ai/api/paas/v4/chat/completions",
    consoleURL: "https://z.ai/manage-apikey/apikey-list",
    envVars: ["ZAI_API_KEY"],
    defaultModel: "glm-5.3",
    fallbackModels: ["glm-5.3", "glm-5.2", "glm-4.7", "glm-4.6"],
    notes: "OpenAI-compatible (base https://api.z.ai/api/paas/v4). /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "no verified caching contract — stable serialization only",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-chat",
    chatEndpoint: "https://openrouter.ai/api/v1/chat/completions",
    consoleURL: "https://openrouter.ai/keys",
    envVars: ["OPENROUTER_API_KEY"],
    defaultModel: "anthropic/claude-sonnet-4.6",
    fallbackModels: [
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-5.4",
      "x-ai/grok-4.6",
      "deepseek/deepseek-chat-v3.1",
      "qwen/qwen3-coder-plus",
    ],
    notes: "OpenAI-compatible aggregator (org/model slugs). Live /models is authoritative. /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: true,
      notes: "usage.prompt_tokens_details.cached_tokens (+ cost)",
    },
    capabilities: {
      streaming: true,
      vision: true,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "cerebras",
    name: "Cerebras",
    kind: "openai-chat",
    chatEndpoint: "https://api.cerebras.ai/v1/chat/completions",
    consoleURL: "https://cloud.cerebras.ai",
    envVars: ["CEREBRAS_API_KEY"],
    defaultModel: "gpt-oss-120b",
    // Only 2 public models exist (live /models authoritative); exempt from
    // the 3-6 curated-names rule enforced for other remote providers.
    fallbackModels: ["gpt-oss-120b", "qwen-3.8-27b"],
    notes: "OpenAI-compatible. /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "no verified caching contract — stable serialization only",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
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
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "server-dependent; stable serialization only, nothing reported",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 4096,
    },
  },
  {
    id: "cohere",
    name: "Cohere",
    kind: "openai-chat",
    // Cohere's native /v2/chat speaks its own request/response shape, so the
    // OpenAI-compatible surface is used instead (verified live 2026-10-07:
    // /compatibility/v1/{chat/completions,models} answer 401 without a key).
    chatEndpoint: "https://api.cohere.ai/compatibility/v1/chat/completions",
    consoleURL: "https://dashboard.cohere.com/api-keys",
    envVars: ["COHERE_API_KEY"],
    // Live models per https://docs.cohere.com/docs/models (2026-10-07):
    // command-r-plus / command-r are deprecated aliases (Sept 15 2025), so
    // the Command A / refreshed Command R generation is the curated set.
    defaultModel: "command-a-03-2025",
    fallbackModels: ["command-a-03-2025", "command-r-plus-08-2024", "command-r-08-2024"],
    notes: "OpenAI-compatible (base https://api.cohere.ai/compatibility/v1). /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "no verified caching contract — stable serialization only",
    },
    capabilities: {
      streaming: true,
      vision: true,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "perplexity",
    name: "Perplexity",
    kind: "openai-chat",
    chatEndpoint: "https://api.perplexity.ai/chat/completions",
    consoleURL: "https://www.perplexity.ai/settings/api",
    envVars: ["PERPLEXITY_API_KEY"],
    defaultModel: "sonar-pro",
    fallbackModels: ["sonar-pro", "sonar", "sonar-reasoning-pro"],
    notes: "OpenAI-compatible chat/completions. /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "no verified caching contract — stable serialization only",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    kind: "openai-chat",
    chatEndpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
    consoleURL: "https://build.nvidia.com/explore/discover",
    envVars: ["NVIDIA_API_KEY"],
    // Live catalog probe 2026-10-07: GET /v1/models is public (200) and
    // meta/llama-3.3-70b-instruct answers 410 Gone (EOL 2026-08-26), so the
    // curated set is models the endpoint still serves (401 = alive + keyed).
    defaultModel: "deepseek-ai/deepseek-v4.1-flash",
    fallbackModels: ["deepseek-ai/deepseek-v4.1-flash", "moonshotai/kimi-k3", "mistralai/mistral-large-2-instruct"],
    notes: "OpenAI-compatible chat/completions. /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "no verified caching contract — stable serialization only",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "together",
    name: "Together AI",
    kind: "openai-chat",
    chatEndpoint: "https://api.together.xyz/v1/chat/completions",
    consoleURL: "https://api.together.xyz/settings/api-keys",
    envVars: ["TOGETHER_API_KEY"],
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    fallbackModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct-Turbo"],
    notes: "OpenAI-compatible chat/completions. /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "no verified caching contract — stable serialization only",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    kind: "openai-chat",
    chatEndpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
    consoleURL: "https://fireworks.ai/account/api-keys",
    envVars: ["FIREWORKS_API_KEY"],
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    fallbackModels: ["accounts/fireworks/models/llama-v3p3-70b-instruct", "accounts/fireworks/models/llama-v3p1-8b-instruct"],
    notes: "OpenAI-compatible chat/completions. /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "no verified caching contract — stable serialization only",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    kind: "openai-chat",
    // Placeholder endpoint: the real URL shape is
    // https://{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…
    // (custom endpoint construction lands with the full adapter).
    chatEndpoint: "https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT/chat/completions?api-version=2024-06-01",
    consoleURL: "https://portal.azure.com/#view/Microsoft_Azure_ProjectForge/CognitiveServicesHub/~/OpenAI",
    envVars: ["AZURE_OPENAI_API_KEY"],
    defaultModel: "gpt-4o",
    fallbackModels: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    notes: "Azure OpenAI (custom endpoint shape — set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT env vars). /effort sends reasoning_effort (Auto omits it).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: true,
      notes: "automatic prefix caching; usage.prompt_tokens_details.cached_tokens",
    },
    capabilities: {
      streaming: true,
      vision: true,
      tools: true,
      jsonMode: true,
      contextWindow: 128000,
      maxOutputTokens: 16384,
    },
  },
  {
    id: "bedrock",
    name: "AWS Bedrock",
    kind: "anthropic-messages",
    // Bedrock serves the Anthropic Messages wire format but signs requests
    // with AWS SigV4 — the full adapter lands in a follow-up task.
    chatEndpoint: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-5-20250929-v1:0/invoke",
    consoleURL: "https://console.aws.amazon.com/bedrock/",
    envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    defaultModel: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    fallbackModels: ["anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic.claude-3-5-sonnet-20241022-v2:0", "anthropic.claude-3-haiku-20240307-v1:0"],
    notes: "AWS Bedrock (requires AWS SigV4 signing — adapter coming soon). Set AWS_REGION env var.",
    cache: {
      explicitBreakpoints: true,
      implicitPrefix: true,
      usageCacheFields: true,
      notes: "cache_control {type:ephemeral} on stable system block + last tool; usage.cache_read/cache_creation_input_tokens",
    },
    capabilities: {
      streaming: true,
      vision: true,
      tools: true,
      jsonMode: false,
      contextWindow: 200000,
      maxOutputTokens: 4096,
    },
  },
  {
    id: "vertex-ai",
    name: "Google Vertex AI",
    kind: "gemini-generate",
    // Vertex serves the Gemini generateContent wire format but authenticates
    // with GCP service-account credentials — the full adapter lands in a
    // follow-up task.
    chatEndpoint: "https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent",
    consoleURL: "https://console.cloud.google.com/vertex-ai",
    envVars: ["GOOGLE_APPLICATION_CREDENTIALS"],
    defaultModel: "gemini-2.5-flash",
    fallbackModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    notes: "Google Vertex AI (requires GCP service-account auth — adapter coming soon). Set GOOGLE_APPLICATION_CREDENTIALS env var.",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: true,
      notes: "implicit caching by default; usageMetadata.cachedContentTokenCount",
    },
    capabilities: {
      streaming: true,
      vision: true,
      tools: true,
      jsonMode: false,
      contextWindow: 1000000,
      maxOutputTokens: 8192,
    },
  },
  // Local runtimes (auto-discovered; see src/local-discovery.ts). All three
  // serve the OpenAI-compatible /v1/* surface ATOM chats through
  // (Ollama natively documents /v1/chat/completions with streaming, tools,
  // vision, and reasoning support). No API key: the servers ignore bearer
  // auth. fallbackModels stay empty — nothing is listed until discovery
  // reports it, so no model names are fabricated.
  {
    id: "ollama",
    name: "Ollama",
    kind: "openai-chat",
    chatEndpoint: undefined,
    consoleURL: "https://ollama.com",
    envVars: [],
    defaultModel: "",
    fallbackModels: [],
    notes: "Local Ollama server (auto-discovered). Discovery reads native /api/tags, chat uses OpenAI-compatible /v1.",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "server-dependent; stable serialization only, nothing reported",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 4096,
    },
    local: {
      defaultBaseURL: "http://127.0.0.1:11434",
      baseURLEnvVar: "ATOM_OLLAMA_URL",
    },
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "openai-chat",
    chatEndpoint: undefined,
    consoleURL: "https://lmstudio.ai",
    envVars: [],
    defaultModel: "",
    fallbackModels: [],
    notes: "Local LM Studio server (auto-discovered, OpenAI-compatible /v1).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "server-dependent; stable serialization only, nothing reported",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 4096,
    },
    local: {
      defaultBaseURL: "http://127.0.0.1:1234",
      baseURLEnvVar: "ATOM_LMSTUDIO_URL",
    },
  },
  {
    id: "llamacpp",
    name: "llama.cpp",
    kind: "openai-chat",
    chatEndpoint: undefined,
    consoleURL: "https://github.com/ggml-org/llama.cpp",
    envVars: [],
    defaultModel: "",
    fallbackModels: [],
    notes: "Local llama-server (auto-discovered, OpenAI-compatible /v1; exposes only the loaded model).",
    cache: {
      explicitBreakpoints: false,
      implicitPrefix: true,
      usageCacheFields: false,
      notes: "server-dependent; stable serialization only, nothing reported",
    },
    capabilities: {
      streaming: true,
      vision: false,
      tools: true,
      jsonMode: false,
      contextWindow: 128000,
      maxOutputTokens: 4096,
    },
    local: {
      defaultBaseURL: "http://127.0.0.1:8080",
      baseURLEnvVar: "ATOM_LLAMACPP_URL",
    },
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

// Local runtimes need no API key (loopback servers ignore bearer auth),
// and Kilo serves anonymous free (`:free`) models, so picker/submit key
// gates must let both through keyless.
export function providerNeedsKey(id: ProviderId): boolean {
  if (id === "kilo") return false;
  return !isLocalProviderId(id);
}

// Resolve a local server baseURL: explicit override wins, then the
// ATOM_*_URL env var, then the loopback default. Env-before-stored matches
// key resolution (env wins); stored stays reserved for future UI.
export function localBaseURLFor(id: LocalProviderId, storedBaseURL?: string): string {
  const def = getProvider(id);
  const envVar = def?.local?.baseURLEnvVar;
  const fromEnv = envVar ? (process.env[envVar] ?? "").trim() : "";
  if (fromEnv) return normalizeBaseURL(fromEnv);
  const stored = (storedBaseURL ?? "").trim();
  if (stored) return normalizeBaseURL(stored);
  return def?.local?.defaultBaseURL ?? "";
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

// Local chat endpoint: server base + OpenAI-compatible path, appended iff
// missing (a custom baseURL may already include /v1).
export function localChatEndpoint(baseURL: string): string {
  const base = normalizeBaseURL(baseURL);
  return base.endsWith("/v1/chat/completions")
    ? base
    : `${base}/v1/chat/completions`;
}

// Local models URL: server base + OpenAI-compatible listing path.
export function localModelsURL(baseURL: string): string {
  const base = normalizeBaseURL(baseURL);
  return base.endsWith("/v1/models") ? base : `${base}/v1/models`;
}

// Chat endpoint for a provider (openai-compatible needs stored baseURL;
// local runtimes resolve env/default loopback baseURLs).
export function chatEndpointFor(
  id: ProviderId,
  storedBaseURL?: string
): string {
  const def = getProvider(id)!;
  if (id === "openai-compatible") {
    return openaiCompatibleChatEndpoint(storedBaseURL ?? "");
  }
  if (isLocalProviderId(id)) {
    return localChatEndpoint(localBaseURLFor(id, storedBaseURL));
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
  // Perplexity lists models under /v1/models (verified live 2026-10-07: the
  // derived /models answers 404, /v1/models answers 401 = auth-gated but
  // present), while chat stays at /chat/completions.
  if (id === "perplexity") return "https://api.perplexity.ai/v1/models";
  if (isLocalProviderId(id)) {
    return localModelsURL(localBaseURLFor(id, storedBaseURL));
  }
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

// Providers whose registry entry ships before its adapter. Chat and health
// checks must fail fast with this message instead of a misleading
// provider-side error (placeholder DNS failures, AWS/GCP auth rejections).
const STUB_PROVIDER_MESSAGES: Partial<Record<ProviderId, string>> = {
  "azure-openai":
    "Azure OpenAI is not usable yet — its adapter (deployment/endpoint URL mapping) is not implemented. Pick another provider.",
  bedrock:
    "AWS Bedrock is not usable yet — its adapter (SigV4 request signing) is not implemented. Pick another provider.",
  "vertex-ai":
    "Google Vertex AI is not usable yet — its adapter (GCP service-account auth) is not implemented. Pick another provider.",
};

// Stub notice for a provider, undefined once the adapter exists.
export function stubProviderMessage(id: ProviderId): string | undefined {
  return STUB_PROVIDER_MESSAGES[id];
}

// Health check result for a provider.
export type ProviderHealthResult = {
  ok: boolean;
  latencyMs: number;
  error?: string;
};

// Timeout for remote provider health checks (ms).
const REMOTE_HEALTH_TIMEOUT_MS = 5000;
// Timeout for local provider health checks (ms).
const LOCAL_HEALTH_TIMEOUT_MS = 2000;

// Perform a minimal API call to verify a provider is working.
// Never throws — always returns a ProviderHealthResult.
export async function checkProviderHealth(
  id: ProviderId,
  apiKey?: string
): Promise<ProviderHealthResult> {
  const stub = stubProviderMessage(id);
  if (stub) return { ok: false, latencyMs: 0, error: stub };
  const isLocal = isLocalProviderId(id);
  const url = modelsUrlForProvider(id);
  const timeoutMs = isLocal ? LOCAL_HEALTH_TIMEOUT_MS : REMOTE_HEALTH_TIMEOUT_MS;
  const headers: Record<string, string> = {};
  if (apiKey && !isLocal && id !== "kilo" && id !== "opencode-zen") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    if (response.ok) {
      return { ok: true, latencyMs };
    }
    return { ok: false, latencyMs, error: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}


