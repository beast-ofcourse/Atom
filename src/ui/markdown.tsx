// Zero-dependency markdown renderer for assistant transcript turns.
//
// Terminal-native hierarchy, no boxes: headings are bold, lists use one
// consistent bullet (nesting as 2-space indents, task lists as ballot
// boxes), code blocks are indentation + a dim language label (```/~~~
// fences, unclosed runs to end of input), tables are aligned columns with
// one dim separator row, links read as `text (url)`. Soft line breaks join
// (true markdown); blank lines separate paragraphs. Raw fences/bold-markers
// never leak: when the model emits plain text, it paints back byte-identical.
// Long code lines are never pre-wrapped or truncated — Ink wraps them and
// the source line stays intact for copy/paste; long table cells truncate
// with `…` so one cell never blows out the grid.
//
// Performance: parsed blocks are cached per exact input (bounded FIFO), so
// re-renders and long sessions never re-parse. Parsing is linear in input
// size; rendering stays one <Text> per run (no per-character nodes).
import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import { CodeBlock } from "./components/CodeBlock.js";
import { useTerminalSize } from "./layout.js";

export type InlineRun =
  | { kind: "text"; text: string; bold?: boolean; italic?: boolean; strike?: boolean }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string };

export type Block =
  | { kind: "heading"; level: number; runs: InlineRun[] }
  | { kind: "paragraph"; runs: InlineRun[] }
  | { kind: "list"; items: { marker: string; indent: number; runs: InlineRun[] }[] }
  | { kind: "quote"; runs: InlineRun[] }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "table"; headers: InlineRun[][]; rows: InlineRun[][][] };

// Split `s` on inline-code spans first (code content is never formatted),
// then links, then bold/italic/strikethrough inside the remaining text.
export function parseInline(s: string): InlineRun[] {
  const out: InlineRun[] = [];
  const parts = s.split(/(`[^`]*`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      out.push({ kind: "code", text: part.slice(1, -1) });
      continue;
    }
    out.push(...parseInlineRich(part));
  }
  return out;
}

function parseInlineRich(s: string): InlineRun[] {
  const out: InlineRun[] = [];
  // Links: [text](url). Autolinks (bare https://…) paint as plain text.
  const re = /\[([^\]]*)\]\(([^)\s]+)\)|(\*\*[^*]+?\*\*)|(__[^_]+?__)|(~~[^~\n]+?~~)|(\*[^*\n]+?\*)|(_[^_\n]+?_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (t: string) => {
    if (t) out.push({ kind: "text", text: t });
  };
  // Single-char markers must not fire intra-word (`my_var`, `2*3*4` stay
  // literal — CommonMark flanking, simplified to word boundaries).
  const isWord = (c: string | undefined) => c !== undefined && /[\w]/.test(c);
  while ((m = re.exec(s)) !== null) {
    const raw = m[0];
    const single = raw.startsWith("~~") || (raw.startsWith("*") && !raw.startsWith("**")) || (raw.startsWith("_") && !raw.startsWith("__"));
    if (single) {
      const before = m.index > 0 ? s[m.index - 1] : undefined;
      const after = m.index + raw.length < s.length ? s[m.index + raw.length] : undefined;
      if (isWord(before) || isWord(after)) {
        pushText(s.slice(last, m.index + raw.length));
        last = m.index + raw.length;
        continue;
      }
    }
    pushText(s.slice(last, m.index));
    last = m.index + raw.length;
    if (m[1] !== undefined && m[2] !== undefined) {
      out.push({ kind: "link", text: m[1], url: m[2] });
    } else {
      const inner = raw.startsWith("**") || raw.startsWith("__")
        ? raw.slice(2, -2)
        : raw.slice(1, -1);
      out.push({
        kind: "text",
        text: inner,
        bold: (raw.startsWith("**") || raw.startsWith("__")) || undefined,
        italic: (!raw.startsWith("**") && !raw.startsWith("__") && !raw.startsWith("~~")) || undefined,
        strike: raw.startsWith("~~") || undefined,
      });
    }
  }
  pushText(s.slice(last));
  // Coalesce adjacent plain runs (literal fallbacks split them) — fewer
  // nodes, and plain text stays one contiguous run.
  const merged: InlineRun[] = [];
  for (const r of out) {
    const prev = merged[merged.length - 1];
    if (
      r.kind === "text" && !r.bold && !r.italic && !r.strike &&
      prev?.kind === "text" && !prev.bold && !prev.italic && !prev.strike
    ) {
      prev.text += r.text;
    } else {
      merged.push(r.kind === "text" ? { ...r } : r);
    }
  }
  return merged;
}

function expandTabs(line: string): string {
  return line.replace(/\t/g, "  ");
}

// --- Tables (GFM, terminal-quiet) ---------------------------------------
// Tables render where feasible: header + dim separator + left-aligned rows,
// columns joined with `│`. Column widths come from cell content, capped so
// one long cell (a path, URL, stack line) never blows out an 80-col
// terminal; over-long cells truncate with `…`. No outer borders: nothing
// extra lands on copy/paste beyond the cell text itself.
export const TABLE_MAX_COL = 40;

function splitTableRow(line: string): string[] | null {
  if (!line.includes("|")) return null;
  // Split on unescaped pipes; `\|` stays a literal pipe inside the cell.
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < line.length; k++) {
    const c = line[k]!;
    if (c === "\\" && line[k + 1] === "|") {
      cur += "|";
      k += 1;
      continue;
    }
    if (c === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur);
  // Drop the empty caps from leading/trailing pipes: `| a | b |` -> [a, b].
  if (cells.length > 0 && cells[0]!.trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === "") cells.pop();
  if (cells.length === 0) return null;
  return cells.map((c) => c.trim());
}

function isTableDelimiter(line: string): boolean {
  const cells = splitTableRow(line);
  if (!cells || cells.length === 0) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c));
}

// Rendered plain width of a cell: links read as `text (url)`, code as bare
// text — the width must match what Ink actually paints.
function cellPlain(runs: InlineRun[]): string {
  return runs
    .map((r) => {
      if (r.kind === "code") return r.text;
      if (r.kind === "link") {
        return r.text && r.text !== r.url ? `${r.text} (${r.url})` : r.text || r.url;
      }
      return r.text;
    })
    .join("");
}

function truncatePlain(s: string, max: number): string {
  if ([...s].length <= max) return s;
  return [...s].slice(0, Math.max(0, max - 1)).join("") + theme.symbol.ellipsis;
}

// ATX closing hashes (`## Title ##`) are decoration, not content.
function stripAtxClose(s: string): string {
  return s.replace(/\s+#+$/, "").trim();
}

// Line-based block parser. Unclosed fences run to end of input (streaming
// cutoffs still render). Lists keep nesting as 2-space indents (capped —
// terminal width is scarce, deep nesting is re-indented, not tree-rendered).
// Tables parse only with a valid delimiter row; anything malformed stays a
// plain paragraph so streaming partials never flash a broken grid.
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push({ kind: "paragraph", runs: parseInline(para.join(" ")) });
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*(\S*)\s*$/);
    if (fence) {
      flushPara();
      const marker = fence[2]!.startsWith("`") ? "`" : "~";
      const fenceRe = marker === "`" ? /^\s*`{3,}\s*$/ : /^\s*~{3,}\s*$/;
      const lang = fence[3] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !fenceRe.test(lines[i]!)) {
        body.push(expandTabs(lines[i]!));
        i += 1;
      }
      i += 1; // consume closing fence (or run past end when unclosed)
      blocks.push({ kind: "code", lang, lines: body });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const text = stripAtxClose(heading[2] ?? "");
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        runs: parseInline(text || " "),
      });
      i += 1;
      continue;
    }
    // Setext headings: `Text\n===` (H1) and `Text\n---` (H2). A `---` with
    // no pending paragraph stays a horizontal rule (spacing carries it).
    if (/^=+\s*$/.test(line) && para.length > 0) {
      blocks.push({ kind: "heading", level: 1, runs: parseInline(para.join(" ")) });
      para = [];
      i += 1;
      continue;
    }
    if (/^-{3,}\s*$/.test(line) && para.length > 0 && !line.includes("|")) {
      blocks.push({ kind: "heading", level: 2, runs: parseInline(para.join(" ")) });
      para = [];
      i += 1;
      continue;
    }
    const hr = /^\s*([-*_]\s*){3,}$/.test(line);
    if (hr) {
      flushPara();
      i += 1;
      continue; // spacing around neighbors carries the separation; no chrome
    }
    // GFM table: header row + delimiter row, then 0+ body rows. A header
    // without a delimiter is an ordinary paragraph (streaming partials).
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1]!)) {
      const headerCells = splitTableRow(line);
      if (headerCells) {
        flushPara();
        const headers = headerCells.map((c) => parseInline(c));
        const rows: InlineRun[][][] = [];
        i += 2;
        while (i < lines.length) {
          const rowLine = lines[i]!;
          if (!rowLine.includes("|") || /^\s*$/.test(rowLine)) break;
          if (isTableDelimiter(rowLine)) break;
          // A new block (fence/heading/quote/list) ends the table.
          if (/^(\s*)(`{3,}|~{3,})/.test(rowLine)) break;
          if (/^(#{1,6})\s+/.test(rowLine)) break;
          if (/^>\s?/.test(rowLine)) break;
          if (/^(\s*)([-*+]|\d+[.)])\s+/.test(rowLine)) break;
          const cells = splitTableRow(rowLine);
          if (!cells) break;
          while (cells.length < headerCells.length) cells.push("");
          rows.push(cells.slice(0, headerCells.length).map((c) => parseInline(c)));
          i += 1;
        }
        blocks.push({ kind: "table", headers, rows });
        continue;
      }
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushPara();
      const cited: string[] = [quote[1] ?? ""];
      i += 1;
      while (i < lines.length) {
        const cont = lines[i]!.match(/^>\s?(.*)$/);
        if (!cont) break;
        cited.push(cont[1] ?? "");
        i += 1;
      }
      blocks.push({ kind: "quote", runs: parseInline(cited.join(" ")) });
      continue;
    }
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushPara();
      const items: { marker: string; indent: number; runs: InlineRun[] }[] = [];
      let raws: string[] = [];
      const pushItem = () => {
        const prev = items[items.length - 1];
        if (!prev) return;
        prev.runs = parseInline(raws.join(" "));
        raws = [];
      };
      while (i < lines.length) {
        const it = lines[i]!.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (it) {
          if (items.length > 0) pushItem();
          const indentSpaces = expandTabs(it[1] ?? "").length;
          const indent = Math.min(Math.floor(indentSpaces / 2), 4);
          const ordered = /^\d/.test(it[2]!);
          let content = it[3] ?? "";
          let marker = ordered ? `${it[2]}` : theme.symbol.bullet;
          // Task lists: `- [ ] todo` / `- [x] done` read as ballot boxes.
          const task = content.match(/^\[([ xX])\]\s+(.*)$/);
          if (!ordered && task) {
            marker = task[1]!.toLowerCase() === "x" ? `${theme.symbol.bullet} ☑` : `${theme.symbol.bullet} ☐`;
            content = task[2] ?? "";
          }
          items.push({ marker, indent, runs: [] });
          raws = [content];
          i += 1;
          continue;
        }
        // Indented continuation lines join the current item (multi-line
        // list bodies); anything else ends the list.
        if (items.length > 0 && /^(\s+)\S/.test(lines[i]!) && !/^\s*$/.test(lines[i]!)) {
          raws.push(lines[i]!.trim());
          i += 1;
          continue;
        }
        break;
      }
      if (items.length > 0) pushItem();
      blocks.push({ kind: "list", items });
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      i += 1;
      continue;
    }
    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return blocks;
}

// Incremental streaming parse (Extreme-fast 1B.3): the draft grows by
// appending, so re-parsing the WHOLE text per paint is O(n²) over a long
// answer. Split at the last blank line: the head is byte-stable across
// paints (parsed once per head value, single-entry memo), only the tail
// re-parses per paint (bounded by paragraph length). Falls back to a full
// parse when there is no blank line yet or an open fence spans the split
// (fence bodies would otherwise parse as markdown). Committed turns keep
// the exact full-parse path (convergence untouched).
const streamHeadCache = new Map<string, Block[]>();
export const streamFullParseProbe = { count: 0 };

function fenceOpen(src: string): boolean {
  const m = src.match(/```/g);
  return (m?.length ?? 0) % 2 === 1;
}

export function parseMarkdownStreamIncremental(full: string): Block[] {
  const idx = full.lastIndexOf("\n\n");
  if (idx === -1) {
    streamFullParseProbe.count += 1;
    return parseMarkdown(full);
  }
  const head = full.slice(0, idx);
  if (fenceOpen(head)) {
    streamFullParseProbe.count += 1;
    return parseMarkdown(full);
  }
  let headBlocks = streamHeadCache.get(head);
  if (!headBlocks) {
    streamFullParseProbe.count += 1;
    headBlocks = parseMarkdown(head);
    streamHeadCache.clear();
    streamHeadCache.set(head, headBlocks);
  }
  return [...headBlocks, ...parseMarkdown(full.slice(idx + 2))];
}

// Bounded parse cache: Static items render once, but timer-tick re-renders,
// /resume restores, and tests re-render the same turns — never re-parse.
const PARSE_CACHE_CAP = 300;
const parseCache = new Map<string, Block[]>();

export function parseMarkdownCached(src: string): Block[] {
  const hit = parseCache.get(src);
  if (hit) return hit;
  const blocks = parseMarkdown(src);
  parseCache.set(src, blocks);
  if (parseCache.size > PARSE_CACHE_CAP) {
    const oldest = parseCache.keys().next();
    if (!oldest.done) parseCache.delete(oldest.value);
  }
  return blocks;
}

function InlineRuns({ runs }: { runs: InlineRun[] }) {
  return (
    <>
      {runs.map((r, k) => {
        if (r.kind === "code") {
          return (
            <Text key={k} color={theme.color.code}>
              {r.text}
            </Text>
          );
        }
        if (r.kind === "link") {
          return (
            <Text key={k}>
              <Text color={theme.color.link} underline>
                {r.text || r.url}
              </Text>
              {r.text && r.text !== r.url ? <Text dimColor> ({r.url})</Text> : null}
            </Text>
          );
        }
        return (
          <Text key={k} bold={r.bold} italic={r.italic} strikethrough={r.strike}>
            {r.text}
          </Text>
        );
      })}
    </>
  );
}

// Tables paint as plain aligned columns: bold header, one dim separator
// row, left-aligned body. No outer borders or boxes (copy/paste stays the
// cell text). Widths derive from truncated cell plains so a single long
// cell never pushes the grid off-screen; Ink wraps the row if the terminal
// is narrower still, preserving content over grid shape. Responsive: very
// narrow (<50) stacks as list; narrow caps cols tighter to avoid horizontal
// explosion.
function TableView({
  block,
  gap,
}: {
  block: { headers: InlineRun[][]; rows: InlineRun[][][] };
  gap: boolean;
}) {
  let columns = 100;
  try {
    columns = useTerminalSize().columns;
  } catch {
    columns = 100;
  }
  // Very narrow: degrade to stacked key: value list instead of grid.
  if (columns < 50) {
    return (
      <Box flexDirection="column" marginTop={gap ? 1 : 0}>
        {block.headers.map((_, c) => (
          <Box key={c} flexDirection="column" marginTop={c > 0 ? 1 : 0}>
            <Text bold wrap="truncate">
              {cellPlain(block.headers[c] ?? [])}
            </Text>
            {block.rows.map((r, k) => (
              <Text key={k} dimColor wrap="wrap">
                {theme.symbol.bullet} {cellPlain(r[c] ?? [])}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    );
  }
  const responsiveMax = columns < 70 ? 20 : columns < 100 ? 30 : TABLE_MAX_COL;
  const cols = block.headers.length;
  const headPlains = block.headers.map((h) => truncatePlain(cellPlain(h), responsiveMax));
  const bodyPlains = block.rows.map((r) =>
    Array.from({ length: cols }, (_, c) => truncatePlain(cellPlain(r[c] ?? []), responsiveMax))
  );
  const widths = Array.from({ length: cols }, (_, c) => {
    let w = [...(headPlains[c] ?? "")].length;
    for (const row of bodyPlains) w = Math.max(w, [...(row[c] ?? "")].length);
    return Math.max(w, 1);
  });
  // Clamp total width to terminal minus reserve so the table never explodes.
  const colSep = ` ${theme.symbol.quoteBar} `;
  const joint = "┼";
  const natural = widths.reduce((a, b) => a + b, 0) + colSep.length * Math.max(0, cols - 1);
  if (natural > columns - 4) {
    // Proportionally shrink columns to fit.
    const avail = Math.max(10, columns - 4 - colSep.length * Math.max(0, cols - 1));
    const per = Math.max(8, Math.floor(avail / cols));
    for (let c = 0; c < cols; c++) widths[c] = Math.min(widths[c]!, per);
  }
  const ruleRow = widths.map((w) => theme.symbol.rule.repeat(w)).join(`${theme.symbol.rule}${joint}${theme.symbol.rule}`);
  // Long cells render as truncated plain text (shape over formatting);
  // short cells keep their runs (bold/code/links) plus space padding.
  const renderCell = (runs: InlineRun[], plain: string, width: number, boldCell: boolean) => {
    const full = cellPlain(runs);
    if (full !== plain) {
      return <Text bold={boldCell}>{plain + " ".repeat(Math.max(0, width - [...plain].length))}</Text>;
    }
    return (
      <Text bold={boldCell}>
        <InlineRuns runs={runs} />
        {width > [...plain].length ? " ".repeat(width - [...plain].length) : null}
      </Text>
    );
  };
  return (
    <Box flexDirection="column" marginTop={gap ? 1 : 0}>
      <Text wrap="truncate">
        {block.headers.map((h, c) => (
          <Text key={c}>
            {c > 0 ? colSep : null}
            {renderCell(h, headPlains[c] ?? "", widths[c] ?? 1, true)}
          </Text>
        ))}
      </Text>
      <Text dimColor wrap="truncate">{ruleRow}</Text>
      {block.rows.map((r, k) => (
        <Text key={k} wrap="truncate">
          {Array.from({ length: cols }, (_, c) => (
            <Text key={c}>
              {c > 0 ? colSep : null}
              {renderCell(r[c] ?? [], bodyPlains[k]?.[c] ?? "", widths[c] ?? 1, false)}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

function BlockView({ block, gap }: { block: Block; gap: boolean }) {
  const top = gap ? 1 : 0;
  switch (block.kind) {
    case "heading":
      // Level-aware hierarchy without hue (theme law: headings are bold,
      // no hue). H1 carries an underline so document titles land; H2 stays
      // bold; H3+ stays bold at body weight — structure reads from weight
      // + spacing, never decoration.
      return (
        <Box marginTop={top}>
          <Text bold underline={block.level <= 1} wrap="wrap">
            <InlineRuns runs={block.runs} />
          </Text>
        </Box>
      );
    case "list":
      return (
        <Box flexDirection="column" marginTop={top}>
          {block.items.map((it, k) => (
            <Text key={k} wrap="wrap">
              {"  ".repeat(it.indent)}
              {it.marker} <InlineRuns runs={it.runs} />
            </Text>
          ))}
        </Box>
      );
    case "table":
      return <TableView block={block} gap={top > 0} />;
    case "quote":
      return (
        <Box marginTop={top}>
          <Text dimColor wrap="wrap">
            {theme.symbol.quoteBar} <InlineRuns runs={block.runs} />
          </Text>
        </Box>
      );
    case "code":
      return <CodeBlock lang={block.lang} lines={block.lines} gap={top > 0} />;
    case "paragraph":
      return (
        <Box marginTop={top}>
          <Text wrap="wrap">
            <InlineRuns runs={block.runs} />
          </Text>
        </Box>
      );
  }
}

// --- Streaming variant --------------------------------------------------
// Mid-stream partials end with unclosed markers (`**bold`, `*italic`,
// `~~strike`, `` `code ``, `[text](url`). Committed rendering would leak
// the raw markers, so the streaming pass auto-closes a trailing opener
// before parsing — the paint then matches the final shape instead of
// flashing broken markdown. Closers apply only with markdown-flanking
// (opener glued to content, not `a ** b`; intra-word `my_var`/`2*3*4`
// stay literal), so literal asterisks never misfire mid-stream. Fences
// (```/~~~) need no help: the block parser already runs unclosed fences
// to end of input. Tables need no help either: a header without its
// delimiter row parses as plain text until the delimiter streams in.
function unclosedMarker(s: string, m: "**" | "__" | "~~"): boolean {
  let count = 0;
  let idx = -1;
  for (;;) {
    idx = s.indexOf(m, idx + 1);
    if (idx === -1) break;
    count += 1;
  }
  if (count % 2 === 0) return false;
  const last = s.lastIndexOf(m);
  const after = s[last + m.length];
  const before = last > 0 ? s[last - 1] : undefined;
  if (after === undefined || /\s/.test(after)) return false;
  if (before !== undefined && /[\w]/.test(before) && /[\w]/.test(after)) return false;
  return true;
}

// Single `*`/`_` closers ignore characters already paired as `**`/`__`
// doubles, then apply the same flanking + intra-word guards as the parser.
function unclosedSingle(s: string, ch: "*" | "_", double: "**" | "__"): boolean {
  const withoutDoubles = s.split(double).join("");
  let count = 0;
  for (const c of withoutDoubles) if (c === ch) count += 1;
  if (count % 2 === 0) return false;
  const last = withoutDoubles.lastIndexOf(ch);
  const after = withoutDoubles[last + 1];
  const before = last > 0 ? withoutDoubles[last - 1] : undefined;
  if (after === undefined || /\s/.test(after)) return false;
  // The appended closer lands at end-of-string (non-word), so the
  // committed full match is literal only when the opener sits intra-word
  // (`my_var`) — matching the parser's own single-marker guard.
  if (before !== undefined && /[\w]/.test(before)) return false;
  return true;
}

export function closeStreamingMarkers(s: string): string {
  // Code spans protect their contents from marker counting.
  const fenceless = s.replace(/^(\s*)(`{3,}|~{3,}).*$/gm, "");
  const stripped = fenceless.replace(/`[^`\n]*`/g, "");
  let out = s;
  if (unclosedMarker(stripped, "**")) out += "**";
  if (unclosedMarker(stripped, "__")) out += "__";
  if (unclosedMarker(stripped, "~~")) out += "~~";
  if (unclosedSingle(stripped, "*", "**")) out += "*";
  if (unclosedSingle(stripped, "_", "__")) out += "_";
  const ticks = stripped.split("").filter((c) => c === "`").length;
  if (ticks % 2 === 1) {
    const lastTick = stripped.lastIndexOf("`");
    const after = stripped[lastTick + 1];
    if (after !== undefined && !/\s/.test(after)) out += "`";
  }
  // Unclosed link destination: `[text](https://…` streams char-by-char;
  // closing it renders the link shape instead of flashing raw brackets.
  if (/\[[^\]\n]*\]\([^)\s]*$/.test(stripped)) out += ")";
  return out;
}

// Streaming answer draft: same grammar as the committed body, but parsed
// fresh per paint (partials churn — caching them would evict committed
// turns' entries for zero hits) with transient markers closed and the
// block cursor riding the final run. Converges to MarkdownText byte-for-
// byte once the stream completes (cursor aside), so commit never visually
// jumps.
//
// Memoized on `text` — the ONLY parse input (TABLE_MAX_COL is a fixed
// const, wrapping is Ink's job, the cursor glyph is a module const). A 1s
// busy tick re-renders the parent with identical text and must NOT reparse:
// same text bails here, changed text re-parses (one linear pass).
export const streamParseProbe = { count: 0 };

export const MarkdownStream = React.memo(function MarkdownStream({ text }: { text: string }) {
  streamParseProbe.count += 1;
  const blocks = parseMarkdownStreamIncremental(closeStreamingMarkers(text) + theme.symbol.cursorBar);
  return (
    <Box flexDirection="column">
      {blocks.map((b, k) => (
        <BlockView key={k} block={b} gap={k > 0} />
      ))}
    </Box>
  );
});
// Assistant body: full markdown when the text parses into structure,
// byte-identical plain text otherwise (a single paragraph paints its runs;
// with no formatting syntax those runs are the input verbatim).
export function MarkdownText({ text }: { text: string }) {
  const blocks = parseMarkdownCached(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, k) => (
        <BlockView key={k} block={b} gap={k > 0} />
      ))}
    </Box>
  );
}

// Compact tool/activity line. The call row keeps its loop-produced text
// byte-identical (`⚙ name target` is pinned by tests + help), and state
// reads from shape, not decoration:
// - success: dim call row, plus a `· Ns` suffix when the TUI measured a
//   slow run (TOOL_SLOW_MS threshold — fast tools stay one clean line).
// - failed: the red `↳ detail` row the loop commits (error flag forces red
//   on any shape, so unknown future shapes still read as failures).
// - warning (`⚠ `): warning color — the one hue escalation, marking "needs
//   attention" without a box.
// - denied (`⊘ `), retry (`↻ `), cancel notices, boundaries, and multi-line
//   outputs (todo checklists): full fidelity, dim, untouched.
// Results are deliberately NOT echoed on success (the model owns them, not
// the transcript — pinned by plan-mode tests); large outputs never dump.
// True folding needs interactive history (Static items freeze on commit);
// this component is that chunk's seam.
export const TOOL_SLOW_MS = 2000;

export function ToolLine({ content, error, ms, via }: { content: string; error?: boolean; ms?: number; via?: string | null }) {
  // Approval provenance suffix (ticket 04): a dim `· via <token>` marker
  // rendered OUTSIDE the label text, so `⚙ name target` stays byte-identical
  // for the parsers/tests that read it (parseToolLabel/parseActivityHint)
  // while what allowed the call stays visible on the audit line.
  const suffix = via ? ` ${theme.symbol.separator} via ${via}` : "";
  // Lifecycle note: the running state lives in the live tail (Progress:
  // `◉ <verb>…`), this committed line is the terminal state — quiet dim on
  // success, red card below on failure (ToolCall). The label text itself
  // stays byte-identical single-node so parsers/tests keep matching; state
  // reads from the card + inspector glyphs, never from label restyling.
  // Success results are never echoed (the model owns them); failures keep
  // one summary line here with the full output in Ctrl+O.
  if (error) {
    return <Text color={theme.color.toolError} wrap="wrap">{content}{suffix}</Text>;
  }
  if (content.startsWith(`${theme.symbol.warningMark} `)) {
    return <Text color={theme.color.warning} wrap="wrap">{content}</Text>;
  }
  if (
    content.startsWith(`${theme.symbol.toolMark} `) &&
    !content.includes("\n") &&
    ms !== undefined &&
    ms >= TOOL_SLOW_MS
  ) {
    const dur = `${Math.round(ms / 1000)}s`;
    return (
      <Text color={theme.color.tool} dimColor wrap="wrap">
        {content}{suffix} {theme.symbol.separator} {dur}
      </Text>
    );
  }
  return (
    <Text color={theme.color.tool} dimColor wrap="wrap">
      {content}{suffix}
    </Text>
  );
}
