// Subscription status tracking (Phase 2.5): fetch plan/usage for a logged-in
// provider subscription, compute the usage fraction, and derive limit
// warnings. Informational only — a failed fetch never blocks a login or a
// request, results are token-free, and the bearer token is only ever sent as
// an Authorization header (never logged, never part of a message).

import type { ProviderId } from "./providers.js";

/** Counted usage for one billing period; `unit` names what is counted. */
export type SubscriptionUsage = {
  used: number;
  limit: number;
  unit: string;
};

export type ProviderSubscriptionStatus = {
  plan?: string;
  accountId?: string;
  usage?: SubscriptionUsage;
  /** Next renewal, seconds since epoch. */
  renewsAt?: number;
};

export type SubscriptionStatusResult =
  | { ok: true; status: ProviderSubscriptionStatus }
  | { ok: false; error: string };

type ProviderStatusConfig = {
  statusEndpoint: string;
  envOverride: string;
};

// UNVERIFIED — override via ATOM_OPENAI_OAUTH_STATUS_URL; confirm against
// provider docs before relying on the default.
const OPENAI_STATUS_ENDPOINT = "https://api.openai.com/v1/organization/usage";

/** Providers with a subscription status endpoint. Extend as endpoints get verified. */
const PROVIDER_STATUS_ENDPOINTS: Partial<
  Record<ProviderId, ProviderStatusConfig>
> = {
  openai: {
    statusEndpoint: OPENAI_STATUS_ENDPOINT,
    envOverride: "ATOM_OPENAI_OAUTH_STATUS_URL",
  },
};

/** Abort a status fetch that has not answered within this window. */
export const STATUS_FETCH_TIMEOUT_MS = 8_000;

/** Fraction of the usage limit at which a warning is shown. */
export const USAGE_WARN_FRACTION = 0.9;

// In-memory status per provider for /login status display this process.
// Display-only: cleared on logout, refetched on the next login.
const statusByProvider = new Map<ProviderId, ProviderSubscriptionStatus>();

export function recordSubscriptionStatus(
  id: ProviderId,
  status: ProviderSubscriptionStatus
): void {
  statusByProvider.set(id, status);
}

export function getRecordedStatus(
  id: ProviderId
): ProviderSubscriptionStatus | undefined {
  return statusByProvider.get(id);
}

export function forgetSubscriptionStatus(id: ProviderId): void {
  statusByProvider.delete(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envValue(name: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : "";
}

/** Status URL for one provider (env override wins); undefined when unconfigured. */
function resolveStatusEndpoint(id: ProviderId): string | undefined {
  const config = PROVIDER_STATUS_ENDPOINTS[id];
  if (!config) return undefined;
  return envValue(config.envOverride) || config.statusEndpoint;
}

function pickString(
  source: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(
  source: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

// Single-record envelopes ({ data: {...} }, { subscription: {...} }).
// Anything else — lists, scalars, unknown shapes — is parsed as-is.
function unwrapPayload(raw: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["data", "subscription", "result"]) {
    const inner = raw[key];
    if (isRecord(inner)) return inner;
  }
  return raw;
}

const PLAN_KEYS = ["plan", "tier", "subscription_tier"] as const;
const ACCOUNT_ID_KEYS = ["account_id", "accountId"] as const;
const PERCENT_USED_KEYS = ["percent_used", "percentUsed"] as const;
const RENEWS_AT_KEYS = ["renews_at", "renewal_date", "period_end"] as const;

// Usage in either an explicit {used, limit, unit} triple (the contract shape
// our own adapters return) or the common {percent_used} form. Numbers may
// arrive as strings from JSON.
function parseUsage(
  payload: Record<string, unknown>
): SubscriptionUsage | undefined {
  const container = isRecord(payload["usage"]) ? payload["usage"] : payload;
  const used = pickNumber(container, ["used", "count", "consumed"]);
  const limit = pickNumber(container, ["limit", "max", "total"]);
  if (used !== undefined && limit !== undefined && limit > 0) {
    return { used, limit, unit: pickString(container, ["unit", "units"]) ?? "units" };
  }
  const percent =
    pickNumber(payload, PERCENT_USED_KEYS) ??
    pickNumber(container, PERCENT_USED_KEYS);
  if (percent !== undefined) return { used: percent, limit: 100, unit: "%" };
  return undefined;
}

// Renewal as epoch seconds: a numeric value is taken as seconds per the
// contract; an ISO date string is parsed. Unparseable → absent.
function parseRenewal(payload: Record<string, unknown>): number | undefined {
  for (const key of RENEWS_AT_KEYS) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    }
  }
  return undefined;
}

/**
 * Best-effort field-by-field parse of a status payload. Shape drift never
 * throws: unknown payloads yield an empty status (the caller treats that as
 * "nothing to display").
 */
export function parseSubscriptionStatus(
  raw: unknown
): ProviderSubscriptionStatus {
  if (!isRecord(raw)) return {};
  const payload = unwrapPayload(raw);
  const status: ProviderSubscriptionStatus = {};
  const plan = pickString(payload, PLAN_KEYS);
  if (plan) status.plan = plan;
  const accountId = pickString(payload, ACCOUNT_ID_KEYS);
  if (accountId) status.accountId = accountId;
  const usage = parseUsage(payload);
  if (usage) status.usage = usage;
  const renewsAt = parseRenewal(payload);
  if (renewsAt !== undefined) status.renewsAt = renewsAt;
  return status;
}

/** Fraction of the limit used (0..1+), undefined when no usable usage data. */
export function usageFraction(
  status: ProviderSubscriptionStatus
): number | undefined {
  const usage = status.usage;
  if (!usage || usage.limit <= 0) return undefined;
  return usage.used / usage.limit;
}

/**
 * Limit warnings for one provider: none below USAGE_WARN_FRACTION, an
 * approaching-limit line at or above it, a limit-reached line at or over 1.
 */
export function subscriptionWarnings(
  status: ProviderSubscriptionStatus,
  label: string
): string[] {
  const fraction = usageFraction(status);
  if (fraction === undefined) return [];
  const percent = Math.round(fraction * 100);
  if (fraction >= 1) {
    return [`${label} subscription: usage limit reached (${percent}%)`];
  }
  if (fraction >= USAGE_WARN_FRACTION) {
    return [`${label} subscription: ${percent}% of the usage limit used`];
  }
  return [];
}

export type SubscriptionStatusOptions = {
  /** Defaults to STATUS_FETCH_TIMEOUT_MS; tests pass a short one. */
  timeoutMs?: number;
};

/**
 * Fetch a provider's subscription status with the OAuth access token.
 * Never throws: transport errors, non-200s, and non-JSON bodies come back as
 * `{ok: false, error}` with a concise, token-free message.
 */
export async function fetchSubscriptionStatus(
  id: ProviderId,
  accessToken: string,
  opts: SubscriptionStatusOptions = {}
): Promise<SubscriptionStatusResult> {
  const endpoint = resolveStatusEndpoint(id);
  if (!endpoint) {
    return { ok: false, error: `status endpoint not configured for ${id}` };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? STATUS_FETCH_TIMEOUT_MS
  );
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `status request failed: HTTP ${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: "status endpoint returned a non-JSON response" };
    }
    return { ok: true, status: parseSubscriptionStatus(body) };
  } catch (e) {
    return {
      ok: false,
      error: `status request failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
