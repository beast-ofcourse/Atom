// High-frequency streaming state, held OUTSIDE App's React state.
//
// Problem: token/thinking partials arrive many times per second. When they
// lived in App useState (setDraft/setThinking), every paint re-executed the
// entire App function body (~5k lines: slash-menu derivation, picker entries,
// phase labels, all leaf prop assembly) and reconciled the whole tree, only
// for every memoized leaf to bail out except the live tail. Yoga + ANSI
// serialization then re-ran over the full visible tree per token.
//
// Fix: this tiny external store carries exactly {draft, thinking}. The loop
// callbacks (onToken/onThinking, via the existing DRAFT_THROTTLE_MS
// throttler) write here; LiveTailHost subscribes via useSyncExternalStore and
// re-renders ALONE. App never re-renders on token paints — render radius
// shrinks from "whole tree" to "live tail".
//
// Commit paths are unchanged: turn end still commits the loop's byte-exact
// `reply` (draft is display-only), and thinking commits via thinkingRef.
// The store is per-App-instance (createStreamStore in App), so tests mounting
// several Apps stay hermetic — no module singleton.
export type StreamSnapshot = {
  draft: string | null;
  thinking: string | null;
};

export type StreamStore = {
  /** Stable-identity snapshot for useSyncExternalStore. */
  getSnapshot: () => StreamSnapshot;
  subscribe: (cb: () => void) => () => void;
  setDraft: (text: string | null) => void;
  setThinking: (text: string | null) => void;
  getDraft: () => string | null;
  getThinking: () => string | null;
  clear: () => void;
};

const EMPTY: StreamSnapshot = { draft: null, thinking: null };

export function createStreamStore(): StreamStore {
  let snapshot: StreamSnapshot = EMPTY;
  const listeners = new Set<() => void>();
  function emit(): void {
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch {
        // A throwing listener must not break the remaining subscribers.
      }
    }
  }
  function assign(next: StreamSnapshot): void {
    if (next.draft === snapshot.draft && next.thinking === snapshot.thinking) return;
    snapshot = next;
    emit();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setDraft: (text: string | null) => {
      if (text === snapshot.draft) return;
      assign({ draft: text, thinking: snapshot.thinking });
    },
    setThinking: (text: string | null) => {
      if (text === snapshot.thinking) return;
      assign({ draft: snapshot.draft, thinking: text });
    },
    getDraft: () => snapshot.draft,
    getThinking: () => snapshot.thinking,
    clear: () => {
      if (snapshot !== EMPTY) {
        snapshot = EMPTY;
        emit();
      }
    },
  };
}
