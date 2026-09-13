// MCP OAuth 2.1 flow for remote servers (ticket 05): authorization-server
// discovery (RFC 8414 + WWW-Authenticate fallback), dynamic client
// registration (RFC 7591), PKCE + local-callback browser flow with CSRF
// state validation, code exchange, and refresh grants. Node builtins only.
// No browser dependency: the system browser is opened best-effort and the
// URL is always handed to onRedirect (tests simulate the browser by GETting
// the callback URL directly — never open a real one).

import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { McpError } from "./client.js";
import type { McpClientInfo, McpTokens } from "./auth.js";
import type { McpOAuthConfig } from "./config.js";

export type OAuthEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchJson(url: string, init: RequestInit, timeout: number, what: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new McpError(`${what} failed: HTTP ${res.status}`);
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new McpError(`${what} returned non-JSON`);
    }
  } catch (e) {
    if (e instanceof McpError) throw e;
    throw new McpError(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

function requireStringEndpoint(metadata: Record<string, unknown>, key: string, what: string): string {
  const v = metadata[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new McpError(`${what}: metadata is missing "${key}"`);
  }
  return v;
}

/** Discover the authorization server's endpoints for an MCP server URL. */
export async function discoverEndpoints(
  serverUrl: string,
  headers: Record<string, string>,
  timeout: number
): Promise<{ endpoints: OAuthEndpoints; authServer: string }> {
  const parsed = new URL(serverUrl);
  const origin = parsed.origin;
  const candidates = [`${origin}/.well-known/oauth-authorization-server`];
  if (parsed.pathname && parsed.pathname !== "/") {
    candidates.push(`${origin}/.well-known/oauth-authorization-server${parsed.pathname}`);
  }
  for (const url of candidates) {
    try {
      const metadata = (await fetchJson(
        url,
        { headers: { Accept: "application/json", ...headers } },
        timeout,
        "OAuth discovery"
      )) as unknown;
      if (!isRecord(metadata)) continue;
      return {
        endpoints: {
          authorizationEndpoint: requireStringEndpoint(metadata, "authorization_endpoint", "OAuth discovery"),
          tokenEndpoint: requireStringEndpoint(metadata, "token_endpoint", "OAuth discovery"),
          registrationEndpoint:
            typeof metadata["registration_endpoint"] === "string"
              ? (metadata["registration_endpoint"] as string)
              : undefined,
        },
        authServer: origin,
      };
    } catch {
      continue;
    }
  }
  // Fallback: the MCP server's 401 WWW-Authenticate may point at protected-
  // resource metadata carrying the authorization server list (RFC 9728).
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    const match = wwwAuth.match(/resource_metadata="([^"]+)"/);
    if (match?.[1]) {
      const resourceMeta = (await fetchJson(
        match[1],
        { headers: { Accept: "application/json" } },
        timeout,
        "OAuth resource metadata"
      )) as unknown;
      const servers =
        isRecord(resourceMeta) && Array.isArray(resourceMeta["authorization_servers"])
          ? (resourceMeta["authorization_servers"] as unknown[])
          : [];
      const first = typeof servers[0] === "string" ? (servers[0] as string) : undefined;
      if (first) {
        const base = first.replace(/\/$/, "");
        const metadata = (await fetchJson(
          `${base}/.well-known/oauth-authorization-server`,
          { headers: { Accept: "application/json" } },
          timeout,
          "OAuth discovery"
        )) as unknown;
        if (isRecord(metadata)) {
          return {
            endpoints: {
              authorizationEndpoint: requireStringEndpoint(metadata, "authorization_endpoint", "OAuth discovery"),
              tokenEndpoint: requireStringEndpoint(metadata, "token_endpoint", "OAuth discovery"),
              registrationEndpoint:
                typeof metadata["registration_endpoint"] === "string"
                  ? (metadata["registration_endpoint"] as string)
                  : undefined,
            },
            authServer: base,
          };
        }
      }
    }
  } catch {
    // fall through to the guidance error below
  }
  throw new McpError(
    `MCP server requires OAuth but no authorization server could be discovered for ${origin}. ` +
      `If the server does not use discovery, configure a pre-registered "oauth": { "clientId": "..." } entry.`
  );
}

/** Resolve client credentials: pre-registered wins, else dynamic registration. */
export async function resolveClient(
  endpoints: OAuthEndpoints,
  serverName: string,
  opts: { redirectUri: string; oauth: McpOAuthConfig; stored?: McpClientInfo },
  timeout: number
): Promise<{ info: McpClientInfo; registered: boolean }> {
  if (opts.oauth.clientId) {
    return {
      info: { clientId: opts.oauth.clientId, ...(opts.oauth.clientSecret ? { clientSecret: opts.oauth.clientSecret } : {}) },
      registered: false,
    };
  }
  if (opts.stored && !(opts.stored.clientSecretExpiresAt && opts.stored.clientSecretExpiresAt < Date.now() / 1000)) {
    return { info: opts.stored, registered: false };
  }
  if (!endpoints.registrationEndpoint) {
    throw new McpError(
      `MCP server "${serverName}" does not support dynamic client registration. ` +
        `Add a pre-registered clientId to your config: "mcp": { "${serverName}": { "type": "remote", "url": "<url>", "oauth": { "clientId": "your-client-id" } } }`
    );
  }
  const body: Record<string, unknown> = {
    redirect_uris: [opts.redirectUri],
    client_name: "ATOM",
    client_uri: "https://github.com/beast-ofcourse/Atom",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: opts.oauth.clientSecret ? "client_secret_post" : "none",
  };
  if (opts.oauth.scope) body["scope"] = opts.oauth.scope;
  const registered = (await fetchJson(
    endpoints.registrationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeout,
    "OAuth dynamic client registration"
  )) as unknown;
  if (!isRecord(registered) || typeof registered["client_id"] !== "string") {
    throw new McpError("OAuth dynamic client registration returned a malformed response");
  }
  return {
    info: {
      clientId: registered["client_id"] as string,
      ...(typeof registered["client_secret"] === "string" ? { clientSecret: registered["client_secret"] as string } : {}),
      ...(typeof registered["client_id_issued_at"] === "number"
        ? { clientIdIssuedAt: registered["client_id_issued_at"] as number }
        : {}),
      ...(typeof registered["client_secret_expires_at"] === "number"
        ? { clientSecretExpiresAt: registered["client_secret_expires_at"] as number }
        : {}),
    },
    registered: true,
  };
}

export function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildAuthorizeUrl(
  endpoints: OAuthEndpoints,
  clientId: string,
  args: { redirectUri: string; scope?: string; state: string; challenge: string }
): string {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  if (args.scope) url.searchParams.set("scope", args.scope);
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

type CallbackResult = { code: string };

/** Loopback callback server: resolves the authorization code for one state. */
export function startCallbackServer(): Promise<{
  port: number;
  redirectUri: string;
  waitForCode: (state: string, timeoutMs: number) => Promise<string>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const pending = new Map<string, (result: CallbackResult) => void>();
    const failers = new Map<string, (error: Error) => void>();
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const escapeHtml = (s: string): string =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const done = (status: number, title: string, detail: string): void => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<html><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p>You can close this tab and return to ATOM.</p></body></html>`
        );
      };
      if (!state || !pending.has(state)) {
        done(400, "ATOM MCP authorization failed", "Invalid or expired state parameter.");
        return;
      }
      const succeed = pending.get(state)!;
      const fail = failers.get(state)!;
      pending.delete(state);
      failers.delete(state);
      if (error) {
        fail(new McpError(`Authorization failed: ${url.searchParams.get("error_description") ?? error}`));
        done(200, "ATOM MCP authorization failed", error);
        return;
      }
      if (!code) {
        fail(new McpError("Authorization response carried no code"));
        done(400, "ATOM MCP authorization failed", "No authorization code provided.");
        return;
      }
      succeed({ code });
      done(200, "ATOM MCP authorized", "Authorization complete.");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        redirectUri: `http://127.0.0.1:${port}/callback`,
        waitForCode: (state, timeoutMs) =>
          new Promise<string>((resolveCode, rejectCode) => {
            const timer = setTimeout(() => {
              pending.delete(state);
              failers.delete(state);
              rejectCode(new McpError("OAuth callback timed out — authorization took too long"));
            }, timeoutMs);
            pending.set(state, ({ code }) => {
              clearTimeout(timer);
              resolveCode(code);
            });
            failers.set(state, (error) => {
              clearTimeout(timer);
              rejectCode(error);
            });
          }),
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function exchangeCode(
  tokenEndpoint: string,
  args: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    verifier: string;
  },
  timeout: number
): Promise<McpTokens> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.verifier,
  });
  if (args.clientSecret) params.set("client_secret", args.clientSecret);
  const raw = (await fetchJson(
    tokenEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
    timeout,
    "OAuth token exchange"
  )) as unknown;
  return toTokens(raw, "OAuth token exchange");
}

function toTokens(raw: unknown, what: string): McpTokens {
  if (!isRecord(raw) || typeof raw["access_token"] !== "string") {
    throw new McpError(`${what} returned a malformed response`);
  }
  const tokens: McpTokens = { accessToken: raw["access_token"] as string };
  if (typeof raw["refresh_token"] === "string") tokens.refreshToken = raw["refresh_token"];
  const expiresIn = raw["expires_in"];
  const seconds = typeof expiresIn === "number" ? expiresIn : typeof expiresIn === "string" ? Number(expiresIn) : NaN;
  if (Number.isFinite(seconds)) tokens.expiresAt = Date.now() / 1000 + (seconds as number);
  if (typeof raw["scope"] === "string") tokens.scope = raw["scope"];
  return tokens;
}

/** Refresh grant against a known token endpoint. */
export async function refreshTokens(
  tokenEndpoint: string,
  client: McpClientInfo,
  refreshToken: string,
  scope: string | undefined,
  timeout: number
): Promise<McpTokens> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
  });
  if (client.clientSecret) params.set("client_secret", client.clientSecret);
  if (scope) params.set("scope", scope);
  const raw = (await fetchJson(
    tokenEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
    timeout,
    "OAuth token refresh"
  )) as unknown;
  const tokens = toTokens(raw, "OAuth token refresh");
  // Some servers omit a fresh refresh token: keep using the old one.
  if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}

/** Best-effort system browser open (Windows/macOS/Linux). Never throws. */
export function openBrowser(url: string): void {
  try {
    const target: [string, string[]] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(target[0], target[1], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is always also handed to onRedirect — the browser is a bonus.
  }
}

export type OAuthFlowOptions = {
  serverName: string;
  serverUrl: string;
  headers: Record<string, string>;
  oauth: McpOAuthConfig;
  storedClient?: McpClientInfo;
  timeout: number;
  /** Defaults to 5 minutes; tests pass a short budget. */
  callbackTimeoutMs?: number;
  /** Receives the authorize URL (tests capture it instead of opening). */
  onRedirect?: (url: string) => void;
  /** Defaults to true; tests set false. */
  openBrowser?: boolean;
};

/**
 * Run the full browser authorization flow: discover, register (or reuse),
 * authorize via the loopback callback, exchange. Returns fresh tokens plus
 * the client info to persist (undefined when pre-registered from config —
 * nothing new to store).
 */
export async function runOAuthFlow(opts: OAuthFlowOptions): Promise<{ tokens: McpTokens; clientInfo?: McpClientInfo }> {
  // Discovery first (fails fast with guidance when the server has no
  // metadata); the callback server starts inside, because dynamic
  // registration must commit the real loopback redirect URI.
  const { endpoints } = await discoverEndpoints(opts.serverUrl, opts.headers, opts.timeout);
  return runFlowWithCallback(endpoints, opts);
}

async function runFlowWithCallback(
  endpoints: OAuthEndpoints,
  opts: OAuthFlowOptions
): Promise<{ tokens: McpTokens; clientInfo?: McpClientInfo }> {
  const callback = await startCallbackServer();
  try {
    const redirectUri = callback.redirectUri;
    const { info, registered } = await resolveClient(
      endpoints,
      opts.serverName,
      { redirectUri, oauth: opts.oauth, stored: opts.storedClient },
      opts.timeout
    );
    const state = randomBytes(32).toString("hex");
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const authorizeUrl = buildAuthorizeUrl(endpoints, info.clientId, {
      redirectUri,
      scope: opts.oauth.scope,
      state,
      challenge,
    });
    opts.onRedirect?.(authorizeUrl);
    if (opts.openBrowser !== false) openBrowser(authorizeUrl);
    const code = await callback.waitForCode(state, opts.callbackTimeoutMs ?? 5 * 60 * 1000);
    const tokens = await exchangeCode(
      endpoints.tokenEndpoint,
      { code, redirectUri, clientId: info.clientId, clientSecret: info.clientSecret, verifier },
      opts.timeout
    );
    return { tokens, clientInfo: registered ? info : undefined };
  } finally {
    await callback.close();
  }
}
