// Auth store mirroring opencode's auth.json (manual-key + subscription).
// Credentials in ~/.atom/auth.json shaped:
//   {version:2, keyVersion:1, providers:{"<id>":{apiKey, baseURL?, subscription?}}}
// subscription: {type, accessToken, refreshToken?, expiresAt?, accountId?, plan?}
// accessToken and refreshToken are encrypted at rest (AES-256-GCM).
// 0600 perms on POSIX via chmod; best-effort on Windows.
// Key resolution per provider: standard env var wins when set, else stored.
// Env names: KILO_API_KEY (kilo; optional — free models work anonymously),
// OPENCODE_ZEN_API_KEY (zen), OPENAI_API_KEY, ANTHROPIC_API_KEY,
// DEEPSEEK_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY (also GOOGLE_API_KEY
// alias), GROQ_API_KEY, XAI_API_KEY, ZAI_API_KEY, OPENROUTER_API_KEY,
// CEREBRAS_API_KEY. openai-compatible: stored key + stored baseURL only.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { getProvider, type ProviderId } from "./providers.js";

export const AUTH_VERSION = 2;

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export type SubscriptionAuth = {
  type: "oauth" | "api-key";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  plan?: string;
};

/** Admin attribution for a shared (team-managed) stored key. */
export type TeamKeyMeta = {
  managedBy: string;
};

export type StoredProviderAuth = {
  apiKey: string;
  baseURL?: string;
  subscription?: SubscriptionAuth;
  team?: TeamKeyMeta;
};

export type AuthFile = {
  version: number;
  keyVersion?: number;
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

function keyFilePath(home?: string): string {
  return path.join(atomDir(home), ".key");
}

export function emptyAuth(): AuthFile {
  return { version: AUTH_VERSION, keyVersion: 1, providers: {} };
}

function getEncryptionKey(): Buffer {
  const envKey = process.env.ATOM_ENCRYPTION_KEY;
  if (envKey) {
    const key = Buffer.from(envKey, "hex");
    if (key.length !== KEY_LENGTH) {
      throw new Error("ATOM_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
    }
    return key;
  }

  const keyPath = keyFilePath();
  if (existsSync(keyPath)) {
    const keyHex = readFileSync(keyPath, "utf8").trim();
    const key = Buffer.from(keyHex, "hex");
    if (key.length !== KEY_LENGTH) {
      throw new Error(".key file contains invalid key length");
    }
    return key;
  }

  const newKey = randomBytes(KEY_LENGTH);
  mkdirSync(atomDir(), { recursive: true });
  writeFileSync(keyPath, newKey.toString("hex"), "utf8");
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best-effort on Windows
  }
  return newKey;
}

function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptToken(encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
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
        const team = e["team"];
        if (typeof team === "object" && team !== null) {
          const managedBy = (team as Record<string, unknown>)["managedBy"];
          if (typeof managedBy === "string" && managedBy.length > 0) {
            entry.team = { managedBy };
          }
        }
        const sub = e["subscription"];
        if (typeof sub === "object" && sub !== null) {
          const s = sub as Record<string, unknown>;
          if (typeof s["accessToken"] === "string") {
            const subscription: SubscriptionAuth = {
              type: s["type"] === "api-key" ? "api-key" : "oauth",
              accessToken: s["accessToken"] as string,
            };
            if (typeof s["refreshToken"] === "string") {
              subscription.refreshToken = s["refreshToken"] as string;
            }
            if (typeof s["expiresAt"] === "number") {
              subscription.expiresAt = s["expiresAt"] as number;
            }
            if (typeof s["accountId"] === "string") {
              subscription.accountId = s["accountId"] as string;
            }
            if (typeof s["plan"] === "string") {
              subscription.plan = s["plan"] as string;
            }
            try {
              subscription.accessToken = decryptToken(subscription.accessToken);
              if (subscription.refreshToken) {
                subscription.refreshToken = decryptToken(subscription.refreshToken);
              }
              entry.subscription = subscription;
            } catch {
              // Undecryptable tokens (regenerated .key / corrupted value):
              // drop only the tokens — the provider's stored apiKey and
              // baseURL survive, so a later saveAuth never erases them.
            }
          }
        }
        providers[k] = entry;
      }
    }
    const keyVersion = typeof o["keyVersion"] === "number" ? (o["keyVersion"] as number) : 1;
    return { version: AUTH_VERSION, keyVersion, providers };
  } catch {
    return emptyAuth();
  }
}

// Save auth.json (mkdir -p + 0600 on POSIX, best-effort on Windows).
export function saveAuth(auth: AuthFile, home?: string): void {
  const dir = atomDir(home);
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "auth.json");

  const providers: Record<string, StoredProviderAuth> = {};
  for (const [k, v] of Object.entries(auth.providers ?? {})) {
    const entry: StoredProviderAuth = { apiKey: v.apiKey };
    if (v.baseURL) entry.baseURL = v.baseURL;
    if (v.team) entry.team = { managedBy: v.team.managedBy };
    if (v.subscription) {
      const sub = v.subscription;
      const encryptedSub: SubscriptionAuth = {
        ...sub,
        accessToken: encryptToken(sub.accessToken),
      };
      if (sub.refreshToken) {
        encryptedSub.refreshToken = encryptToken(sub.refreshToken);
      }
      entry.subscription = encryptedSub;
    }
    providers[k] = entry;
  }

  const payload: AuthFile = {
    version: AUTH_VERSION,
    keyVersion: auth.keyVersion ?? 1,
    providers,
  };
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
    keyVersion: auth.keyVersion,
    providers: { ...auth.providers },
  };
  const prev = next.providers[id];
  const entry: StoredProviderAuth = { apiKey };
  const base = baseURL !== undefined ? baseURL : prev?.baseURL;
  if (typeof base === "string" && base.length > 0) entry.baseURL = base;
  // Replacing the credential keeps the admin attribution; the command
  // layer (App) decides whether a team-managed key may be replaced at all.
  if (prev?.team) entry.team = prev.team;
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

export function setSubscriptionAuth(
  auth: AuthFile,
  id: ProviderId,
  subscription: SubscriptionAuth
): AuthFile {
  const next: AuthFile = {
    version: AUTH_VERSION,
    keyVersion: auth.keyVersion,
    providers: { ...auth.providers },
  };
  const prev = next.providers[id];
  const entry: StoredProviderAuth = {
    apiKey: prev?.apiKey ?? "",
    subscription,
  };
  if (prev?.baseURL) entry.baseURL = prev.baseURL;
  if (prev?.team) entry.team = prev.team;
  next.providers[id] = entry;
  return next;
}

export function getSubscriptionAuth(
  auth: AuthFile,
  id: ProviderId
): SubscriptionAuth | undefined {
  return auth.providers[id]?.subscription;
}

export function clearSubscriptionAuth(
  auth: AuthFile,
  id: ProviderId
): AuthFile {
  const next: AuthFile = {
    version: AUTH_VERSION,
    keyVersion: auth.keyVersion,
    providers: { ...auth.providers },
  };
  const prev = next.providers[id];
  if (prev) {
    // Full credential removal drops the team meta too — it described a key
    // that no longer exists (the /logout command refuses team-managed keys
    // before ever reaching this helper).
    const entry: StoredProviderAuth = { apiKey: prev.apiKey };
    if (prev.baseURL) entry.baseURL = prev.baseURL;
    next.providers[id] = entry;
  }
  return next;
}

// ---- team (shared-key) metadata ----

/** The admin managing a shared key for one provider, when marked. */
export function getTeamManaged(auth: AuthFile, id: ProviderId): string | undefined {
  return auth.providers[id]?.team?.managedBy;
}

/** Mark a stored key as admin-managed; returns the updated auth. */
export function setTeamManaged(
  auth: AuthFile,
  id: ProviderId,
  managedBy: string
): AuthFile {
  const next: AuthFile = {
    version: AUTH_VERSION,
    keyVersion: auth.keyVersion,
    providers: { ...auth.providers },
  };
  const prev = next.providers[id];
  const entry: StoredProviderAuth = { apiKey: prev?.apiKey ?? "" };
  if (prev?.baseURL) entry.baseURL = prev.baseURL;
  if (prev?.subscription) entry.subscription = prev.subscription;
  entry.team = { managedBy };
  next.providers[id] = entry;
  return next;
}

/** Remove the admin mark from one provider's stored key. */
export function clearTeamManaged(auth: AuthFile, id: ProviderId): AuthFile {
  const next: AuthFile = {
    version: AUTH_VERSION,
    keyVersion: auth.keyVersion,
    providers: { ...auth.providers },
  };
  const prev = next.providers[id];
  if (prev) {
    const entry: StoredProviderAuth = { apiKey: prev.apiKey };
    if (prev.baseURL) entry.baseURL = prev.baseURL;
    if (prev.subscription) entry.subscription = prev.subscription;
    next.providers[id] = entry;
  }
  return next;
}
