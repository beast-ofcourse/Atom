// Pure input-editing model: multiline cursor math, line/word kills, paste
// normalization, and history-browse index ops. No React, no Ink — the App
// wires these to state, and the unit tests pin them here.
//
// Phase 4: cursor math moves in Intl.Segmenter graphemes (never splits
// emoji/ZWJ/CJK clusters) with CJK width awareness for vertical motion;
// paste markers are atomic units (cursor steps over, kills take the whole
// marker). ASCII behavior is byte-identical to the legacy UTF-16 math.
export const INPUT_HISTORY_CAP = 100;

export function splitInputLines(text: string): string[] {
  return text.split("\n");
}

// --- Graphemes (Phase 4.2) ---

let segmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    segmenter =
      typeof Intl !== "undefined" && "Segmenter" in Intl
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
}

/** Grapheme clusters of a single line (no newlines inside). */
export function graphemesOf(s: string): string[] {
  const seg = getSegmenter();
  if (seg) {
    try {
      const out: string[] = [];
      for (const part of seg.segment(s)) out.push(part.segment);
      return out;
    } catch {
      // fall through to code-point split
    }
  }
  return Array.from(s);
}

/** UTF-16 offsets of every grapheme boundary in s (starts 0, ends s.length). */
export function graphemeBoundaries(s: string): number[] {
  const gs = graphemesOf(s);
  const out: number[] = [0];
  let acc = 0;
  for (const g of gs) {
    acc += g.length;
    out.push(acc);
  }
  return out;
}

/** Snap an offset down to the nearest grapheme boundary (cursor can never sit inside a cluster). */
export function clampToGraphemeBoundary(s: string, offset: number): number {
  const safe = Math.max(0, Math.min(offset, s.length));
  const bounds = graphemeBoundaries(s);
  let lo = 0;
  for (const b of bounds) {
    if (b <= safe) lo = b;
    else break;
  }
  return lo;
}

/** Grapheme index of the boundary at/before offset. */
export function graphemeIndexAt(s: string, offset: number): number {
  const clamped = clampToGraphemeBoundary(s, offset);
  const bounds = graphemeBoundaries(s);
  const i = bounds.indexOf(clamped);
  return i === -1 ? 0 : i;
}

/** UTF-16 offset of the start of grapheme idx (clamped). */
export function offsetAtGraphemeIndex(s: string, idx: number): number {
  const bounds = graphemeBoundaries(s);
  const i = Math.max(0, Math.min(idx, bounds.length - 1));
  return bounds[i]!;
}

/** Previous grapheme boundary strictly before offset (stays put at 0). */
export function prevGraphemeBoundary(s: string, offset: number): number {
  const clamped = clampToGraphemeBoundary(s, offset);
  if (clamped <= 0) return 0;
  const bounds = graphemeBoundaries(s);
  const i = bounds.indexOf(clamped);
  return bounds[Math.max(0, i - 1)]!;
}

/** Next grapheme boundary strictly after offset (stays put at end). */
export function nextGraphemeBoundary(s: string, offset: number): number {
  const safe = Math.max(0, Math.min(offset, s.length));
  const bounds = graphemeBoundaries(s);
  for (const b of bounds) {
    if (b > safe) return b;
  }
  return s.length;
}

// CJK width awareness: wide (W/F) code points + emoji present as 2 columns,
// everything else 1. ZWJ sequences contain emoji → 2. Narrow table inline
// (Node has no built-in east-asian-width accessor — `util` carries none).
const WIDE_RE =
  /[\u1100-\u115F\u231A-\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD-\u25FE\u2614-\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA-\u26AB\u26BD-\u26BE\u26C4-\u26C5\u26CE\u26D4\u26EA\u26F2-\u26F3\u26F5\u26FA\u26FD\u2705\u270A-\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B-\u2B1C\u2B50\u2B55\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

let emojiRe: RegExp | null | undefined;

function isWideGrapheme(g: string): boolean {
  if (!g) return false;
  if (WIDE_RE.test(g)) return true;
  try {
    if (emojiRe === undefined) {
      emojiRe =
        typeof RegExp === "function"
          ? new RegExp("\\p{Extended_Pictographic}", "u")
          : null;
    }
    if (emojiRe && emojiRe.test(g)) return true;
  } catch {
    // regexp engine without unicode property support — wide table above stands
  }
  const cp = g.codePointAt(0) ?? 0;
  if (cp >= 0x20000 && cp <= 0x3fffd) return true;
  return false;
}

export function graphemeWidth(g: string): 1 | 2 {
  return isWideGrapheme(g) ? 2 : 1;
}

/** Visual column width of the first `count` graphemes of a line. */
export function visualWidthOf(line: string, graphemeCount: number): number {
  const gs = graphemesOf(line);
  const n = Math.max(0, Math.min(graphemeCount, gs.length));
  let w = 0;
  for (let i = 0; i < n; i++) w += graphemeWidth(gs[i]!);
  return w;
}

/** Grapheme index whose visual start best matches target width (nearest, ties go left). */
export function graphemeIndexForVisualWidth(
  line: string,
  target: number,
): number {
  const gs = graphemesOf(line);
  let w = 0;
  let best = 0;
  let bestDist = Math.abs(target - 0);
  for (let i = 0; i < gs.length; i++) {
    w += graphemeWidth(gs[i]!);
    const dist = Math.abs(target - w);
    if (dist < bestDist) {
      bestDist = dist;
      best = i + 1;
    }
    if (w > target && dist >= bestDist) break;
  }
  return best;
}

/** Split a line at a grapheme index into before/cursor-grapheme/after for the inverse cursor. */
export function splitLineAtGrapheme(
  line: string,
  graphemeIdx: number,
): { before: string; at: string; after: string } {
  const gs = graphemesOf(line);
  const i = Math.max(0, Math.min(graphemeIdx, gs.length));
  return {
    before: gs.slice(0, i).join(""),
    at: gs[i] ?? "",
    after: gs.slice(i + 1).join(""),
  };
}

export function lineColOf(text: string, offset: number): { line: number; col: number } {
  const safe = Math.max(0, Math.min(offset, text.length));
  const lines = splitInputLines(text);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const len = line.length;
    if (safe <= acc + len || i === lines.length - 1) {
      // col is a grapheme index (ASCII-identical to UTF-16 units).
      return { line: i, col: graphemeIndexAt(line, safe - acc) };
    }
    acc += len + 1;
  }
  return { line: 0, col: 0 };
}

export function offsetOfLines(lines: string[], line: number, col: number): number {
  const l = Math.max(0, Math.min(line, lines.length - 1));
  const lineText = lines[l] ?? "";
  // col is a grapheme index — clamp to the grapheme count, not UTF-16 length.
  const c = Math.max(0, Math.min(col, graphemesOf(lineText).length));
  let acc = 0;
  for (let i = 0; i < l; i++) acc += lines[i]!.length + 1;
  return acc + offsetAtGraphemeIndex(lineText, c);
}

// Vertical cursor motion. `edge` is true when already on the first/last
// line — the caller falls through to history browse instead of moving.
// Column preservation is visual-width aware so CJK/wide graphemes track.
export function moveVertically(
  text: string,
  offset: number,
  dir: -1 | 1
): { offset: number; edge: boolean } {
  const lines = splitInputLines(text);
  const { line, col } = lineColOf(text, offset);
  const next = line + dir;
  if (next < 0 || next >= lines.length) return { offset, edge: true };
  const visual = visualWidthOf(lines[line]!, col);
  const targetCol = graphemeIndexForVisualWidth(lines[next]!, visual);
  return { offset: offsetOfLines(lines, next, targetCol), edge: false };
}

// Ctrl+K: delete to end of the current line; at line end (with more lines)
// delete the newline itself (join). Ctrl+U: delete to line start.
export function killToLineEnd(text: string, offset: number): { text: string; offset: number } {
  const safe = clampToGraphemeBoundary(text, offset);
  const nl = text.indexOf("\n", safe);
  if (nl === -1) {
    if (safe >= text.length) return { text, offset: safe };
    return { text: text.slice(0, safe), offset: safe };
  }
  if (nl === safe) return { text: text.slice(0, safe) + text.slice(safe + 1), offset: safe };
  return { text: text.slice(0, safe) + text.slice(nl), offset: safe };
}

export function killToLineStart(text: string, offset: number): { text: string; offset: number } {
  const safe = clampToGraphemeBoundary(text, offset);
  const { line, col } = lineColOf(text, safe);
  if (col === 0) return { text, offset: safe };
  const lines = splitInputLines(text);
  const start = offsetOfLines(lines, line, 0);
  return { text: text.slice(0, start) + text.slice(safe), offset: start };
}

// Ctrl+W: delete the word before the cursor (word chars + the gap before
// it). Words are [A-Za-z0-9_]+ runs; anything else is a single-grapheme step
// when no word precedes (punctuation never eats a whole run).
export function killWordBefore(text: string, offset: number): { text: string; offset: number } {
  let at = clampToGraphemeBoundary(text, offset);
  if (at <= 0) return { text, offset: 0 };
  let start = at;
  while (start > 0 && /\s/.test(text[start - 1]!)) {
    start = prevGraphemeBoundary(text, start);
  }
  // A skipped gap is the whole kill unit ("foo   " → "foo", not "").
  if (start < at) return { text: text.slice(0, start) + text.slice(at), offset: start };
  if (/[\w]/.test(text[start - 1]!)) {
    while (start > 0 && /[\w]/.test(text[start - 1]!)) {
      start = prevGraphemeBoundary(text, start);
    }
  } else {
    start = prevGraphemeBoundary(text, start);
  }
  return { text: text.slice(0, start) + text.slice(at), offset: start };
}

// --- Paste markers, atomic (Phase 4.1) ---
//
// Markers are opaque one-line tokens standing in for hidden full text
// (App paste chunks: `[Pasted ~N lines]`, `[Image N]`, file paths; the
// input-model registry below: `[paste #n +m lines]`). All helpers take the
// live marker strings explicitly — the model never owns registry state, so
// units stay pure and callers (App) pass `pastedChunks.map(c => c.token)`.

export const PASTE_MARKER_LINES = 10;
export const PASTE_MARKER_CHARS = 1000;
export const PASTE_REGISTRY_CAP = 20;

export function shouldCollapseToMarker(text: string): boolean {
  if (!text) return false;
  return text.split("\n").length >= PASTE_MARKER_LINES || text.length > PASTE_MARKER_CHARS;
}

export function pasteMarkerFor(id: number, text: string): string {
  const lines = text.length === 0 ? 0 : text.split("\n").length;
  return `[paste #${id} +${lines} lines]`;
}

export type PasteChunk = { token: string; full: string };

/** Bounded push: oldest drops past the cap with its marker text frozen inline (caller keeps the token literal — the dropped mapping simply stops expanding). */
export function pushPasteChunk(
  chunks: PasteChunk[],
  chunk: PasteChunk,
  cap: number = PASTE_REGISTRY_CAP,
): PasteChunk[] {
  const next = [...chunks, chunk];
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
}

/** Restore full pasted content for submit (byte-exact). Sequential first-occurrence replace per chunk so duplicate tokens each restore their own text. */
export function expandPasteMarkers(input: string, chunks: PasteChunk[]): string {
  let out = input;
  for (const c of chunks) {
    if (!out.includes(c.token)) continue;
    out = out.replace(c.token, () => c.full);
  }
  return out;
}

type MarkerSpan = { start: number; end: number };

function markerSpans(input: string, markers: readonly string[]): MarkerSpan[] {
  const spans: MarkerSpan[] = [];
  for (const m of markers) {
    if (!m) continue;
    let from = 0;
    while (from <= input.length) {
      const at = input.indexOf(m, from);
      if (at === -1) break;
      spans.push({ start: at, end: at + m.length });
      from = at + Math.max(1, m.length);
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/** Expand [delStart, delEnd) to cover every partially-overlapped marker fully (kills take the whole marker; fully-covered markers delete as-is). */
export function expandRangeOverMarkers(
  input: string,
  delStart: number,
  delEnd: number,
  markers: readonly string[] = [],
): { start: number; end: number } {
  let start = Math.max(0, Math.min(delStart, delEnd));
  let end = Math.max(delStart, delEnd);
  if (markers.length === 0 || end <= start) return { start, end };
  for (const s of markerSpans(input, markers)) {
    if (s.start < end && s.end > start) {
      start = Math.min(start, s.start);
      end = Math.max(end, s.end);
    }
  }
  return { start, end };
}

/** Cursor step right: marker start/jump wins (atomic), else one grapheme. */
export function moveCursorRightAtomic(
  input: string,
  offset: number,
  markers: readonly string[] = [],
): number {
  const safe = Math.max(0, Math.min(offset, input.length));
  for (const s of markerSpans(input, markers)) {
    if (safe >= s.start && safe < s.end) return s.end;
  }
  return nextGraphemeBoundary(input, safe);
}

/** Cursor step left: marker end/jump wins (atomic), else one grapheme. */
export function moveCursorLeftAtomic(
  input: string,
  offset: number,
  markers: readonly string[] = [],
): number {
  const safe = Math.max(0, Math.min(offset, input.length));
  for (const s of markerSpans(input, markers)) {
    if (safe > s.start && safe <= s.end) return s.start;
  }
  return prevGraphemeBoundary(input, safe);
}

/** Backspace: whole marker when abutting/inside one, else one grapheme. */
export function backspaceAtomic(
  text: string,
  offset: number,
  markers: readonly string[] = [],
): { text: string; offset: number } {
  // Snap interior offsets to a boundary first — slicing at an interior
  // offset would split a surrogate/ZWJ cluster.
  const safe = clampToGraphemeBoundary(text, offset);
  if (safe <= 0) return { text, offset: 0 };
  for (const s of markerSpans(text, markers)) {
    if (safe > s.start && safe <= s.end) {
      return { text: text.slice(0, s.start) + text.slice(s.end), offset: s.start };
    }
  }
  const delStart = prevGraphemeBoundary(text, safe);
  const { start } = expandRangeOverMarkers(text, delStart, safe, markers);
  return { text: text.slice(0, start) + text.slice(safe), offset: start };
}

/** Delete-forward: whole marker when abutting/inside one, else one grapheme. */
export function deleteForwardAtomic(
  text: string,
  offset: number,
  markers: readonly string[] = [],
): { text: string; offset: number } {
  const safe = clampToGraphemeBoundary(text, offset);
  if (safe >= text.length) return { text, offset: safe };
  for (const s of markerSpans(text, markers)) {
    if (safe >= s.start && safe < s.end) {
      return { text: text.slice(0, s.start) + text.slice(s.end), offset: s.start };
    }
  }
  const delEnd = nextGraphemeBoundary(text, safe);
  const { end } = expandRangeOverMarkers(text, safe, delEnd, markers);
  return { text: text.slice(0, safe) + text.slice(end), offset: safe };
}

// Bracketed-paste content arrives verbatim (including newlines) — only line
// endings normalize. Pasted text never submits, even when multiline.
export function normalizePaste(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// History is in-memory only (never persisted: prompts may carry pasted
// secrets, and the session file warns as much). Blank + consecutive-duplicate
// submits are skipped; oldest drops past the cap.
export function pushInputHistory(hist: string[], text: string): string[] {
  if (!text.trim()) return hist;
  if (hist.length > 0 && hist[hist.length - 1] === text) return hist;
  const next = [...hist, text];
  if (next.length > INPUT_HISTORY_CAP) next.splice(0, next.length - INPUT_HISTORY_CAP);
  return next;
}

export function historyOlderIndex(hist: string[], index: number | null): number | null {
  if (hist.length === 0) return null;
  if (index === null) return hist.length - 1;
  return Math.max(0, index - 1);
}

// Past the newest entry → null (the caller restores the stashed draft).
export function historyNewerIndex(hist: string[], index: number | null): number | null {
  if (index === null) return null;
  const next = index + 1;
  return next >= hist.length ? null : next;
}
