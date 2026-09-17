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
export type StreamLane = "draft" | "thinking";

export type StreamSnapshot = {
  draft: string | null;
  thinking: string | null;
  // Single active lane (opencode-style ordered blocks): the loop callbacks
  // declare which lane owns the newest bytes, and the live zone renders
  // ONLY that lane. The inactive lane's text stays in the snapshot (its
  // commit path still owns it) but never paints beside the active lane —
  // thinking and preview can no longer race in the same frame, and a
  // thinking-only flush never re-parses the draft markdown (nor vice
  // versa). Null = nothing live (idle/cleared).
  activeLane: StreamLane | null;
};

export type StreamStore = {
  /** Stable-identity snapshot for useSyncExternalStore. */
  getSnapshot: () => StreamSnapshot;
  subscribe: (cb: () => void) => () => void;
  setDraft: (text: string | null) => void;
  setThinking: (text: string | null) => void;
  /**
   * Atomic multi-lane update: applies every present lane in ONE snapshot
   * swap, so subscribers render once no matter how many lanes changed.
   * Absent lanes keep their current value. This is the paint scheduler's
   * commit path — draft + thinking always land in the same frame.
   * `activeLane` may be set explicitly (the loop's lane-switch call does);
   * when absent it follows the cleared/kept lanes: clearing the active
   * lane falls back to the surviving lane, else null.
   */
  set: (next: { draft?: string | null; thinking?: string | null; activeLane?: StreamLane | null }) => void;
  getDraft: () => string | null;
  getThinking: () => string | null;
  getActiveLane: () => StreamLane | null;
  clear: () => void;
};

const EMPTY: StreamSnapshot = { draft: null, thinking: null, activeLane: null };

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
    if (next.draft === snapshot.draft && next.thinking === snapshot.thinking && next.activeLane === snapshot.activeLane) return;
    snapshot = next;
    emit();
  }
  // Lane rule: writing text claims the lane; clearing the active lane
  // falls back to the surviving lane (or null when both are empty).
  function laneAfterWrite(wrote: StreamLane, text: string | null): StreamLane | null {
    if (text !== null) return wrote;
    if (wrote === "draft") return snapshot.thinking !== null ? "thinking" : null;
    return snapshot.draft !== null ? "draft" : null;
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
      assign({ draft: text, thinking: snapshot.thinking, activeLane: laneAfterWrite("draft", text) });
    },
    setThinking: (text: string | null) => {
      if (text === snapshot.thinking) return;
      assign({ draft: snapshot.draft, thinking: text, activeLane: laneAfterWrite("thinking", text) });
    },
    set: (next: { draft?: string | null; thinking?: string | null; activeLane?: StreamLane | null }) => {
      const draft = next.draft !== undefined ? next.draft : snapshot.draft;
      const thinking = next.thinking !== undefined ? next.thinking : snapshot.thinking;
      let activeLane = next.activeLane !== undefined ? next.activeLane : snapshot.activeLane;
      if (next.activeLane === undefined) {
        if (next.draft !== undefined && draft === null && activeLane === "draft") {
          activeLane = thinking !== null ? "thinking" : null;
        }
        if (next.thinking !== undefined && thinking === null && activeLane === "thinking") {
          activeLane = draft !== null ? "draft" : null;
        }
      }
      if (draft === snapshot.draft && thinking === snapshot.thinking && activeLane === snapshot.activeLane) return;
      assign({ draft, thinking, activeLane });
    },
    getDraft: () => snapshot.draft,
    getThinking: () => snapshot.thinking,
    getActiveLane: () => snapshot.activeLane,
    clear: () => {
      if (snapshot !== EMPTY) {
        snapshot = EMPTY;
        emit();
      }
    },
  };
}
