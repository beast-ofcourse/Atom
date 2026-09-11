// Extension tool overrides + prompt hints (ticket 06): the audited,
// reversible shadow layer over builtin tools plus the model-context hints.
//
// Dependency-free like custom.ts/intercept.ts (no imports) so the registry,
// the scheduler, the extension host, and the prompt assembly can all share
// it with no cycle: extensions register here, the registry/executors apply
// here, nobody imports the other.
//
// Semantics:
// - An override shadows ONE builtin tool by name. Registration is explicit
//   and single-winner (a second override for the same builtin throws); the
//   override receives every call and decides per call — deny a subset with a
//   reason (throw, or return an `Error:` result) or pass the rest through via
//   ctx.passthrough (default). Deny-by-default shadowing is forbidden: the
//   builtin stays reachable through passthrough, and removing the override
//   restores the pristine builtin with no residue.
// - executionMode is a scheduling hint ("sequential" forces the whole sibling
//   batch serial, "parallel" is advisory). The scheduler only ever ADDS
//   serialization from it — existing guarantees are never weakened.
// - Prompt hints are short model-facing guidance strings. They reach the
//   model through the existing prompt assembly (zen buildSystemPrompt), never
//   a parallel pipeline.
export type ToolExecutionMode = "sequential" | "parallel";

export function isToolExecutionMode(value: unknown): value is ToolExecutionMode {
  return value === "sequential" || value === "parallel";
}

export type ToolOverrideContext = {
  /** Working directory the tool call executes against (loop-provided). */
  cwd: string;
  /**
   * Run the pristine builtin with (by default, the received) args and return
   * its result. Never re-enters the override — recursion is impossible.
   */
  passthrough: (args?: Record<string, unknown>) => Promise<string>;
};

export type ToolOverrideExecute = (
  args: Record<string, unknown>,
  ctx: ToolOverrideContext
) => string | Promise<string>;

/** Registration shape an extension passes to api.overrideTool. */
export type ExtensionToolOverrideDefinition = {
  /** Builtin tool name to shadow (must name a real builtin — checked where builtin names are known). */
  name: string;
  /**
   * Implementation: receives validated args, denies a subset (throw with a
   * reason, or return an `Error:` result) and passes the rest through via
   * ctx.passthrough. A throwing implementation degrades to an `Error:`
   * result string — never a crash, so call pairing in the loop stays valid.
   */
  execute: ToolOverrideExecute;
  /**
   * Scheduling hint. "sequential" forces the whole sibling batch to run
   * one-at-a-time (Pi-style); "parallel" is advisory and changes nothing
   * today (fail-safe: unknown footprints still serialize).
   */
  executionMode?: ToolExecutionMode;
};

export type ToolOverrideRecord = {
  name: string;
  execute: ToolOverrideExecute;
  executionMode: ToolExecutionMode | undefined;
  /** Extension name that registered the override (audit trail for markers). */
  owner: string;
};

const overrides = new Map<string, ToolOverrideRecord>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate an override shape. Throws Error on any problem (bad name,
 * non-function execute, bad executionMode). Builtin-existence and duplicate
 * checks live in the registry wrapper (registerExtensionToolOverride), which
 * knows the builtin names.
 */
export function validateExtensionToolOverrideDef(def: ExtensionToolOverrideDefinition): void {
  if (!isRecord(def)) throw new Error("extension tool override definition must be an object");
  if (typeof def.name !== "string" || !NAME_RE.test(def.name)) {
    throw new Error(
      `extension tool override has an invalid name ${JSON.stringify(def.name)} (want 1-64 chars of A-Za-z0-9_-)`
    );
  }
  if (typeof def.execute !== "function") {
    throw new Error(`extension tool override "${def.name}" needs an execute function`);
  }
  if (def.executionMode !== undefined && !isToolExecutionMode(def.executionMode)) {
    throw new Error(
      `extension tool override "${def.name}" field "executionMode" must be "sequential" or "parallel"`
    );
  }
}

/** Register a validated override. Throws on duplicate names. */
export function registerToolOverride(
  def: ExtensionToolOverrideDefinition,
  owner = "(unknown)"
): () => void {
  validateExtensionToolOverrideDef(def);
  if (overrides.has(def.name)) {
    throw new Error(`extension tool override "${def.name}" is already registered`);
  }
  const rec: ToolOverrideRecord = {
    name: def.name,
    execute: def.execute,
    executionMode: def.executionMode,
    owner,
  };
  overrides.set(def.name, rec);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    if (overrides.get(def.name) === rec) overrides.delete(def.name);
  };
}

export function unregisterToolOverride(name: string): boolean {
  return overrides.delete(name);
}

export function getToolOverride(name: string): ToolOverrideRecord | undefined {
  return overrides.get(name);
}

export function isToolOverridden(name: string): boolean {
  return overrides.has(name);
}

/** Snapshot of live overrides in registration order (audit surface). */
export function listToolOverrides(): ToolOverrideRecord[] {
  return [...overrides.values()];
}

/** Test seam: drop every tool override. */
export function clearToolOverrides(): void {
  overrides.clear();
}

// ---- Extension prompt hints (same ticket, same audit posture) ----

// Short model-facing guidance strings ("prefer X with tool Y") contributed by
// extensions. They reach the model only through the existing prompt assembly
// (zen buildSystemPrompt appends them under an "Extension hints" section) —
// no parallel prompt pipeline is ever introduced. Registration order is kept.
export const MAX_PROMPT_HINT_CHARS = 2000;

type PromptHintRecord = {
  text: string;
  owner: string;
};

const promptHints: PromptHintRecord[] = [];

/** Validate a prompt hint shape. Throws Error on any problem. */
export function validateExtensionPromptHint(hint: string): void {
  if (typeof hint !== "string" || hint.trim().length === 0) {
    throw new Error("extension prompt hint must be a non-empty string");
  }
  if (hint.length > MAX_PROMPT_HINT_CHARS) {
    throw new Error(
      `extension prompt hint exceeds ${MAX_PROMPT_HINT_CHARS} chars (got ${hint.length})`
    );
  }
}

/** Register a prompt hint. Returns an unregister function. */
export function registerExtensionPromptHint(hint: string, owner = "(unknown)"): () => void {
  validateExtensionPromptHint(hint);
  const record: PromptHintRecord = { text: hint, owner };
  promptHints.push(record);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const idx = promptHints.indexOf(record);
    if (idx >= 0) promptHints.splice(idx, 1);
  };
}

/** Hint texts in registration order (what the prompt assembly appends). */
export function getExtensionPromptHints(): string[] {
  return promptHints.map((h) => h.text);
}

/** Test seam: drop every prompt hint. */
export function clearExtensionPromptHints(): void {
  promptHints.length = 0;
}
