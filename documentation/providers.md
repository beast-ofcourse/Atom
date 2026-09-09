# Providers and Models

7 providers behind one UI (`src/providers.ts`). Manual-key only, mirroring opencode `/connect`. No OAuth, no browser flow.

## Provider table

| Provider | Key env (wins over stored) | Endpoint | Notes |
|---|---|---|---|
| opencode-zen | `OPENCODE_ZEN_API_KEY` | `https://opencode.ai/zen/v1/chat/completions` | OpenAI-compatible chat/completions default. Key at `https://opencode.ai/auth` |
| openai | `OPENAI_API_KEY` | `https://api.openai.com/v1/chat/completions` | OpenAI-compatible. Key at `https://platform.openai.com/api-keys` |
| anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/messages` | Messages API (`x-api-key` plus `anthropic-version: 2023-06-01`, `max_tokens` 4096). Key at `https://console.anthropic.com/settings/keys` |
| deepseek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/chat/completions` | OpenAI-compatible, no `/v1` prefix. Key at `https://platform.deepseek.com/api_keys` |
| mistral | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1/chat/completions` | OpenAI-compatible. Key at `https://console.mistral.ai/api-keys` |
| google-gemini | `GEMINI_API_KEY` (alias `GOOGLE_API_KEY`) | `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse` (`:generateContent` fallback) | `x-goog-api-key`. Key at `https://aistudio.google.com/apikey` |
| openai-compatible | stored key only | stored baseURL (`/chat/completions` appended when missing) | Prompts for baseURL (must be http/https). Live `/models` is authoritative |

Keys are never printed full (masked as last4), never logged, never in fixtures (tests use `"test-key"`).

## Defaults and fallbacks

- Default provider: `opencode-zen`
- Zen default model: `deepseek-v4-pro`, picked for reliable multi-step tool use. Free models (`big-pickle` and similar) stay selectable via `/model` for quick single-turn questions. Override any time with `/model` or `OPENCODE_ZEN_MODEL`
- Each provider ships a curated fallback model list used when the live `/models` call fails. The live list is authoritative when reachable

Fallbacks are build-time curated (2026-09-07) from vendor docs. See the header comment in `src/providers.ts` for per-vendor sources.

## Key resolution

Precedence per provider (`src/auth.ts`):

1. First non-empty env var in the provider `envVars` list
2. Stored key in `~/.atom/auth.json`

`openai-compatible` has no env vars, so it is stored-only by construction. Stored zen key applies when no env key is set.

Auth file shape:

```json
{
  "version": 1,
  "providers": {
    "<id>": { "apiKey": "...", "baseURL?": "..." }
  }
}
```

File lives at `~/.atom/auth.json` (`ATOM_HOME` overrides the home dir). `0600` on POSIX, best-effort on Windows. Missing or corrupt file loads as empty auth, never throws.

## Switching

- `/provider`: pick provider, paste key once (validated, stored), chat. Switching provider keeps session history text. System prompt stays
- `/model`: unified picker — active provider's live models first (curated fallback on any failure), then every other provider with a key (env or stored; cached live list when warm, else curated fallback). `openai-compatible` joins only with both a key and a stored baseURL. Type to filter, list windows to 10 rows, picking another provider's model switches provider too
- `/effort`: reasoning-effort picker. Sent as `reasoning_effort` only for opencode-zen supported models. Stored elsewhere but never sent

Custom server: pick `openai-compatible`, paste the baseURL (validated as http/https, trailing slashes trimmed) and key. Endpoint helper appends `/chat/completions` when missing.

See [Configuration](configuration.md) for env var details and [Troubleshooting](troubleshooting.md) for auth failures.

## Prompt caching

ATOM constructs a cache-friendly prompt on every POST and each provider realizes it its own way (`ProviderDef.cache` in `src/providers.ts`, assembled in `src/prompt-cache.ts`). No prompt caching is implemented harness-side — this is deliberate prefix construction plus usage reporting.

- **Stable prefix** (byte-identical across POSTs): system instructions + project overlay + tool definitions. The per-turn env block (timestamps, git status) splits off into its own trailing system content, so it never breaks the prefix. No timestamps, random IDs, or dynamic content in the prefix; tool order is source order.
- **Anthropic**: explicit `cache_control: {type: ephemeral}` breakpoints on the stable system block and the last tool (5m default TTL, no beta header). System renders as blocks only when an env tail splits off, else the legacy string.
- **OpenAI-shape** (zen/openai/deepseek/mistral/compatible): consecutive `[stable, dynamic]` system messages (content-neutral concatenation); prefix caching itself is automatic server-side.
- **Gemini**: `system_instruction` splits into stable/dynamic parts the same way.
- **Hits are only ever shown when reported**: Anthropic `cache_read/_creation_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`, DeepSeek `prompt_cache_hit_tokens`, Gemini `cachedContentTokenCount` accumulate into session totals and surface in `/context`. Absent fields display as "(not reported)", never zeros.
