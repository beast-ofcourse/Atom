// Markdown: explicit facade over the zero-dependency markdown engine.
//
// Contract:
//   MarkdownBody { text } — committed assistant body (cached parse).
//   MarkdownDraft { text } — streaming draft (marker-tolerant + cursor).
// Both delegate to ui/markdown leaves; this file owns no grammar.
// Presentation only: no store, no timers, no agent logic.
import React from "react";
import { MarkdownStream, MarkdownText } from "../markdown.js";

export type MarkdownBodyProps = { text: string };
export type MarkdownDraftProps = { text: string };

export function MarkdownBody({ text }: MarkdownBodyProps) {
  return <MarkdownText text={text} />;
}

export const MarkdownDraft = React.memo(function MarkdownDraft({ text }: MarkdownDraftProps) {
  return <MarkdownStream text={text} />;
});
