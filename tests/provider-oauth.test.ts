// Provider subscription OAuth flow (src/provider-oauth.ts): authorize-URL
// construction, env overrides, token parsing, error surfacing, refresh.
// Hermetic by construction: fetch is mocked and the loopback callback is a
// socket-free stub — no real browser, no real port.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SubscriptionAuth } from "../src/auth.js";
import type { ProviderOAuthTokens } from "../src/provider-oauth.js";
import {
  PROVIDER_OAUTH,
  ProviderOAuthError,
  refreshProviderOAuth,
  resolveProviderOAuthConfig,
  runProviderLoginOAuth,
  type ProviderOAuthCallback,
} from "../src/provider-oauth.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function signedJwt(claims: Record<string, unknown>): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.test-signature`;
}

type StubCallback = {
  callback: ProviderOAuthCallback;
  stateSeen: () => string | undefined;
  closed: () => boolean;
};

function stubCallback(code: string): StubCallback {
  let seenState: string | undefined;
  let closed = false;
  return {
    callback: {
      redirectUri: "http://127.0.0.1:54321/callback",
      waitForCode: async (state: string, _timeoutMs: number): Promise<string> => {
        seenState = state;
        return code;
      },
      close: async (): Promise<void> => {
        closed = true;
      },
    },
    stateSeen: () => seenState,
    closed: () => closed,
  };
}

type LoginAttempt = {
  authorizeUrl: string;
  outcome: { tokens: ProviderOAuthTokens } | { failure: Error };
  stub: StubCallback;
  fetchMock: ReturnType<typeof makeFetchMock>;
};

function makeFetchMock(tokenBody: unknown, tokenStatus = 200) {
  return vi.fn((_url: string, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(jsonResponse(tokenBody, tokenStatus))
  );
}

// Drive one full login attempt with a stubbed callback + mocked fetch,
// returning the captured authorize URL and the success or failure outcome.
async function attemptLogin(
  tokenBody: unknown,
  tokenStatus = 200
): Promise<LoginAttempt> {
  const stub = stubCallback("auth-code-1");
  const fetchMock = makeFetchMock(tokenBody, tokenStatus);
  vi.stubGlobal("fetch", fetchMock);
  let authorizeUrl = "";
  const outcome = await runProviderLoginOAuth("openai", {
    startCallback: async () => stub.callback,
    openBrowser: false,
    onAuthorizeUrl: (url) => {
      authorizeUrl = url;
    },
  }).then(
    (tokens): LoginAttempt["outcome"] => ({ tokens }),
    (error: unknown): LoginAttempt["outcome"] => ({
      failure: error instanceof Error ? error : new Error(String(error)),
    })
  );
  return { authorizeUrl, outcome, stub, fetchMock };
}

function tokensOf(attempt: LoginAttempt): ProviderOAuthTokens {
  if ("failure" in attempt.outcome) throw attempt.outcome.failure;
  return attempt.outcome.tokens;
}

function failureOf(attempt: LoginAttempt): Error {
  if ("failure" in attempt.outcome) return attempt.outcome.failure;
  throw new Error("expected the login attempt to fail, but it succeeded");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("provider OAuth login", () => {
  test("authorize URL carries client_id, PKCE challenge, state, redirect_uri and scopes", async () => {
    const config = resolveProviderOAuthConfig("openai");
    if (!config) throw new Error("openai OAuth config missing");
    const attempt = await attemptLogin({
      access_token: "access-1",
      expires_in: 60,
    });
    expect(tokensOf(attempt).accessToken).toBe("access-1");
    expect(attempt.stub.closed()).toBe(true);
    const url = new URL(attempt.authorizeUrl);
    expect(url.origin + url.pathname).toBe(config.authorizationEndpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(attempt.stub.callback.redirectUri);
    expect(url.searchParams.get("scope")).toBe(config.scopes);
    expect(url.searchParams.get("state")).toBe(attempt.stub.stateSeen());
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = url.searchParams.get("code_challenge");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  test("env overrides win over the table constants", async () => {
    vi.stubEnv("ATOM_OPENAI_OAUTH_CLIENT_ID", "env-client-9");
    vi.stubEnv("ATOM_OPENAI_OAUTH_AUTH_URL", "https://env.example/authorize");
    vi.stubEnv("ATOM_OPENAI_OAUTH_TOKEN_URL", "https://env.example/token");
    const config = resolveProviderOAuthConfig("openai");
    if (!config) throw new Error("openai OAuth config missing");
    expect(config.clientId).toBe("env-client-9");
    expect(config.authorizationEndpoint).toBe("https://env.example/authorize");
    expect(config.tokenEndpoint).toBe("https://env.example/token");
    expect(PROVIDER_OAUTH.openai?.clientId).not.toBe("env-client-9");

    const attempt = await attemptLogin({ access_token: "access-env" });
    expect(tokensOf(attempt).accessToken).toBe("access-env");
    const url = new URL(attempt.authorizeUrl);
    expect(url.origin).toBe("https://env.example");
    expect(url.searchParams.get("client_id")).toBe("env-client-9");
    expect(attempt.fetchMock.mock.calls[0]?.[0]).toBe("https://env.example/token");
  });

  test("token exchange parses into the SubscriptionAuth shape with unix-seconds expiresAt", async () => {
    const idToken = signedJwt({ account_id: "acct-42", plan: "team" });
    const attempt = await attemptLogin({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      id_token: idToken,
    });
    const tokens = tokensOf(attempt);
    expect(attempt.stub.closed()).toBe(true);
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(nowSeconds + 3590);
    expect(tokens.expiresAt).toBeLessThanOrEqual(nowSeconds + 3600);
    expect(tokens.accountId).toBe("acct-42");
    expect(tokens.plan).toBe("team");
    const subscription: SubscriptionAuth = { type: "oauth", ...tokens };
    expect(subscription).toEqual({
      type: "oauth",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: tokens.expiresAt,
      accountId: "acct-42",
      plan: "team",
    });
  });

  test("a cancelled authorization (access_denied) reports a plain reason", async () => {
    const callback: ProviderOAuthCallback = {
      redirectUri: "http://127.0.0.1:54321/callback",
      waitForCode: () =>
        Promise.reject(new Error("Authorization failed: access_denied")),
      close: async (): Promise<void> => {},
    };
    const failure: unknown = await runProviderLoginOAuth("openai", {
      startCallback: async () => callback,
      openBrowser: false,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProviderOAuthError);
    if (!(failure instanceof Error)) throw new Error("expected an Error");
    expect(failure.message).toBe("authorization was cancelled");
  });

  test("a non-200 token exchange fails concisely without leaking the body's tokens", async () => {
    const attempt = await attemptLogin(
      {
        error: "invalid_grant",
        error_description: "authorization code expired",
        access_token: "SECRET-TOKEN-IN-BODY",
      },
      400
    );
    const failure = failureOf(attempt);
    expect(failure).toBeInstanceOf(ProviderOAuthError);
    expect(failure.message).toContain("token exchange failed: HTTP 400");
    expect(failure.message).toContain("authorization code expired");
    expect(failure.message).not.toContain("SECRET-TOKEN-IN-BODY");
  });

  test("refresh returns rotated tokens and posts the refresh grant", async () => {
    const config = resolveProviderOAuthConfig("openai");
    if (!config) throw new Error("openai OAuth config missing");
    const fetchMock = makeFetchMock({
      access_token: "access-2",
      refresh_token: "refresh-2",
      expires_in: 7200,
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshProviderOAuth("openai", "refresh-old");
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(tokens.accessToken).toBe("access-2");
    expect(tokens.refreshToken).toBe("refresh-2");
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(nowSeconds + 7190);
    expect(tokens.expiresAt).toBeLessThanOrEqual(nowSeconds + 7200);

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(config.tokenEndpoint);
    const body = call?.[1]?.body;
    if (typeof body !== "string") throw new Error("expected a form-encoded body");
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-old");
    expect(params.get("client_id")).toBe(config.clientId);
  });
});
