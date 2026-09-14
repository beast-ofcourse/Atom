// Paste hardening (07 paste slice, G3): long-paste collapse, pasted-filepath
// attach, pasted-image attach. Pure helpers + one async existence check —
// App.tsx wires these to state (pastedChunksRef/mentionsRef) and the usePaste
// handler. Mirrors the src/ui/mentions.ts + src/ui/shell.ts style: no React,
// no Ink, never throws, never persists (pasted secrets stay in-memory only).
import * as fs from "node:fs";
import * as path from "node:path";

// opencode parity (prompt/index.tsx pasteInputText): collapse when
// lineCount >= 3 OR length > 150. Visible draft shows a one-line summary;
// the full text rides a PastedChunk and is restored at submit time.
const PASTE_COLLAPSE_LINES = 3;
const PASTE_COLLAPSE_CHARS = 150;
export const PASTE_MAX_ATTACHMENTS = 8;

function pasteLineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

export function shouldCollapsePaste(text: string): boolean {
  return pasteLineCount(text) >= PASTE_COLLAPSE_LINES || text.length > PASTE_COLLAPSE_CHARS;
}

// One-line visible summary for a collapsed paste. Unique per live token set:
// repeats of the same size get a ` #n` suffix so chunk re-anchor stays 1:1
// (mirrors the mentions token approach).
export function pasteSummaryToken(content: string, liveTokens: string[] = []): string {
  const base = `[Pasted ~${pasteLineCount(content)} lines]`;
  if (!liveTokens.includes(base)) return base;
  let n = 2;
  while (liveTokens.includes(`${base.slice(0, -1)} #${n}]`)) n += 1;
  return `${base.slice(0, -1)} #${n}]`;
}

// Raw binary/image bytes pasted with no usable path (Ink gives no clipboard
// mime, so \0 is the signal): visible draft shows [Image N], never garbage.
export function pasteImageToken(n: number): string {
  return `[Image ${n}]`;
}

export function containsBinary(text: string): boolean {
  return text.includes("\0");
}

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".svg",
  ".avif",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".pdf",
]);

function isImagePathLike(p: string): boolean {
  const ext = path.extname(p.trim().toLowerCase());
  return IMAGE_EXTS.has(ext);
}

export type PastedChunk = {
  token: string; // one-line summary visible in the draft
  full: string; // full pasted content restored into the submit payload
};

// Drop chunks whose summary token no longer appears in the draft (re-anchor
// on edits — same contract as pruneMentions).
export function prunePastedChunks(input: string, chunks: PastedChunk[]): PastedChunk[] {
  return chunks.filter((c) => input.includes(c.token));
}

// Restore full pasted content for submit. Sequential replace (first token
// occurrence per chunk in order) so identical summaries from distinct pastes
// each restore their own text.
export function expandPastedSummaries(input: string, chunks: PastedChunk[]): string {
  let out = input;
  for (const c of chunks) {
    if (!out.includes(c.token)) continue;
    out = out.replace(c.token, () => c.full);
  }
  return out;
}

// Candidate path strings found in a paste: the whole trimmed blob plus each
// trimmed line (quotes stripped), so both "is a path" and "contains a path
// per line" pastes attach. Capped; never throws.
export function extractPastedPathCandidates(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const cand = raw.trim().replace(/^["']+|["']+$/g, "").trim();
    if (!cand || cand.length > 500 || cand.includes("\0")) return;
    if (cand === "/" || cand === "." || cand === ".." || cand === "~") return;
    if (seen.has(cand)) return;
    seen.add(cand);
    out.push(cand);
  };
  push(text);
  for (const line of text.split("\n")) push(line);
  return out.slice(0, PASTE_MAX_ATTACHMENTS);
}

// Whitespace-separated tokens inside a line that look path-ish (contain a
// separator or a dotted extension). Whole-line matches are handled by
// extractPastedPathCandidates; this covers "see <path> please" pastes.
export function extractInlinePathCandidates(line: string): string[] {
  const out: string[] = [];
  for (const raw of line.split(/\s+/)) {
    const cand = raw.trim().replace(/^[("'<]+|[)"'">,;:.!?]+$/g, "").replace(/^["']+|["']+$/g, "").trim();
    if (!cand || cand.length < 3 || cand.length > 500 || cand.includes("\0")) continue;
    if (!cand.includes("/") && !cand.includes("\\") && !cand.includes(":") && !/\.[A-Za-z0-9]{1,5}$/.test(cand)) continue;
    if (!out.includes(cand)) out.push(cand);
    if (out.length >= PASTE_MAX_ATTACHMENTS) break;
  }
  return out;
}

export type PastedPathHit = {
  candidate: string; // as typed in the paste (pre-strip display)
  abs: string; // resolved absolute path
  rel: string; // mention path: cwd-relative when inside cwd, else absolute
  isImage: boolean;
};

// Stat each candidate; return the ones that exist locally (files or dirs).
// Relative candidates resolve against cwd. Never throws — unreadable/missing
// just means "not a path, paste verbatim".
export async function findExistingPastedPaths(
  candidates: string[],
  cwd: string = process.cwd()
): Promise<PastedPathHit[]> {
  const hits: PastedPathHit[] = [];
  for (const candidate of candidates.slice(0, PASTE_MAX_ATTACHMENTS)) {
    const abs = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
    let ok = false;
    try {
      const st = await fs.promises.stat(abs);
      ok = st.isFile() || st.isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) continue;
    const relInside = path.relative(cwd, abs);
    const rel = relInside === "" ? "." : !relInside.startsWith("..") && !path.isAbsolute(relInside) ? relInside.split(path.sep).join("/") : abs;
    hits.push({ candidate, abs, rel, isImage: isImagePathLike(abs) });
    if (hits.length >= PASTE_MAX_ATTACHMENTS) break;
  }
  return hits;
}
