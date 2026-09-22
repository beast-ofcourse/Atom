// Step-ordered live blocks: the UI-domain ordered block model.
//
// Ticket 01 (expand step): this type exists ALONGSIDE today's single-lane
// live zone — StreamStore{draft,thinking,activeLane} still drives LiveTail,
// and the transcript, collapse, and paint scheduling paths are untouched.
// Future tickets switch the live zone onto this list; today it only feeds
// the inert StepBlockList sidecar (mounted beside the lanes, rendering
// nothing), so frames stay byte-identical.
//
// Model: one entry per live piece (thinking / text / tool), in paint order,
// each with a stable per-step identity (`stepId`) and a `done` flag. Live
// blocks are never done — completion is a commit-path concern, not a
// streaming concern — so derivation below always sets `done: false` and a
// later ticket flips it at commit time without reshaping the type.
export type StepBlockKind = "thinking" | "text" | "tool";

export type StepBlock = {
  /** Stable React key (`step-<kind>` today; `step-<n>-<kind>` when a turn holds several). */
  id: string;
  /** Per-step identity: which step owns this block. Single-step turns use one id. */
  stepId: string;
  /** Position in the ordered list (paint order, ascending). */
  order: number;
  kind: StepBlockKind;
  /** Body text. Tool blocks carry the raw hint (name + target); the renderer derives the verb. */
  text: string;
  /** Completion flag. Always false for live blocks; commit sets it. */
  done: boolean;
};

// Paint order mirrors LiveTail: thinking precedes the draft (transient dim
// reasoning above the primary answer body), the tool row anchors last.
const STEP_ORDER: Record<StepBlockKind, number> = {
  thinking: 0,
  text: 1,
  tool: 2,
};

// Multi-step turns stack whole steps: step N+1 paints below step N, kinds
// keep their within-step order. Single-step turns (step 0) land on the same
// values toStepBlocks uses below, so both derivations agree.
export function stepBlockOrder(step: number, kind: StepBlockKind): number {
  return step * 3 + STEP_ORDER[kind];
}

export function stepBlockId(step: number, kind: StepBlockKind): string {
  return `step-${step}-${kind}`;
}

export function stepIdForStep(step: number): string {
  return `step-${step}`;
}

// Shared empty list (frozen): stores and refs start here so identity checks
// stay cheap, and clearing is a pointer swap, never an allocation.
export const EMPTY_STEP_BLOCKS: readonly StepBlock[] = [];

const SINGLE_STEP_ID = "step-0";

export type StepBlocksInput = {
  draft: string | null;
  thinking: string | null;
  toolHint: string | null;
  activeLane?: "draft" | "thinking" | null;
  /** Rendering-only thinking toggle (same meaning as LiveTail's prop). */
  showThinking?: boolean;
};

// Pure derivation: snapshot + hint in, ordered blocks out. No store reads,
// no mutation, no JSX — unit-tested without Ink. Lane-aware like LiveTail:
// only the active lane contributes text (a null lane, or a lane without
// text, falls back to whatever is live), so the sidecar can never show a
// combination the lanes themselves would not paint.
export function toStepBlocks(input: StepBlocksInput): StepBlock[] {
  const { draft, thinking, toolHint, activeLane = null, showThinking = true } = input;
  const blocks: StepBlock[] = [];
  const thinkingOn = activeLane !== "draft" && thinking !== null && showThinking;
  if (thinkingOn && thinking !== null) {
    blocks.push({
      id: "step-thinking",
      stepId: SINGLE_STEP_ID,
      order: STEP_ORDER.thinking,
      kind: "thinking",
      text: thinking,
      done: false,
    });
  }
  const draftOn = activeLane !== "thinking" && draft !== null && draft.length > 0;
  if (draftOn && draft !== null) {
    blocks.push({
      id: "step-text",
      stepId: SINGLE_STEP_ID,
      order: STEP_ORDER.text,
      kind: "text",
      text: draft,
      done: false,
    });
  }
  if (toolHint !== null && toolHint.length > 0) {
    blocks.push({
      id: "step-tool",
      stepId: SINGLE_STEP_ID,
      order: STEP_ORDER.tool,
      kind: "tool",
      text: toolHint,
      done: false,
    });
  }
  blocks.sort((a, b) => a.order - b.order);
  return blocks;
}

// Live accumulator (ticket 02): upsert the step's block with the newest
// partial. Pure + immutable — returns the SAME array reference when the
// text is unchanged, so stores can identity-skip no-op paints. Order stays
// sorted: thinking, text, tool per step, steps ascending.
export function upsertStepBlock(
  blocks: readonly StepBlock[],
  step: number,
  kind: StepBlockKind,
  text: string,
): readonly StepBlock[] {
  const id = stepBlockId(step, kind);
  const existing = blocks.find((b) => b.id === id);
  if (existing !== undefined && existing.text === text) return blocks;
  const next: StepBlock = {
    id,
    stepId: stepIdForStep(step),
    order: stepBlockOrder(step, kind),
    kind,
    text,
    done: false,
  };
  const out =
    existing === undefined
      ? [...blocks, next]
      : blocks.map((b) => (b.id === id ? next : b));
  out.sort((a, b) => a.order - b.order);
  return out;
}

// Step-tagged live deltas (ticket 02): every thinking/text delta carries the
// loop step (POST index) that produced it, so the live list files each delta
// into its own step's block. Old untagged producers read as step 0 — the
// single-step turns ticket 01 modeled — so legacy callers keep working.
export type StepLiveLane = "thinking" | "text";

export type StepLiveDelta = {
  /** Loop step index from the onToken/onThinking tag (defaults to 0). */
  step?: number;
  lane: StepLiveLane;
  /** Latest live text for this delta (paint text or accumulated partial). */
  text: string;
};

export function stepIdFor(step: number): string {
  const n = Number.isFinite(step) && step >= 0 ? Math.floor(step) : 0;
  return `step-${n}`;
}

// Pure append: one delta in, next ordered list out. No store reads, no
// mutation, no JSX — unit-tested without Ink. Step isolation is structural:
// a delta only ever touches the TAIL block, and only when that block already
// carries the same step id and kind; every other delta pushes a new block.
// Step-N text can therefore never land in a step-M block, and a lane switch
// inside one step (thinking, text, thinking) yields one block per segment in
// arrival order instead of two lanes fighting over one slot. A returning lane
// carries only its new segment: the text already frozen in that step's older
// same-kind blocks is cut as a prefix (whole text falls back when the prefix
// does not match, so nothing is ever dropped). Empty segments push nothing.
export function applyStepDelta(blocks: readonly StepBlock[], delta: StepLiveDelta): StepBlock[] {
  const stepId = stepIdFor(delta.step ?? 0);
  const kind: StepBlockKind = delta.lane === "thinking" ? "thinking" : "text";
  const text = delta.text;
  if (text.length === 0) return [...blocks];
  const last = blocks.length > 0 ? blocks[blocks.length - 1]! : undefined;
  // Same segment continues: latest-wins in place, stable id and order.
  if (last !== undefined && last.stepId === stepId && last.kind === kind) {
    if (last.text === text) return [...blocks];
    return blocks.map((b, i) => (i === blocks.length - 1 ? { ...b, text } : b));
  }
  // New segment: cut what this step's older same-kind blocks already hold.
  let prefix = "";
  let sameKind = 0;
  for (const b of blocks) {
    if (b.stepId === stepId && b.kind === kind) {
      prefix += b.text;
      sameKind += 1;
    }
  }
  const segment = prefix.length > 0 && text.startsWith(prefix) ? text.slice(prefix.length) : text;
  if (segment.length === 0) return [...blocks];
  return [
    ...blocks,
    {
      id: `${stepId}-${kind}-${sameKind}`,
      stepId,
      order: blocks.length,
      kind,
      text: segment,
      done: false,
    },
  ];
}
