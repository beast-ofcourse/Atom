// Stale-read fingerprints: readTool records a content hash per resolved
// path; editTool refuses when the file changed since the model last read
// it; /rewind restores refresh (or forget) the record per file.
import { createHash } from "node:crypto";
// Read-tracking guard: readTool records a sha1 of the full file content per
// resolved absolute path after each successful FILE read (directory listings
// are not tracked). editTool refuses when a record exists and the current
// content hash differs — the file changed since the model last read it
// (user's editor, git checkout, another tool). Limit: files never read this
// session have no record, so the guard cannot catch those (e.g. content
// learned via grep). Successful writeTool/editTool refresh the record so
// read→write→edit and edit→edit chains never false-refuse; identical
// rewrites (same hash) never trigger.
export const readFingerprints = new Map<string, string>();

export function fingerprintKey(abs: string): string {
  return abs;
}

export function contentHash(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

// Ticket 01 (/rewind): a restore writes bytes behind these executors, so the
// caller refreshes (or forgets, on deletion) the stale-read fingerprint per
// restored file — otherwise the next edit would false-refuse as a stale read.
export function refreshReadFingerprint(abs: string, text: string): void {
  if (typeof abs !== "string" || typeof text !== "string") return;
  readFingerprints.set(fingerprintKey(abs), contentHash(text));
}

export function forgetReadFingerprint(abs: string): void {
  if (typeof abs !== "string") return;
  readFingerprints.delete(fingerprintKey(abs));
}
