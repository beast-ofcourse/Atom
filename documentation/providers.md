# Providers and Models

8 remote providers plus 3 local runtimes (Ollama, LM Studio, llama.cpp) behind one UI (`src/providers.ts`). Manual-key only, mirroring opencode `/connect`. No OAuth, no browser flow. Kilo Gateway is the default provider and is OpenAI-compatible. Local runtimes need no key: they join the pickers once discovery reports models (loopback servers, auto-discovered).

## Provider table

| Provider | Key env (wins over stored) | Endpoint | Notes |
|---|---|---|---|
| kilo | `KILO_API_KEY` (optional — free models work anonymously) | `https://api.kilo.ai/api/gateway/chat/completions` | Kilo Gateway, OpenAI-compatible. Default provider. Anonymous access covers eligible free (`:free`) models; a key unlocks the full catalog |
| opencode-zen | `OPENCODE_ZEN_API_KEY` | `https://opencode.ai/zen/v1/chat/completions` | OpenAI-compatible chat/completions. Key at `https://opencode.ai/auth` |
| openai | `OPENAI_API_KEY` | `https://api.openai.com/v1/chat/completions` | OpenAI-compatible. Key at `https://platform.openai.com/api-keys` |
| anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/messages` | Messages API (`x-api-key` plus `anthropic-version: 2023-06-01`, `max_tokens` 4096). Key at `https://console.anthropic.com/settings/keys` |
| deepseek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/chat/completions` | OpenAI-compatible, no `/v1` prefix. Key at `https://platform.deepseek.com/api_keys` |
| mistral | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1/chat/completions` | OpenAI-compatible. Key at `https://console.mistral.ai/api-keys` |
| google-gemini | `GEMINI_API_KEY` (alias `GOOGLE_API_KEY`) | `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse` (`:generateContent` fallback) | `x-goog-api-key`. Key at `https://aistudio.google.com/apikey` |
| openai-compatible | stored key only | stored baseURL (`/chat/completions` appended when missing) | Prompts for baseURL (must be http/https). Live `/models` is authoritative |

Keys are never printed full (masked as last4), never logged, never in fixtures (tests use `"test-key"`).

## Kilo Gateway (default)

- Kilo is ATOM's default provider: fresh installs start on Kilo with no key required
- The model catalog is discovered live via `GET https://api.kilo.ai/api/gateway/models` (cached for 5 minutes; `/model refresh` re-fetches while Kilo is active). Nothing is hardcoded — the catalog is authoritative, and free-model availability can change as Kilo updates it
- Anonymous access covers eligible free models (ids ending in `:free`, including the `kilo-auto/free` dynamic routing model, which Kilo resolves server-side). Without a key ATOM prefers `kilo-auto/free` when exposed, else the first free model, else the first live id
- Configure a key with `/provider` (validated, stored in `~/.atom/auth.json`) or `KILO_API_KEY` to unlock the full catalog; authenticated requests send `Authorization: Bearer <key>`, anonymous requests send no auth header at all
- Free models show a `(free)` badge in `/model` and match the `free` filter
- Chat is OpenAI-compatible (`POST /chat/completions`) with streaming, tool calls, and usage metadata on the shared OpenAI-chat path; failures surface as short actionable messages (e.g. `Kilo: anonymous free-model rate limit reached.`, `Kilo: API key is invalid.`, `Kilo: model is unavailable.`, `Kilo: gateway temporarily unavailable.`)

## Defaults and fallbacks

- Default provider: `kilo` (default model: `kilo-auto/free` when no key is configured)
- Zen default model: `deepseek-v4-pro`, picked for reliable multi-step tool use. Free models (`big-pickle` and similar) stay selectable via `/model` for quick single-turn questions. Override any time with `/model` or `OPENCODE_ZEN_MODEL`
- Each provider ships a fallback model list used when the live `/models` call fails. The live list is authoritative when reachable. Kilo's fallback is just the `kilo-auto/free` routing placeholder (one id, not a catalog)

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

- `/provider`: pick provider, paste key once (validated, stored), chat. Kilo's key is optional — without one the prompt offers anonymous free-model use. Switching provider keeps session history text. System prompt stays
- `/model`: unified picker — active provider's live models first (fallback on any failure), then every other keyed provider's models plus the always-visible keyless Kilo and local lists (cached live list when warm, else fallback). `openai-compatible` joins only with both a key and a stored baseURL. Type to filter (`free` matches free Kilo models), list windows to 10 rows, picking another provider's model switches provider too. `/model <text>` opens pre-filtered; `/model refresh` re-probes local servers (Kilo gateway catalog while Kilo is active)
- `/effort`: reasoning-effort picker (`Auto`/`Low`/`Medium`/`High`/`Max`). Sent for every model on every provider: `reasoning_effort` on OpenAI-chat kinds (zen, OpenAI, DeepSeek, Mistral, Kilo, openai-compatible, locals), a `thinking` budget on Anthropic, a `thinkingConfig.thinkingLevel` on Gemini. `Auto` omits the knob. A model that truly lacks the knob fails the POST with a 400 naming it — the turn warns and retries once without it, so `(unsupported)` only ever reflects an actual server rejection

Custom server: pick `openai-compatible`, paste the baseURL (validated as http/https, trailing slashes trimmed) and key. Endpoint helper appends `/chat/completions` when missing.

See [Configuration](configuration.md) for env var details and [Troubleshooting](troubleshooting.md) for auth failures.

## Prompt caching

ATOM constructs a cache-friendly prompt on every POST and each provider realizes it its own way (`ProviderDef.cache` in `src/providers.ts`, assembled in `src/prompt-cache.ts`). No prompt caching is implemented harness-side — this is deliberate prefix construction plus usage reporting.

- **Stable prefix** (byte-identical across POSTs): system instructions + project overlay + tool definitions. The per-turn env block (timestamps, git status) splits off into its own trailing system content, so it never breaks the prefix. No timestamps, random IDs, or dynamic content in the prefix; tool order is source order.
- **Anthropic**: explicit `cache_control: {type: ephemeral}` breakpoints on the stable system block and the last tool (5m default TTL, no beta header). System renders as blocks only when an env tail splits off, else the legacy string.
- **OpenAI-shape** (kilo/zen/openai/deepseek/mistral/compatible): consecutive `[stable, dynamic]` system messages (content-neutral concatenation); prefix caching itself is automatic server-side.
- **Gemini**: `system_instruction` splits into stable/dynamic parts the same way.
- **Hits are only ever shown when reported**: Anthropic `cache_read/_creation_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`, DeepSeek `prompt_cache_hit_tokens`, Gemini `cachedContentTokenCount` accumulate into session totals and surface in `/context`. Absent fields display as "(not reported)", never zeros.
