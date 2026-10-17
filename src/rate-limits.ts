// Rate limit awareness (Task 3.2): parse rate-limit headers from resolved
// model POSTs (fed by the provider-hooks after-response observer), keep the
// latest snapshot per provider, and surface a throttle warning once per
// limit window when remaining quota approaches zero. Observe-only — parsing
// never blocks a request and warnings never break a turn. Header values are
// counts and timestamps, never secrets; warning lines quote no header dump.

export type RateLimitSnapshot = {
  provider: string;
  /** Quota allowed in the window, when reported. */
  limit?: number;
  /** Quota left in the window, when reported. */
  remaining?: number;
  /** Window reset, seconds since epoch (best-effort parse). */
  resetAt?: number;
  /** Which header family supplied the numbers. */
  unit: "requests" | "tokens";
  /** When this snapshot was parsed, seconds since epoch. */
  observedAt: number;
};

/** Warn when remaining quota is at or below this fraction of the limit. */
export const RATE_LIMIT_WARN_FRACTION = 0.1;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parseCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

// Reset headers arrive as: epoch seconds (huge numbers), seconds until
// reset (small numbers), ISO-8601 datetimes (Anthropic), or Go durations
// like "6m0s" (OpenAI). Anything else stays unknown rather than guessed.
function parseReset(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    return asNumber > 1e9
      ? Math.floor(asNumber)
      : now + Math.max(0, Math.floor(asNumber));
  }
  const iso = Date.parse(trimmed);
  if (Number.isFinite(iso)) return Math.floor(iso / 1000);
  const duration = /^((\d+)h)?((\d+)m)?((\d+)s)?$/.exec(trimmed);
  if (duration && trimmed.length > 0 && duration.slice(1).some((g) => g !== undefined)) {
    const hours = Number(duration[2] ?? 0);
    const minutes = Number(duration[4] ?? 0);
    const seconds = Number(duration[6] ?? 0);
    return now + hours * 3600 + minutes * 60 + seconds;
  }
  return undefined;
}

type HeaderFamily = {
  unit: "requests" | "tokens";
  limit?: number;
  remaining?: number;
  reset?: number;
};

// Anthropic: anthropic-ratelimit-requests-limit/-remaining/-reset (ISO
// reset) and the input/output token equivalents.
function anthropicFamily(headers: Record<string, string>, now: number): HeaderFamily | undefined {
  const requests: HeaderFamily = {
    unit: "requests",
    limit: parseCount(headers["anthropic-ratelimit-requests-limit"]),
    remaining: parseCount(headers["anthropic-ratelimit-requests-remaining"]),
    reset: parseReset(headers["anthropic-ratelimit-requests-reset"], now),
  };
  if (requests.limit !== undefined || requests.remaining !== undefined) return requests;
  const tokens: HeaderFamily = {
    unit: "tokens",
    limit:
      parseCount(headers["anthropic-ratelimit-input-tokens-limit"]) ??
      parseCount(headers["anthropic-ratelimit-output-tokens-limit"]),
    remaining:
      parseCount(headers["anthropic-ratelimit-input-tokens-remaining"]) ??
      parseCount(headers["anthropic-ratelimit-output-tokens-remaining"]),
    reset:
      parseReset(headers["anthropic-ratelimit-input-tokens-reset"], now) ??
      parseReset(headers["anthropic-ratelimit-output-tokens-reset"], now),
  };
  if (tokens.limit !== undefined || tokens.remaining !== undefined) return tokens;
  return undefined;
}

// OpenAI (and compatible gateways): x-ratelimit-limit-requests /
// -remaining-requests / -reset-requests, with token twins.
function openAiFamily(headers: Record<string, string>, now: number): HeaderFamily | undefined {
  const requests: HeaderFamily = {
    unit: "requests",
    limit: parseCount(headers["x-ratelimit-limit-requests"]),
    remaining: parseCount(headers["x-ratelimit-remaining-requests"]),
    reset: parseReset(headers["x-ratelimit-reset-requests"], now),
  };
  if (requests.limit !== undefined || requests.remaining !== undefined) return requests;
  const tokens: HeaderFamily = {
    unit: "tokens",
    limit: parseCount(headers["x-ratelimit-limit-tokens"]),
    remaining: parseCount(headers["x-ratelimit-remaining-tokens"]),
    reset: parseReset(headers["x-ratelimit-reset-tokens"], now),
  };
  if (tokens.limit !== undefined || tokens.remaining !== undefined) return tokens;
  return undefined;
}

/**
 * Parse rate-limit headers from a response-header snapshot (lower-cased
 * keys tolerated either way). Returns undefined when the response carries
 * no recognized quota header — unknown shapes are simply "no data".
 */
export function parseRateLimitHeaders(
  provider: string,
  rawHeaders: Record<string, string>,
  at: number = nowSeconds()
): RateLimitSnapshot | undefined {
  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === "string") headers[key.toLowerCase()] = value;
    }
    const family = anthropicFamily(headers, at) ?? openAiFamily(headers, at);
    if (!family) return undefined;
    const snapshot: RateLimitSnapshot = {
      provider,
      unit: family.unit,
      observedAt: at,
    };
    if (family.limit !== undefined) snapshot.limit = family.limit;
    if (family.remaining !== undefined) snapshot.remaining = family.remaining;
    if (family.reset !== undefined) snapshot.resetAt = family.reset;
    return snapshot;
  } catch {
    return undefined;
  }
}

/**
 * The throttle warning for a snapshot, or null when quota is healthy or
 * the snapshot lacks the counts needed to judge. Quotes no header values
 * beyond the parsed numbers.
 */
export function rateLimitWarning(
  snapshot: RateLimitSnapshot,
  at: number = nowSeconds()
): string | null {
  const { limit, remaining } = snapshot;
  if (limit === undefined || remaining === undefined || limit <= 0) return null;
  const fraction = remaining / limit;
  if (fraction > RATE_LIMIT_WARN_FRACTION) return null;
  const reset =
    snapshot.resetAt !== undefined && snapshot.resetAt > at
      ? ` — resets in ${Math.max(1, Math.ceil((snapshot.resetAt - at) / 60))}m`
      : "";
  const quota = `${remaining} of ${limit} ${snapshot.unit}`;
  return fraction <= 0
    ? `${snapshot.provider}: rate limit reached (${quota} left${reset})`
    : `${snapshot.provider}: rate limit approaching — ${quota} left${reset}`;
}

// Latest snapshot per provider (surfaceable state; observe-only).
const snapshotByProvider = new Map<string, RateLimitSnapshot>();

export function recordRateLimit(snapshot: RateLimitSnapshot): void {
  snapshotByProvider.set(snapshot.provider, snapshot);
}

export function getRateLimit(provider: string): RateLimitSnapshot | undefined {
  return snapshotByProvider.get(provider);
}

export function forgetRateLimit(provider: string): void {
  snapshotByProvider.delete(provider);
}

// Providers already warned for a given reset window (marker = resetAt, 0
// when the headers carry no reset) — one warning per window, not per POST.
const warnedWindows = new Map<string, number>();

/**
 * The next warning to show for this snapshot, deduped per reset window:
 * the first crossing warns, repeats of the same window do not, and a
 * healthy snapshot re-arms the provider for the next crossing.
 */
export function nextRateLimitWarning(
  snapshot: RateLimitSnapshot,
  at: number = nowSeconds()
): string | null {
  const warning = rateLimitWarning(snapshot, at);
  if (!warning) {
    warnedWindows.delete(snapshot.provider);
    return null;
  }
  const marker = snapshot.resetAt ?? 0;
  if (warnedWindows.get(snapshot.provider) === marker) return null;
  warnedWindows.set(snapshot.provider, marker);
  return warning;
}

/** Test seam: drop snapshots and warning dedupe state. */
export function clearRateLimitState(): void {
  snapshotByProvider.clear();
  warnedWindows.clear();
}
