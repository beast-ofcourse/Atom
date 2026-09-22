// Conversation: the committed scrollback as a UI concept.
//
// Contract:
//   props.turns — display turns (append-only, immutable once appended).
//   props.clearGen — list-generation (bumps on /clear /resume /new /rewind).
//   props.end — commit frontier (null = follow latest).
//   props.held — frozen-view flag (shows resume hint, freezes live tail).
//   props.showThinking — forward-only thinking visibility (default true).
//   props.renderItem — optional row renderer (defaults to Message).
// Delegates to TranscriptView; owns no pairing/admission logic itself.
import React from "react";
import { TranscriptView, type StaticItem, type Turn } from "../transcript.js";
import { Message } from "./Message.js";

export type ConversationProps = {
  turns: Turn[];
  clearGen: number;
  end?: number | null;
  held?: boolean;
  showThinking?: boolean;
  collapsedIds?: ReadonlySet<string>;
  collapsedGen?: number;
  renderItem?: (item: StaticItem) => React.ReactNode;
};

// Module-scope default row renderer. ANTI-FLICKER: TranscriptRow's custom
// compare requires render-function identity (`a.render === b.render`) to
// skip unchanged rows. An inline arrow here would be a NEW function on every
// Conversation render, failing the compare for EVERY row — so each committed
// tool/turn append re-rendered the whole scrollback subtree (MarkdownText,
// diff views) instead of painting exactly one new row. Module scope keeps
// the identity stable forever; custom renderItem props still work as before.
function defaultRenderItem(item: StaticItem): React.ReactNode {
  return <Message item={item} />;
}

export const Conversation = React.memo(function Conversation({
  turns,
  clearGen,
  end,
  held,
  showThinking = true,
  collapsedIds,
  collapsedGen = 0,
  renderItem,
}: ConversationProps) {
  return (
    <TranscriptView
      turns={turns}
      clearGen={clearGen}
      end={end}
      held={held}
      showThinking={showThinking}
      collapsedIds={collapsedIds}
      collapsedGen={collapsedGen}
      renderItem={renderItem ?? defaultRenderItem}
    />
  );
});
