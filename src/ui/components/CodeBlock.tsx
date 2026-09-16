// CodeBlock: terminal code presentation (indentation + dim language label
// plus zero-dependency syntax highlighting via ui/highlight — the same
// tokenizer the diff view uses, so keyword/string/number/comment hues stay
// consistent across surfaces).
//
// Contract:
//   props.lang — fence info string (e.g. "ts", "python", "sh") or null.
//                Mapped to the highlight family (c/py/sh/data); unknown
//                stays plain (no invented paint).
//   props.lines — code body lines (already split, no fences).
//   props.gap — when true, one blank line above (block spacing rule).
// Pure + memoized; no parsing beyond highlightLine (line-cached), no theme
// literals outside tokens. Long lines are never truncated — Ink wraps them
// and the source stays intact for copy/paste.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { highlightLine, type SyntaxKind } from "../highlight.js";

export type CodeBlockProps = {
  lang?: string | null;
  lines: string[];
  gap?: boolean;
};

function syntaxColor(kind: SyntaxKind): string | undefined {
  if (kind === "keyword") return theme.color.synKeyword;
  if (kind === "string") return theme.color.synString;
  if (kind === "number") return theme.color.synNumber;
  return undefined;
}

// Map fence language ids to the highlight families the tokenizer knows.
// Unknown ids return null (plain paint) — never guess a family.
function highlightFamilyFor(lang: string | null): "c" | "py" | "sh" | "data" | null {
  if (!lang) return null;
  const l = lang.trim().toLowerCase();
  // C-like braces: ts/js/go/rust/java/c/cpp/cs/kotlin/swift/dart/scala/php
  if (
    /^(ts|tsx|js|jsx|mjs|cjs|javascript|typescript|java|c|cpp|cc|c\+\+|h|hpp|cs|csharp|go|golang|rust|rs|swift|kotlin|kt|scala|php|dart|zig|solidity|sol)$/.test(
      l
    )
  )
    return "c";
  if (/^(py|python|r|ruby|rb)$/.test(l)) return "py";
  if (/^(sh|bash|zsh|shell|console|terminal|dotenv|env|bashrc|zshrc)$/.test(l)) return "sh";
  if (/^(json|jsonc|yaml|yml|toml|ini|xml|html|css|scss|less|graphql|gql|sql|md|markdown)$/.test(l))
    return "data";
  return null;
}

export const CodeBlock = React.memo(function CodeBlock({ lang = null, lines, gap = false }: CodeBlockProps) {
  const family = highlightFamilyFor(lang);
  // Huge blocks: window to keep the conversation usable (thousands of lines
  // would otherwise create thousands of Text nodes and freeze the frame).
  // The full text stays in the turn (copy/paste, inspector), but the
  // transcript only paints a slice.
  const visibleLines = lines.length > 60 ? lines.slice(0, 60) : lines;
  const overflow = lines.length - visibleLines.length;
  return (
    <Box flexDirection="column" marginTop={gap ? 1 : 0}>
      {lang ? (
        <Box flexDirection="row">
          <Text color={theme.color.code} bold>{lang}</Text>
          <Text dimColor> {theme.symbol.rule.repeat(Math.min(24, Math.max(4, 30 - lang.length)))}</Text>
        </Box>
      ) : null}
      {visibleLines.map((ln, k) => {
        if (ln.length === 0) return <Text key={k}> </Text>;
        const indent = theme.spacing.codeIndent;
        // Very long single lines (minified, base64) skip tokenization: one
        // regex on 20k chars would stall the 64ms draft throttle.
        const skipHighlight = ln.length > 500;
        if (!family || skipHighlight) {
          return (
            <Text key={k} wrap="wrap">
              {indent}
              {ln}
            </Text>
          );
        }
        const runs = highlightLine(ln, family);
        return (
          <Text key={k} wrap="wrap">
            {indent}
            {runs.map((r, i) => {
              if (r.kind === "comment") {
                return (
                  <Text key={i} dimColor>
                    {r.text}
                  </Text>
                );
              }
              const c = syntaxColor(r.kind);
              return c ? (
                <Text key={i} color={c}>
                  {r.text}
                </Text>
              ) : (
                <Text key={i}>{r.text}</Text>
              );
            })}
          </Text>
        );
      })}
      {overflow > 0 ? (
        <Text dimColor>
          {theme.symbol.ellipsis} {overflow} more line{overflow === 1 ? "" : "s"} — Ctrl+O for full block
        </Text>
      ) : null}
    </Box>
  );
});
