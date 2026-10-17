// Team/enterprise features (Task 3.3) at the TUI level: /login share marks
// a stored key admin-managed, /login status names the admin, /logout
// refuses until /login unshare, and /login audit lists the changes newest
// first — plus the paste-prompt guard that refuses to overwrite a
// team-managed key before any health check runs. Hermetic: a temp authHome
// holds auth.json + audit.jsonl; the real ~/.atom is never touched and no
// network call is made.
import React from "react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { readAuditEvents } from "../src/audit.js";
import { emptyAuth, getStoredKey, loadAuth, saveAuth, setStoredKey, setTeamManaged } from "../src/auth.js";
import { waitForFrame } from "./helpers/wait-for-frame.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const SEEDED_KEY = "sk-team-test-key-12345";

let authHome: string;
let fetchSpy: ReturnType<typeof vi.fn>;

// Slash commands must arrive as separate stdin writes: text, then the
// carriage return (the pattern every other TUI test uses — one chunk
// races the composer's render).
function send(app: ReturnType<typeof renderApp>, command: string): void {
  app.stdin.write(command);
  app.stdin.write("\r");
}

function renderApp() {
  return render(
    <App
      apiKey="test-key"
      endpoint={ENDPOINT}
      initialModel="big-pickle"
      initialModels={["big-pickle"]}
      authHome={authHome}
    />
  );
}

beforeEach(() => {
  authHome = mkdtempSync(path.join(tmpdir(), "atom-team-keys-test-"));
  saveAuth(setStoredKey(emptyAuth(), "openai", SEEDED_KEY), authHome);
  fetchSpy = vi.fn(async () => {
    throw new Error("network is disabled in this test");
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { fetch?: unknown }).fetch;
  rmSync(authHome, { recursive: true, force: true });
});

describe("team-managed keys in the TUI", () => {
  test("share → status names the admin → logout refuses → unshare → logout clears → audit lists it", async () => {
    const app = renderApp();
    try {
      send(app, "/login share openai alice");
      await waitForFrame(app, "paste/logout are locked");
      expect(loadAuth(authHome).providers.openai?.team?.managedBy).toBe("alice");

      send(app, "/login status");
      await waitForFrame(app, "(team: alice)");

      // Logout refuses while shared — the key must survive untouched.
      send(app, "/logout openai");
      await waitForFrame(app, "/login unshare openai first");
      expect(getStoredKey(loadAuth(authHome), "openai")).toBe(SEEDED_KEY);

      send(app, "/login unshare openai");
      await waitForFrame(app, "local again");
      expect(loadAuth(authHome).providers.openai?.team).toBeUndefined();
      expect(getStoredKey(loadAuth(authHome), "openai")).toBe(SEEDED_KEY);

      // Now logout goes through and clears only the credential.
      send(app, "/logout openai");
      await waitForFrame(app, "Logged out from");
      expect(getStoredKey(loadAuth(authHome), "openai")).toBe("");

      send(app, "/login audit");
      await waitForFrame(app, "credential audit");
      // Newest first: logout, unshare, share — all three recorded.
      expect(readAuditEvents(authHome).map((e) => e.action)).toEqual([
        "logout",
        "unshare",
        "share",
      ]);
      // The audit trail names the admin but never the key.
      const raw = JSON.stringify(readAuditEvents(authHome));
      expect(raw).toContain("alice");
      expect(raw).not.toContain(SEEDED_KEY);
    } finally {
      app.unmount();
    }
  });

  test("the paste prompt refuses a team-managed key before any health check", async () => {
    // Same mark /login share would write, seeded directly for isolation.
    saveAuth(
      setTeamManaged(setStoredKey(emptyAuth(), "openai", SEEDED_KEY), "openai", "alice"),
      authHome,
    );

    const app = renderApp();
    try {
      send(app, "/login openai");
      await waitForFrame(app, "API key");
      app.stdin.write("sk-new-key-should-not-store");
      app.stdin.write("\r");
      await waitForFrame(app, "team-managed by alice");

      // Guard runs before checkProviderHealth: no network call at all.
      expect(fetchSpy).not.toHaveBeenCalled();
      // The stored key was never replaced.
      expect(getStoredKey(loadAuth(authHome), "openai")).toBe(SEEDED_KEY);
    } finally {
      app.unmount();
    }
  });
});
