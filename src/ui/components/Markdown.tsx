// Markdown: explicit facade over the zero-dependency markdown engine.
//
// Contract:
//   MarkdownBody { text } — committed assistant body (cached parse).
//   MarkdownDraft { text, maxLines?, columns? } — streaming draft
//   (marker-tolerant + cursor), tail-windowed to `maxLines` display rows
//   at `columns` width when a budget is given (live callers always pass
//   one; tests may omit it to inspect the raw stream).
// Both delegate to ui/markdown leaves; this file owns no grammar.
// Presentation only: no store, no timers, no agent logic.
import React from "react";
import { FALLBACK_SIZE, tailDisplayWindow } from "../layout.js";
import { MarkdownStream, MarkdownText } from "../markdown.js";

export type MarkdownBodyProps = { text: string };
export type MarkdownDraftProps = {
  text: string;
  /** Display-row budget for the live tail (absent = no windowing). */
  maxLines?: number;
  /** Terminal width the budget is measured in (defaults to 80). */
  columns?: number;
};

export function MarkdownBody({ text }: MarkdownBodyProps) {
  return <MarkdownText text={text} />;
}

export const MarkdownDraft = React.memo(function MarkdownDraft({
  text,
  maxLines,
  columns = FALLBACK_SIZE.columns,
}: MarkdownDraftProps) {
  // Tail window (see layout.tailDisplayWindow): the streaming frame stays
  // inside its height budget, so a long answer can never grow taller than
  // the viewport and force a full-screen repaint. Text that already fits
  // keeps its reference — MarkdownStream's memo then skips the re-parse.
  const visible =
    maxLines === undefined ? text : tailDisplayWindow(text, columns, maxLines);
  return <MarkdownStream text={visible} />;
});
