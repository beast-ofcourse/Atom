// Auth store v2 (src/auth.ts): AES-256-GCM at-rest encryption of
// subscription tokens, plaintext-free auth.json, corrupt-token containment
// (only the tokens are dropped, never the provider's apiKey), v1 file
// upgrade, and encryption-key validation. Hermetic: a fixed
// ATOM_ENCRYPTION_KEY + a temp home directory — no real credentials and no
// ~/.atom files are touched.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AUTH_VERSION,
  authFilePath,
  clearSubscriptionAuth,
  clearTeamManaged,
  emptyAuth,
  getStoredKey,
  getSubscriptionAuth,
  getTeamManaged,
  loadAuth,
  saveAuth,
  setStoredBaseURL,
  setStoredKey,
  setSubscriptionAuth,
  setTeamManaged,
} from "../src/auth.js";

// 64 hex chars = 32 bytes for aes-256-gcm. Constant keeps every run
// independent of (and harmless to) the user's real ~/.atom/.key.
const TEST_ENCRYPTION_KEY = "ab".repeat(32);

let home: string;

function writeAuthJson(contents: unknown): void {
  mkdirSync(path.dirname(authFilePath(home)), { recursive: true });
  writeFileSync(authFilePath(home), JSON.stringify(contents, null, 2), "utf8");
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "atom-auth-test-"));
  vi.stubEnv("ATOM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("subscription tokens at rest", () => {
  test("saveAuth encrypts the tokens; the file never contains their plaintext", () => {
    const auth = setSubscriptionAuth(emptyAuth(), "openai", {
      type: "oauth",
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
      expiresAt: 1_800_000_000,
      accountId: "acct-42",
      plan: "team",
    });

    saveAuth(auth, home);

    const raw = readFileSync(authFilePath(home), "utf8");
    expect(raw).not.toContain("secret-access-token");
    expect(raw).not.toContain("secret-refresh-token");
    expect(raw).toContain('"version": 2');
    const stored = JSON.parse(raw) as {
      providers: Record<string, { subscription?: { accessToken: string } }>;
    };
    // iv:authTag:ciphertext, all hex.
    expect(stored.providers.openai?.subscription?.accessToken).toMatch(
      /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/
    );
  });

  test("loadAuth decrypts a full roundtrip with every field intact", () => {
    const original = setSubscriptionAuth(
      setStoredBaseURL(setStoredKey(emptyAuth(), "openai-compatible", "sk-local"), "openai-compatible", "http://localhost:8080"),
      "openai",
      {
        type: "oauth",
        accessToken: "access-roundtrip",
        refreshToken: "refresh-roundtrip",
        expiresAt: 1_800_000_000,
        accountId: "acct-42",
        plan: "team",
      }
    );

    saveAuth(original, home);
    const loaded = loadAuth(home);

    expect(loaded.version).toBe(AUTH_VERSION);
    expect(getStoredKey(loaded, "openai-compatible")).toBe("sk-local");
    expect(loaded.providers["openai-compatible"]?.baseURL).toBe("http://localhost:8080");
    expect(getSubscriptionAuth(loaded, "openai")).toEqual({
      type: "oauth",
      accessToken: "access-roundtrip",
      refreshToken: "refresh-roundtrip",
      expiresAt: 1_800_000_000,
      accountId: "acct-42",
      plan: "team",
    });
  });
});

describe("corrupt and legacy files", () => {
  test("an undecryptable token drops only the tokens — the stored apiKey survives", () => {
    writeAuthJson({
      version: 2,
      keyVersion: 1,
      providers: {
        openai: {
          apiKey: "sk-keep-me",
          subscription: {
            type: "oauth",
            accessToken: "aa:bb:cc",
          },
        },
        anthropic: { apiKey: "sk-untouched" },
      },
    });

    const loaded = loadAuth(home);

    expect(getStoredKey(loaded, "openai")).toBe("sk-keep-me");
    expect(getSubscriptionAuth(loaded, "openai")).toBeUndefined();
    expect(getStoredKey(loaded, "anthropic")).toBe("sk-untouched");

    // Saving the loaded file must not erase the key it just read.
    saveAuth(loaded, home);
    expect(getStoredKey(loadAuth(home), "openai")).toBe("sk-keep-me");
  });

  test("a missing or unparseable auth.json yields empty auth instead of throwing", () => {
    expect(loadAuth(home)).toEqual(emptyAuth());
    mkdirSync(path.dirname(authFilePath(home)), { recursive: true });
    writeFileSync(authFilePath(home), "{not json", "utf8");
    expect(loadAuth(home)).toEqual(emptyAuth());
  });

  test("a v1 file (no version, plaintext key) loads and upgrades on save", () => {
    writeAuthJson({ providers: { openai: { apiKey: "sk-legacy" } } });

    const loaded = loadAuth(home);
    expect(loaded.version).toBe(AUTH_VERSION);
    expect(loaded.keyVersion).toBe(1);
    expect(getStoredKey(loaded, "openai")).toBe("sk-legacy");

    saveAuth(loaded, home);
    const saved = JSON.parse(
      readFileSync(authFilePath(home), "utf8")
    ) as { version: number };
    expect(saved.version).toBe(AUTH_VERSION);
  });
});

describe("encryption key validation", () => {
  test("a malformed ATOM_ENCRYPTION_KEY fails loudly on encrypt", () => {
    vi.stubEnv("ATOM_ENCRYPTION_KEY", "not-a-real-key");
    const auth = setSubscriptionAuth(emptyAuth(), "openai", {
      type: "oauth",
      accessToken: "access-1",
    });
    expect(() => saveAuth(auth, home)).toThrow(
      "ATOM_ENCRYPTION_KEY must be a 64-character hex string"
    );
  });
});

// Task 3.3: team (shared, admin-managed) keys.
describe("team key metadata", () => {
  test("setTeamManaged round-trips through save/load; credential edits keep the mark", () => {
    let auth = setStoredKey(emptyAuth(), "openai", "sk-team");
    auth = setTeamManaged(auth, "openai", "alice");
    auth = setSubscriptionAuth(auth, "openai", {
      type: "oauth",
      accessToken: "tok",
    });
    saveAuth(auth, home);

    const loaded = loadAuth(home);
    expect(getTeamManaged(loaded, "openai")).toBe("alice");
    expect(getStoredKey(loaded, "openai")).toBe("sk-team");

    // Replacing the key (the setter the guard lets through) keeps attribution.
    const replaced = setStoredKey(loaded, "openai", "sk-next");
    expect(getTeamManaged(replaced, "openai")).toBe("alice");

    // Clearing the mark keeps the credential itself.
    const unshared = clearTeamManaged(replaced, "openai");
    expect(getTeamManaged(unshared, "openai")).toBeUndefined();
    expect(getStoredKey(unshared, "openai")).toBe("sk-next");

    // Full credential removal (logout) drops the mark with it.
    const loggedOut = clearSubscriptionAuth(replaced, "openai");
    expect(getTeamManaged(loggedOut, "openai")).toBeUndefined();
    expect(getStoredKey(loggedOut, "openai")).toBe("sk-next");
  });

  test("an empty or malformed managedBy never survives a load", () => {
    writeAuthJson({
      version: 2,
      keyVersion: 1,
      providers: {
        openai: { apiKey: "sk-x", team: { managedBy: "" } },
        anthropic: { apiKey: "sk-y", team: "alice" },
      },
    });
    const loaded = loadAuth(home);
    expect(getTeamManaged(loaded, "openai")).toBeUndefined();
    expect(getTeamManaged(loaded, "anthropic")).toBeUndefined();
    // The keys themselves are untouched.
    expect(getStoredKey(loaded, "openai")).toBe("sk-x");
    expect(getStoredKey(loaded, "anthropic")).toBe("sk-y");
  });

  test("marking an unmarked provider and clearing an unmarked one are no-ops on data", () => {
    const auth = setStoredKey(emptyAuth(), "openai", "sk-local");
    expect(getTeamManaged(auth, "openai")).toBeUndefined();
    const cleared = clearTeamManaged(auth, "openai");
    expect(getStoredKey(cleared, "openai")).toBe("sk-local");
    expect(getTeamManaged(cleared, "openai")).toBeUndefined();
  });
});
