// Approval-time + transcript diff view: the unified, word-highlighted,
// syntax-colored preview for write/edit calls.
//
// Claude-Code parity, ATOM-ified: hunk headers + `-`/`+` lines +
// changed-word backgrounds + syntax foregrounds (ui/highlight, zero-dep),
// one <Text> per run (no per-character nodes), word diff + highlighting
// memoized/cached so the 1s busy tick never recomputes. Long lines are
// never truncated (Ink wraps; copy/paste stays intact) — only hunk COUNT
// is capped via maxLines so the modal stays compact. All paint comes from
// ui/theme tokens (Ink supports color + backgroundColor on Text — verified
// against the installed Ink 7 typings).
import React from "react";
import { Box, Text } from "ink";
import { computeDiff, type WordRun } from "./diff.js";
import { highlightLine, type SyntaxKind } from "./highlight.js";
import { theme } from "./theme.js";

export type DiffViewProps = {
  oldText: string | null; // null = new file (all additions)
  newText: string;
  // Highlight family id ("c"/"py"/"sh"/"data", see ui/highlight).
  // Null/unknown = plain paint (add/del line tint, as before).
  lang?: string | null;
  // Max rendered diff body lines (hunk headers excluded). Extra lines
  // collapse into a dim "… N more" trailer. Defaults to Infinity.
  maxLines?: number;
};

function syntaxColor(kind: SyntaxKind): string | undefined {
  if (kind === "keyword") return theme.color.synKeyword;
  if (kind === "string") return theme.color.synString;
  if (kind === "number") return theme.color.synNumber;
  return undefined; // comment → dim, plain → line paint
}

// One diff line body: word-diff runs sub-split by syntax spans. Both
// segmentations tile the same line text, so walking them together with
// an offset cursor paints every char exactly once (text integrity is
// pinned by tests — highlighting must never alter content). Exported:
// the side-by-side view (ui/side-by-side) reuses it per pane cell.
export function LineBody({
  lineText,
  runs,
  base,
  lang,
}: {
  lineText: string;
  runs: WordRun[];
  base: "add" | "del";
  lang: string | null;
}) {
  const baseColor = base === "add" ? theme.color.success : theme.color.toolError;
  const hlBg = base === "add" ? "green" : "red";
  const langKnown = lang === "c" || lang === "py" || lang === "sh" || lang === "data";
  const syn = langKnown ? highlightLine(lineText, lang) : [];
  const nodes: React.ReactNode[] = [];
  let offset = 0;
  let synIdx = 0;
  runs.forEach((r, k) => {
    const runStart = offset;
    const runEnd = offset + r.text.length;
    offset = runEnd;
    if (r.changed) {
      // Changed words keep the high-contrast background treatment —
      // syntax hues would muddy the signal.
      nodes.push(
        <Text key={k} backgroundColor={hlBg} color="black" bold>
          {r.text}
        </Text>
      );
      // Advance the syntax cursor past this run so later runs align.
      while (synIdx < syn.length && syn[synIdx]!.end <= runEnd) synIdx += 1;
      return;
    }
    // Unchanged text: paint syntax spans; plain spans inherit the line
    // paint (base tint for unknown files, terminal default when the
    // language is known — the +/- prefix carries line identity there).
    // Skip syntax runs that end before this run starts (can happen only
    // if segmentations disagree — defensive, never expected).
    while (synIdx < syn.length && syn[synIdx]!.end <= runStart) synIdx += 1;
    let si = synIdx;
    const parts: React.ReactNode[] = [];
    let pk = 0;
    while (si < syn.length && syn[si]!.start < runEnd) {
      const s = syn[si]!;
      const a = Math.max(s.start, runStart);
      const b = Math.min(s.end, runEnd);
      if (b > a) {
        const piece = r.text.slice(a - runStart, b - runStart);
        const fg = syntaxColor(s.kind) ?? (langKnown ? undefined : baseColor);
        parts.push(
          s.kind === "comment" ? (
            <Text key={pk++} dimColor>
              {piece}
            </Text>
          ) : (
            <Text key={pk++} color={fg}>
              {piece}
            </Text>
          )
        );
      }
      if (s.end <= runEnd) si += 1;
      else break;
    }
    if (parts.length === 0) {
      parts.push(
        <Text key={pk++} color={langKnown ? undefined : baseColor}>
          {r.text}
        </Text>
      );
    }
    nodes.push(<Text key={k}>{parts}</Text>);
  });
  return <Text color={langKnown ? undefined : baseColor}>{nodes}</Text>;
}

function DiffViewInner({ oldText, newText, lang = null, maxLines = Infinity }: DiffViewProps) {
  const diff = React.useMemo(() => computeDiff(oldText, newText), [oldText, newText]);

  if (diff.skipped) {
    return <Text dimColor>{diff.skipped}</Text>;
  }
  if (diff.hunks.length === 0) {
    return <Text dimColor>(no visible changes)</Text>;
  }

  let bodyLines = 0;
  const overflow: number = (() => {
    let total = 0;
    for (const h of diff.hunks) total += h.lines.length;
    return Math.max(0, total - maxLines);
  })();

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {diff.isNewFile ? "new file " : ""}+{diff.adds} −{diff.dels}
      </Text>
      {diff.hunks.map((h, hi) => (
        <Box key={hi} flexDirection="column">
          <Text dimColor>
            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </Text>
          {h.lines.map((ln, k) => {
            bodyLines += 1;
            if (bodyLines > maxLines) return null;
            if (ln.kind === "context") {
              return (
                <Text key={k} dimColor>
                  {"  "}
                  {ln.text.length > 0 ? ln.text : " "}
                </Text>
              );
            }
            if (ln.kind === "del") {
              return (
                <Text key={k}>
                  <Text color={theme.color.toolError}>- </Text>
                  <LineBody lineText={ln.text} runs={ln.runs} base="del" lang={lang} />
                  {ln.text.length === 0 ? " " : null}
                </Text>
              );
            }
            return (
              <Text key={k}>
                <Text color={theme.color.success}>+ </Text>
                <LineBody lineText={ln.text} runs={ln.runs} base="add" lang={lang} />
                {ln.text.length === 0 ? " " : null}
              </Text>
            );
          })}
        </Box>
      ))}
      {overflow > 0 ? <Text dimColor>… {overflow} more line{overflow === 1 ? "" : "s"}</Text> : null}
      {diff.truncated ? <Text dimColor>(diff truncated at 400 changed lines)</Text> : null}
    </Box>
  );
}

export const DiffView = React.memo(DiffViewInner);
