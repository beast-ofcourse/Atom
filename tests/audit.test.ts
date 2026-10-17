// Credential audit log (src/audit.ts): append/read round-trip, newest-first
// limiting, corrupt-line containment, best-effort writes, and a one-line
// format carrying no key material. Hermetic: a temp home directory — the
// real ~/.atom/audit.jsonl is never touched.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AUDIT_READ_LIMIT,
  auditFilePath,
  formatAuditEvent,
  readAuditEvents,
  recordAuditEvent,
} from "../src/audit.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "atom-audit-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("recordAuditEvent / readAuditEvents", () => {
  test("events round-trip newest-first with action, provider, detail, actor, timestamp", () => {
    recordAuditEvent(home, { action: "login", provider: "openai" });
    recordAuditEvent(home, { action: "share", provider: "openai", detail: "alice" });

    const events = readAuditEvents(home);
    expect(events).toHaveLength(2);
    expect(events[0]?.action).toBe("share");
    expect(events[0]?.detail).toBe("alice");
    expect(events[1]?.action).toBe("login");
    expect(events[1]?.detail).toBeUndefined();
    expect(events[0]?.actor.length).toBeGreaterThan(0);
    expect(events[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(events[0]?.provider).toBe("openai");
  });

  test("the read limit caps newest events; a smaller limit narrows it", () => {
    const total = AUDIT_READ_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      recordAuditEvent(home, { action: "token-refresh", provider: "openai" });
    }
    expect(readAuditEvents(home)).toHaveLength(AUDIT_READ_LIMIT);
    expect(readAuditEvents(home, 3)).toHaveLength(3);
    // The full log still holds every line on disk.
    expect(readAuditEvents(home, total)).toHaveLength(total);
  });

  test("a missing log reads as empty; corrupt lines are skipped, never fatal", () => {
    expect(readAuditEvents(home)).toEqual([]);

    recordAuditEvent(home, { action: "login", provider: "openai" });
    appendFileSync(auditFilePath(home), "{broken json\n", "utf8");
    appendFileSync(
      auditFilePath(home),
      JSON.stringify({ at: "not-enough-fields" }) + "\n",
      "utf8"
    );

    const events = readAuditEvents(home);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("login");
  });

  test("an unwritable location never throws (best-effort trail)", () => {
    // A file where the .atom directory should go: every write path fails.
    const blocked = path.join(home, "not-a-dir");
    writeFileSync(blocked, "x", "utf8");
    expect(() =>
      recordAuditEvent(blocked, { action: "login", provider: "openai" })
    ).not.toThrow();
    expect(readAuditEvents(blocked)).toEqual([]);
  });

  test("events never carry a key field — only the declared fields are written", () => {
    recordAuditEvent(home, { action: "login", provider: "openai" });
    recordAuditEvent(home, { action: "share", provider: "openai", detail: "alice" });
    const raw = readFileSync(auditFilePath(home), "utf8");
    for (const line of raw.trim().split("\n")) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(
        ["action", "actor", "at", "provider"].concat(
          parsed.detail !== undefined ? ["detail"] : []
        ).sort()
      );
    }
  });
});

describe("formatAuditEvent", () => {
  test("one readable line: timestamp, actor, action, provider, optional detail", () => {
    expect(
      formatAuditEvent({
        at: "2026-10-07T19:05:12.345Z",
        action: "oauth-login",
        provider: "openai",
        actor: "bob",
        detail: "pro",
      })
    ).toBe("2026-10-07 19:05:12 bob oauth-login openai (pro)");
    expect(
      formatAuditEvent({
        at: "2026-10-07T19:05:12.345Z",
        action: "logout",
        provider: "anthropic",
        actor: "bob",
      })
    ).toBe("2026-10-07 19:05:12 bob logout anthropic");
  });

  test("the line contains no key-like material", () => {
    const line = formatAuditEvent({
      at: "2026-10-07T19:05:12.345Z",
      action: "login",
      provider: "openai",
      actor: "bob",
    });
    expect(line).not.toContain("sk-");
    expect(line).not.toContain("token");
  });
});
