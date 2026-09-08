// Curated per-model context windows (tokens) for the footer token segment.
// Built at BUILD time from vendor docs — models missing here render WITHOUT
// a percent (bare `token: NK`); a window is never invented (same honesty
// rule as `token: n/a` for unreported usage). Zen chat models reuse this map
// by model id (no zen-vs-other distinction).
import type { Usage } from "./zen.js";

export const CONTEXT_WINDOWS: Record<string, number> = {
  // DeepSeek V4 family: 1M context.
  // Sources: https://www.deepseek.com/en/news/v4-preview/
  // ("1M context is now the default"), https://arxiv.org/abs/2606.19348
  // ("supporting a context length of one million tokens").
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-flash-vision-exp": 1_000_000,
  // Kimi K2.5 / K2.6: 256K context (262144 tokens).
  // Sources: https://github.com/MoonshotAI/Kimi-K2.5 (Context Length 256K),
  // https://huggingface.co/moonshotai/Kimi-K2.5 (Context Length 256K),
  // https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart
  // ("kimi-k2.7-code and kimi-k2.6 models both provide a 256K context window").
  "kimi-k2.5": 262_144,
  "kimi-k2.6": 262_144,
  // Kimi K2.7 Code: 256K context.
  // Source: https://www.kimi.com/code/docs/en/kimi-code/models.html
  // (kimi-for-coding / K2.7 Code: 256k context window).
  "kimi-k2.7-code": 262_144,
  // Kimi K3: 1M context (1048576 tokens).
  // Sources: https://github.com/MoonshotAI/Kimi-K3 (Context Length 1048576),
  // https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3
  // (Input Context Length: 1,048,576 tokens).
  "kimi-k3": 1_048_576,
  // GLM-5.1: 200K context.
  // Sources: https://llm-stats.com/models/compare/glm-5.1-vs-glm-5.3
  // (GLM-5.1: 200,000 tokens), https://z.ai/blog/glm-5.1
  // (eval settings "with a 200K context window").
  "glm-5.1": 200_000,
  // GLM-5.2: solid 1M context.
  // Source: https://z.ai/blog/glm-5.2 ("a solid 1M-token context").
  "glm-5.2": 1_000_000,
  // GLM-5.3: 1M context.
  // Sources: https://docs.aimlapi.com/api-references/text-models-llm/zhipu/glm-5.3
  // ("1M-token context window"), https://kie.ai/blog/what-is-glm-5-3
  // ("Context window 1M tokens").
  "glm-5.3": 1_000_000,
  // MiniMax M2.5 / M2.7: 204800 context; MiniMax M3: 1M context.
  // Sources: https://platform.minimax.io/docs/guides/text-generation
  // (context-window table: M3 1,000,000; M2.7/M2.5 204,800),
  // https://www.minimax.io/models/text/m3 ("up to 1M tokens context window").
  "minimax-m2.5": 204_800,
  "minimax-m2.7": 204_800,
  "minimax-m3": 1_000_000,
  // OpenAI flagship chat models: 1.05M context window.
  // Source: https://platform.openai.com/docs/models (Context window 1.05M
  // for GPT-6 Astra, GPT-5.6 Sol/Terra/Luna).
  "gpt-6-astra": 1_050_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  // Anthropic Claude: 1M context (Opus 5 / Sonnet 5 / Fable 5.1),
  // 200K for Haiku 4.5.
  // Source: https://platform.claude.com/docs/en/models/overview
  // (Context window row: 1M tokens / 1M tokens / 1M tokens / 200K tokens).
  "claude-fable-5-1": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  // Google Gemini 3 family: 1M context (1,048,576 tokens).
  // Sources: https://ai.google.dev/gemini-api/docs/gemini-3
  // (Context Window 1M), https://ai.google.dev/gemini-api/docs/long-context
  // ("large context windows of 1 million or more tokens"),
  // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-7-flash
  // (Context window 1,048,576).
  "gemini-3-flash-preview": 1_048_576,
  "gemini-3.1-pro-preview": 1_048_576,
  "gemini-3.1-flash-lite": 1_048_576,
  "gemini-3.5-flash": 1_048_576,
  "gemini-3.7-flash": 1_048_576,
  "gemini-3.8-flash": 1_048_576,
};

// Context window for a model id, or undefined when the model has no
// verified window (callers render the bare `token: NK` form).
export function contextWindowFor(model: string): number | undefined {
  return CONTEXT_WINDOWS[model];
}

// Total session tokens: prefer usage.total_tokens when present, else
// prompt_tokens + completion_tokens (missing keys count as 0).
export function totalTokens(usage: Usage): number {
  if (typeof usage.total_tokens === "number") {
    return Math.max(0, Math.floor(usage.total_tokens));
  }
  const prompt =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completion =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return Math.max(0, Math.floor(prompt + completion));
}

// Footer token segment, EXACT format:
// - no usage reported yet: `token: n/a` (never estimated)
// - known window: `token: (P%) NK` (NK = round(total/1024) + "K" from the
//   CUMULATIVE session spend; P = round(100*load/window) from the CURRENT
//   context load — prompt_tokens of the last POST, else the 4ch/token
//   estimate. Cumulative spend keeps growing after compaction, so it must
//   NOT drive P; load does. Pass load explicitly; when omitted it falls
//   back to the cumulative total for backward compat.)
// - unknown window: `token: NK` (never invent a window)
// Zero usage with a known window is `token: (0%) 0K`; without one `token: 0K`.
export function formatTokenSegment(
  usage: Usage | null,
  model: string,
  load?: number | null
): string {
  if (!usage) return "token: n/a";
  const total = totalTokens(usage);
  const k = `${Math.round(total / 1024)}K`;
  const window = contextWindowFor(model);
  if (window === undefined) return `token: ${k}`;
  const loadTokens =
    typeof load === "number" && Number.isFinite(load) && load >= 0
      ? Math.floor(load)
      : total;
  const pct = Math.round((100 * loadTokens) / window);
  return `token: (${pct}%) ${k}`;
}
