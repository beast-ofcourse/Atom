// Kilo Gateway provider (ATOM's default provider).
//
// Kilo exposes an OpenAI-compatible surface:
//   GET  {base}/models
//   POST {base}/chat/completions
// Chat/streaming/tool-call wire behavior is the shared OpenAI-chat path in
// src/zen.ts — this module owns ONLY Kilo-specific concerns:
//   - endpoint constants + header construction (auth is optional: free
//     `:free` models work anonymously, so no Authorization header is sent
//     when no key is configured)
//   - dynamic catalog parsing into ATOM's normalized model representation
//   - free-model detection (`:free` suffix, incl. the `kilo-auto/free`
//     dynamic routing model)
//   - TTL-cached discovery (manual refresh clears it)
//   - provider-specific error normalization (concise, actionable, key-free)
//
// Nothing here is imported by other providers: no Kilo behavior leaks.

export const KILO_BASE_URL = "https://api.kilo.ai/api/gateway";

export const KILO_CHAT_ENDPOINT = `${KILO_BASE_URL}/chat/completions`;

export const KILO_MODELS_URL = `${KILO_BASE_URL}/models`;

// Env var names in precedence order (mirrors the ProviderDef.envVars shape;
// the registry entry is the single declaration point).
export const KILO_ENV_VARS: readonly string[] = ["KILO_API_KEY"];

// Dynamic routing model: Kilo picks a free model server-side. Preferred
// whenever the user has no API key and the live catalog exposes it — but
// never assumed present (the catalog is authoritative, see
// preferFreeKiloModel).
export const KILO_AUTO_MODEL = "kilo-auto/free";

// Offline placeholder only: the live /models list is authoritative. Kept to
// one routing id (not a catalog) so nothing here goes stale as Kilo changes
// its models.
export const KILO_FALLBACK_MODELS: readonly string[] = [KILO_AUTO_MODEL];

// Discovery cache TTL: 5 minutes. The App also keeps successful lists in its
// session cache; this TTL bounds gateway hits across provider switches while
// staying fresh enough for a changing catalog.
export const KILO_MODELS_TTL_MS = 5 * 60 * 1000;

// ---- Normalized model representation ----

export type KiloModelInfo = {
  id: string;
  displayName: string;
  // Upstream provider prefix parsed from "provider/model-name" ids.
  provider?: string;
  contextLength?: number;
  capabilities?: string[];
  // True for `:free`-suffixed ids (anonymous-eligible), or when the catalog
  // explicitly prices the model at zero.
  free: boolean;
  pricing?: { prompt?: number; completion?: number };
  // Tool/function-calling support when the catalog declares it.
  toolsSupported?: boolean;
};

// A model is free when its id carries the `:free` suffix (Kilo's free-model
// convention) or names the free routing slot (`<provider>/free`, e.g.
// `kilo-auto/free`), or its catalog pricing is explicitly zero. Unknown
// pricing is NOT free — never assume.
export function isFreeKiloModel(id: string): boolean {
  if (id.endsWith(":free")) return true;
  if (/\/free$/.test(id)) return true;
  return false;
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function entryId(entry: unknown): string | null {
  if (typeof entry === "string") return entry || null;
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const id = e["id"] ?? e["name"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

function entryRecord(entry: unknown): Record<string, unknown> | null {
  if (typeof entry !== "object" || entry === null) return null;
  return entry as Record<string, unknown>;
}

function parseContextLength(e: Record<string, unknown>): number | undefined {
  for (const key of [
    "context_length",
    "contextLength",
    "max_context_length",
    "maxContextLength",
    "context_window",
    "contextWindow",
  ]) {
    const hit = finiteCount(e[key]);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function parseCapabilities(e: Record<string, unknown>): string[] | undefined {
  const raw = e["capabilities"] ?? e["supported_parameters"] ?? e["supportedParameters"];
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? out : undefined;
}

function parsePricing(e: Record<string, unknown>):
  | { pricing: { prompt?: number; completion?: number }; zero: boolean }
  | undefined {
  const raw = e["pricing"];
  if (typeof raw !== "object" || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  // Kilo/OpenRouter-style pricing may be a decimal string ("0") — accept it.
  const coerce = (v: unknown): number | undefined => {
    if (typeof v === "number") return num(v);
    if (typeof v === "string" && v.trim().length > 0) {
      const n = Number(v.trim());
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    }
    return undefined;
  };
  const prompt = coerce(p["prompt"]) ?? coerce(p["input"]);
  const completion = coerce(p["completion"]) ?? coerce(p["output"]);
  if (prompt === undefined && completion === undefined) return undefined;
  return {
    pricing: {
      ...(prompt !== undefined ? { prompt } : {}),
      ...(completion !== undefined ? { completion } : {}),
    },
    zero: (prompt ?? 0) === 0 && (completion ?? 0) === 0,
  };
}

function parseToolsSupported(e: Record<string, unknown>): boolean | undefined {
  for (const key of [
    "tools_supported",
    "toolsSupported",
    "supports_tools",
    "supportsTools",
    "tool_support",
    "toolSupport",
  ]) {
    if (typeof e[key] === "boolean") return e[key] as boolean;
  }
  // Some catalogs advertise function calling via supported parameters.
  const caps = parseCapabilities(e);
  if (caps?.some((c) => /tool|function/i.test(c))) return true;
  return undefined;
}

// Parse one catalog entry into the normalized representation. Returns null
// when the entry carries no usable model id.
export function parseKiloModelEntry(entry: unknown): KiloModelInfo | null {
  const id = entryId(entry);
  if (!id) return null;
  const e = entryRecord(entry);
  const slash = id.indexOf("/");
  const info: KiloModelInfo = {
    id,
    displayName: nonEmptyString(e?.["display_name"] ?? e?.["displayName"] ?? e?.["name"]) ?? id,
    ...(slash > 0 ? { provider: id.slice(0, slash) } : {}),
    free: isFreeKiloModel(id),
  };
  if (!e) return info;
  const contextLength = parseContextLength(e);
  if (contextLength !== undefined) info.contextLength = contextLength;
  const capabilities = parseCapabilities(e);
  if (capabilities !== undefined) info.capabilities = capabilities;
  const pricing = parsePricing(e);
  if (pricing !== undefined) {
    info.pricing = pricing.pricing;
    if (pricing.zero) info.free = true;
  }
  const toolsSupported = parseToolsSupported(e);
  if (toolsSupported !== undefined) info.toolsSupported = toolsSupported;
  return info;
}

function catalogEntries(data: unknown): unknown[] | null {
  try {
    const entries: unknown = Array.isArray(data)
      ? data
      : (data as { data?: unknown })?.data;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    return entries;
  } catch {
    return null;
  }
}

// Full normalized catalog parse. Malformed payloads yield an empty list
// (callers fall back to KILO_FALLBACK_MODELS) — never throws.
export function parseKiloModelInfos(data: unknown): KiloModelInfo[] {
  const entries = catalogEntries(data);
  if (!entries) return [];
  const out: KiloModelInfo[] = [];
  for (const entry of entries) {
    try {
      const info = parseKiloModelEntry(entry);
      if (info) out.push(info);
    } catch {
      // One bad entry must not drop the whole catalog.
    }
  }
  return out;
}

// Picker-compatible id list from a catalog payload. ANY failure (malformed
// payload, zero usable ids) returns the fallback — never throws.
export function parseKiloModelsList(data: unknown, fallback: readonly string[] = KILO_FALLBACK_MODELS): string[] {
  const infos = parseKiloModelInfos(data);
  if (infos.length === 0) return [...fallback];
  return infos.map((m) => m.id);
}

// Default pick for a fresh session without an API key: the exposed
// `kilo-auto/free` routing model when present, else the first `:free` model,
// else the first live id, else the offline fallback. Never assumes a
// specific free model exists beyond what the catalog exposes.
export function preferFreeKiloModel(
  models: readonly string[],
  fallback: string = KILO_AUTO_MODEL
): string {
  if (models.length === 0) return fallback;
  const auto = models.find((m) => m === KILO_AUTO_MODEL);
  if (auto) return auto;
  const free = models.find((m) => isFreeKiloModel(m));
  if (free) return free;
  return models[0]!;
}

// ---- Headers (auth optional) ----

// Free `:free` models work anonymously: no Authorization header is sent when
// no key is configured (never an empty `Bearer `). No Kilo-specific,
// identity-spoofing, or bypass headers are ever sent — plain
// OpenAI-compatible auth only.
export function kiloHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

// ---- Discovery (TTL-cached, key-optional) ----

export type KiloModelsStatus = { models: string[]; infos: KiloModelInfo[]; ok: boolean };

type CacheSlot = { at: number; status: KiloModelsStatus };

const kiloModelsCache = new Map<string, CacheSlot>();

function cacheKey(hasKey: boolean): string {
  // Anonymous and authenticated catalogs can differ (paid models appear
  // with a key), so they cache separately.
  return hasKey ? "auth" : "anon";
}

function readKiloCache(hasKey: boolean, now: number = Date.now()): KiloModelsStatus | undefined {
  const slot = kiloModelsCache.get(cacheKey(hasKey));
  if (!slot) return undefined;
  if (now - slot.at > KILO_MODELS_TTL_MS) {
    kiloModelsCache.delete(cacheKey(hasKey));
    return undefined;
  }
  return slot.status;
}

// Manual refresh path: clears the discovery cache so the next fetch hits
// `/model refresh` again (used by the refresh path and provider switches).
export function clearKiloModelsCache(): void {
  kiloModelsCache.clear();
}

// GET the live catalog. Anonymous when apiKey is "" (free models only);
// authenticated otherwise. ANY failure returns the offline fallback with
// ok:false (callers keep failures uncached) — never throws.
export async function fetchKiloModelsWithStatus(apiKey: string): Promise<KiloModelsStatus> {
  const hasKey = apiKey.length > 0;
  const cached = readKiloCache(hasKey);
  if (cached) return cached;
  const fallback: KiloModelsStatus = {
    models: [...KILO_FALLBACK_MODELS],
    infos: [],
    ok: false,
  };
  try {
    const res = await fetch(KILO_MODELS_URL, { headers: kiloHeaders(apiKey) });
    if (!res.ok) return fallback;
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return fallback;
    }
    const infos = parseKiloModelInfos(data);
    if (infos.length === 0) return fallback;
    const status: KiloModelsStatus = {
      models: infos.map((m) => m.id),
      infos,
      ok: true,
    };
    kiloModelsCache.set(cacheKey(hasKey), { at: Date.now(), status });
    return status;
  } catch {
    return fallback;
  }
}

// ---- Error normalization ----

// Concise, actionable TUI errors. Never includes the API key, raw bodies, or
// HTTP dumps (callers truncate bodies before this point). `hasKey` selects
// the anonymous vs authenticated wording for 429s.
export function kiloErrorMessage(status: number, hasKey: boolean): string {
  switch (status) {
    case 401:
      return "Kilo: API key is invalid.";
    case 403:
      return "Kilo: access forbidden for this model or key.";
    case 404:
      return "Kilo: model is unavailable.";
    case 429:
      return hasKey
        ? "Kilo: rate limit reached — wait a moment, then resend."
        : "Kilo: anonymous free-model rate limit reached.";
    case 500:
    case 502:
    case 503:
    case 504:
      return "Kilo: gateway temporarily unavailable.";
    default:
      return `Kilo: request failed (HTTP ${status}).`;
  }
}

// Reframe a chat-POST failure thrown by the shared OpenAI-chat path
// (`Kilo HTTP {status}: ...`) into the normalized message above, preserving
// non-HTTP failures (network throws, truncation, empty replies) for their
// own handling. Never throws; unknown shapes pass through untouched.
export function normalizeKiloChatError(error: unknown, apiKey: string): unknown {
  if (!(error instanceof Error)) return error;
  const m = /^Kilo HTTP (\d+):/.exec(error.message);
  if (!m) return error;
  const status = Number(m[1]);
  if (!Number.isFinite(status)) return error;
  return new Error(kiloErrorMessage(status, apiKey.length > 0));
}

// Human drift-guard for the TUI: connection-level failures (no HTTP status
// at all) get the gateway wording instead of a bare fetch throw.
export function kiloNetworkErrorMessage(): string {
  return "Kilo: gateway temporarily unavailable.";
}
