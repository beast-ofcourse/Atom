// Subscription OAuth token refresh (src/token-refresh.ts): skew-window
// expiry, single-flight refresh per provider, rotated-token persistence
// into auth, expiry reporting, and the API-key-wins gating contract at the
// request-credential call site. refreshProviderOAuth is mocked — no
// network, no disk (setSubscriptionAuth/loadAuth helpers stay in memory).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  emptyAuth,
  getSubscriptionAuth,
  setStoredKey,
  setSubscriptionAuth,
  type AuthFile,
  type SubscriptionAuth,
} from "../src/auth.js";
import { refreshProviderOAuth, type ProviderOAuthTokens } from "../src/provider-oauth.js";
import {
  isExpiringSoon,
  refreshIfNeeded,
  resolveRequestCredential,
  TOKEN_REFRESH_SKEW_SECONDS,
} from "../src/token-refresh.js";

vi.mock("../src/provider-oauth.js", () => ({
  refreshProviderOAuth: vi.fn(),
}));

const refreshMock = vi.mocked(refreshProviderOAuth);

const PROVIDER = "openai" as const;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function oauthAuth(subscription: Partial<SubscriptionAuth>): AuthFile {
  return setSubscriptionAuth(emptyAuth(), PROVIDER, {
    type: "oauth",
    accessToken: "access-1",
    ...subscription,
  });
}

function storedSubscription(auth: AuthFile): SubscriptionAuth {
  const subscription = getSubscriptionAuth(auth, PROVIDER);
  if (!subscription) throw new Error("expected a stored subscription");
  return subscription;
}

// Neutralize any ambient OPENAI_API_KEY so resolveApiKey cannot hand the
// gate an env key and mask the subscription path under test.
beforeEach(() => {
  refreshMock.mockReset();
  vi.stubEnv("OPENAI_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isExpiringSoon", () => {
  test("no expiresAt never expires; within the skew window does", () => {
    expect(isExpiringSoon({ type: "oauth", accessToken: "a" })).toBe(false);
    expect(
      isExpiringSoon({
        type: "oauth",
        accessToken: "a",
        expiresAt: nowSeconds() + TOKEN_REFRESH_SKEW_SECONDS - 1,
      })
    ).toBe(true);
    expect(
      isExpiringSoon({
        type: "oauth",
        accessToken: "a",
        expiresAt: nowSeconds() + TOKEN_REFRESH_SKEW_SECONDS + 60,
      })
    ).toBe(false);
  });
});

describe("refreshIfNeeded", () => {
  test("a token outside the skew window is a no-op — refresh never called", async () => {
    const fresh = oauthAuth({ refreshToken: "refresh-1", expiresAt: nowSeconds() + 3600 });
    const noExpiry = oauthAuth({ refreshToken: "refresh-1" });
    for (const auth of [fresh, noExpiry]) {
      const result = await refreshIfNeeded(PROVIDER, auth);
      expect(result.expired).toBeFalsy();
      expect(result.refreshed).toBe(false);
      expect(result.auth).toBe(auth);
    }
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("expiring token with a refresh token rotates the subscription once", async () => {
    const auth = oauthAuth({
      refreshToken: "refresh-1",
      expiresAt: nowSeconds() + 60,
      accountId: "acct-42",
      plan: "team",
    });
    const expiresAt = nowSeconds() + 7200;
    refreshMock.mockResolvedValue({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt,
    });

    const result = await refreshIfNeeded(PROVIDER, auth);

    expect(result.expired).toBeFalsy();
    expect(result.refreshed).toBe(true);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith(PROVIDER, "refresh-1");
    expect(getSubscriptionAuth(result.auth, PROVIDER)).toEqual({
      type: "oauth",
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt,
      accountId: "acct-42",
      plan: "team",
    });
    // The input auth is never mutated — refresh returns a new AuthFile.
    expect(storedSubscription(auth).accessToken).toBe("access-1");
  });

  test("a server that omits the refresh token keeps the stored one", async () => {
    const auth = oauthAuth({ refreshToken: "refresh-1", expiresAt: nowSeconds() + 60 });
    refreshMock.mockResolvedValue({ accessToken: "access-2" });

    const result = await refreshIfNeeded(PROVIDER, auth);

    expect(result.refreshed).toBe(true);
    expect(storedSubscription(result.auth).refreshToken).toBe("refresh-1");
  });

  test("concurrent callers share one in-flight refresh grant", async () => {
    const auth = oauthAuth({ refreshToken: "refresh-1", expiresAt: nowSeconds() + 60 });
    let grant!: (tokens: ProviderOAuthTokens) => void;
    refreshMock.mockReturnValue(
      new Promise<ProviderOAuthTokens>((resolve) => {
        grant = resolve;
      })
    );

    const first = refreshIfNeeded(PROVIDER, auth);
    const second = refreshIfNeeded(PROVIDER, auth);
    expect(refreshMock).toHaveBeenCalledTimes(1);

    grant({ accessToken: "access-2", expiresAt: nowSeconds() + 7200 });
    const [a, b] = await Promise.all([first, second]);
    expect(a.refreshed).toBe(true);
    expect(b.refreshed).toBe(true);
    expect(storedSubscription(a.auth).accessToken).toBe("access-2");
    expect(storedSubscription(b.auth).accessToken).toBe("access-2");
  });

  test("a failed grant reports expired with the reason and leaves auth unchanged", async () => {
    const auth = oauthAuth({ refreshToken: "refresh-1", expiresAt: nowSeconds() + 60 });
    refreshMock.mockRejectedValue(
      new Error("refresh grant failed: HTTP 401 invalid_grant")
    );

    const result = await refreshIfNeeded(PROVIDER, auth);

    expect(result.expired).toBe(true);
    if (!result.expired) throw new Error("expected the refresh to report expired");
    expect(result.refreshed).toBe(false);
    expect(result.reason).toBe("refresh grant failed: HTTP 401 invalid_grant");
    expect(result.auth).toBe(auth);
  });

  test("an expiring token with no refresh token reports expired without a network call", async () => {
    const auth = oauthAuth({ expiresAt: nowSeconds() + 60 });

    const result = await refreshIfNeeded(PROVIDER, auth);

    expect(result.expired).toBe(true);
    if (!result.expired) throw new Error("expected the refresh to report expired");
    expect(result.reason).toBe("no refresh token stored");
    expect(result.auth).toBe(auth);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("non-oauth and missing subscriptions are no-ops", async () => {
    const apiKeySubscription = setSubscriptionAuth(emptyAuth(), PROVIDER, {
      type: "api-key",
      accessToken: "key-1",
      refreshToken: "refresh-1",
      expiresAt: nowSeconds() + 60,
    });
    for (const auth of [apiKeySubscription, emptyAuth()]) {
      const result = await refreshIfNeeded(PROVIDER, auth);
      expect(result.expired).toBeFalsy();
      expect(result.refreshed).toBe(false);
      expect(result.auth).toBe(auth);
    }
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe("resolveRequestCredential", () => {
  test("a stored API key wins: no refresh, no block, no subscription key", async () => {
    const auth = setStoredKey(
      oauthAuth({ refreshToken: "refresh-1", expiresAt: nowSeconds() + 60 }),
      PROVIDER,
      "sk-stored"
    );

    const credential = await resolveRequestCredential(PROVIDER, auth);

    expect(credential.status).toBe("usable");
    if (credential.status !== "usable") throw new Error("expected a usable credential");
    expect(credential.refreshed).toBe(false);
    expect(credential.subscriptionKey).toBe("");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("a fresh OAuth subscription supplies the request key without refreshing", async () => {
    const auth = oauthAuth({ expiresAt: nowSeconds() + 3600 });

    const credential = await resolveRequestCredential(PROVIDER, auth);

    expect(credential.status).toBe("usable");
    if (credential.status !== "usable") throw new Error("expected a usable credential");
    expect(credential.refreshed).toBe(false);
    expect(credential.subscriptionKey).toBe("access-1");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("an expiring OAuth subscription refreshes and supplies the new key", async () => {
    const auth = oauthAuth({ refreshToken: "refresh-1", expiresAt: nowSeconds() + 60 });
    refreshMock.mockResolvedValue({ accessToken: "access-2", expiresAt: nowSeconds() + 7200 });

    const credential = await resolveRequestCredential(PROVIDER, auth);

    expect(credential.status).toBe("usable");
    if (credential.status !== "usable") throw new Error("expected a usable credential");
    expect(credential.refreshed).toBe(true);
    expect(credential.subscriptionKey).toBe("access-2");
    expect(storedSubscription(credential.auth).accessToken).toBe("access-2");
  });

  test("an unusable OAuth subscription reports expired with the reason", async () => {
    const auth = oauthAuth({ expiresAt: nowSeconds() + 60 });

    const credential = await resolveRequestCredential(PROVIDER, auth);

    expect(credential.status).toBe("expired");
    if (credential.status !== "expired") throw new Error("expected an expired credential");
    expect(credential.reason).toBe("no refresh token stored");
  });

  test("no subscription yields a usable result with no subscription key", async () => {
    const credential = await resolveRequestCredential(PROVIDER, emptyAuth());

    expect(credential.status).toBe("usable");
    if (credential.status !== "usable") throw new Error("expected a usable credential");
    expect(credential.subscriptionKey).toBe("");
    expect(credential.refreshed).toBe(false);
  });
});
