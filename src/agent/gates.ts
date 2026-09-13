// Turn-end stops: every condition that can continue or end a turn decides
// behind one chain — the todo guard, the verification gate, judge
// settlement, terminal goal verdicts (with the honesty probe), the
// error-streak hold, and goal auto-continue. The loop consumes StopDecisions
// only (continue / end) and applies the carried effects (goal-turn
// accounting, pause notices); it implements no stop itself.
//
// The pinned gates stay pure functions over an explicit context — no loop
// state, no I/O, no UI. Stateful trackers (error streak, goal progress) are
// injected through the context, never read ambiently; the single ambient
// read left in this module is openTodoNeedles, which is context pinning for
// trimmers, not a stop.
// Moved verbatim from src/zen.ts; zen.ts re-exports the stable surface.
import { getTodos } from "../tools.js";
import {
  GOAL_STALL_REPEATS,
  goalFollowUp,
  goalPausedNotice,
  goalStallNudge,
  goalStallReached,
  goalVerdictNotice,
  resetGoalStall,
  type GoalDisposition,
  type GoalProgressState,
} from "../goal.js";
import { errorStreakFollowUp, type ErrorStreakTracker } from "./loop-guard.js";

// One open todo item as a stop sees it: status + content only. The loop
// reads the live list once per turn end (getTodos at the seam) and injects
// it here — stops never touch the ambient list themselves.
export type OpenTodo = { status: string; content: string };

export type TurnEndContext = {
  /** Current tool-round index (drives the spent-budget branch). */
  step: number;
  /** Effective tool-round budget (opts.maxSteps ?? toolStepBudget(); Infinity when uncapped). */
  maxSteps: number;
  /** Whether a write/edit executed successfully since the last reset. */
  filesWritten: boolean;
  /** Open todos injected by the caller (the loop reads getTodos once per
   * turn end at the seam) — stops never read the ambient list. */
  openTodos: OpenTodo[];
  /** Whether a verification command ran after the last write. */
  verifiedAfterWrite: boolean;
  /** Whether a code-path write/edit still needs a passing check. When absent
   * (older callers), falls back to filesWritten — same meaning as before. */
  needsVerification?: boolean;
  /** Code paths changed since the last passing check (for messages). */
  unverifiedPaths?: string[];
  /** Verification-gate continues already spent this turn (bounds nag cycles). */
  verifyRounds?: number;
  /** Todo-guard continues already spent this turn (bounds guard cycles). */
  todoRounds?: number;
};

export type TurnEndDecision =
  | { action: "pass" }
  | { action: "continue"; assistantText: string; followUp: string }
  | { action: "end"; finalText: string };

export type TurnEndGate = (finalText: string, ctx: TurnEndContext) => TurnEndDecision;

// Todo-completion guard: the turn may not end with final text while todos
// are open. With budget left, record the attempt and feed back a guard
// message as a user follow-up so the model must continue with tool calls or
// explicitly resolve the todos. With the step budget spent, end with an
// explicit blocked statement naming the unfinished items instead.
export function todoCompletionGate(finalText: string, ctx: TurnEndContext): TurnEndDecision {
  const open = ctx.openTodos.filter((t) => t.status !== "completed");
  if (open.length === 0) return { action: "pass" };
  const items = open.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");
  if (ctx.step >= ctx.maxSteps) {
    return {
      action: "end",
      finalText: `${finalText}${finalText ? "\n" : ""}(blocked: ${open.length} open todo(s) — resolve with todo_update/todowrite before ending the turn:\n${items})`,
    };
  }
  // Guard cycles are bounded (like the verification gate): a model that
  // keeps answering without resolving todos ends with a blocked statement
  // instead of looping forever. Normal flows resolve within a round or two.
  if ((ctx.todoRounds ?? 0) >= MAX_TODO_ROUNDS) {
    return {
      action: "end",
      finalText: `${finalText}${finalText ? "\n" : ""}(blocked: ${open.length} open todo(s) remain after ${MAX_TODO_ROUNDS} guard rounds — resolve with todo_update/todowrite before ending the turn:\n${items})`,
    };
  }
  return {
    action: "continue",
    assistantText: finalText,
    followUp: `(todo guard: ${open.length} open todo(s) — do not end the turn with final text. Continue with tool calls, or resolve them with todo_update/todowrite:\n${items})`,
  };
}

// Task 7 verification gate: code files were written but no test/typecheck/
// build command has PASSED since. The turn CONTINUES (never ends on a mere
// report — the system prompt forbids unverified finishes, so the runtime
// must not terminate while just labeling): the attempt is recorded and a
// verification follow-up re-enters the loop, exactly like the todo guard.
// Two bounded exits: an explicit step budget spent, or MAX_VERIFY_ROUNDS nag
// without a passing run — both end with an explicit labeled statement naming
// what is unverified and why the loop stopped. Turns with no code writes
// (questions, docs, explanations, read-only work) are unaffected.
export const MAX_VERIFY_ROUNDS = 3;

// Todo-guard continues before the turn ends blocked: a model that keeps
// answering final text without resolving open todos is sent back at most
// this many times. Mirrors MAX_VERIFY_ROUNDS so no gate can spin forever.
export const MAX_TODO_ROUNDS = 3;

// Source-code extensions whose writes require a passing verification run.
// Curated heuristic boundary (not a parser): docs, configs, data, and
// extensionless files never arm the gate, so a README edit finishes clean.
// Case-insensitive; dotfiles and trailing dots never match.
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "pyw", "rb", "go", "rs", "java", "kt", "kts",
  "swift", "c", "h", "cpp", "hpp", "cc", "cxx", "cs",
  "php", "scala", "sh", "bash", "lua", "r", "dart",
  "vue", "svelte", "astro", "sql", "pl", "pm",
]);

export function isCodePath(p: unknown): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  const base = p.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return false;
  return CODE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function verifyFilesLabel(paths: string[]): string {
  if (paths.length === 0) return "changed files";
  const shown = paths.slice(0, 5);
  const extra = paths.length - shown.length;
  return shown.join(", ") + (extra > 0 ? ` (+${extra} more)` : "");
}

export function verificationGate(finalText: string, ctx: TurnEndContext): TurnEndDecision {
  const needs = ctx.needsVerification ?? ctx.filesWritten;
  if (!needs || ctx.verifiedAfterWrite) return { action: "pass" };
  const files = verifyFilesLabel(ctx.unverifiedPaths ?? []);
  if (ctx.step >= ctx.maxSteps) {
    return {
      action: "end",
      finalText: `${finalText}${finalText ? "\n" : ""}(blocked: turn budget spent (${ctx.maxSteps} tool steps) with ${files} still unverified — run the verification and report its pass/fail lines, or name why it cannot run.)`,
    };
  }
  if ((ctx.verifyRounds ?? 0) >= MAX_VERIFY_ROUNDS) {
    return {
      action: "end",
      finalText: `${finalText}${finalText ? "\n" : ""}(unverified: ${files} changed without a passing verification run — verification was requested ${MAX_VERIFY_ROUNDS}× and never ran. Run \`npm test\` and \`npm run typecheck\` and report their pass/fail lines, or name the blocker explicitly.)`,
    };
  }
  return {
    action: "continue",
    assistantText: finalText,
    followUp: `(verification required: ${files} changed since the last passing check. Run the repo's verification (e.g. \`npm test\`, \`npm run typecheck\`) and report pass/fail before finishing — final text ends the turn only after a check passes.)`,
  };
}

export const TURN_END_GATES: TurnEndGate[] = [todoCompletionGate, verificationGate];

export function evaluateTurnEnd(
  finalText: string,
  ctx: TurnEndContext,
  gates: TurnEndGate[] = TURN_END_GATES
):
  | { kind: "continue"; assistantText: string; followUp: string; via: string }
  | { kind: "end"; finalText: string } {
  for (let i = 0; i < gates.length; i++) {
    const gate = gates[i]!;
    const decision = gate(finalText, ctx);
    if (decision.action === "pass") continue;
    if (decision.action === "continue") {
      // Which gate continued (the loop bounds verification nag cycles):
      // the verification gate by name, anything else by function name.
      const via = gate === verificationGate ? "verification" : gate.name || `gate-${i}`;
      return { kind: "continue", assistantText: decision.assistantText, followUp: decision.followUp, via };
    }
    return { kind: "end", finalText: decision.finalText };
  }
  return { kind: "end", finalText };
}

// Task 7 verification gate: a bash command counts as a verification run
// when it names a common test/typecheck/build entry point. This is a word
// heuristic, not a parser — a miss only appends a non-blocking
// informational flag (never stops the turn), and the list is pinned by
// tests/loop-verification-gate.test.ts.
export function isVerificationCommand(command: string): boolean {
  return /\b(vitest|jest|mocha|pytest|typecheck|tsc|verify|check|build|tests?)\b/i.test(command);
}

// Explicit verification outcome: the bash executor's JSON envelope carries
// exitCode. 0 = the check passed (evidence); non-zero = it ran and FAILED
// (not evidence — the gate stays armed so the model sees the failure and
// fixes forward). Unparseable results (custom executors, test fakes
// returning plain strings) keep the legacy conservative behavior: a
// reporting runner counts as a pass. Never throws.
export function bashExitCode(result: string): number | null {
  try {
    const v: unknown = JSON.parse(result);
    if (typeof v === "object" && v !== null) {
      const code = (v as Record<string, unknown>)["exitCode"];
      if (typeof code === "number" && Number.isFinite(code)) return Math.floor(code);
    }
  } catch {
    // non-JSON runners keep legacy behavior (see caller)
  }
  return null;
}
// Current open todo texts (content + activeForm) via the shared getTodos
// read path — no duplicated state. Completed items never pin (their echoes
// are stale context). Never throws: on any failure there is simply nothing
// todo-pinned and truncation falls back to task-prompt + latest-turn pinning.
// Exported so manager-based trimmers (App submit) pin the same live todos.
// NOTE: this is context pinning, not a stop — the stops above take injected
// openTodos and never read the ambient list.
export function openTodoNeedles(): string[] {
  try {
    const open = getTodos().filter((t) => t.status !== "completed");
    const out: string[] = [];
    for (const t of open) {
      if (typeof t.content === "string" && t.content.length > 0) out.push(t.content);
      if (typeof t.activeForm === "string" && t.activeForm.length > 0) out.push(t.activeForm);
    }
    return out;
  } catch {
    return [];
  }
}

// ---- Unified stop policy: decideTurnEnd ----
//
// Every turn-end stop decides here, in order, over one explicit context:
//   1. the pinned gates (todo guard, verification gate) — continues return
//      immediately; ends transform the text and fall through, so a
//      blocked/unverified label never skips the stops below;
//   2. judge settlement (only when the judge ran for this turn end);
//   3. terminal goal verdicts, with the honesty probe for `complete`
//      (unverified code or open todos continue instead of stopping;
//      `blocked` stops unconditionally);
//   4. the error-streak hold (sustained unaddressed failures get one
//      fix-forward attempt before final text lands);
//   5. goal auto-continue (with the stall redirect and the spent-budget
//      pause);
//   6. the plain end.
//
// The loop consumes the decision only: transcript commits, round counting
// (via the `via` tag), goal-turn accounting (`noteGoalTurn`), and the pause
// notice (`pauseNotice`). Judge acquisition stays in the loop — it is async
// I/O like the model POST — and arrives here as `judge` + `disposition`.
//
// TURN_END_GATES is intentionally untouched: it stays the documented
// attachment point for future gates (pinned by turn-seam.test.ts). The
// stateful stops need the richer StopContext, so they live in this chain
// rather than in that array.

// A live goal as a stop sees it: active, with its objective. Null means no
// live goal — every goal stop passes and the turn ends plainly.
export type StopGoal = { objective: string };

// What the judge run for this turn end produced (null = the judge did not
// run — no runner configured, no live goal, or a model report already
// consumed). The loop folds a clear verdict into `disposition` itself, so
// only the non-verdict outcomes arrive here:
// - failed: the judge threw — pause with the truncated error;
// - unclear: no clear verdict — pause instead of looping;
// - dropped: the goal cleared/paused mid-judge — end normally, never pause
//   or continue a goal that is gone.
export type StopJudge =
  | { kind: "failed"; message: string }
  | { kind: "unclear" }
  | { kind: "dropped" };

export type StopContext = TurnEndContext & {
  /** Injected error-streak state machine (shouldHoldFinal consumes one hold
   * per true — decideTurnEnd runs once per turn end, so at most one). */
  errorStreak: ErrorStreakTracker;
  /** This turn's consumed update_goal report (null = none filed). A
   * `continue` report's next action becomes the goal follow-up; terminal
   * reports stop the run with a verdict. */
  disposition: GoalDisposition | null;
  /** Live goal snapshot taken after judge acquisition (null = none live). */
  goal: StopGoal | null;
  /** Total tool calls made this turn (drives the spent-budget branches). */
  toolCalls: number;
  /** Explicit per-turn tool-call budget (Infinity when uncapped). */
  maxTotalToolCalls: number;
  /** Whether this run engaged a goal before it cleared — the final turn
   * still counts its goal turn (the work happened). */
  goalEngaged: boolean;
  /** Injected novelty memory for the stall redirect (reset when it fires). */
  goalProgress: GoalProgressState | null;
  /** Judge outcome for this turn end (null = judge did not run). */
  judge: StopJudge | null;
};

export type StopDecision =
  | {
      kind: "continue";
      /** Which stop continued: "verification" | "todoCompletionGate" |
       * "honesty" | "errorStreak" | "goalContinue". The loop bounds
       * verification/todo nag cycles off the first two. */
      via: string;
      assistantText: string;
      followUp: string;
      /** True only for goal auto-continue (a guard hold is not a turn end). */
      noteGoalTurn: boolean;
    }
  | {
      kind: "end";
      /** Which stop ended it: "goalVerdict" | "honestyBudget" | "goalBudget"
       * | "judgePause" | "judgeDropped" | "end". */
      via: string;
      finalText: string;
      noteGoalTurn: boolean;
      /** When present the loop pauses the goal with this notice verbatim. */
      pauseNotice?: string;
    };

/** After the pinned gates have been evaluated (no `continue`), decide the
 * remaining stops — judge settlement, honesty-probed verdicts, error-streak
 * hold, goal auto-continue — from the gated text. Pure; judge/disposition
 * are injected, never read ambiently. Used by `decideTurnEnd` and directly
 * by the loop after its `evaluateTurnEnd` pre-check so the gate chain is
 * evaluated exactly once. */
export function decideTurnEndAfterGates(gatedText: string, ctx: StopContext): StopDecision {
  let text = gatedText;
  // Phase 2: judge settlement (only when the judge ran).
  if (ctx.judge !== null && ctx.judge.kind === "dropped") {
    return { kind: "end", via: "judgeDropped", finalText: text, noteGoalTurn: ctx.goalEngaged };
  }
  if (ctx.judge !== null && ctx.goal !== null) {
    const reason =
      ctx.judge.kind === "failed"
        ? `(judge failed: ${ctx.judge.message})`
        : `(judge unclear — no clear verdict)`;
    return {
      kind: "end",
      via: "judgePause",
      finalText: text,
      noteGoalTurn: true,
      pauseNotice: goalPausedNotice(ctx.goal.objective, reason),
    };
  }
  // Phase 3: terminal dispositions (goal still live). `blocked` stops
  // unconditionally; `complete` first passes the honesty probe.
  const disposition = ctx.disposition;
  const goal = ctx.goal;
  if (disposition !== null && disposition.status !== "continue" && goal !== null) {
    if (disposition.status === "complete") {
      // Voice-only probe: budgets/rounds zeroed so the pinned gates return
      // their `continue` follow-up whenever their state is dirty — the live
      // budget owns spinning protection in the branch below.
      const honestCtx: TurnEndContext = {
        step: 0,
        maxSteps: Number.POSITIVE_INFINITY,
        filesWritten: ctx.filesWritten,
        openTodos: ctx.openTodos,
        needsVerification: ctx.needsVerification,
        verifiedAfterWrite: ctx.verifiedAfterWrite,
        unverifiedPaths: ctx.unverifiedPaths === undefined ? undefined : [...ctx.unverifiedPaths],
        verifyRounds: 0,
        todoRounds: 0,
      };
      const todoProbe = todoCompletionGate(text, honestCtx);
      const verifyProbe = verificationGate(text, honestCtx);
      const honestBlock =
        todoProbe.action === "continue"
          ? todoProbe
          : verifyProbe.action === "continue"
            ? verifyProbe
            : null;
      if (honestBlock !== null) {
        // Spent budget cannot start another turn: end (preserving, via the
        // pause notice) instead of completing dirty or spinning.
        if (ctx.step >= ctx.maxSteps || ctx.toolCalls >= ctx.maxTotalToolCalls) {
          return {
            kind: "end",
            via: "honestyBudget",
            finalText: text,
            noteGoalTurn: true,
            pauseNotice: goalPausedNotice(goal.objective, "(budget spent)"),
          };
        }
        // A guard-style continue: not a turn end, so no goal-turn
        // accounting — and the false report is already consumed, so the
        // next turn must file fresh evidence.
        return {
          kind: "continue",
          via: "honesty",
          assistantText: honestBlock.assistantText,
          followUp: honestBlock.followUp,
          noteGoalTurn: false,
        };
      }
    }
    const verdict =
      disposition.status === "complete"
        ? goalVerdictNotice(goal.objective, "complete", disposition.reason, disposition.unverified)
        : goalVerdictNotice(goal.objective, disposition.status, disposition.reason);
    const final = text ? `${text}\n${verdict}` : verdict;
    return { kind: "end", via: "goalVerdict", finalText: final, noteGoalTurn: true, pauseNotice: verdict };
  }
  // Phase 4: error-streak hold. Ending on sustained unaddressed `Error:`
  // results is almost always premature — single errors still end normally
  // (the model may be reporting a blocker); a streak holds final text for
  // one fix-forward attempt, bounded by the tracker.
  if (ctx.errorStreak.shouldHoldFinal(2)) {
    const streak = ctx.errorStreak.current;
    return {
      kind: "continue",
      via: "errorStreak",
      assistantText: text,
      followUp: errorStreakFollowUp(streak),
      noteGoalTurn: false,
    };
  }
  // Phase 5: goal auto-continue — a would-be turn end starts the next turn
  // through the same assistant+user follow-up seam the guards use.
  // Unconditional (no turn cap): the run ends only via pause, clear, a
  // terminal disposition, or a thrown failure. Runs after the error-streak
  // hold so sustained tool failures still get their fix-forward guidance
  // first (a hold is not a turn end, so it counts no goal turn — and a
  // consumed `continue` report is dropped with it).
  if (goal !== null) {
    // A spent budget can never make progress — end (preserving, via the
    // pause notice) instead of POSTing forever. The turn was still taken.
    if (ctx.step >= ctx.maxSteps || ctx.toolCalls >= ctx.maxTotalToolCalls) {
      return {
        kind: "end",
        via: "goalBudget",
        finalText: text,
        noteGoalTurn: true,
        pauseNotice: goalPausedNotice(goal.objective, "(budget spent)"),
      };
    }
    const next =
      disposition !== null && disposition.status === "continue" && disposition.next !== undefined
        ? disposition.next
        : null;
    // Stall redirect: a run of exact repeats gets the replan nudge as its
    // follow-up — the epoch resets; the goal is never paused, cleared, or
    // ended here (existing budgets still bound a run that keeps stalling).
    const followUp = goalStallReached(ctx.goalProgress)
      ? (() => {
          resetGoalStall(ctx.goalProgress);
          return goalStallNudge(goal.objective, GOAL_STALL_REPEATS);
        })()
      : (next ?? goalFollowUp(goal.objective));
    return { kind: "continue", via: "goalContinue", assistantText: text, followUp, noteGoalTurn: true };
  }
  // Phase 6: the plain end. A run that engaged a goal before it cleared
  // still counts its final turn (the work happened — no continuation, the
  // goal is gone).
  return { kind: "end", via: "end", finalText: text, noteGoalTurn: ctx.goalEngaged };
}

export function decideTurnEnd(finalText: string, ctx: StopContext): StopDecision {
  // Single chain: pinned gates first, then the remaining stops. Keeps the
  // isolated test surface (`stop-policy.test.ts` calls this directly) while
  // the loop can call `evaluateTurnEnd` + `decideTurnEndAfterGates` to avoid
  // evaluating the gates twice and to keep disposition/judge acquisition
  // after the guard `continue` path.
  const gated = evaluateTurnEnd(finalText, ctx);
  if (gated.kind === "continue") {
    return {
      kind: "continue",
      via: gated.via,
      assistantText: gated.assistantText,
      followUp: gated.followUp,
      noteGoalTurn: false,
    };
  }
  return decideTurnEndAfterGates(gated.finalText, ctx);
}
