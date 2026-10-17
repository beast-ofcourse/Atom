// Credential audit log (Task 3.3): append-only JSONL at ~/.atom/audit.jsonl
// recording who changed credentials and when. Best-effort by design — an
// unwritable log never breaks a login — and it never stores key material:
// events carry action/provider/context only, never a token or key value.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomDir } from "./auth.js";

export type AuditAction =
  | "login"
  | "logout"
  | "oauth-login"
  | "token-refresh"
  | "share"
  | "unshare";

export type AuditEvent = {
  /** ISO timestamp of the event. */
  at: string;
  action: AuditAction;
  provider: string;
  /** Local OS user the change was made by. */
  actor: string;
  /** Token-free context (plan name, admin name, failure reason). */
  detail?: string;
};

const AUDIT_FILE_NAME = "audit.jsonl";
/** Newest events returned by default (viewing is newest-first). */
export const AUDIT_READ_LIMIT = 50;

export function auditFilePath(home?: string): string {
  return path.join(atomDir(home), AUDIT_FILE_NAME);
}

/** The local OS user for attribution; never throws. */
export function currentActor(): string {
  try {
    const name = os.userInfo().username;
    return name.length > 0 ? name : "unknown";
  } catch {
    return "unknown";
  }
}

export type AuditEventInput = {
  action: AuditAction;
  provider: string;
  detail?: string;
};

/**
 * Append one event. Best-effort: any filesystem failure is swallowed with
 * an explicit comment — the audit trail must never break the credential
 * change it is observing, and retrying it is pointless (next event logs).
 */
export function recordAuditEvent(home: string | undefined, input: AuditEventInput): void {
  try {
    mkdirSync(atomDir(home), { recursive: true });
    const event: AuditEvent = {
      at: new Date().toISOString(),
      action: input.action,
      provider: input.provider,
      actor: currentActor(),
    };
    if (input.detail && input.detail.length > 0) event.detail = input.detail;
    appendFileSync(auditFilePath(home), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // best-effort trail — never fail a login over the audit file
  }
}

function parseAuditLine(line: string): AuditEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const raw: unknown = JSON.parse(trimmed);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    if (
      typeof record["at"] !== "string" ||
      typeof record["action"] !== "string" ||
      typeof record["provider"] !== "string" ||
      typeof record["actor"] !== "string"
    ) {
      return undefined;
    }
    const event: AuditEvent = {
      at: record["at"],
      action: record["action"] as AuditAction,
      provider: record["provider"],
      actor: record["actor"],
    };
    if (typeof record["detail"] === "string" && record["detail"].length > 0) {
      event.detail = record["detail"];
    }
    return event;
  } catch {
    return undefined; // a corrupt line is skipped, never fatal
  }
}

/**
 * The newest `limit` events, newest first. Unreadable or missing logs
 * yield []; corrupt lines are skipped.
 */
export function readAuditEvents(
  home?: string,
  limit: number = AUDIT_READ_LIMIT
): AuditEvent[] {
  try {
    const file = auditFilePath(home);
    if (!existsSync(file)) return [];
    const events: AuditEvent[] = [];
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
      const event = parseAuditLine(lines[i] ?? "");
      if (event) events.push(event);
    }
    return events;
  } catch {
    return [];
  }
}

// One human line: "2026-10-07 19:05:12 alice oauth-login openai (pro)".
export function formatAuditEvent(event: AuditEvent): string {
  const stamp = event.at.length >= 19 ? event.at.slice(0, 19).replace("T", " ") : event.at;
  const detail = event.detail ? ` (${event.detail})` : "";
  return `${stamp} ${event.actor} ${event.action} ${event.provider}${detail}`;
}
