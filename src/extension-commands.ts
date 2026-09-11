// Extension slash commands (ticket 04): the runtime store behind
// ExtensionAPI.registerCommand. Dependency-free (no imports) like
// tools/custom.ts and tools/intercept.ts, so the extension host and the App
// slash dispatch share it with no cycle: extensions register here, the App
// lists/parses/runs here, nobody imports the other.
//
// A command is a real slash command (`/name args...`): it appears in the
// command palette and the "/" menu, takes typed free-text arguments, and
// runs extension code OUTSIDE the model turn loop with a generation-bound
// context (prompt the user, read a session snapshot, post messages).
//
// Semantics:
// - Names are bare in the definition ("deploy") and slash-prefixed at the
//   seam ("/deploy"). Lowercase [a-z0-9_-] only, mirroring builtin style so
//   menu/palette matching stays exact and case-free.
// - Collision decision: builtins always win. The host rejects a colliding
//   name at activation (loud error, nothing commits) and App dispatch
//   routes builtins first as backstop — a builtin is never shadowed, and
//   there is no renamed form to discover. Duplicate extension names throw
//   the same way (first registration wins, deterministically by load order).
// - Handlers never touch model history: say() stages messages and the
//   runner commits them only on success. A throwing handler drops the
//   stage and surfaces a clean `Error:` string — the session is untouched.
// - The context is generation-bound: every ctx call runs checkStale first,
//   so use after a session replacement throws loudly instead of acting on
//   the wrong session (same rule as the event API).

export type ExtensionCommandSessionSnapshot = {
  /** Active store session id (null when the store is unavailable). */
  id: string | null;
  /** Display title of the active session. */
  title: string;
  /** Committed transcript turns (user + assistant + tool/info). */
  turnCount: number;
};

export type ExtensionCommandAskUser = (
  question: string,
  options: string[],
  allowCustom?: boolean
) => Promise<string>;

export type ExtensionCommandContext = {
  /** Bare command name as registered ("deploy"). */
  readonly name: string;
  /** Raw typed arguments (everything after "/name", trimmed). */
  readonly args: string;
  /** Whitespace-tokenized args (double/single-quote grouping, no escapes). */
  readonly argv: string[];
  /** Working directory the command runs against (host-provided). */
  readonly cwd: string;
  /** Prompt the user (modal picker; generation-bound). */
  askUser: ExtensionCommandAskUser;
  /** Read a snapshot of the active session (generation-bound). */
  getSession: () => ExtensionCommandSessionSnapshot;
  /** Stage a message for the conversation (committed only on success). */
  say: (message: string) => void;
};

export type ExtensionCommandHandler = (
  ctx: ExtensionCommandContext
) => string | void | Promise<string | void>;

/** Registration shape an extension passes to api.registerCommand. */
export type ExtensionCommandDefinition = {
  /** Bare command name: [a-z0-9][a-z0-9_-]{0,63}, no leading slash. */
  name: string;
  /** One-line description for the palette and the "/" menu. */
  description: string;
  /** Implementation: runs outside the model turn loop, never throws across. */
  handler: ExtensionCommandHandler;
};

export type ExtensionCommandRecord = {
  name: string;
  description: string;
  handler: ExtensionCommandHandler;
  /** Extension name that registered the command (audit trail). */
  owner: string;
};

export type ExtensionCommandDeps = {
  cwd?: string;
  askUser: ExtensionCommandAskUser;
  getSession: () => ExtensionCommandSessionSnapshot;
  /** Commit sink for staged messages (transcript only, never model history). */
  say: (message: string) => void;
  /** Throws when the calling generation went stale (session replacement). */
  checkStale?: () => void;
};

export type ExtensionCommandResult =
  | { ok: true; posted: number }
  | { ok: false; error: string };

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const store = new Map<string, ExtensionCommandRecord>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "unknown error");
}

/**
 * Validate a registration shape. Throws Error on any problem (bad name,
 * empty description, non-function handler). Duplicate and builtin-
 * collision checks live with the callers that own those names (the store
 * owns extension names; the host owns the builtin set).
 */
export function validateExtensionCommandDef(def: ExtensionCommandDefinition): void {
  if (!isRecord(def)) throw new Error("extension command definition must be an object");
  if (typeof def.name !== "string" || !NAME_RE.test(def.name)) {
    throw new Error(
      `extension command has an invalid name ${JSON.stringify(def.name)} (want a bare 1-64 char a-z0-9_- name, no leading slash)`
    );
  }
  if (typeof def.description !== "string" || def.description.trim().length === 0) {
    throw new Error(`extension command "/${def.name}" needs a non-empty description`);
  }
  if (typeof def.handler !== "function") {
    throw new Error(`extension command "/${def.name}" needs a handler function`);
  }
}

/** Register a validated command. Throws on duplicate names. Returns an unregister function. */
export function registerExtensionCommand(
  def: ExtensionCommandDefinition,
  owner = "(unknown)"
): () => void {
  validateExtensionCommandDef(def);
  if (store.has(def.name)) {
    throw new Error(`extension command "/${def.name}" is already registered`);
  }
  const rec: ExtensionCommandRecord = {
    name: def.name,
    description: def.description,
    handler: def.handler,
    owner,
  };
  store.set(def.name, rec);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    if (store.get(def.name) === rec) store.delete(def.name);
  };
}

export function unregisterExtensionCommand(name: string): boolean {
  return store.delete(name);
}

export function getExtensionCommand(name: string): ExtensionCommandRecord | undefined {
  return store.get(name);
}

/** Live commands in registration order (deterministic menu/palette order). */
export function listExtensionCommands(): ExtensionCommandRecord[] {
  return [...store.values()];
}

/** Test seam: drop every extension command. */
export function clearExtensionCommands(): void {
  store.clear();
}

export type ParsedExtensionCommandInput = {
  /** Bare name as typed (case preserved; lookup stays exact like builtins). */
  name: string;
  /** Raw arguments after the name, trimmed ("" when bare). */
  args: string;
};

// Split "/name args..." into its bare name and raw args. Returns null for
// anything that is not a single-line slash invocation (plain text, a bare
// "/", multiline, namespaced skill forms like "/skill:dep" — the name must
// be followed by whitespace or end, so skill routing is never disturbed).
export function parseExtensionCommandInput(text: string): ParsedExtensionCommandInput | null {
  if (!text.startsWith("/") || text.length < 2) return null;
  if (/[\r\n]/.test(text)) return null;
  const match = /^\/([A-Za-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  return { name: match[1]!, args: (match[2] ?? "").trim() };
}

// Whitespace tokenizer for ctx.argv: double/single quotes group words, the
// quotes are stripped, no escape processing (documented, not shell).
export function splitCommandArgs(args: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

// Run a registered command outside the model turn loop. Never throws for
// handler failures: unknown names and throwing handlers return a clean
// `Error:` result. say() output stages in a buffer and commits through
// deps.say only on success, so a throwing handler leaves the session
// untouched. Every context call runs checkStale first — stale use throws
// into the same clean-error path instead of acting on the wrong session.
export async function runExtensionCommand(
  name: string,
  rawArgs: string,
  deps: ExtensionCommandDeps
): Promise<ExtensionCommandResult> {
  const rec = store.get(name);
  if (!rec) {
    return { ok: false, error: `Error: unknown extension command "/${name}" (not registered)` };
  }
  const stale = deps.checkStale ?? (() => undefined);
  const staged: string[] = [];
  const ctx: ExtensionCommandContext = {
    name,
    args: rawArgs,
    argv: splitCommandArgs(rawArgs),
    cwd: deps.cwd ?? process.cwd(),
    askUser: async (question, options, allowCustom) => {
      stale();
      return deps.askUser(question, options, allowCustom);
    },
    getSession: () => {
      stale();
      return deps.getSession();
    },
    say: (message) => {
      stale();
      if (typeof message !== "string") {
        throw new Error(`extension command "/${name}" say() needs a string`);
      }
      if (message.length === 0) return;
      staged.push(message);
    },
  };
  let returned: string | void;
  try {
    returned = await rec.handler(ctx);
  } catch (e) {
    return { ok: false, error: `Error: extension command "/${name}" failed: ${errorText(e)}` };
  }
  if (typeof returned === "string" && returned.length > 0) staged.push(returned);
  try {
    for (const message of staged) deps.say(message);
  } catch (e) {
    return { ok: false, error: `Error: extension command "/${name}" failed: ${errorText(e)}` };
  }
  return { ok: true, posted: staged.length };
}
