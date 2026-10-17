// Provider subscription OAuth login ("OAuth flow, OpenAI first").
// PKCE authorize + loopback callback reuse src/mcp/oauth.ts primitives;
// the code exchange and refresh grant talk to the provider's token
// endpoint with form-encoded fetch. This module returns tokens — the
// caller persists them encrypted via auth-v2 (setSubscriptionAuth/saveAuth).
// Token values never reach logs or user-facing messages.

import { createHash, randomBytes } from "node:crypto";
import {
  base64Url,
  buildAuthorizeUrl,
  openBrowser,
  refreshTokens,
  startCallbackServer,
} from "./mcp/oauth.js";
import type { ProviderId } from "./providers.js";

/** Env-var names per config field; when set and non-empty the env value wins. */
export type ProviderOAuthEnvVarNames = {
  clientId?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
};

export type ProviderOAuthConfig = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /** Space-separated OAuth scope string sent on the authorize URL. */
  scopes: string;
  extraParams?: Record<string, string>;
  envOverrides: ProviderOAuthEnvVarNames;
};

/** Token result in auth-v2 SubscriptionAuth shape (minus `type`). */
export type ProviderOAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Seconds since epoch, from `expires_in`. */
  expiresAt?: number;
  accountId?: string;
  plan?: string;
};

/** Every failure this module surfaces: concise, user-facing, token-free. */
export class ProviderOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOAuthError";
  }
}

// UNVERIFIED — override via ATOM_OPENAI_OAUTH_* env vars; confirm against provider docs.
const OPENAI_OAUTH_CLIENT_ID = "atom-tui";
const OPENAI_OAUTH_AUTHORIZATION_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const OPENAI_OAUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const OPENAI_OAUTH_SCOPES = "openid profile email offline_access";

/** Providers with a subscription OAuth flow. Extend per provider as endpoints get verified. */
export const PROVIDER_OAUTH: Partial<Record<ProviderId, ProviderOAuthConfig>> = {
  openai: {
    authorizationEndpoint: OPENAI_OAUTH_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: OPENAI_OAUTH_TOKEN_ENDPOINT,
    clientId: OPENAI_OAUTH_CLIENT_ID,
    scopes: OPENAI_OAUTH_SCOPES,
    envOverrides: {
      clientId: "ATOM_OPENAI_OAUTH_CLIENT_ID",
      authorizationEndpoint: "ATOM_OPENAI_OAUTH_AUTH_URL",
      tokenEndpoint: "ATOM_OPENAI_OAUTH_TOKEN_URL",
    },
  },
};

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15 * 1000;
const ERROR_DETAIL_MAX_CHARS = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envValue(name: string | undefined): string {
  if (!name) return "";
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : "";
}

/**
 * Config for one provider with env overrides applied (env wins over the
 * table constant). Undefined when OAuth is not configured for the id.
 */
export function resolveProviderOAuthConfig(
  id: ProviderId
): ProviderOAuthConfig | undefined {
  const config = PROVIDER_OAUTH[id];
  if (!config) return undefined;
  return {
    ...config,
    clientId: envValue(config.envOverrides.clientId) || config.clientId,
    authorizationEndpoint:
      envValue(config.envOverrides.authorizationEndpoint) ||
      config.authorizationEndpoint,
    tokenEndpoint:
      envValue(config.envOverrides.tokenEndpoint) || config.tokenEndpoint,
  };
}

/** Loopback callback server, injectable so tests never open a socket. */
export type ProviderOAuthCallback = {
  redirectUri: string;
  waitForCode: (state: string, timeoutMs: number) => Promise<string>;
  close: () => Promise<void>;
};

export type ProviderLoginOAuthOptions = {
  /** Defaults to 5 minutes. */
  callbackTimeoutMs?: number;
  /** Defaults to true; tests pass false (they never open a real browser). */
  openBrowser?: boolean;
  /** Receives the authorize URL (tests capture it instead of opening). */
  onAuthorizeUrl?: (url: string) => void;
  /** Defaults to the real loopback server; tests inject a socket-free stub. */
  startCallback?: () => Promise<ProviderOAuthCallback>;
};

// Only the OAuth error fields are read from a non-2xx body — never a token
// field, so a misbehaving endpoint cannot leak a secret into the transcript.
async function errorDetailSuffix(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return ""; // non-JSON error body: status alone is the honest detail
  }
  if (!isRecord(body)) return "";
  const raw =
    typeof body["error_description"] === "string"
      ? body["error_description"]
      : typeof body["error"] === "string"
        ? body["error"]
        : "";
  const detail = raw.replace(/\s+/g, " ").trim();
  if (!detail) return "";
  return ` — ${detail.slice(0, ERROR_DETAIL_MAX_CHARS)}`;
}

async function postForm(
  url: string,
  params: URLSearchParams,
  what: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });
  } catch (e) {
    throw new ProviderOAuthError(
      `${what} failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!response.ok) {
    throw new ProviderOAuthError(
      `${what} failed: HTTP ${response.status}${await errorDetailSuffix(response)}`
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ProviderOAuthError(`${what} returned a non-JSON response`);
  }
}

// Best-effort claim lookup: malformed or absent claims are simply absent.
function pickString(
  claims: Record<string, unknown> | undefined,
  keys: readonly string[]
): string | undefined {
  if (!claims) return undefined;
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Decode a JWT payload claim set; anything unparseable yields undefined. */
function decodeJwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined; // best-effort: a malformed id_token never fails the login
  }
}

function bestEffortIdentity(
  raw: Record<string, unknown>
): { accountId?: string; plan?: string } {
  const account = isRecord(raw["account"]) ? raw["account"] : undefined;
  const idClaims = decodeJwtClaims(raw["id_token"]);
  const identity: { accountId?: string; plan?: string } = {};
  const accountId =
    pickString(account, ["account_id", "id"]) ??
    pickString(idClaims, ["account_id"]);
  const plan = pickString(account, ["plan"]) ?? pickString(idClaims, ["plan"]);
  if (accountId) identity.accountId = accountId;
  if (plan) identity.plan = plan;
  return identity;
}

function parseTokenResponse(raw: unknown, what: string): ProviderOAuthTokens {
  if (!isRecord(raw) || typeof raw["access_token"] !== "string" || raw["access_token"].length === 0) {
    throw new ProviderOAuthError(`${what} returned a malformed response`);
  }
  const tokens: ProviderOAuthTokens = { accessToken: raw["access_token"] };
  if (typeof raw["refresh_token"] === "string") tokens.refreshToken = raw["refresh_token"];
  const expiresIn = raw["expires_in"];
  const seconds =
    typeof expiresIn === "number"
      ? expiresIn
      : typeof expiresIn === "string"
        ? Number(expiresIn)
        : NaN;
  if (Number.isFinite(seconds)) {
    tokens.expiresAt = Math.floor(Date.now() / 1000) + seconds;
  }
  const identity = bestEffortIdentity(raw);
  if (identity.accountId) tokens.accountId = identity.accountId;
  if (identity.plan) tokens.plan = identity.plan;
  return tokens;
}

function withExtraParams(
  authorizeUrl: string,
  extraParams: Record<string, string> | undefined
): string {
  if (!extraParams) return authorizeUrl;
  const url = new URL(authorizeUrl);
  for (const [key, value] of Object.entries(extraParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// The loopback server reports provider errors (e.g. access_denied) as raw
// callback text; map the cancel case to the wording users recognize.
function callbackFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /access_denied/i.test(message) ? "authorization was cancelled" : message;
}

async function waitForAuthorizationCode(
  callback: ProviderOAuthCallback,
  state: string,
  timeoutMs: number
): Promise<string> {
  try {
    return await callback.waitForCode(state, timeoutMs);
  } catch (e) {
    throw new ProviderOAuthError(callbackFailureMessage(e));
  }
}

async function exchangeAuthorizationCode(
  config: ProviderOAuthConfig,
  args: { code: string; redirectUri: string; verifier: string }
): Promise<ProviderOAuthTokens> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: config.clientId,
    code_verifier: args.verifier,
  });
  const raw = await postForm(config.tokenEndpoint, params, "token exchange");
  return parseTokenResponse(raw, "token exchange");
}

/**
 * Full browser subscription login: PKCE authorize URL, loopback callback,
 * code exchange. Rejects with ProviderOAuthError only — concise and
 * token-free. The callback server always closes, success or failure.
 */
export async function runProviderLoginOAuth(
  id: ProviderId,
  opts: ProviderLoginOAuthOptions = {}
): Promise<ProviderOAuthTokens> {
  const config = resolveProviderOAuthConfig(id);
  if (!config) {
    throw new ProviderOAuthError(`OAuth is not configured for ${id}`);
  }
  const startCallback = opts.startCallback ?? startCallbackServer;
  const callback = await startCallback();
  try {
    const state = base64Url(randomBytes(32));
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const authorizeUrl = withExtraParams(
      buildAuthorizeUrl(
        {
          authorizationEndpoint: config.authorizationEndpoint,
          tokenEndpoint: config.tokenEndpoint,
        },
        config.clientId,
        {
          redirectUri: callback.redirectUri,
          scope: config.scopes,
          state,
          challenge,
        }
      ),
      config.extraParams
    );
    opts.onAuthorizeUrl?.(authorizeUrl);
    if (opts.openBrowser !== false) openBrowser(authorizeUrl);
    const code = await waitForAuthorizationCode(
      callback,
      state,
      opts.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS
    );
    return await exchangeAuthorizationCode(config, {
      code,
      redirectUri: callback.redirectUri,
      verifier,
    });
  } finally {
    await callback.close();
  }
}

/**
 * Refresh grant for a stored provider refresh token. Returns rotated
 * tokens (the old refresh token is kept when the server omits a new one)
 * or rejects with ProviderOAuthError.
 */
export async function refreshProviderOAuth(
  id: ProviderId,
  refreshToken: string
): Promise<ProviderOAuthTokens> {
  const config = resolveProviderOAuthConfig(id);
  if (!config) {
    throw new ProviderOAuthError(`OAuth is not configured for ${id}`);
  }
  let refreshed;
  try {
    refreshed = await refreshTokens(
      config.tokenEndpoint,
      { clientId: config.clientId },
      refreshToken,
      config.scopes,
      REFRESH_TIMEOUT_MS
    );
  } catch (e) {
    throw new ProviderOAuthError(e instanceof Error ? e.message : String(e));
  }
  const tokens: ProviderOAuthTokens = { accessToken: refreshed.accessToken };
  if (refreshed.refreshToken) tokens.refreshToken = refreshed.refreshToken;
  // Whole seconds, matching parseTokenResponse (mcp's helper keeps millis).
  if (refreshed.expiresAt !== undefined) tokens.expiresAt = Math.floor(refreshed.expiresAt);
  return tokens;
}
