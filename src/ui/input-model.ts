// Pure input-editing model: multiline cursor math, line/word kills, paste
// normalization, and history-browse index ops. No React, no Ink — the App
// wires these to state, and the unit tests pin them here.
export const INPUT_HISTORY_CAP = 100;

export function splitInputLines(text: string): string[] {
  return text.split("\n");
}

export function lineColOf(text: string, offset: number): { line: number; col: number } {
  const safe = Math.max(0, Math.min(offset, text.length));
  const lines = splitInputLines(text);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.length;
    if (safe <= acc + len || i === lines.length - 1) {
      return { line: i, col: safe - acc };
    }
    acc += len + 1;
  }
  return { line: 0, col: 0 };
}

export function offsetOfLines(lines: string[], line: number, col: number): number {
  const l = Math.max(0, Math.min(line, lines.length - 1));
  const c = Math.max(0, Math.min(col, lines[l]!.length));
  let acc = 0;
  for (let i = 0; i < l; i++) acc += lines[i]!.length + 1;
  return acc + c;
}

// Vertical cursor motion. `edge` is true when already on the first/last
// line — the caller falls through to history browse instead of moving.
export function moveVertically(
  text: string,
  offset: number,
  dir: -1 | 1
): { offset: number; edge: boolean } {
  const lines = splitInputLines(text);
  const { line, col } = lineColOf(text, offset);
  const next = line + dir;
  if (next < 0 || next >= lines.length) return { offset, edge: true };
  return { offset: offsetOfLines(lines, next, col), edge: false };
}

// Ctrl+K: delete to end of the current line; at line end (with more lines)
// delete the newline itself (join). Ctrl+U: delete to line start.
export function killToLineEnd(text: string, offset: number): { text: string; offset: number } {
  const safe = Math.max(0, Math.min(offset, text.length));
  const nl = text.indexOf("\n", safe);
  if (nl === -1) {
    if (safe >= text.length) return { text, offset: safe };
    return { text: text.slice(0, safe), offset: safe };
  }
  if (nl === safe) return { text: text.slice(0, safe) + text.slice(safe + 1), offset: safe };
  return { text: text.slice(0, safe) + text.slice(nl), offset: safe };
}

export function killToLineStart(text: string, offset: number): { text: string; offset: number } {
  const safe = Math.max(0, Math.min(offset, text.length));
  const { line, col } = lineColOf(text, safe);
  if (col === 0) return { text, offset: safe };
  const lines = splitInputLines(text);
  const start = offsetOfLines(lines, line, 0);
  return { text: text.slice(0, start) + text.slice(safe), offset: start };
}

// Ctrl+W: delete the word before the cursor (word chars + the gap before
// it). Words are [A-Za-z0-9_]+ runs; anything else is a single-char step
// when no word precedes (punctuation never eats a whole run).
export function killWordBefore(text: string, offset: number): { text: string; offset: number } {
  let at = Math.max(0, Math.min(offset, text.length));
  if (at <= 0) return { text, offset: 0 };
  let start = at;
  while (start > 0 && /\s/.test(text[start - 1]!)) start -= 1;
  // A skipped gap is the whole kill unit ("foo   " → "foo", not "").
  if (start < at) return { text: text.slice(0, start) + text.slice(at), offset: start };
  if (/[\w]/.test(text[start - 1]!)) {
    while (start > 0 && /[\w]/.test(text[start - 1]!)) start -= 1;
  } else {
    start -= 1;
  }
  return { text: text.slice(0, start) + text.slice(at), offset: start };
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
