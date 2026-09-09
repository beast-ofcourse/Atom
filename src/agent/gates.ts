// Turn-end gates: the runtime-enforced finish conditions every turn must
// satisfy before final text ends it (todo completion, verification). Pure
// functions over an explicit context — no loop state, no I/O, no UI.
// Moved verbatim from src/zen.ts; zen.ts re-exports the stable surface.
import { getTodos } from "../tools.js";

export type TurnEndContext = {
  /** Current tool-round index (drives the spent-budget branch). */
  step: number;
  /** Effective tool-round budget (opts.maxSteps ?? toolStepBudget()). */
  maxSteps: number;
  /** Whether a write/edit executed successfully since the last reset. */
  filesWritten: boolean;
  /** Whether a verification command ran after the last write. */
  verifiedAfterWrite: boolean;
  /** Whether a code-path write/edit still needs a passing check. When absent
   * (older callers), falls back to filesWritten — same meaning as before. */
  needsVerification?: boolean;
  /** Code paths changed since the last passing check (for messages). */
  unverifiedPaths?: string[];
  /** Verification-gate continues already spent this turn (bounds nag cycles). */
  verifyRounds?: number;
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
  const open = getTodos().filter((t) => t.status !== "completed");
  if (open.length === 0) return { action: "pass" };
  const items = open.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");
  if (ctx.step >= ctx.maxSteps) {
    return {
      action: "end",
      finalText: `${finalText}${finalText ? "\n" : ""}(blocked: ${open.length} open todo(s) — resolve with todo_update/todowrite before ending the turn:\n${items})`,
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
// Two bounded exits: spent step budget, or MAX_VERIFY_ROUNDS nag cycles
// without a passing run — both end with an explicit labeled statement naming
// what is unverified and why the loop stopped. Turns with no code writes
// (questions, docs, explanations, read-only work) are unaffected.
export const MAX_VERIFY_ROUNDS = 3;

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
