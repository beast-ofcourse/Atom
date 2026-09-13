// MCP OAuth credential store (ticket 05): tokens + dynamic-registration
// client info persisted under the ATOM home directory with owner-only
// permissions, bound to the server URL so a URL change invalidates them.
// Secrets never land in project config. Reads never throw (missing or
// malformed files read as empty); writes throw Error with context for the
// manager to convert at the tool boundary.

import * as fs from "node:fs";
import * as path from "node:path";
import { homeDir } from "../auth.js";

export type McpTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Seconds since epoch, like a JWT exp claim. */
  expiresAt?: number;
  scope?: string;
};

export type McpClientInfo = {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
};

export type McpAuthEntry = {
  serverUrl?: string;
  tokens?: McpTokens;
  clientInfo?: McpClientInfo;
};

export type McpAuthFile = {
  servers: Record<string, McpAuthEntry>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function authFilePath(home?: string): string {
  return path.join(home ?? homeDir(), ".atom", "mcp-auth.json");
}

function sanitizeEntry(raw: unknown): McpAuthEntry | null {
  if (!isRecord(raw)) return null;
  const entry: McpAuthEntry = {};
  if (typeof raw["serverUrl"] === "string") entry.serverUrl = raw["serverUrl"];
  const tokens = raw["tokens"];
  if (isRecord(tokens) && typeof tokens["accessToken"] === "string") {
    entry.tokens = { accessToken: tokens["accessToken"] as string };
    if (typeof tokens["refreshToken"] === "string") entry.tokens.refreshToken = tokens["refreshToken"];
    if (typeof tokens["expiresAt"] === "number" && Number.isFinite(tokens["expiresAt"])) {
      entry.tokens.expiresAt = tokens["expiresAt"];
    }
    if (typeof tokens["scope"] === "string") entry.tokens.scope = tokens["scope"];
  }
  const info = raw["clientInfo"];
  if (isRecord(info) && typeof info["clientId"] === "string") {
    entry.clientInfo = { clientId: info["clientId"] as string };
    if (typeof info["clientSecret"] === "string") entry.clientInfo.clientSecret = info["clientSecret"];
    if (typeof info["clientIdIssuedAt"] === "number") entry.clientInfo.clientIdIssuedAt = info["clientIdIssuedAt"];
    if (typeof info["clientSecretExpiresAt"] === "number") {
      entry.clientInfo.clientSecretExpiresAt = info["clientSecretExpiresAt"];
    }
  }
  return entry;
}

export function loadAuthFile(filePath?: string): McpAuthFile {
  try {
    const raw = fs.readFileSync(filePath ?? authFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { servers: {} };
    const servers: Record<string, McpAuthEntry> = {};
    const bucket = isRecord(parsed["servers"]) ? (parsed["servers"] as Record<string, unknown>) : {};
    for (const [name, entry] of Object.entries(bucket)) {
      const clean = sanitizeEntry(entry);
      if (clean) servers[name] = clean;
    }
    return { servers };
  } catch {
    return { servers: {} };
  }
}

export function saveAuthFile(file: McpAuthFile, filePath?: string): void {
  const target = filePath ?? authFilePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Atomic write (tmp + rename) with owner-only permissions: a half-written
    // credential file must never be left behind, and other users must not
    // read it. Mode bits are best-effort on Windows.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ servers: file.servers }, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // Windows: mode bits don't apply; the user profile dir is ACL'd.
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    throw new Error(`MCP auth store write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function getEntry(file: McpAuthFile, name: string): McpAuthEntry | undefined {
  return file.servers[name];
}

/** Entries are URL-bound: a changed server URL invalidates old credentials. */
export function getEntryForUrl(file: McpAuthFile, name: string, serverUrl: string): McpAuthEntry | undefined {
  const entry = file.servers[name];
  if (!entry || entry.serverUrl !== serverUrl) return undefined;
  return entry;
}

export function setTokens(file: McpAuthFile, name: string, tokens: McpTokens, serverUrl: string): void {
  const entry = file.servers[name] ?? {};
  entry.tokens = tokens;
  entry.serverUrl = serverUrl;
  file.servers[name] = entry;
}

export function setClientInfo(
  file: McpAuthFile,
  name: string,
  info: McpClientInfo,
  serverUrl: string
): void {
  const entry = file.servers[name] ?? {};
  entry.clientInfo = info;
  entry.serverUrl = serverUrl;
  file.servers[name] = entry;
}

export function removeEntry(file: McpAuthFile, name: string): boolean {
  if (!(name in file.servers)) return false;
  delete file.servers[name];
  return true;
}

/** Treat near-expiry as expired (60s clock-skew leeway). */
export function isTokenExpired(tokens: McpTokens | undefined, nowSeconds?: number): boolean {
  if (!tokens) return true;
  if (tokens.expiresAt === undefined) return false;
  return tokens.expiresAt < (nowSeconds ?? Date.now() / 1000) + 60;
}
