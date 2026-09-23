// High-frequency streaming state, held OUTSIDE App's React state.
//
// Problem: token/thinking partials arrive many times per second. When they
// lived in App useState (setDraft/setThinking), every paint re-executed the
// entire App function body (~5k lines: slash-menu derivation, picker entries,
// phase labels, all leaf prop assembly) and reconciled the whole tree, only
// for every memoized leaf to bail out except the live tail. Yoga + ANSI
// serialization then re-ran over the full visible tree per token.
//
// Fix: this tiny external store carries {draft, thinking, stepBlocks}. The
// loop callbacks (onToken/onThinking, via the paint scheduler) and the core
// adapter mirror BOTH write here — one accumulator, one paint path. LiveTail
// Host subscribes via useSyncExternalStore and re-renders ALONE. App never
// re-renders on token paints — render radius shrinks from "whole tree" to
// "live tail".
//
// Sequencing is block-owned (ticket 05): `stepBlocks` is the ordered live
// list (applyStepDelta). There is no exclusive active lane — thinking and
// text segments coexist in paint order. `draft`/`thinking` remain the
// byte-exact cumulative partials for gap guards and commit fallbacks; they
// never gate which block paints.
//
// Commit paths are unchanged: turn end still commits the loop's byte-exact
// `reply` (draft is display-only), and thinking commits via thinkingRef /
// finished thinking blocks. The store is per-App-instance (createStreamStore
// in App), so tests mounting several Apps stay hermetic — no module singleton.

import type { StepBlock } from "./step-blocks.js";

export type StreamSnapshot = {
  draft: string | null;
  thinking: string | null;
  // Step-ordered live blocks (ticket 02+): the per-step thinking/text/tool
  // list the loop's step-tagged deltas build via applyStepDelta. Rides the
  // SAME store update as the lanes (one set() per paint-scheduler flush), so
  // the one-paint-per-keystroke invariant holds — blocks never cost an extra
  // render. Null = no step blocks yet (idle/cleared/legacy callers).
  stepBlocks: StepBlock[] | null;
};

export type StreamStore = {
  /** Stable-identity snapshot for useSyncExternalStore. */
  getSnapshot: () => StreamSnapshot;
  subscribe: (cb: () => void) => () => void;
  setDraft: (text: string | null) => void;
  setThinking: (text: string | null) => void;
  /**
   * Atomic multi-field update: applies every present field in ONE snapshot
   * swap, so subscribers render once no matter how many fields changed.
   * Absent fields keep their current value. This is the paint scheduler's
   * commit path — draft + thinking + blocks always land in the same frame.
   */
  set: (next: {
    draft?: string | null;
    thinking?: string | null;
    stepBlocks?: StepBlock[] | null;
  }) => void;
  getDraft: () => string | null;
  getThinking: () => string | null;
  getStepBlocks: () => StepBlock[] | null;
  clear: () => void;
};

const EMPTY: StreamSnapshot = { draft: null, thinking: null, stepBlocks: null };

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
    if (
      next.draft === snapshot.draft &&
      next.thinking === snapshot.thinking &&
      next.stepBlocks === snapshot.stepBlocks
    ) {
      return;
    }
    snapshot = next;
    emit();
  }
  function set(next: {
    draft?: string | null;
    thinking?: string | null;
    stepBlocks?: StepBlock[] | null;
  }): void {
    const draft = next.draft !== undefined ? next.draft : snapshot.draft;
    const thinking = next.thinking !== undefined ? next.thinking : snapshot.thinking;
    const stepBlocks = next.stepBlocks !== undefined ? next.stepBlocks : snapshot.stepBlocks;
    if (
      draft === snapshot.draft &&
      thinking === snapshot.thinking &&
      stepBlocks === snapshot.stepBlocks
    ) {
      return;
    }
    assign({ draft, thinking, stepBlocks });
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
      set({ draft: text });
    },
    setThinking: (text: string | null) => {
      set({ thinking: text });
    },
    set,
    getDraft: () => snapshot.draft,
    getThinking: () => snapshot.thinking,
    getStepBlocks: () => snapshot.stepBlocks,
    clear: () => {
      if (snapshot !== EMPTY) {
        snapshot = EMPTY;
        emit();
      }
    },
  };
}
