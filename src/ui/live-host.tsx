// Live-tail host: the subscription boundary between App and the streaming UI.
//
// App renders this host with LOW-frequency props only (busy/held/empty flags,
// elapsed seconds, tool hint). The HIGH-frequency streaming text (draft +
// thinking, up to ~15 paints/sec via DRAFT_THROTTLE_MS) flows through the
// StreamStore instead: this host subscribes via useSyncExternalStore, so a
// token paint re-renders this host + LiveTail alone — App's body,
// reconciliation of every other leaf, and their prop assembly never run.
//
// LiveTail itself is untouched (same props API, same paint), so all existing
// LiveTail tests keep passing; only the delivery path changed.
import React, { useSyncExternalStore } from "react";
import { LiveTail } from "./live-tail.js";
import type { StreamStore } from "./stream-store.js";

export type LiveTailHostProps = {
  store: StreamStore;
  isEmpty: boolean;
  sessionHint: boolean;
  emptySessionTitle?: string | null;
  busy: boolean;
  held: boolean;
  toolHint: string | null;
  toolElapsedSecs: number | null;
  elapsedSecs: number;
  showThinking: boolean;
  // Gap guard: true once any output (tokens/thinking/tool) appeared this
  // turn. Suppresses the "Thinking… · Ns" gap line between the final commit
  // (draft cleared) and the busy teardown, so a slow teardown never reads
  // as a still-thinking agent. Defaults to false (legacy gap behavior).
  hasHadOutput?: boolean;
  /** Terminal width for quote-bar alignment in ThinkingBlock. */
  columns?: number;
};

export const LiveTailHost = React.memo(function LiveTailHost({
  store,
  isEmpty,
  sessionHint,
  emptySessionTitle,
  busy,
  held,
  toolHint,
  toolElapsedSecs,
  elapsedSecs,
  showThinking,
  hasHadOutput = false,
  columns,
}: LiveTailHostProps) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <LiveTail
      isEmpty={isEmpty}
      sessionHint={sessionHint}
      emptySessionTitle={emptySessionTitle}
      draft={snap.draft}
      thinking={snap.thinking}
      busy={busy}
      held={held}
      toolHint={toolHint}
      toolElapsedSecs={toolElapsedSecs}
      elapsedSecs={elapsedSecs}
      showThinking={showThinking}
      hasHadOutput={hasHadOutput}
      columns={columns}
    />
  );
});
