// Auth store mirroring opencode's auth.json (manual-key only).
// Credentials in ~/.atom/auth.json shaped:
//   {version:1, providers:{"<id>":{apiKey, baseURL?}}}
// 0600 perms on POSIX via chmod; best-effort on Windows.
// Key resolution per provider: standard env var wins when set, else stored.
// Env names: KILO_API_KEY (kilo; optional — free models work anonymously),
// OPENCODE_ZEN_API_KEY (zen), OPENAI_API_KEY, ANTHROPIC_API_KEY,
// DEEPSEEK_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY (also GOOGLE_API_KEY
// alias). openai-compatible: stored key + stored baseURL only.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProvider, type ProviderId } from "./providers.js";

export const AUTH_VERSION = 1;

export type StoredProviderAuth = {
  apiKey: string;
  baseURL?: string;
};

export type AuthFile = {
  version: number;
  providers: Record<string, StoredProviderAuth>;
};

export function homeDir(): string {
  return (
    process.env.ATOM_HOME ??
    process.env.HOME ??
    process.env.USERPROFILE ??
    os.homedir()
  );
}

export function atomDir(home?: string): string {
  return path.join(home ?? homeDir(), ".atom");
}

export function authFilePath(home?: string): string {
  return path.join(atomDir(home), "auth.json");
}

export function emptyAuth(): AuthFile {
  return { version: AUTH_VERSION, providers: {} };
}

// Load auth.json; missing/corrupt file yields empty auth (never throws).
export function loadAuth(home?: string): AuthFile {
  try {
    const p = authFilePath(home);
    if (!existsSync(p)) return emptyAuth();
    const raw = readFileSync(p, "utf8");
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return emptyAuth();
    const o = data as Record<string, unknown>;
    const providers: Record<string, StoredProviderAuth> = {};
    const src = o["providers"];
    if (typeof src === "object" && src !== null) {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (typeof v !== "object" || v === null) continue;
        const e = v as Record<string, unknown>;
        if (typeof e["apiKey"] !== "string") continue;
        const entry: StoredProviderAuth = { apiKey: e["apiKey"] as string };
        if (typeof e["baseURL"] === "string" && (e["baseURL"] as string).length > 0) {
          entry.baseURL = e["baseURL"] as string;
        }
        providers[k] = entry;
      }
    }
    return { version: AUTH_VERSION, providers };
  } catch {
    return emptyAuth();
  }
}

// Save auth.json (mkdir -p + 0600 on POSIX, best-effort on Windows).
export function saveAuth(auth: AuthFile, home?: string): void {
  const dir = atomDir(home);
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "auth.json");
  const payload: AuthFile = { version: AUTH_VERSION, providers: auth.providers ?? {} };
  writeFileSync(p, JSON.stringify(payload, null, 2) + "\n", "utf8");
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort on Windows; ignore
  }
}

export function getStoredAuth(auth: AuthFile, id: ProviderId): StoredProviderAuth | undefined {
  return auth.providers[id];
}

export function getStoredKey(auth: AuthFile, id: ProviderId): string {
  return auth.providers[id]?.apiKey ?? "";
}

export function getStoredBaseURL(auth: AuthFile, id: ProviderId): string {
  return auth.providers[id]?.baseURL ?? "";
}

// Env key for a provider (first non-empty env var wins). Empty when none.
export function getEnvKey(id: ProviderId): string {
  const def = getProvider(id);
  if (!def) return "";
  for (const name of def.envVars) {
    const v = process.env[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

// Resolved key: env wins when set, else stored. openai-compatible has no
// env vars, so it is stored-only by construction.
export function resolveApiKey(id: ProviderId, auth: AuthFile): string {
  return getEnvKey(id) || getStoredKey(auth, id);
}

export function hasKey(id: ProviderId, auth: AuthFile): boolean {
  return resolveApiKey(id, auth).length > 0;
}

// Set (or replace) the stored key for a provider; returns the updated auth.
export function setStoredKey(
  auth: AuthFile,
  id: ProviderId,
  apiKey: string,
  baseURL?: string
): AuthFile {
  const next: AuthFile = {
    version: AUTH_VERSION,
    providers: { ...auth.providers },
  };
  const prev = next.providers[id];
  const entry: StoredProviderAuth = { apiKey };
  const base = baseURL !== undefined ? baseURL : prev?.baseURL;
  if (typeof base === "string" && base.length > 0) entry.baseURL = base;
  next.providers[id] = entry;
  return next;
}

export function setStoredBaseURL(
  auth: AuthFile,
  id: ProviderId,
  baseURL: string
): AuthFile {
  const prev = auth.providers[id];
  return setStoredKey(auth, id, prev?.apiKey ?? "", baseURL);
}
