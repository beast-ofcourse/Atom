// Local LLM auto-discovery: Ollama, LM Studio, llama.cpp (llama-server).
//
// On startup ATOM probes the three standard local endpoints in parallel
// with short timeouts, normalizes whatever models each runtime exposes,
// and hands the lists to the existing provider/model registry — local
// models then ride the normal openai-chat path (chatCompletionForProvider
// + runLoopWithChat), never a parallel agent implementation.
//
// Endpoint facts (verified 2026-09-09 against ollama/ollama + llama.cpp docs):
// - Ollama: native GET {base}/api/tags -> {models:[{name,model,size,digest,
//   details:{format,family,families,parameter_size,quantization_level}}]};
//   OpenAI-compatible {base}/v1/chat/completions (streaming, tools, vision,
//   reasoning) + {base}/v1/models as fallback listing. api_key ignored.
// - LM Studio: OpenAI-compatible {base}/v1/models -> {data:[{id,...}]}.
// - llama-server: GET {base}/v1/models -> {object:"list",data:[{id,
//   owned_by:"llamacpp",meta:{...n_ctx_train...}|null}]} — always a single
//   element (the loaded model); id defaults to the model file path unless
//   --alias is set. Bearer auth accepted-and-ignored.
//
// Honesty rules: capabilities stay unknown (undefined) unless a response
// exposes them (llama-server meta.n_ctx_train -> contextLength). Nothing is
// fabricated. Unreachable/malformed servers yield ok:false, never throw —
// discovery failures are isolated per provider and silent by default (the
// TUI surfaces them only via /models).
//
// Concurrency: createLocalDiscovery() owns one in-flight promise per scope
// ("all" or one provider id), so overlapping refresh calls share work and
// never race the snapshot. Results live in memory only — refresh
// re-discovers, disappeared servers flip to ok:false with empty models.

import {
  getProvider,
  LOCAL_PROVIDER_IDS,
  normalizeBaseURL,
  type LocalProviderId,
} from "./providers.js";

export type { LocalProviderId };

// Capabilities a runtime exposes about a model. Every field is optional:
// absent means unknown, never assumed.
export type LocalCapabilities = {
  streaming?: boolean;
  toolCalling?: boolean;
  vision?: boolean;
  contextLength?: number;
  reasoning?: boolean;
};

export type DiscoveredModel = {
  id: string;
  sizeBytes?: number;
  family?: string;
  parameterSize?: string;
  contextLength?: number;
  capabilities: LocalCapabilities;
};

export type LocalDiscoveryResult = {
  provider: LocalProviderId;
  baseURL: string;
  ok: boolean;
  models: DiscoveredModel[];
  error?: string;
};

export type LocalSnapshot = {
  results: Record<LocalProviderId, LocalDiscoveryResult>;
  version: number;
};

// Short by design: a dead local server must not delay startup.
export const DISCOVERY_TIMEOUT_MS = 2000;

export type FetchImpl = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export type DiscoveryDeps = {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  // Explicit base override (tests, or a future stored value). Otherwise the
  // provider's env override wins, else its loopback default.
  baseURL?: string;
};

export function discoveryBaseURL(
  provider: LocalProviderId,
  override?: string
): string {
  const stored = (override ?? "").trim();
  if (stored) return normalizeBaseURL(stored);
  const def = getProvider(provider);
  const envVar = def?.local?.baseURLEnvVar;
  const fromEnv = envVar ? (process.env[envVar] ?? "").trim() : "";
  if (fromEnv) return normalizeBaseURL(fromEnv);
  return def?.local?.defaultBaseURL ?? "";
}

function initialResult(provider: LocalProviderId): LocalDiscoveryResult {
  return {
    provider,
    baseURL: discoveryBaseURL(provider),
    ok: false,
    models: [],
  };
}

export function emptyLocalSnapshot(): LocalSnapshot {
  return {
    results: {
      ollama: initialResult("ollama"),
      lmstudio: initialResult("lmstudio"),
      llamacpp: initialResult("llamacpp"),
    },
    version: 0,
  };
}

// One-line human summary for /models output (counts only, no transcript spam).
export function summarizeLocalSnapshot(snap: LocalSnapshot): string {
  const parts = LOCAL_PROVIDER_IDS.map((id) => {
    const r = snap.results[id];
    const name = getProvider(id)?.name ?? id;
    if (!r.ok) return `${name}: unavailable`;
    return `${name}: ${r.models.length} model${r.models.length === 1 ? "" : "s"}`;
  });
  return `local models — ${parts.join(" · ")}`;
}

// ---- HTTP plumbing (short timeout, never hangs) ---------------------------

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    const withTimeout = AbortSignal as unknown as {
      timeout?: (ms: number) => AbortSignal;
    };
    if (typeof withTimeout.timeout === "function") return withTimeout.timeout(ms);
  } catch {
    // fall through: no timeout support, plain fetch
  }
  return undefined;
}

async function fetchJson(url: string, deps: DiscoveryDeps): Promise<unknown> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const signal = timeoutSignal(timeoutMs);
  let res: Response;
  try {
    if (signal) {
      res = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal,
      });
    } else {
      // No AbortSignal.timeout on this runtime: manual race so a dead
      // server still cannot hang discovery past the timeout.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        res = await Promise.race([
          fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } }),
          new Promise<Response>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "fetch failed");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new Error("invalid JSON");
  }
}

// ---- Pure response parsers (null = unusable shape) -------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function modelIdOf(entry: unknown): string | null {
  if (typeof entry === "string") return entry || null;
  const o = asRecord(entry);
  if (!o) return null;
  const id = o["id"] ?? o["name"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

// Ollama native listing: {models:[{name|model,size,details:{...}}]}.
export function parseOllamaTagsPayload(data: unknown): DiscoveredModel[] | null {
  try {
    const o = asRecord(data);
    const list = o?.["models"];
    if (!Array.isArray(list)) return null;
    const out: DiscoveredModel[] = [];
    for (const entry of list) {
      const r = asRecord(entry);
      const raw = r ? (r["name"] ?? r["model"]) : null;
      if (typeof raw !== "string" || raw.length === 0) continue;
      const m: DiscoveredModel = { id: raw, capabilities: {} };
      const size = r ? finiteNumber(r["size"]) : undefined;
      if (size !== undefined && size > 0) m.sizeBytes = size;
      const details = r ? asRecord(r["details"]) : null;
      if (details) {
        const family = details["family"];
        if (typeof family === "string" && family.length > 0) m.family = family;
        const params = details["parameter_size"];
        if (typeof params === "string" && params.length > 0) m.parameterSize = params;
      }
      out.push(m);
    }
    return out;
  } catch {
    return null;
  }
}

// OpenAI-shape listing: {data:[{id,meta?}]}. Used by LM Studio, llama-server,
// and as the Ollama fallback. llama-server meta.n_ctx_train (when a finite
// number) becomes contextLength; everything else stays unknown.
export function parseOpenAIModelsPayload(data: unknown): DiscoveredModel[] | null {
  try {
    const o = asRecord(data);
    const list = o?.["data"];
    if (!Array.isArray(list)) return null;
    const out: DiscoveredModel[] = [];
    for (const entry of list) {
      const id = modelIdOf(entry);
      if (!id) continue;
      const m: DiscoveredModel = { id, capabilities: {} };
      const meta = asRecord(entry) ? asRecord((asRecord(entry) as Record<string, unknown>)["meta"]) : null;
      const nCtx = meta ? finiteNumber(meta["n_ctx_train"]) : undefined;
      if (nCtx !== undefined && nCtx > 0) {
        m.contextLength = Math.floor(nCtx);
        m.capabilities = { ...m.capabilities, contextLength: Math.floor(nCtx) };
      }
      out.push(m);
    }
    return out;
  } catch {
    return null;
  }
}

// ---- Per-runtime discoverers (never throw) ----------------------------------

function fail(provider: LocalProviderId, baseURL: string, error: string): LocalDiscoveryResult {
  return { provider, baseURL, ok: false, models: [], error };
}

export async function discoverOllama(
  deps: DiscoveryDeps = {}
): Promise<LocalDiscoveryResult> {
  const baseURL = discoveryBaseURL("ollama", deps.baseURL);
  if (!baseURL) return fail("ollama", "", "no base URL");
  try {
    const tags = await fetchJson(`${baseURL}/api/tags`, deps);
    const parsed = parseOllamaTagsPayload(tags);
    if (parsed !== null) return { provider: "ollama", baseURL, ok: true, models: parsed };
  } catch {
    // fall through to the OpenAI-compatible listing
  }
  try {
    const compat = await fetchJson(`${baseURL}/v1/models`, deps);
    const parsed = parseOpenAIModelsPayload(compat);
    if (parsed !== null) return { provider: "ollama", baseURL, ok: true, models: parsed };
    return fail("ollama", baseURL, "malformed response");
  } catch (e) {
    return fail("ollama", baseURL, e instanceof Error ? e.message : "fetch failed");
  }
}

async function discoverOpenAICompatible(
  provider: LocalProviderId,
  deps: DiscoveryDeps = {}
): Promise<LocalDiscoveryResult> {
  const baseURL = discoveryBaseURL(provider, deps.baseURL);
  if (!baseURL) return fail(provider, "", "no base URL");
  try {
    const data = await fetchJson(`${baseURL}/v1/models`, deps);
    const parsed = parseOpenAIModelsPayload(data);
    if (parsed === null) return fail(provider, baseURL, "malformed response");
    return { provider, baseURL, ok: true, models: parsed };
  } catch (e) {
    return fail(provider, baseURL, e instanceof Error ? e.message : "fetch failed");
  }
}

export async function discoverLMStudio(
  deps: DiscoveryDeps = {}
): Promise<LocalDiscoveryResult> {
  return discoverOpenAICompatible("lmstudio", deps);
}

export async function discoverLlamaCpp(
  deps: DiscoveryDeps = {}
): Promise<LocalDiscoveryResult> {
  return discoverOpenAICompatible("llamacpp", deps);
}

export async function discoverLocalProvider(
  provider: LocalProviderId,
  deps: DiscoveryDeps = {}
): Promise<LocalDiscoveryResult> {
  try {
    if (provider === "ollama") return await discoverOllama(deps);
    if (provider === "lmstudio") return await discoverLMStudio(deps);
    return await discoverLlamaCpp(deps);
  } catch (e) {
    return fail(provider, discoveryBaseURL(provider, deps.baseURL), e instanceof Error ? e.message : "fetch failed");
  }
}

// ---- Discovery lifecycle (in-memory cache, deduped refresh) -----------------

export type LocalDiscovery = {
  snapshot(): LocalSnapshot;
  refresh(provider?: LocalProviderId): Promise<LocalSnapshot>;
};

export function createLocalDiscovery(
  deps: DiscoveryDeps = {}
): LocalDiscovery {
  let snap: LocalSnapshot = emptyLocalSnapshot();
  const inFlight = new Map<string, Promise<LocalSnapshot>>();

  const runAll = async (): Promise<LocalSnapshot> => {
    const [ollama, lmstudio, llamacpp] = await Promise.all([
      discoverLocalProvider("ollama", deps),
      discoverLocalProvider("lmstudio", deps),
      discoverLocalProvider("llamacpp", deps),
    ]);
    snap = {
      results: { ollama, lmstudio, llamacpp },
      version: snap.version + 1,
    };
    return snap;
  };

  const runOne = async (provider: LocalProviderId): Promise<LocalSnapshot> => {
    const res = await discoverLocalProvider(provider, deps);
    snap = {
      results: { ...snap.results, [provider]: res },
      version: snap.version + 1,
    };
    return snap;
  };

  return {
    snapshot: () => snap,
    refresh: (provider?: LocalProviderId) => {
      const key = provider ?? "all";
      const existing = inFlight.get(key);
      if (existing) return existing;
      const p = (provider ? runOne(provider) : runAll()).finally(() => {
        if (inFlight.get(key) === p) inFlight.delete(key);
      });
      inFlight.set(key, p);
      return p;
    },
  };
}
