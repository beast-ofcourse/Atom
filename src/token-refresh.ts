// Subscription OAuth token refresh (Phase 2.4): keep an expiring OAuth
// subscription access token alive before a chat POST, and report expiry so
// the caller fails fast with a re-login line instead of sending a dead
// token. Refresh results carry no token values; failure reasons come from
// ProviderOAuthError, which is token-free by contract.

import {
  getSubscriptionAuth,
  resolveApiKey,
  setSubscriptionAuth,
  type AuthFile,
  type SubscriptionAuth,
} from "./auth.js";
import { refreshProviderOAuth, type ProviderOAuthTokens } from "./provider-oauth.js";
import type { ProviderId } from "./providers.js";

/** Refresh this many seconds before `expiresAt` — network/clock slack. */
export const TOKEN_REFRESH_SKEW_SECONDS = 300;

/** True when the token exists and expires within `skewSeconds` (or already did). */
export function isExpiringSoon(
  subscription: SubscriptionAuth,
  skewSeconds: number = TOKEN_REFRESH_SKEW_SECONDS
): boolean {
  return (
    subscription.expiresAt !== undefined &&
    Math.floor(Date.now() / 1000) + skewSeconds >= subscription.expiresAt
  );
}

export type RefreshResult =
  | { auth: AuthFile; refreshed: boolean; expired?: false }
  | { auth: AuthFile; refreshed: false; expired: true; reason: string };

// Single-flight map: parallel tool calls must stampede the refresh endpoint
// at most once per provider. Entry is removed as soon as the grant settles.
const inFlightRefreshes = new Map<ProviderId, Promise<ProviderOAuthTokens>>();

function refreshOnce(
  id: ProviderId,
  refreshToken: string
): Promise<ProviderOAuthTokens> {
  const inFlight = inFlightRefreshes.get(id);
  if (inFlight) return inFlight;
  const started = refreshProviderOAuth(id, refreshToken);
  inFlightRefreshes.set(id, started);
  const settle = (): void => {
    if (inFlightRefreshes.get(id) === started) inFlightRefreshes.delete(id);
  };
  // Attaches a rejection handler so a failed grant never becomes an
  // unhandled rejection when every caller has already gone away.
  started.then(settle, settle);
  return started;
}

// Rotated subscription: server-issued refresh token wins, else the stored
// one is kept (providers may omit it). The old expiresAt described the
// rotated-away token, so it is dropped when the server reports no new
// expiry — an unknown expiry matches the login path: no auto-refresh.
function rotatedSubscription(
  previous: SubscriptionAuth,
  tokens: ProviderOAuthTokens
): SubscriptionAuth {
  const next: SubscriptionAuth = { type: "oauth", accessToken: tokens.accessToken };
  const refreshToken = tokens.refreshToken ?? previous.refreshToken;
  if (refreshToken) next.refreshToken = refreshToken;
  if (tokens.expiresAt !== undefined) next.expiresAt = tokens.expiresAt;
  if (previous.accountId) next.accountId = previous.accountId;
  if (previous.plan) next.plan = previous.plan;
  return next;
}

/**
 * Refresh a provider's OAuth subscription when it is expiring soon.
 * No-op (not expired) without a subscription, without `type: "oauth"`,
 * or outside the skew window. An expiring token with no refresh token —
 * or a failed grant — reports `expired` with a concise, token-free reason
 * and leaves `auth` untouched.
 */
export async function refreshIfNeeded(
  id: ProviderId,
  auth: AuthFile
): Promise<RefreshResult> {
  const subscription = getSubscriptionAuth(auth, id);
  if (!subscription || subscription.type !== "oauth") return { auth, refreshed: false };
  if (!isExpiringSoon(subscription)) return { auth, refreshed: false };
  if (!subscription.refreshToken) {
    return {
      auth,
      refreshed: false,
      expired: true,
      reason: "no refresh token stored",
    };
  }
  try {
    const tokens = await refreshOnce(id, subscription.refreshToken);
    const next = setSubscriptionAuth(
      auth,
      id,
      rotatedSubscription(subscription, tokens)
    );
    return { auth: next, refreshed: true };
  } catch (e) {
    return {
      auth,
      refreshed: false,
      expired: true,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export type RequestCredential =
  | {
      status: "usable";
      auth: AuthFile;
      refreshed: boolean;
      /** Request key from the OAuth subscription; "" when none supplies it. */
      subscriptionKey: string;
    }
  | { status: "expired"; reason: string };

/**
 * Pre-POST credential gate for one provider. The OAuth subscription
 * supplies the request key only when no API key resolves first (env wins,
 * then stored — resolveApiKey). When an API key resolves, this never
 * refreshes and never blocks. Otherwise the subscription key is returned,
 * refreshed first when expiring, or reported expired when no usable token
 * remains.
 */
export async function resolveRequestCredential(
  id: ProviderId,
  auth: AuthFile
): Promise<RequestCredential> {
  if (resolveApiKey(id, auth).length > 0) {
    return { status: "usable", auth, refreshed: false, subscriptionKey: "" };
  }
  const refresh = await refreshIfNeeded(id, auth);
  if (refresh.expired) return { status: "expired", reason: refresh.reason };
  const subscription = getSubscriptionAuth(refresh.auth, id);
  return {
    status: "usable",
    auth: refresh.auth,
    refreshed: refresh.refreshed,
    // Only type "oauth" subscriptions are produced by the login flow today.
    subscriptionKey: subscription?.type === "oauth" ? subscription.accessToken : "",
  };
}
