// Step-ordered live blocks: the UI-domain ordered block model.
//
// Blocks are the single sequencing owner through streaming, commit, and
// teardown. There is no exclusive active lane: each thinking / text / tool
// piece is its own entry, painted in arrival order with a stable per-step
// identity (`stepId`) and a `done` flag. Live thinking/text blocks are never
// done — commit paths take them via commitStepBlocks instead of a raw prune.
// Tool blocks start running (done: false), FLIP to done on result commit,
// and are consumed from the live list when the transcript turn lands.
import type { Turn } from "./transcript.js";

export type StepBlockKind = "thinking" | "text" | "tool";

// Tool payload on tool blocks: what the committed ToolCall presenter needs
// presenter needs to render the done state (audit line + summary or error)
// without re-deriving from the transcript. Running blocks carry the live
// hint in `label` with null duration/summary/error; completion fills them
// in on the SAME block (stable id — the running row flips, never swaps).
export type StepToolState = {
  /** Audit label (`⚙ name target`) at completion; live hint while running. */
  label: string;
  /** Wall-clock duration at completion (ms); null while running. */
  durationMs: number | null;
  /** Precomputed deriveSummary one-liner; null while running / unsummarizable. */
  summary: string | null;
  /** First line of a failed result; null on success and while running. */
  errorLine: string | null;
};

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
  /**
   * Completion flag. Thinking/text blocks are never done while live (their
   * commit paths prune them instead). Tool blocks flip done on completion
   * and STAY in the live list until the commit path consumes them.
   */
  done: boolean;
  /** Present on tool blocks from the start/complete lifecycle. */
  tool?: StepToolState;
};

export function stepIdFor(step: number): string {
  const n = Number.isFinite(step) && step >= 0 ? Math.floor(step) : 0;
  return `step-${n}`;
}

// Next paint position: one past the highest order present, so appended
// blocks never collide with surviving orders after a commit consumed entries.
function nextBlockOrder(blocks: readonly StepBlock[]): number {
  let max = -1;
  for (const b of blocks) if (b.order > max) max = b.order;
  return max + 1;
}

// Step-tagged live deltas: every thinking/text delta carries the loop step
// (POST index) that produced it, so the live list files each delta into its
// own step's block. Untagged producers read as step 0, so legacy callers
// keep working.
export type StepLiveLane = "thinking" | "text";

export type StepLiveDelta = {
  /** Loop step index from the onToken/onThinking tag (defaults to 0). */
  step?: number;
  lane: StepLiveLane;
  /** Latest live text for this delta (paint text or accumulated partial). */
  text: string;
};

export type StepToolStart = {
  /** Loop step index (liveStepRef — best effort; arrival order is what matters). */
  step: number;
  /** Live hint (name [+ target] as announced). */
  hint: string;
};

// Append a running tool block at arrival order. id gets a per-step tool
// index (`step-<n>-tool-<k>`) so several tools in one step never collide;
// order appends past the highest present so consumed entries never collide.
export function startToolBlock(
  blocks: readonly StepBlock[],
  { step, hint }: StepToolStart,
): StepBlock[] {
  const stepId = stepIdFor(step);
  let k = 0;
  for (const b of blocks) if (b.stepId === stepId && b.kind === "tool") k += 1;
  return [
    ...blocks,
    {
      id: `${stepId}-tool-${k}`,
      stepId,
      order: nextBlockOrder(blocks),
      kind: "tool",
      text: hint,
      done: false,
      tool: { label: hint, durationMs: null, summary: null, errorLine: null },
    },
  ];
}

export type StepToolComplete = {
  /** Audit label from describeToolCall (`⚙ name target`). */
  label: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Precomputed deriveSummary one-liner (null when not summarizable). */
  summary: string | null;
  /** First line of a failed result; null on success. */
  errorLine: string | null;
};

// Flip the FIRST running tool block to done (FIFO: the queue head the loop
// just committed). Same id/order/stepId — the running row settles in place.
// Returns the same array reference when nothing is running (idle commits
// never force a store write).
export function completeToolBlock(
  blocks: readonly StepBlock[],
  { label, durationMs, summary, errorLine }: StepToolComplete,
): StepBlock[] {
  const idx = blocks.findIndex((b) => b.kind === "tool" && !b.done);
  if (idx < 0) return blocks as StepBlock[];
  return blocks.map((b, i) =>
    i === idx
      ? { ...b, text: label, done: true, tool: { label, durationMs, summary, errorLine } }
      : b,
  );
}

// Pure append: one delta in, next ordered list out. No store reads, no
// mutation, no JSX — unit-tested without Ink. Returns the SAME array
// reference when the delta changes nothing, so stores identity-skip no-op
// paints. Step isolation is structural: a delta only ever touches the TAIL
// block, and only when that block already carries the same step id and kind;
// every other delta pushes a new block. Step-N text can therefore never land
// in a step-M block, and a lane switch inside one step (thinking, text,
// thinking) yields one block per segment in arrival order instead of two
// lanes fighting over one slot. A returning lane carries only its new
// segment: the text already frozen in that step's older same-kind blocks is
// cut as a prefix (whole text falls back when the prefix does not match, so
// nothing is ever dropped). Empty segments push nothing.
export function applyStepDelta(blocks: readonly StepBlock[], delta: StepLiveDelta): StepBlock[] {
  const stepId = stepIdFor(delta.step ?? 0);
  const kind: StepBlockKind = delta.lane === "thinking" ? "thinking" : "text";
  const text = delta.text;
  if (text.length === 0) return blocks as StepBlock[];
  const last = blocks.length > 0 ? blocks[blocks.length - 1]! : undefined;
  // Same segment continues: latest-wins in place, stable id and order.
  if (last !== undefined && last.stepId === stepId && last.kind === kind) {
    if (last.text === text) return blocks as StepBlock[];
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
  if (segment.length === 0) return blocks as StepBlock[];
  return [
    ...blocks,
    {
      id: `${stepId}-${kind}-${sameKind}`,
      stepId,
      order: nextBlockOrder(blocks),
      kind,
      text: segment,
      done: false,
    },
  ];
}

// --- Commit seam ------------------------------------------------------------
//
// Split the live list into finished blocks (done flipped true) and the rest
// still streaming. Pure + immutable — untouched blocks keep their references
// so store identity checks stay cheap. The caller appends one transcript
// turn per finished block (list order = paint order) and publishes `rest` in
// the SAME streamStore.set as any accompanying lane clear, so one flush still
// costs one paint. `stepId` narrows to one step; omit to take every matching
// kind (thinking freezes, text pins, tool completion).
export function commitStepBlocks(
  blocks: readonly StepBlock[],
  kind: StepBlockKind,
  stepId?: string,
): { finished: StepBlock[]; rest: StepBlock[] } {
  const finished: StepBlock[] = [];
  let matched = false;
  for (const b of blocks) {
    const match = b.kind === kind && (stepId === undefined || b.stepId === stepId);
    if (match) {
      matched = true;
      finished.push({ ...b, done: true });
    }
  }
  if (!matched) return { finished, rest: blocks as StepBlock[] };
  const rest: StepBlock[] = [];
  for (const b of blocks) {
    const match = b.kind === kind && (stepId === undefined || b.stepId === stepId);
    if (!match) rest.push(b);
  }
  return { finished, rest };
}

// Consume done tool blocks after their transcript turns land.
// Running blocks stay (still painting the live row). Same reference when
// nothing is done, so idle commits never force a store write.
export function consumeDoneToolBlocks(blocks: readonly StepBlock[]): StepBlock[] {
  if (!blocks.some((b) => b.kind === "tool" && b.done)) return blocks as StepBlock[];
  return blocks.filter((b) => !(b.kind === "tool" && b.done));
}

// Commit every finished thinking/text block to transcript turns in LIST order
// (arrival order — interleaved thinking/text never reorders). Tool blocks
// stay for the tool commit path (consumeDoneToolBlocks). Single owner for
// the block-to-turn mapping: App and the core-path adapter both use this, so
// the live list can never duplicate the transcript on either path.
export function commitLiveBlockTurns(blocks: readonly StepBlock[]): {
  turns: Turn[];
  rest: StepBlock[];
} {
  const thinking = commitStepBlocks(blocks, "thinking");
  const text = commitStepBlocks(thinking.rest, "text");
  const finished = [...thinking.finished, ...text.finished].sort((a, b) => a.order - b.order);
  const turns: Turn[] = finished.map((b) =>
    b.kind === "thinking"
      ? { role: "assistant", content: b.text, thinking: true as const }
      : { role: "assistant", content: b.text },
  );
  return { turns, rest: text.rest };
}
