// Zero-dependency, line-scoped syntax highlighter for diff bodies.
//
// Claude-Code parity, ATOM-ified: Claude renders diffs through a
// highlight.js-backed color-diff; ATOM stays dependency-free, so this is
// a small regex tokenizer covering the common cases (keywords, strings,
// numbers, line comments) for a few language families. Deliberate limits:
// - stateless per line: multi-line block comments / strings are NOT
//   tracked across lines (a continuation line simply highlights as code).
// - keyword sets are tight (declarations + control flow) to avoid
//   painting identifiers that happen to match contextual words.
// - unknown language → single plain run (caller falls back to its own
//   paint); highlighting NEVER alters text — runs always rejoin to the
//   input line byte-identical (pinned by tests).
//
// Performance: highlighted lines are cached (bounded FIFO) — hunks
// re-render on every busy tick, but tokenizing happens once per unique
// line. Tokenizing itself is one linear regex pass per line.
export type SyntaxKind = "keyword" | "string" | "number" | "comment" | "plain";

export type SyntaxRun = {
  text: string;
  kind: SyntaxKind;
  start: number; // char offset into the line (UTF-16, like String.slice)
  end: number;
};

// Highlight families (opaque ids produced by the registry's ext→lang
// map): "c" = C-like braces (ts/js/go/rust/java/…), "py" = Python-like,
// "sh" = shell-like, "data" = strings/numbers/hash-comments without
// keywords (json/yaml/toml). Anything else (or null) = no highlighting.
export type HighlightLang = "c" | "py" | "sh" | "data";

const C_KEYWORDS = new Set(
  "break case catch class const continue debugger default delete do else enum export extends finally for function if implements import interface let new return static super switch this throw try typeof var void while with yield async await".split(
    " "
  )
);

const PY_KEYWORDS = new Set(
  "def class return if elif else for while in is not and or import from as try except finally with lambda pass break continue raise True False None async await".split(
    " "
  )
);

const SH_KEYWORDS = new Set(
  "if then else elif fi for while do done case esac function return exit echo local export readonly".split(
    " "
  )
);

function keywordsFor(lang: HighlightLang): Set<string> | null {
  if (lang === "c") return C_KEYWORDS;
  if (lang === "py") return PY_KEYWORDS;
  if (lang === "sh") return SH_KEYWORDS;
  return null; // "data": no keywords
}

function commentStyle(lang: HighlightLang): "slash" | "hash" | "none" {
  if (lang === "c") return "slash";
  if (lang === "data") return "hash";
  return "hash"; // py + sh
}

// Master token pattern over the code part of a line: strings (with
// escapes, incl. unterminated tails so streaming/odd lines still paint),
// numbers, words, and single fallback chars.
const TOKEN_RE =
  /'(?:[^'\\\n]|\\.)*(?:'|$)|"(?:[^"\\\n]|\\.)*(?:"|$)|`(?:[^`\\]|\\.)*(?:`|$)|[0-9][0-9_]*(?:\.[0-9_]+)?\b|[A-Za-z_$][A-Za-z0-9_$]*|\s+|./g;

const NUMBER_RE = /^[0-9][0-9_]*(?:\.[0-9_]+)?\b$/;
const WORD_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Split off a trailing line comment, honoring string spans: `//` inside
// a string is code, and (for hash style) `#` inside a string is code.
// Single-line `/* … */` pairs are treated as comments when both halves
// sit on this line; an unterminated opener is left as code (multi-line
// state is the documented non-goal).
function splitComment(line: string, lang: HighlightLang): { code: string; comment: string } {
  const style = commentStyle(lang);
  let inStr: string | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inStr !== null) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      inStr = c;
      continue;
    }
    if (style === "slash" && c === "/" && line[i + 1] === "/") {
      return { code: line.slice(0, i), comment: line.slice(i) };
    }
    if (style === "hash" && c === "#") {
      // Shebang or comment to end of line.
      return { code: line.slice(0, i), comment: line.slice(i) };
    }
  }
  if (style === "slash") {
    const open = line.indexOf("/*");
    const close = open >= 0 ? line.indexOf("*/", open + 2) : -1;
    if (open >= 0 && close > open) {
      // Keep it simple: trailing block comment paints as comment; an
      // embedded one splits code around it via the token pass below
      // (rare — paint the whole tail as comment only when the opener
      // starts after code we already keep plain).
      return { code: line.slice(0, open), comment: line.slice(open) };
    }
  }
  return { code: line, comment: "" };
}

function highlightCode(code: string, lang: HighlightLang, base: number): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const keywords = keywordsFor(lang);
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(code)) !== null) {
    const text = m[0];
    const start = base + (m.index ?? 0);
    let kind: SyntaxKind = "plain";
    const first = text[0]!;
    if (first === "'" || first === '"' || first === "`") kind = "string";
    else if (NUMBER_RE.test(text)) kind = "number";
    else if (keywords !== null && WORD_RE.test(text) && keywords.has(text)) kind = "keyword";
    runs.push({ text, kind, start, end: start + text.length });
  }
  return runs;
}

// Bounded highlight cache: diff hunks re-render on busy ticks and the
// same lines repeat across hunks/turns — tokenize once per unique line.
const HIGHLIGHT_CACHE_CAP = 2000;
const highlightCache = new Map<string, SyntaxRun[]>();

export function highlightLine(line: string, lang: HighlightLang | string | null): SyntaxRun[] {
  if (lang !== "c" && lang !== "py" && lang !== "sh" && lang !== "data") {
    return line === "" ? [] : [{ text: line, kind: "plain", start: 0, end: line.length }];
  }
  const key = `${lang} ${line}`;
  const hit = highlightCache.get(key);
  if (hit) return hit;
  const { code, comment } = splitComment(line, lang);
  const runs = highlightCode(code, lang, 0);
  if (comment) {
    runs.push({ text: comment, kind: "comment", start: code.length, end: line.length });
  }
  const out = runs.length > 0 ? runs : [];
  highlightCache.set(key, out);
  if (highlightCache.size > HIGHLIGHT_CACHE_CAP) {
    const oldest = highlightCache.keys().next();
    if (!oldest.done) highlightCache.delete(oldest.value);
  }
  return out;
}

// Test seam: current cache size (eviction behavior).
export function highlightCacheSize(): number {
  return highlightCache.size;
}
