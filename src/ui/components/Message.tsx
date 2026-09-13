// Message: one committed transcript entry as a UI concept.
//
// Contract:
//   props.item — StaticItem { id, turn?, label? } (TranscriptView shape).
// Thin facade over renderTranscriptItem (the canonical row renderer in
// ui/transcript, which itself composes ThinkingBlock + ToolCall +
// MarkdownBody). No duplicated JSX here — Message exists so the component
// tree reads as AppShell > Conversation > Message > (Thinking|Tool|Markdown).
import React from "react";
import type { StaticItem } from "../transcript.js";
import { renderTranscriptItem } from "../transcript.js";

export type MessageProps = { item: StaticItem };

export const Message = React.memo(function Message({ item }: MessageProps) {
  return <>{renderTranscriptItem(item)}</>;
});
