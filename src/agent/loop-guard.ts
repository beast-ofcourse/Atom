// Loop-guard: repetition/runaway detection + error-streak recovery for the
// agentic loop. Pure state machines, no I/O, never throw.
//
// Why this exists: turns are uncapped by default, so a model stuck calling
// `read <same path>` forever burns POSTs without end. The guard spots the
// pattern early (consecutive identical signatures) and the loop nudges the
// model toward a different approach with a bounded follow-up — then stops
// hard if the pattern survives the nudges. Error streaks get the same
// treatment: ending on 3+ unaddressed `Error:` results is almost always
// premature, so the loop asks for a fix-forward attempt before accepting
// final text.
//
// Repetition intervention is OPT-IN (maxRepeatedCalls set by the caller;
// unset = track-only for stats). Error-streak recovery defaults to 3
// (single errors still end normally — the model may be reporting a blocker).
//
// All thresholds clamp to sane minima; every method is safe to call with any
// input.

export type RepetitionGuardOptions = {
  // Consecutive identical signatures that trigger intervention (>= 2).
  // Undefined = track-only (note() records, shouldIntervene() is false).
  maxRepeatedCalls?: number;
  // Total identical signatures in the turn that trigger intervention
  // (defaults to 3× the consecutive threshold when intervention is on).
  maxTotalRepeats?: number;
  // Guidance follow-ups before a hard stop (>= 1, default 2).
  maxNudges?: number;
  // Extra tool names to exclude from repetition tracking, ADDED to the
  // default polling set below (background-task polls repeat the same call
  // legitimately while output grows — they must never trip the guard).
  excludedTools?: Iterable<string>;
};

// Tools whose identical repeats are legitimate polling, never runaway:
// bash_output re-polls the same taskId while a background task runs (each
// poll can return growing output). Excluded calls still break other tools'
// consecutive streaks — a poll between two identical reads means the reads
// were not consecutive.
export const POLLING_TOOLS: ReadonlySet<string> = new Set(["bash_output"]);

export type RepetitionNote = {
  signature: string;
  consecutive: number;
  total: number;
  intervened: boolean;
  excluded: boolean;
};

export class RepetitionGuard {
  private readonly maxConsecutive: number | null;
  private readonly maxTotal: number | null;
  private readonly maxNudges: number;
  private consecutiveSig: string | null = null;
  private consecutiveCount = 0;
  private totals = new Map<string, number>();
  private nudges = 0;
  private readonly excluded: Set<string>;
  private hits = 0;

  constructor(opts: RepetitionGuardOptions = {}) {
    const mc = opts.maxRepeatedCalls;
    this.maxConsecutive =
      typeof mc === "number" && Number.isFinite(mc) ? Math.max(2, Math.floor(mc)) : null;
    const mt = opts.maxTotalRepeats;
    this.maxTotal =
      typeof mt === "number" && Number.isFinite(mt)
        ? Math.max(2, Math.floor(mt))
        : this.maxConsecutive !== null
          ? this.maxConsecutive * 3
          : null;
    const mn = opts.maxNudges;
    this.maxNudges =
      typeof mn === "number" && Number.isFinite(mn) ? Math.max(1, Math.floor(mn)) : 2;
    this.excluded = new Set(POLLING_TOOLS);
    try {
      if (opts.excludedTools) {
        for (const t of opts.excludedTools) {
          if (typeof t === "string" && t.length > 0) this.excluded.add(t);
        }
      }
    } catch {
      // custom exclusions are best-effort; defaults still apply
    }
  }

  isExcluded(toolName: string): boolean {
    return typeof toolName === "string" && this.excluded.has(toolName);
  }

  note(signature: string, toolName?: string): RepetitionNote {
    const sig = typeof signature === "string" ? signature : String(signature ?? "");
    const name =
      typeof toolName === "string" && toolName.length > 0
        ? toolName
        : sig.includes(" ")
          ? sig.slice(0, sig.indexOf(" "))
          : sig;
    // Polling tools never count: they still break other tools' streaks (a
    // poll between two identical reads means the reads were not consecutive).
    if (this.isExcluded(name)) {
      this.resetStreak();
      return { signature: sig, consecutive: 0, total: this.totals.get(sig) ?? 0, intervened: false, excluded: true };
    }
    const total = (this.totals.get(sig) ?? 0) + 1;
    this.totals.set(sig, total);
    if (this.consecutiveSig === sig) this.consecutiveCount += 1;
    else {
      this.consecutiveSig = sig;
      this.consecutiveCount = 1;
    }
    const intervened = this.shouldIntervene();
    if (intervened) this.hits += 1;
    return { signature: sig, consecutive: this.consecutiveCount, total, intervened, excluded: false };
  }

  shouldIntervene(): boolean {
    if (this.maxConsecutive === null) return false;
    if (this.consecutiveCount >= this.maxConsecutive) return true;
    if (this.maxTotal !== null && this.consecutiveSig !== null) {
      if ((this.totals.get(this.consecutiveSig) ?? 0) >= this.maxTotal) return true;
    }
    return false;
  }

  // Nudge budget: true while guidance follow-ups remain (each consumes one).
  // When exhausted the caller stops hard — the pattern survived coaching.
  consumeNudge(): boolean {
    if (this.nudges >= this.maxNudges) return false;
    this.nudges += 1;
    return true;
  }

  get nudgeCount(): number {
    return this.nudges;
  }

  get hitCount(): number {
    return this.hits;
  }

  resetStreak(): void {
    this.consecutiveSig = null;
    this.consecutiveCount = 0;
  }
}

export function repetitionFollowUp(signature: string, consecutive: number): string {
  const short = signature.length > 160 ? `${signature.slice(0, 160)}…` : signature;
  return (
    `(loop guard: the identical tool call repeated ${consecutive}× consecutively (${short}). ` +
    `The current approach is not making progress — try a different tool, different arguments, ` +
    `or report the blocker with its evidence instead of retrying the same call.)`
  );
}

export function repetitionStopNotice(signature: string, consecutive: number): string {
  const short = signature.length > 160 ? `${signature.slice(0, 160)}…` : signature;
  return (
    `(stopped: identical tool call repeated ${consecutive}× (${short}) — ` +
    `loop-guard halted the runaway instead of burning the remaining tool budget.)`
  );
}

// Error-streak tracker: consecutive `Error:` results. The loop asks whether
// final text should be accepted (streak < threshold → yes) or nudged once
// (streak >= threshold → continue, bounded per turn by the caller).
export class ErrorStreakTracker {
  private readonly threshold: number;
  private streak = 0;
  private nudges = 0;

  constructor(threshold: number | undefined) {
    this.threshold =
      typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0
        ? Math.floor(threshold)
        : threshold === 0
          ? 0
          : 3;
  }

  get enabled(): boolean {
    return this.threshold > 0;
  }

  noteResult(isError: boolean): void {
    if (isError) this.streak += 1;
    else this.streak = 0;
  }

  // Kind-first entry (issue 03): gates read the kind, never the wording.
  // Delegates to noteResult so boolean callers keep working untouched.
  noteKind(kind: import("./tool-result.js").ToolResultKind): void {
    this.noteResult(kind !== "ok");
  }

  noteResults(results: boolean[]): void {
    for (const e of results) this.noteResult(e === true);
  }

  get current(): number {
    return this.streak;
  }

  // True when final text should be held for a fix-forward attempt. Consumes
  // one nudge per true (the caller bounds total nudges per turn).
  shouldHoldFinal(maxNudgesPerTurn: number): boolean {
    if (!this.enabled || this.streak < this.threshold) return false;
    if (this.nudges >= maxNudgesPerTurn) return false;
    this.nudges += 1;
    return true;
  }

  reset(): void {
    this.streak = 0;
  }
}

export function errorStreakFollowUp(streak: number): string {
  return (
    `(recovery: the last ${streak} tool result(s) were errors and the turn tried to end. ` +
    `Do not end on unaddressed failures — read the error text, fix the arguments or replan ` +
    `around the failure, and continue with tool calls. If it cannot be fixed, end by naming ` +
    `the blocker with its evidence.)`
  );
}
