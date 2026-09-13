// Zero-dependency unified diff engine for the approval preview.
//
// Claude-Code parity goals (adapted to ATOM's constraints):
// - unified hunks with 3 lines of context + `@@ -a,b +c,d @@` headers
// - word-level highlighting inside paired del/add lines, with a
//   CHANGE_THRESHOLD fallback to line-level when too much changed
// - hard limits so a giant file can never jank the TUI: binary detect and
//   1MB skip (row caps removed — views render the full hunk list; the Myers
//   prefix/suffix fallback + word-token fallback below keep large inputs
//   linear so full rendering stays smooth).
//
// No per-character nodes — one run per word keeps Ink node counts low.
// The React side memoizes per mount (see ui/diff-view.tsx), so this
// stays pure + synchronous: safe to call from the approve() path.
// Syntax color itself lives in ui/highlight.ts (zero-dep tokenizer);
// the language id rides along on the preview payload below.
export type WordRun = { text: string; changed: boolean };

// The single display payload for a write/edit change, shared by the
// approval modal (ApprovalBox), the committed transcript (Turn.diff),
// the /diff review panel (grouped by path), and the registry helper
// that builds it (previewDiffForApproval).
// lang is the highlight family id ("c"/"py"/"sh"/"data") or null for
// unknown files (caller falls back to its own paint). path is the
// tool-arg path (null when absent — ungroupable previews still render,
// they just never join the /diff file list).
export type DiffPreview = {
  oldText: string | null; // null = new file (all additions)
  newText: string;
  lang: string | null;
  path: string | null;
};

export type DiffLine =
  | { kind: "context"; text: string }
  | { kind: "del"; text: string; runs: WordRun[] }
  | { kind: "add"; text: string; runs: WordRun[] };

export type DiffHunk = {
  oldStart: number; // 1-based
  oldLines: number;
  newStart: number; // 1-based
  newLines: number;
  lines: DiffLine[];
};

export type DiffResult = {
  hunks: DiffHunk[];
  adds: number;
  dels: number;
  truncated: boolean;
  skipped: string | null;
  isNewFile: boolean;
};

// Mirrors Claude's StructuredDiffFallback threshold: when the share of
// changed words in a paired line exceeds this, word highlighting would
// be noise — render the whole line flat instead.
export const CHANGE_THRESHOLD = 0.4;
// Mirrors Claude's DiffDetailView guards.
export const MAX_FILE_BYTES = 1_000_000;
// Retained for compatibility (no longer applied — the engine returns the
// full hunk list; views render it whole). Safety caps that remain enforced:
// MAX_FILE_BYTES, binary detect, MAX_MYERS_LINES fallback, MAX_WORD_TOKENS
// fallback.
export const MAX_CHANGED_LINES = 400;
export const DIFF_CONTEXT = 3;
// Worst-case guards for the O(ND) Myers pass + O(w1*w2) word pass.
const MAX_MYERS_LINES = 1000;
const MAX_WORD_TOKENS = 200;

function splitLines(s: string): string[] {
  if (s === "") return [];
  return s.replace(/\r\n?/g, "\n").split("\n");
}

function isBinary(s: string): boolean {
  return s.includes("\0");
}

// Tokenize into words + whitespace runs (whitespace kept so runs
// rejoin byte-identical to the source line).
function tokenize(line: string): string[] {
  const out = line.split(/(\s+)/g).filter((t) => t.length > 0);
  return out.length > 0 ? out : [line];
}

function isWord(tok: string): boolean {
  return /\S/.test(tok);
}

// LCS table for small sequences (lines or words). Returns the matched
// index pairs in order.
function lcsPairs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  // Uint16 caps at 65535 — sequences here are small (words) or
  // Myers-capped (lines); guard anyway.
  const use32 = n > 6000 || m > 6000;
  const w = m + 1;
  const dp = use32 ? new Uint32Array((n + 1) * w) : new Uint16Array((n + 1) * w);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const v = eq(a[i - 1]!, b[j - 1]!)
        ? dp[(i - 1) * w + (j - 1)]! + 1
        : Math.max(dp[(i - 1) * w + j]!, dp[i * w + (j - 1)]!);
      dp[i * w + j] = v > 65535 && !use32 ? 65535 : v;
    }
  }
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (eq(a[i - 1]!, b[j - 1]!)) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (dp[(i - 1) * w + j]! >= dp[i * w + (j - 1)]!) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  pairs.reverse();
  return pairs;
}

type EditOp = { kind: "same" | "del" | "add"; a?: number; b?: number };

// Myers O(ND) line diff with a hard cell budget — falls back to a
// single del/add block when the files are too big to trace exactly.
// Returns ops over old lines (a) and new lines (b).
function myersOps(a: string[], b: string[]): EditOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, j) => ({ kind: "add" as const, b: j }));
  if (m === 0) return a.map((_, i) => ({ kind: "del" as const, a: i }));
  if (n + m > MAX_MYERS_LINES) {
    // Linear fallback: common prefix/suffix, middle is one block.
    let pre = 0;
    while (pre < n && pre < m && a[pre] === b[pre]) pre += 1;
    let suf = 0;
    while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf += 1;
    const ops: EditOp[] = [];
    for (let i = 0; i < pre; i++) ops.push({ kind: "same", a: i, b: i });
    for (let i = pre; i < n - suf; i++) ops.push({ kind: "del", a: i });
    for (let j = pre; j < m - suf; j++) ops.push({ kind: "add", b: j });
    for (let k = 0; k < suf; k++) ops.push({ kind: "same", a: n - suf + k, b: m - suf + k });
    return ops;
  }
  // Exact Myers when small: LCS pairs, then expand to ops.
  const pairs = lcsPairs(a, b, (x, y) => x === y);
  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of pairs) {
    while (i < pi) ops.push({ kind: "del", a: i++ });
    while (j < pj) ops.push({ kind: "add", b: j++ });
    ops.push({ kind: "same", a: i++, b: j++ });
  }
  while (i < n) ops.push({ kind: "del", a: i++ });
  while (j < m) ops.push({ kind: "add", b: j++ });
  return ops;
}

function flatRuns(text: string): WordRun[] {
  return text === "" ? [] : [{ text, changed: false }];
}

// Word-level pairing for one del/add line pair. Returns runs for both
// sides; falls back to flat (line-level) when the pair is too big or
// too changed (CHANGE_THRESHOLD). Exported: the side-by-side builder
// below and the cell renderer (ui/diff-view) share it.
export function wordRuns(delText: string, addText: string): { del: WordRun[]; add: WordRun[] } {
  const dt = tokenize(delText);
  const at = tokenize(addText);
  if (dt.length > MAX_WORD_TOKENS || at.length > MAX_WORD_TOKENS) {
    return { del: flatRuns(delText), add: flatRuns(addText) };
  }
  const pairs = lcsPairs(dt, at, (x, y) => x === y);
  const delKeep = new Set(pairs.map(([i]) => i));
  const addKeep = new Set(pairs.map(([, j]) => j));
  const dw = dt.filter((t, i) => !delKeep.has(i) && isWord(t)).length;
  const aw = at.filter((t, j) => !addKeep.has(j) && isWord(t)).length;
  // Share of changed words over ALL tokens (whitespace included — it
  // almost always matches, so a single changed word in a normal line
  // stays well under the threshold while near-total rewrites exceed
  // it and fall back to line-level).
  const denom = Math.max(dt.length, at.length, 1);
  if ((dw + aw) / denom > CHANGE_THRESHOLD) {
    return { del: flatRuns(delText), add: flatRuns(addText) };
  }
  const build = (toks: string[], keep: Set<number>): WordRun[] => {
    const runs: WordRun[] = [];
    for (let k = 0; k < toks.length; k++) {
      const changed = !keep.has(k) && isWord(toks[k]!);
      const prev = runs[runs.length - 1];
      if (prev && prev.changed === changed) prev.text += toks[k]!;
      else runs.push({ text: toks[k]!, changed });
    }
    return runs;
  };
  return { del: build(dt, delKeep), add: build(at, addKeep) };
}

export function computeDiff(oldText: string | null, newText: string): DiffResult {
  const empty: DiffResult = {
    hunks: [],
    adds: 0,
    dels: 0,
    truncated: false,
    skipped: null,
    isNewFile: oldText === null,
  };
  if (isBinary(newText) || (oldText !== null && isBinary(oldText))) {
    return { ...empty, skipped: "binary file — diff skipped" };
  }
  if (newText.length > MAX_FILE_BYTES || (oldText !== null && oldText.length > MAX_FILE_BYTES)) {
    return { ...empty, skipped: "file over 1MB — diff skipped" };
  }
  const oldLines = oldText === null ? [] : splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldText !== null && oldText === newText) return empty;

  const ops = myersOps(oldLines, newLines);

  // Group ops into hunks with DIFF_CONTEXT lines of context.
  type RawLine = { kind: "same" | "del" | "add"; text: string };
  const raw: RawLine[] = ops.map((op) =>
    op.kind === "same"
      ? { kind: "same", text: oldLines[op.a!]! }
      : op.kind === "del"
        ? { kind: "del", text: oldLines[op.a!]! }
        : { kind: "add", text: newLines[op.b!]! }
  );
  const changeIdx = raw.map((r, i) => (r.kind === "same" ? -1 : i)).filter((i) => i >= 0);
  if (changeIdx.length === 0) return empty;

  const hunks: DiffHunk[] = [];
  let adds = 0;
  let dels = 0;
  const truncated = false;
  let hunkStart = Math.max(0, changeIdx[0]! - DIFF_CONTEXT);
  let hunkEnd = Math.min(raw.length, changeIdx[0]! + DIFF_CONTEXT + 1);
  const flush = (s: number, e: number) => {
    const slice = raw.slice(s, e);
    // Old/new line numbers at hunk start.
    let o = 0;
    let nn = 0;
    for (let k = 0; k < s; k++) {
      if (raw[k]!.kind !== "add") o += 1;
      if (raw[k]!.kind !== "del") nn += 1;
    }
    const oldStart = o + 1;
    const newStart = nn + 1;
    let oCount = 0;
    let nCount = 0;
    // Pair consecutive del/add runs for word highlighting.
    const lines: DiffLine[] = [];
    let k = 0;
    while (k < slice.length) {
      const r = slice[k]!;
      if (r.kind === "same") {
        lines.push({ kind: "context", text: r.text });
        oCount += 1;
        nCount += 1;
        k += 1;
        continue;
      }
      const delRun: string[] = [];
      const addRun: string[] = [];
      while (k < slice.length && slice[k]!.kind === "del") {
        delRun.push(slice[k]!.text);
        k += 1;
      }
      while (k < slice.length && slice[k]!.kind === "add") {
        addRun.push(slice[k]!.text);
        k += 1;
      }
      const paired = Math.min(delRun.length, addRun.length);
      for (let p = 0; p < paired; p++) {
        const { del, add } = wordRuns(delRun[p]!, addRun[p]!);
        lines.push({ kind: "del", text: delRun[p]!, runs: del });
        lines.push({ kind: "add", text: addRun[p]!, runs: add });
      }
      for (let p = paired; p < delRun.length; p++) {
        lines.push({ kind: "del", text: delRun[p]!, runs: flatRuns(delRun[p]!) });
      }
      for (let p = paired; p < addRun.length; p++) {
        lines.push({ kind: "add", text: addRun[p]!, runs: flatRuns(addRun[p]!) });
      }
      dels += delRun.length;
      adds += addRun.length;
      oCount += delRun.length;
      nCount += addRun.length;
    }
    hunks.push({ oldStart, oldLines: oCount, newStart, newLines: nCount, lines });
  };

  for (let c = 1; c < changeIdx.length; c++) {
    const prev = changeIdx[c - 1]!;
    const cur = changeIdx[c]!;
    if (cur - prev <= DIFF_CONTEXT * 2 + 1) {
      hunkEnd = Math.min(raw.length, cur + DIFF_CONTEXT + 1);
    } else {
      flush(hunkStart, hunkEnd);
      hunkStart = Math.max(0, cur - DIFF_CONTEXT);
      hunkEnd = Math.min(raw.length, cur + DIFF_CONTEXT + 1);
    }
  }
  flush(hunkStart, hunkEnd);
  return { hunks, adds, dels, truncated, skipped: null, isNewFile: oldText === null };
}

// --- Shared summary header -------------------------------------------------
// Ticket 02 signature: one quiet line — counts, path, line range — shared
// by the approval modal, the committed transcript, and the /diff review.
// Pure helpers; the single <Text> lives in ui/diff-view (DiffSummary) so
// both the unified and side-by-side views render byte-identical headers.
export type LineRange = {
  oldMin: number | null;
  oldMax: number | null;
  newMin: number | null;
  newMax: number | null;
};

// Overall changed-line range for unified hunks (hunk context excluded —
// the header names the span that changed, the @@ lines keep per-hunk detail).
export function hunksRange(hunks: DiffHunk[]): LineRange {
  let oldMin: number | null = null;
  let oldMax: number | null = null;
  let newMin: number | null = null;
  let newMax: number | null = null;
  for (const h of hunks) {
    // Walk hunk lines counting only changed lines for the range.
    let ho = h.oldStart;
    let hn = h.newStart;
    for (const ln of h.lines) {
      if (ln.kind === "context") {
        ho += 1;
        hn += 1;
        continue;
      }
      if (ln.kind === "del") {
        oldMin = oldMin === null ? ho : Math.min(oldMin, ho);
        oldMax = oldMax === null ? ho : Math.max(oldMax, ho);
        ho += 1;
      } else {
        newMin = newMin === null ? hn : Math.min(newMin, hn);
        newMax = newMax === null ? hn : Math.max(newMax, hn);
        hn += 1;
      }
    }
  }
  return { oldMin, oldMax, newMin, newMax };
}

// Overall line range for side-by-side rows (change rows only — context
// excluded, same rule as hunksRange so both views agree).
export function sbsRange(rows: SBSRow[]): LineRange {
  let oldMin: number | null = null;
  let oldMax: number | null = null;
  let newMin: number | null = null;
  let newMax: number | null = null;
  for (const r of rows) {
    if (r.kind === "context") continue;
    if (r.oldNo !== null) {
      oldMin = oldMin === null ? r.oldNo : Math.min(oldMin, r.oldNo);
      oldMax = oldMax === null ? r.oldNo : Math.max(oldMax, r.oldNo);
    }
    if (r.newNo !== null) {
      newMin = newMin === null ? r.newNo : Math.min(newMin, r.newNo);
      newMax = newMax === null ? r.newNo : Math.max(newMax, r.newNo);
    }
  }
  return { oldMin, oldMax, newMin, newMax };
}

function span(min: number | null, max: number | null): string | null {
  if (min === null || max === null) return null;
  return min === max ? `L${min}` : `L${min}–${max}`;
}

// "L2 → L2", "L2–20 → L2–21", or the one-sided remainder for pure
// add/del blocks. Null when there is nothing to name (new files carry
// the `new file` marker instead of a range; callers skip null).
export function rangeLabel(r: LineRange): string | null {
  const o = span(r.oldMin, r.oldMax);
  const n = span(r.newMin, r.newMax);
  if (o && n) return o === n ? o : `${o} → ${n}`;
  return o ?? n;
}
// Same inputs as computeDiff, but aligned for two-pane rendering: each
// paired del/add shares ONE row (left = before, right = after), unpaired
// lines take a row with an empty opposite cell, context lines show on
// both sides. Line numbers are 1-based per side (null = empty cell).
// Hunk windowing + budgets mirror computeDiff so both views agree.
export type SBSRow =
  | { kind: "context"; oldNo: number; newNo: number; text: string }
  | {
      kind: "change";
      oldNo: number | null;
      oldText: string | null;
      oldRuns: WordRun[];
      newNo: number | null;
      newText: string | null;
      newRuns: WordRun[];
    };

export type SideBySide =
  | { kind: "same" }
  | { kind: "binary" }
  | { kind: "skipped"; reason: string }
  | {
      kind: "diff";
      rows: SBSRow[];
      adds: number;
      dels: number;
      truncated: boolean;
      isNewFile: boolean;
    };

type NumberedLine = {
  kind: "same" | "del" | "add";
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

export function computeSideBySide(oldText: string | null, newText: string): SideBySide {
  if (isBinary(newText) || (oldText !== null && isBinary(oldText))) {
    return { kind: "binary" };
  }
  if (newText.length > MAX_FILE_BYTES || (oldText !== null && oldText.length > MAX_FILE_BYTES)) {
    return { kind: "skipped", reason: "file over 1MB — diff skipped" };
  }
  if (oldText !== null && oldText === newText) return { kind: "same" };
  const oldLines = oldText === null ? [] : splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = myersOps(oldLines, newLines);

  // Numbered raw lines (1-based per side).
  const raw: NumberedLine[] = [];
  let o = 0;
  let nn = 0;
  for (const op of ops) {
    if (op.kind === "same") {
      o += 1;
      nn += 1;
      raw.push({ kind: "same", text: oldLines[op.a!]!, oldNo: o, newNo: nn });
    } else if (op.kind === "del") {
      o += 1;
      raw.push({ kind: "del", text: oldLines[op.a!]!, oldNo: o, newNo: null });
    } else {
      nn += 1;
      raw.push({ kind: "add", text: newLines[op.b!]!, oldNo: null, newNo: nn });
    }
  }
  const changeIdx = raw.map((r, i) => (r.kind === "same" ? -1 : i)).filter((i) => i >= 0);
  if (changeIdx.length === 0) return { kind: "same" };

  const rows: SBSRow[] = [];
  let adds = 0;
  let dels = 0;
  const truncated = false;
  const flushSlice = (s: number, e: number): void => {
    const slice = raw.slice(s, e);
    let k = 0;
    while (k < slice.length) {
      const r = slice[k]!;
      if (r.kind === "same") {
        rows.push({ kind: "context", oldNo: r.oldNo!, newNo: r.newNo!, text: r.text });
        k += 1;
        continue;
      }
      const delRun: { text: string; no: number }[] = [];
      const addRun: { text: string; no: number }[] = [];
      while (k < slice.length && slice[k]!.kind === "del") {
        delRun.push({ text: slice[k]!.text, no: slice[k]!.oldNo! });
        k += 1;
      }
      while (k < slice.length && slice[k]!.kind === "add") {
        addRun.push({ text: slice[k]!.text, no: slice[k]!.newNo! });
        k += 1;
      }
      const paired = Math.min(delRun.length, addRun.length);
      for (let p = 0; p < paired; p++) {
        const { del, add } = wordRuns(delRun[p]!.text, addRun[p]!.text);
        rows.push({
          kind: "change",
          oldNo: delRun[p]!.no,
          oldText: delRun[p]!.text,
          oldRuns: del,
          newNo: addRun[p]!.no,
          newText: addRun[p]!.text,
          newRuns: add,
        });
      }
      for (let p = paired; p < delRun.length; p++) {
        rows.push({
          kind: "change",
          oldNo: delRun[p]!.no,
          oldText: delRun[p]!.text,
          oldRuns: flatRuns(delRun[p]!.text),
          newNo: null,
          newText: null,
          newRuns: [],
        });
      }
      for (let p = paired; p < addRun.length; p++) {
        rows.push({
          kind: "change",
          oldNo: null,
          oldText: null,
          oldRuns: [],
          newNo: addRun[p]!.no,
          newText: addRun[p]!.text,
          newRuns: flatRuns(addRun[p]!.text),
        });
      }
      dels += delRun.length;
      adds += addRun.length;
    }
  };

  let hunkStart = Math.max(0, changeIdx[0]! - DIFF_CONTEXT);
  let hunkEnd = Math.min(raw.length, changeIdx[0]! + DIFF_CONTEXT + 1);
  for (let c = 1; c < changeIdx.length; c++) {
    const prev = changeIdx[c - 1]!;
    const cur = changeIdx[c]!;
    if (cur - prev <= DIFF_CONTEXT * 2 + 1) {
      hunkEnd = Math.min(raw.length, cur + DIFF_CONTEXT + 1);
    } else {
      flushSlice(hunkStart, hunkEnd);
      hunkStart = Math.max(0, cur - DIFF_CONTEXT);
      hunkEnd = Math.min(raw.length, cur + DIFF_CONTEXT + 1);
    }
  }
  flushSlice(hunkStart, hunkEnd);
  return { kind: "diff", rows, adds, dels, truncated, isNewFile: oldText === null };
}
