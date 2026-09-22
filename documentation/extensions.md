# Extensions

ATOM extensions are **local files you author or install** — plain `.ts`, `.js`, `.mjs`, or `.cjs` — that run **inside the ATOM process with your full user privileges**. There is no sandbox, no VM boundary, and no remote registry. An extension is one factory function that receives an `ExtensionAPI` object and calls methods on it to register tools, commands, interceptors, hooks, and UI contributions.

The workflow is three steps: **write a local file, trust the project (if needed), restart** — and your code runs in-process via [jiti](https://github.com/unjs/jiti) (same-process, TypeScript-capable dynamic import). Three copy-paste samples live under `examples/extensions/` and serve as the **single source of truth**: the guide excerpts them, and the test suite (`tests/extension-gallery.test.ts`) loads those exact checked-in files through the real `loadExtensions` path — never a mock API, never a copy — so the documentation and the working code can never drift.

> **Security note.** Extension code runs with your full privileges. It can read/write any file you can, run any shell command, and exfiltrate data over the network. Only install extensions you wrote or trust, exactly as you would trust your own dotfiles. The project-scope trust gate exists for this reason — see [Trust prompt](#trust-prompt) below.

---

## Table of contents

1. [Install location (global vs project vs explicit)](#install-location-global-vs-project-vs-explicit)
2. [Installation formats (file, directory, package.json manifest)](#installation-formats)
3. [Minimal file shape (factory export)](#minimal-file-shape-factory-export)
4. [How loading works (jiti, staged commit, atomicity)](#how-loading-works)
5. [Trust prompt](#trust-prompt)
6. [Enable, disable, lockdown](#enable-disable-lockdown)
7. [How to see it loaded](#how-to-see-it-loaded)
8. [Gallery (copy-paste samples)](#gallery-copy-paste-samples)
9. [API surface reference](#api-surface-reference)
10. [Runtime model (generations, stale handles, reload)](#runtime-model)
11. [Rules that bite](#rules-that-bite)

---

## Install location (global vs project vs explicit)

Extensions live in one of three **scopes**, each with a different trust posture:

| Scope | Directory | Trust |
|---|---|---|
| **Global** | `~/.atom/extensions/` — or `$ATOM_HOME/extensions/` when `ATOM_HOME` is set | **Implicitly trusted.** User-owned, like your own shell config. These always load. |
| **Project** | `<cwd>/.atom/extensions/` | **Gated.** Never executes until the project is trusted (see [Trust prompt](#trust-prompt)). |
| **Explicit** | `ATOM_EXTENSIONS` env var (path-delimiter-separated) + programmatic `extraPaths` | **Gated**, like project scope. An explicit path is no trust backdoor. |

**Discovery order** — and therefore the order extensions activate — is: **project → global → explicit**. Within each directory, entries are sorted by name. If the same absolute path appears in two scopes, discovery keeps the first occurrence and skips later duplicates.

### Path resolution

```ts
// From src/extensions.ts — these are the canonical helpers.
globalExtensionsDir(home?: string)  // → ~/.atom/extensions  (respects ATOM_HOME)
projectExtensionsDir(cwd?: string) // → <cwd>/.atom/extensions
```

The global directory resolves under `atomDir(home)`, which itself honors `ATOM_HOME`. The project directory is rooted at the process `cwd()` (overridable). Explicit paths from `ATOM_EXTENSIONS` are split on `path.delimiter` (`;` on Windows, `:` on POSIX) and trimmed of whitespace.

### Dotfiles are skipped

Any entry whose name starts with `.` (e.g. `.backup.js`, `.DS_Store`) is silently omitted from discovery. This prevents editor swap files and dotfile configs from accidentally executing.

---

## <a id="installation-formats"></a>Installation formats

Each discovered entry is resolved to one or more loadable `.ts`/`.js`/`.mjs`/`.cjs` **entry files** using these rules (implemented in `resolveEntries` from `src/extensions.ts`):

### 1. Single file

Drop a single entry file directly into any scope directory:

```text
~/.atom/extensions/hello.js          → loads as extension "hello"
~/.atom/extensions/my-tool.mjs        → loads as extension "my-tool"
~/.atom/extensions/deploy.ts         → loads as extension "deploy" (via jiti)
```

### 2. Subdirectory with an index file

A subdirectory is scanned for a conventional entry point. ATOM looks for these basenames in order and loads the first that exists:

1. `index.ts`
2. `index.js`
3. `index.mjs`
4. `index.cjs`

```text
~/.atom/extensions/my-plugin/index.js  → loads as extension "my-plugin"
```

The extension's **name** is the directory name (e.g. `my-plugin`), not `index`. See `resolveExtensionName` in `src/extensions.ts`.

### 3. Subdirectory with an `atom.extensions` manifest (package.json)

A subdirectory may contain a `package.json` with an `atom.extensions` field — an array of entry-file paths relative to that directory. This mirrors the Pi `pi` field convention. When present, **the manifest entries take precedence** over the `index.*` fallback:

```json
{
  "name": "my-extension-suite",
  "atom": {
    "extensions": ["./dist/main.js", "./dist/secondary.js"]
  }
}
```

Each listed path resolves to its own entry file, so a single package can register multiple extensions. Each entry is loaded independently and receives the same `ExtensionAPI` factory contract. The package's extension name for each entry derives from the entry file's stem (or the directory name for `index.*`).

### Recursion limit

Discovery scans **one level deep** only. `resolveEntries` does not recurse beyond a subdirectory's top level (or the manifest entries it declares). This is a deliberate design choice: deep recursive scans through `node_modules`-style trees would be slow and surprising.

---

## Minimal file shape (factory export)

An extension is a **single factory function**. The module's export — either a CommonJS `module.exports` or an ES default export — must be a function. That function receives an `ExtensionAPI` instance and registers contributions by calling methods on it.

### CommonJS (`module.exports`)

```js
// hello.js — put in ~/.atom/extensions/ (trusted) or <cwd>/.atom/extensions/ (gated)
module.exports = function (api) {
  api.notify("hello extension loaded");
};
```

### TypeScript (`export default`)

```ts
// hello.ts — same contract, typed
import type { ExtensionAPI } from "../../src/extensions.js";
export default function (api: ExtensionAPI) {
  api.notify("hello extension loaded");
}
```

### The contract

- The export **must be a function**. A named CommonJS export (`module.exports = { run: fn }`) or a non-function default export is a **recorded load error**, not a crash. `loadExtensions` never throws — per-extension failures land on `runtime.errors` (see the [Runtime model](#runtime-model) section) and loading continues with the rest.
- The factory can be **synchronous or `async`** — `loadExtensions` awaits it. If the factory throws (or a duplicate/colliding name is committed — see [Rules that bite](#rules-that-bite)), that extension fails **alone**: zero registrations from it ever go live, and its error is recorded.
- You can also export named helpers alongside the factory (a CommonJS `module.exports` is an object with a `default`... no wait — for CJS, the exported function itself is the factory; named properties on it are ignored by the loader). The gallery sample `03-custom-command.js` demonstrates this: `module.exports = galleryCommand` sets the factory, and `module.exports.summarizeChoice = summarizeChoice` attaches a pure helper that tests import directly.

### What "same-process via jiti" means

There is no `vm`, no WebAssembly sandbox, no separate worker. jiti resolves and evaluates the file in the **same Node.js process** that runs ATOM. The extension can:

- `import`/`require` any Node built-in (`fs`, `path`, `child_process`, etc.)
- Import any dependency resolvable from the extension's directory (or ATOM's own `node_modules`)
- Access `globalThis` and the full host environment

This is intentional: extensions are trusted local code, not untrusted remote plugins. The trust gate exists precisely because there is no sandbox.

---

## How loading works

Loading is performed by `loadExtensions(opts)` in `src/extensions.ts`. It is a **pure, dependency-free function** — it reads files, evaluates them via jiti, and registers contributions. It never touches React, the TUI, or LLM clients.

### Load options

`loadExtensions` accepts a `LoadOptions` object:

| Option | Type | Default | Description |
|---|---|---|---|
| `home?` | `string` | derived from `ATOM_HOME`/`os.homedir()` | Base dir for global scope + sessions store |
| `cwd?` | `string` | `process.cwd()` | Project root for project scope |
| `extraPaths?` | `string[]` | `[]` | Explicit entry files/directories (highest precedence) |
| `entryPaths?` | `string[]` | `undefined` | Pre-resolved entry files; skips discovery when provided |
| `projectTrusted?` | `boolean` | `true` (programmatic callers) | Whether the project is trusted (see below) |
| `lockdown?` | `boolean` | `false` | Zero third-party extensions, all skipped as `lockdown` |
| `enabledPatterns?` | `string[]` | `[]` | Allowlist globs over extension name |
| `disabledPatterns?` | `string[]` | `[]` | Denylist globs over extension name |
| `builtinSlashCommands?` | `readonly string[]` | `undefined` | Builtin `/` command names to collision-check against |
| `sessionId?` | `string \| null` | `null` | Session the runtime's `get/setSessionState` scopes to |
| `interactive?` | `boolean` | `false` | Whether a live TUI is fulfilling extension dialogs |

### The trust gate (precedence)

Every discovered entry passes through a **gating filter** before import. Skipped entries are **never imported** — their factory never runs — and are recorded in `runtime.skipped` with a reason:

| Skip reason | When |
|---|---|
| `lockdown` | `--no-extensions` / `--lockdown` is active. Covers **all** third-party scopes (project, global, explicit). Builtins are untouched. |
| `untrusted-project` | Scope is project or explicit, and `projectTrusted` is `false`. Global-scope entries are always exempt (implicitly trusted). |
| `disabled` | The extension's name matches a `--disable-extension` glob or `atom.json` `extensions.disabled` entry. |
| `not-enabled` | A non-empty `--enable-extension` allowlist is set and the name doesn't match any pattern. |

**Precedence, highest first:** `lockdown` > `untrusted-project` > `disabled` > `not-enabled` > `load`.

### Staged commit and atomicity

Within `loadExtensions`, each entry's factory runs in a **two-phase activation** — validate-then-commit:

1. **Stage phase.** The factory receives an `activationApi` and calls `registerTool`, `registerCommand`, `on`, etc. Each call validates its shape **eagerly** (e.g. name regex, non-empty description, non-function handler) and pushes the registration into a `pending*` list. Nothing is committed to the global stores yet.

2. **Commit phase.** If the factory resolves successfully, the staged registrations are flushed to the global stores in a fixed order: tools → overrides → commands → hints → UI surface → interceptors → provider hooks → compaction hooks → switch gates. **Every step is atomic:** if any single commit step throws (e.g. a duplicate tool name, a builtin-name collision), all registrations committed earlier in that same round are **rolled back** and the extension is recorded as an error. Zero partial state remains.

This means a factory that throws, or that registers a name colliding with another extension, leaves **nothing** behind — not half a tool definition, not a dangling event handler.

### Module evaluation isolation

jiti instances cache modules by URL. If the same jiti instance were reused across `loadExtensions` calls, an edited extension file would serve stale code on reload. To prevent this, **each `loadExtensions` call creates a fresh jiti importer** that is shared only across that load's entries. Source is read fresh from disk and evaluated with `forceTranspile: true` (bypassing Node's native `.js` require cache) into an isolated module cache. After `/reload`, the current file contents are evaluated.

### `loadExtensions` never throws

This is a hard invariant. Every failure path — missing file, syntax error, non-function export, factory throw, commit-time collision — is **recorded** on `runtime.errors` with the entry's absolute path and an error message, and loading proceeds to the next entry. The caller always gets a usable `ExtensionRuntime` back.

---

## Trust prompt

With a **project-scope** extension present and the project **not yet trusted**, startup triggers a one-time question modal (driven by `App.tsx` reading `runtime.skipped`):

```text
This project contains 1 extension(s) (hello) that run unsandboxed with your full user privileges — they can read/write your files and run commands as you. Load them?
```

The exact wording is generated by `projectTrustQuestion(names)` in `src/project-trust.ts` — it is a **single source** shared by the App and tests, so the acceptance criterion pins on these words.

### Trust answers

| Answer | Effect |
|---|---|
| **`Trust and load`** | Persists a per-project grant in `~/.atom/trusted-projects.json` (a plain JSON array of absolute directory paths). On the next boot the extension loads without asking. |
| **`Keep disabled`** | Nothing executes. A visible "skipped" notice posts in the transcript. The project grant is **not** persisted, so the prompt asks again on next startup. |
| **Esc** (decline) | Same as "Keep disabled" — nothing runs, nothing persists, prompt returns next boot. |

### How trust is stored

`src/project-trust.ts` manages a `trusted-projects.json` file (load-never-throws pattern: a missing or corrupt file yields `[]`, never throws). Grants are added by `grantProjectTrust` and removed by `revokeProjectTrust`. The file is re-read on **every** `loadExtensions` call, so editing it by hand (or via a `/trust`-style command) takes effect on the next boot without needing to touch an in-memory cache.

### The `isProjectTrusted()` API

Extensions themselves can query the trust state via `api.isProjectTrusted()`. This returns `true` when the project is trusted (or the extension is global-scope) and `false` when project/explicit extensions are running inert. Use it to **degrade gracefully** — e.g. skip project-file reads, register read-only commands, or warn the user — instead of assuming trust.

---

## Enable, disable, lockdown

There are four layers of control, applied in decreasing precedence. All are resolved in `loadExtensions` against the extension's **name** (the file stem or directory name) using `*.` and `?` globs from `src/permissions.ts` (`matchGlob`):

### CLI flags (parsed by `parseExtensionFlags` in `src/extensions.ts`)

Pure-function argument parsing (no TUI import) so `cli.tsx` stays thin and tests can unit-test flag parsing directly.

- `--enable-extension <glob>` *(repeatable)*: **Allowlist.** Only matching names load; the rest skip as `not-enabled`. Accepts both `--flag value` and `--flag=value` syntax. Comma-separated values are split and trimmed.
- `--disable-extension <glob>` *(repeatable)*: **Denylist.** Wins over `--enable-extension`; matches skip as `disabled`.
- `--no-extensions` / `--lockdown`: Boots with **zero** third-party extensions — project, global, and explicit paths alike skip as `lockdown`. Builtins are untouched.

### Configuration (`atom.json`)

```json5
// ~/.atom/atom.json (global) or <cwd>/atom.json (project)
{
  "extensions": {
    "enabled": ["my-tool", "ci-*"],
    "disabled": ["secret-scanner"]
  }
}
```

The `enabled` and `disabled` arrays use the **same glob dialect** as the CLI flags. Config is re-read per call, so edits apply without restart.

**Config precedence:** CLI flags win over `atom.json` when set; project `atom.json` wins over global `atom.json`. See [Configuration](configuration.md).

```text
CLI (--enable-extension)    →  wins when present
atom.json (project scope)   →  next
atom.json (global scope)    →  fallback
load (no filter)            →  default: load everything allowed
```

### Precedence summary

```text
lockdown  >  untrusted-project  >  disabled  >  enabled  >  load
```

That is:
1. If `--lockdown` is active → everything third-party skips.
2. If the entry is project/explicit scope and the project is untrusted → skips regardless of enable/disable patterns.
3. If the name matches a `--disable-extension` or `extensions.disabled` pattern → skips.
4. If a non-empty `--enable-extension` / `extensions.enabled` allowlist is set and the name doesn't match → skips as `not-enabled`.
5. Otherwise → loads.

---

## How to see it loaded

On startup, when any extension loads or fails, ATOM posts **one** summary info line to the transcript:

```text
(extensions: 1 loaded (hello))
```

When extensions are skipped (not loaded for a trust/filter/lockdown reason), they appear in a **separate** line with the fix:

```text
(extensions: 1 skipped (hello) — the project is not trusted; trust the project when asked on next startup to load them)
```

Skipped extensions are never imported — their factories never run. Other reasons surface their specific cause (e.g. `disabled`, `lockdown`, `not-enabled`).

### Confirming the surface

Once loaded, an extension contributes to these visible surfaces:

| Surface | How to check |
|---|---|
| **Custom tools** | `/tools` lists registered custom tools alongside builtins |
| **Slash commands** | `Ctrl+P` (command palette) and the `/` menu list registered slash commands |
| **Status bar** | Contributed status segments render in the fixed-width bar |
| **Prompt hints** | Appear under "Extension hints" in the assembled system prompt |
| **Tool overrides** | Shadowed builtins carry an `[overridden by extension "..."]` marker in their description, one-liner, and `/tools` entry |

---

## Gallery (copy-paste samples)

The three files under `examples/extensions/` are the **single source of truth**. The guide excerpts them by name; `tests/extension-gallery.test.ts` loads them through the real `loadExtensions` path — never a mock API, never a copy — so the samples and the guide cannot drift.

### `01-audit-gate.js` — destructive-command audit gate

Blocks risky shell commands **before** they run. Registers an `onBeforeToolCall` interceptor over **every** loop-executed tool call (builtins and custom tools alike). Returning `{ block: reason }` vetoes the call: the reason commits as a normal model-visible `Error: blocked by extension "01-audit-gate": <reason>` result, approval is skipped entirely, and the tool never executes.

```js
// 01-audit-gate.js
module.exports = function auditGate(api) {
  api.onBeforeToolCall(({ name, args }) => {
    if (name !== "bash") return;
    const command = String(args?.command ?? "");
    const DESTRUCTIVE = ["rm -rf /", "rm -rf ~", "rm -rf .", "mkfs", ":(){:|:&};:"];
    if (DESTRUCTIVE.some((sig) => command.includes(sig))) {
      return {
        block:
          "destructive shell commands need explicit confirmation — " +
          "narrow the command or confirm it with the user first",
      };
    }
  });
};
```

**What you see in the transcript** (the test asserts this):

```text
Error: blocked by extension "01-audit-gate": destructive shell commands need explicit confirmation — narrow the command or confirm it with the user first
```

Safe commands (`ls -la`, etc.) pass through untouched — the hook returns early and the call runs normally.

---

### `02-notes-tool.js` — model-callable notes tool

Registers a **brand-new tool** the model can call exactly like a builtin. It appears in the tool definitions sent to the provider, validates its own arguments inline, and dispatches through the shared tool loop.

```js
// 02-notes-tool.js
const notes = [];

module.exports = function notesTool(api) {
  api.registerTool({
    name: "gallery_notes",
    description: "Save a short note and read it back. Use it to remember user preferences across the turn.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (args) => {
      notes.push(String(args.text));
      return `saved note #${notes.length}: ${notes[notes.length - 1]}`;
    },
    // Pure, side-effect-free helper (in-memory only): safe to run
    // without an approval prompt. Anything with a real footprint keeps
    // the default (requireApproval: true).
    requireApproval: false,
  });
};
```

**Key behaviors verified by the tests:**

| Behavior | What the test checks |
|---|---|
| Registration | `toolNames()` contains `"gallery_notes"` |
| Arg validation | `validateToolArgs("gallery_notes", {})` → `missing required field "text"` |
| Type validation | `validateToolArgs("gallery_notes", { text: 42 })` → `must be a string` |
| No execution on bad args | `executeTool("gallery_notes", {})` returns `Error: invalid call: ...` (the `execute` function is never called) |
| Execution | `executeTool("gallery_notes", { text: "hello" })` → `saved note #1: hello` |
| End-to-end loop | A scripted `runLoopWithChat` that calls `gallery_notes` returns the saved-note result paired by `tool_call_id` |

The `requireApproval: false` opt-out is deliberate: this tool only appends to an in-memory array (no filesystem, no network, no shell). Custom tools default to `requireApproval: true` — see [Approval fail-closed](#rules-that-bite).

---

### `03-custom-command.js` — custom slash command with a modal dialog

Registers a real `/gallery-plan` slash command that prompts the user to pick a deploy target in a modal dialog, then posts the plan to the transcript. The workflow logic is extracted into a pure helper (`summarizeChoice`) so the dialog flow is testable headless — the test drives the command with a stub `askUser` and unit-tests the helper directly.

```js
// 03-custom-command.js
function summarizeChoice(choice, extra) {
  const scope = String(extra ?? "").trim();
  return scope.length > 0
    ? `deploying to ${choice} (${scope})`
    : `deploying to ${choice}`;
}

function galleryCommand(api) {
  api.registerCommand({
    name: "gallery-plan",
    description: "Pick a deploy target and post the plan.",
    handler: async (ctx) => {
      const choice = await ctx.askUser("Which environment?", ["staging", "prod"]);
      const plan = summarizeChoice(choice, ctx.args);
      ctx.say(plan);
      return `plan posted for ${choice}`;
    },
  });
}

module.exports = galleryCommand;
module.exports.summarizeChoice = summarizeChoice;
```

**What the test verifies:**

1. The pure helper: `summarizeChoice("staging", "")` → `"deploying to staging"`; `summarizeChoice("prod", "extra notes")` → `"deploying to prod (extra notes)"`.
2. The command registration: `getExtensionCommand("gallery-plan")?.description` contains `"deploy target"`.
3. The full command run with a stub `askUser` that returns `"prod"`: the `deps.asked` array receives `{ question: "Which environment?", options: ["staging", "prod"] }`, the `deps.said` array receives `["deploying to prod (extra notes)", "plan posted for prod"]`, and the result is `{ ok: true, posted: 2 }` (two staged messages committed).

`ctx.args` is the raw typed argument string after `/gallery-plan` (e.g. `gallery-plan extra notes` → `ctx.args = "extra notes"`). `ctx.argv` provides the whitespace-tokenized version with quote grouping. The `say` method stages messages that are **committed only on success** — a throwing handler drops the stage and leaves the session untouched.

---

## API surface reference

The `ExtensionAPI` (defined in `src/extensions.ts`) exposes exactly these methods. Every method throws synchronously if called on a **stale** (pre-replacement) API object — see [Runtime model](#runtime-model).

### Lifecycle

#### `on(event, handler) → unsubscribe`

Subscribes to a lifecycle event. `event` is `"session_start"` (emitted on startup, session switch, `/new`, `/resume`, reload) or `"session_shutdown"` (emitted on quit or session teardown). The `handler` receives a fresh `ExtensionAPI` and an `ExtensionEventInfo` with a `reason: string` describing why the event fired.

```ts
api.on("session_start", (api, info) => {
  // info.reason: "startup" | "switch" | "new" | "resume" | "reload" | "quit" ...
  api.notify(`session started: ${info.reason}`);
});
```

Returns an **unsubscribe function**. Calling it removes the handler from future emissions.

#### `invalidate(message)` (on the runtime, not the API)

Bumps the generation counter. After this, **every API object handed out before the bump throws** on any further use. The host calls this on every session replacement (switch, `/new`, `/resume`, reload). See [Runtime model](#runtime-model).

### Tools

#### `registerTool(def) → unsubscribe`

Registers a **new model-callable tool**. The tool appears in `allToolDefinitions()` (the schema list sent to every provider), validates its arguments through the same inline gate as builtins, and dispatches through the shared tool-execution loop (`executeTool` in `src/tools/registry.ts`). From the model's perspective it is indistinguishable from a builtin.

```ts
api.registerTool({
  name: "gallery_notes",        // [A-Za-z0-9_-]{1,64}
  description: "...",            // non-empty, sent to the provider
  parameters: {                 // OpenAI-style JSON schema, type: "object" required
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  execute: async (args, ctx) => {
    // args: validated against parameters schema (bad args never reach here)
    // ctx: { cwd: string }
    return "result string";
  },
  requireApproval: false,        // defaults to true (fail-closed)
  oneLiner: "Save a note",       // optional, defaults to description head
  executionMode: "sequential",   // optional scheduling hint (see below)
});
```

- **Validation happens before execution.** Bad args produce `Error: invalid call: <detail>` as the model-visible result — the `execute` function never runs. This is enforced in `validateCustomToolArgs` (`src/tools/custom.ts`).
- **Approval fail-closed by default.** Custom tools require user approval unless `requireApproval: false` is set. The approval policy is in `needsApproval` (`src/tools/registry.ts`): a custom tool with no `requireApproval` field defaults to `true`.
- **Serial by default.** Custom tools carry no scheduler effect metadata, so the planner fails safe to a **serial singleton** — one execution at a time, never batched. The optional `executionMode` hint (`"sequential"` | `"parallel"`) only ever **adds** serialization: `"sequential"` forces the whole sibling batch one-at-a-time; `"parallel"` is advisory and changes nothing today.
- **Duplicate detection.** A second `registerTool` with the same name throws (caught at commit, failing that extension alone). Builtin-name collisions also throw.
- Returns an **unsubscribe function** that removes the tool from the registry.

#### `overrideTool(def) → unsubscribe`

Shadows a **builtin tool** by name with an audited, reversible override. This is not a replacement — it is an **interception**. The override's `execute` receives every call to that tool and decides per-call: deny a subset (throw, or return an `Error:` result) or pass the rest through via `ctx.passthrough(...)` (the default behavior).

```ts
api.overrideTool({
  name: "bash",                 // must name a real builtin
  execute: async (args, ctx) => {
    // args: already validated by the builtin's schema (runs before override)
    if (isTooDangerous(args.command)) {
      throw new Error("blocked by policy");
      // OR: return "Error: blocked by policy (reason)";
    }
    // Pass through to the pristine builtin — re-validates args internally.
    return ctx.passthrough(args);  // or ctx.passthrough() to pass through received args
  },
  executionMode: "sequential", // optional
});
```

Key guarantees:
- **Never silent.** The builtin's model-visible definition, activity label (`⚙ bash ... (override: my-ext)`), and `/tools` one-liner all carry an `[overridden by extension "..."]` marker.
- **Reversible.** Removing the override (calling the returned unsubscribe, or `unload()`) restores the pristine builtin with zero residue.
- **Deny-by-default forbidden.** The builtin stays reachable through `ctx.passthrough` — you cannot write an override that permanently blocks a tool.
- **Recursion-proof.** `ctx.passthrough` calls `executeBuiltinTool` directly, which never consults the override store.
- **Only builtins can be overridden.** Passing a non-builtin name throws: `"extension tool override "<name>" is not a builtin tool (only builtins can be overridden)"`.
- Builtin arg validation runs **before** the override and **inside** passthrough, so an override can never smuggle unvalidated args into the pristine builtin.

#### `addPromptHint(hint) → unsubscribe`

Contributes a short model-facing guidance string to the assembled system prompt. Hints append under an **"Extension hints"** section in registration order — they flow through the **existing** prompt assembly (`buildSystemPrompt` in `zen.ts`), never a parallel pipeline.

```ts
api.addPromptHint(
  "Use gallery_notes to remember preferences across the turn. " +
  "Call it before finalizing any decision that depends on user context."
);
```

Validation: the hint must be a non-empty string, max `MAX_PROMPT_HINT_CHARS` (2000) characters. Empty or oversize hints fail activation loudly.

### Commands

#### `registerCommand(def) → unsubscribe`

Registers a **real slash command** (`/name args`) that appears in the command palette (`Ctrl+P`) and the `/` menu. Unlike tools, commands run **outside** the model turn loop — they are invoked by the user, not the model.

```ts
api.registerCommand({
  name: "gallery-plan",         // bare lowercase [a-z0-9][a-z0-9_-]{0,63}
  description: "Pick a deploy target and post the plan.",
  handler: async (ctx) => {
    const choice = await ctx.askUser("Which environment?", ["staging", "prod"]);
    const plan = summarizeChoice(choice, ctx.args);
    ctx.say(plan);
    return `plan posted for ${choice}`;
  },
});
```

The handler receives an `ExtensionCommandContext`:

| Field | Type | Description |
|---|---|---|
| `ctx.name` | `string` | Bare command name as registered (e.g. `"gallery-plan"`) |
| `ctx.args` | `string` | Raw typed arguments after `/name` (trimmed; `""` if bare) |
| `ctx.argv` | `string[]` | Whitespace-tokenized args (double/single quotes group; quotes stripped; no escape processing) |
| `ctx.cwd` | `string` | Working directory the command runs against |
| `ctx.askUser(question, options?, allowCustom?)` | `() => Promise<string>` | Modal dialog picker (see [Dialogs](#promptuserquestion-options-allowcustom)) |
| `ctx.getSession()` | `() => ExtensionCommandSessionSnapshot` | Active session snapshot (`{ id, title, turnCount }`) |
| `ctx.say(message)` | `(message: string) => void` | Stages a transcript message (committed only on success) |

The context is **generation-bound**: every `ctx` call runs an internal stale check first, so use after a session replacement throws loudly instead of acting on the wrong session.

**Collision policy:** Builtins always win. A colliding name fails activation loudly (nothing commits) — there is no renamed form to discover. The host passes `SLASH_COMMANDS` (the builtin `/` command list) via `LoadOptions.builtinSlashCommands`, and `registerCommand` checks against it. App dispatch routes builtins first as a backstop.

A handler that throws surfaces as a clean `Error: extension command "/name" failed: <reason>` and leaves the model session untouched. Staged `say()` messages are committed only after the handler resolves successfully.

`runExtensionCommand(name, rawArgs, deps)` is the test/host entry point. `deps` provides `cwd`, `askUser`, `getSession`, `say`, and an optional `checkStale`.

### Interception hooks

#### `onBeforeToolCall(handler) → unsubscribe`

Registers a **pre-execution interceptor** over **every** loop-executed tool call — builtins and custom tools alike. Handlers run in **registration order**, **pre-validation and pre-approval**.

```ts
api.onBeforeToolCall(({ name, args }) => {
  // name: the tool name as the model called it (always a known tool)
  // args: the current arguments (cumulative rewrites from earlier handlers)
  
  // Rewrite: return { args: newArgs } — later handlers see the rewrite,
  // and the new args re-validate before execution.
  if (name === "bash" && args.command === "rm -rf /") {
    return { args: { ...args, command: "echo 'blocked'" } };
  }

  // Veto: return { block: reason } — approval is skipped entirely, the
  // reason commits as a normal model-visible result ("Error: blocked by
  // extension "...": <reason>"), and the tool never runs.
  return { block: "destructive command blocked" };

  // Or: return a plain string — that's also a block reason.
  // Or: return { block: true } — block with a default reason.
  // Or: return void/null/undefined — pass through untouched.
});
```

Semantics:
- **First block wins.** Once a handler returns a block, later handlers never run for that call.
- **Rewrites are cumulative.** Each handler sees the previous handler's `{ args }`. Rewritten args re-validate before execution.
- **Fail-closed on throws.** A throwing (or rejecting) before-handler **blocks** the call with a `handler failed: <reason>` notice. This is deliberate: an interceptor crash must never let an unsafe execution proceed blindly.
- The input type `BeforeToolCallInput` is `{ name: string; args: Record<string, unknown> }`. The return type `BeforeToolCallResult` accepts `BeforeToolCallDecision | string | null | undefined | void`.

#### `onAfterToolCall(handler) → unsubscribe`

Registers a **post-execution result patcher** — observes every **committed** tool result (executions, blocks, denials, validation errors). Handlers run in registration order inside the commit funnel.

```ts
api.onAfterToolCall(({ name, args, result, isError }) => {
  result;    // the result string about to commit
  isError;  // whether it's an error result
  // Patch what the model sees:
  return { content: result.replace(/secret/g, "[REDACTED]") };
  // Or: return a plain string to replace entirely.
  // Or: return void/null/undefined — pass through untouched.
});
```

Semantics:
- **Fail-open on throws.** A throwing after-handler is dropped; the unpatched result continues. A patch must never break the turn.
- **Call pairing preserved.** `tool_call_id` re-pairing and commit order are untouched — the handler only changes the content string.
- The input type `AfterToolCallInput` is `{ name: string; args: Record<string, unknown>; result: string; isError: boolean }`. The return type `AfterToolCallResult` accepts `AfterToolCallDecision | string | null | undefined | void`, where `AfterToolCallDecision` is `{ content?: string }`.

### Session switch gate

#### `onBeforeSwitch(handler) → unsubscribe`

Vetoes a **pending session switch** (switch, `/new`, `/resume`). This is a cancellable pre-check that runs **before** any snapshot/persist/mutate step, so a cancelled switch leaves the live session completely untouched.

```ts
api.onBeforeSwitch((api, info) => {
  // info: { fromSessionId, toSessionId, reason }
  if (info.reason === "switch" && !isAllowed(info.toSessionId)) {
    return { cancel: true };           // or: true, or: "not allowed"
  }
  // Return void/null/false — allow the switch.
});
```

- **First explicit cancel wins.** Later handlers never run for a cancelled switch.
- **Fail-open on throws.** A throwing handler is recorded and the switch proceeds — a buggy extension must never hold navigation hostage.
- Cancel shapes: `true` (default reason naming the extension), a non-empty string (that reason), or `{ cancel: true | "reason" }`. Everything else (void/null/false/`{cancel:false}`/foreign shapes) allows.
- The handler receives a **fresh generation-bound API**; a captured pre-replacement handle would throw via the generation check.

### Provider hooks (ticket 08)

These hooks run over the **outgoing provider POST** — the assembled payload and headers, and the resulting response. They cover all three transports (`openai-chat`, `anthropic-messages`, `gemini-generate`) via the single `chatCompletionForProvider` dispatcher in `zen.ts`.

#### `onTransformContext(handler) → unsubscribe`

Replaces the **outgoing conversation context** (the message array) before it is sent. Handlers run in registration order per POST over every provider kind; each sees the previous handler's output.

```ts
api.onTransformContext((messages) => {
  // messages: ChatMessage[] — a deep copy, mutations are safe
  // Return a replacement array, or void/null/undefined to pass through.
  return messages.filter((m) => m.role !== "system");
});
```

- **Fail-open.** A throwing handler — or a non-array/malformed-array return — degrades to the untransformed value. There is no unsafe execution to prevent here (only request shaping), and a buggy redactor must not hold every model round hostage.
- The handler receives a **deep copy** (`structuredClone` with JSON fallback) of the messages, so in-place mutation never corrupts the live transcript.
- The loop transcript itself is never mutated — only the per-POST copy is transformed.

#### `onBeforeRequest(handler) → unsubscribe`

Inspects or replaces the **outgoing payload and headers** per POST.

```ts
api.onBeforeRequest(({ provider, model, url, payload, headers }) => {
  // Return { payload } to replace the body wholesale (must be a record).
  // Return { headers } to set per-key values:
  //   string  → set/overwrite
  //   null/undefined → delete the key
  //   anything else → ignored (never silently stringified)
  return {
    headers: { "x-custom-header": "value", "x-stale": null },  // null deletes
  };
});
```

Semantics:
- **Fail-open on throws.** A throwing handler is skipped (its change dropped, the chain continues) — one buggy header injection never fails the turn.
- **Per-key header merge.** `headers` is merged, not replaced. A non-record `payload` replacement is **ignored** — the replacement still flows through downstream JSON/fetch handling, never bypassing it.
- Input: `BeforeRequestInput = { provider, model, url, payload: Record, headers: Record<string, string> }`.
- Output: `BeforeRequestResult = BeforeRequestDecision | null | undefined | void`, where `BeforeRequestDecision = { payload?: Record; headers?: Record<string, string | null | undefined> }`.

#### `onAfterResponse(handler) → unsubscribe`

Observes the **provider's response** without breaking the turn. This is **observe-only** — return values are ignored.

```ts
api.onAfterResponse(({ provider, model, url, status, ok, headers }) => {
  // Fires for every resolved POST — ok responses AND HTTP errors.
  // Network throws never fire (no response to observe).
  console.log(`${provider} ${model} → ${status} (${ok ? "ok" : "error"})`);
});
```

- **Fail-open on throws.** A throwing handler is dropped; the turn continues untouched.
- Snapshot input: `AfterResponseInput = { provider, model, url, status: number, ok: boolean, headers: Record<string, string> }`.
- Headers are lower-cased per the Headers API conventions.

### Compaction hooks (ticket 09)

#### `onBeforeCompact(handler) → unsubscribe`

Vetoes a **pending compaction** (auto threshold, manual `/compact`) or replaces the **builtin summary**.

```ts
api.onBeforeCompact((info) => {
  // info: { reason, focusText, head, tail, olderTurnCount }
  // head: messages about to be summarized (deep copy, read-only)
  // tail: newest turns retained verbatim (deep copy, read-only)
  // reason: "auto" | "manual" | "overflow"

  // Veto:
  return { cancel: true };  // or: true, or: "reason", or: { cancel: "reason" }

  // Custom summary (replaces the builtin summarizer output):
  return { summary: "user set up the project, then ran tests" };

  // Pass through: return void/null/false — let the builtin proceed.
});
```

Semantics:
- **Cancel (fail-closed on explicit veto, fail-open on throws).** Only an explicit cancel vetoes: `true`, a non-empty string, or `{ cancel: true | "reason" }`. A throwing handler is recorded and fails open (degrades to the builtin summary with a visible error). A buggy extension must never hold compaction hostage or half-compact a session.
- **Custom summary (fail-open).** `{ summary: "text" }` replaces the builtin summarizer output. The text must be a non-empty string after trimming. The **first valid summary wins** — later handlers never run. The winning text enters the **same post-processing** as builtin output (touched-files append/fit, boundary marker, atomic swap, save, snapshot clearing) at the single injection point in `doCompact` — never a parallel pipeline.
- **First-wins for both.** The first explicit cancel wins (later handlers never run). The first valid custom summary wins (later handlers never run).
- A **bare string return** is interpreted as a cancel reason (the `before_switch` convention), never a summary — so the two decisions can never be confused.
- The `head`/`tail` arrays are **fresh deep copies per handler** — an in-place mutation cannot corrupt planning.

### Session state

#### `getSessionState() → unknown`

Reads this extension's **per-session state** — the namespaced slot under the session store record's `metadata.extensions` field, so it persists across `/resume` and reload with the session itself. Returns `undefined` when nothing was stored, or when the API is unbound (no active session).

#### `setSessionState(value) → void`

Persists this extension's per-session state into the current session's store record. The value **must be JSON-serializable**. Passing `undefined` **clears** the slot.

```ts
api.on("session_start", (api, info) => {
  const count = (api.getSessionState() as number | undefined) ?? 0;
  api.setSessionState(count + 1);
});
```

- The returned value is a **fresh read** — mutating it persists nothing; you must call `setSessionState` again.
- State writes bump the record's `updatedAt` (they are mutations).
- Throws on unserializable values, when no session is bound, when the record is gone, and on stale (pre-replacement) APIs.
- **Survives reload by design.** `unload()` invalidates APIs and clears global registrations, but per-session extension state rides the session record and is untouched. See [Runtime model](#runtime-model).

### Project trust

#### `isProjectTrusted() → boolean`

Queries whether this load is trusted. Returns `true` when the project is trusted (or the extension is global-scope), `false` when project/explicit extensions are running inert. Use it to **degrade gracefully** — e.g. skip project-file reads, register read-only commands — instead of assuming trust.

### UI surface (ticket 10)

These methods contribute to the **render model** managed by `src/extension-ui.ts`. All staged UI commits atomically with the rest (a throwing factory leaves zero UI residue):

#### `setStatusSegment(text) → unsubscribe`

Contributes a **one-line status-bar segment** — one slot per extension, keyed by owner name (upsert). The bar renders extensions in a fixed-width budget (`EXT_STATUS_SEGMENT_MAX` = 24 chars per segment, `EXT_STATUS_TOTAL_MAX` = 40 chars total, truncation via `truncateSegment` which keeps the meaningful tail).

```ts
api.setStatusSegment("🧠 42 notes");
```

- Empty or oversize text throws fail-closed.
- Calling again updates the same slot live across turns.
- Any of the returned unregister functions removes the slot (so keep the latest handle).
- On session replacement, segments persist keyed by owner — the fresh `session_start` API updates the same slot. On `unload()` or `disposeUI()`, they clear with zero residue.

#### `setWidget(def) → unsubscribe`

Contributes a **panel widget** — a titled text block keyed by owner + id (default `"main"`), rendered by the App in the configured placement. In v1, `"panel"` is the only placement (the bordered panel above the input zone, beside the todo panel).

```ts
api.setWidget({
  id: "dashboard",        // optional, [a-z0-9][a-z0-9_-]{0,31}, default "main"
  placement: "panel",     // v1: "panel" only
  title: "Build Status",  // 1–48 chars
  text: "✅ All green",     // 1–500 chars, plain text
});
```

- Same-id calls upsert in place for live updates.
- Unknown placements throw fail-closed (never a silent nowhere).
- Returns an unsubscribe that removes that widget id.

#### `notify(message) → void`

Posts a **transient transcript notice** — the staged queue drains into the transcript as `(owner) message` info lines, one per notice. Fire-and-forget (synchronous, returns void) — it never blocks, headless or not.

```ts
api.notify("connected to MCP server");
```

- Staged with the other UI, committed only on successful activation.
- **Bounded queue** (cap `EXT_NOTICE_CAP` = 100, drop-oldest) so a chatty extension cannot grow memory between render drains.
- Vanishes on drain or session teardown — nothing to unregister.
- Empty or oversize messages (`max 200 × 4 = 800 chars`) throw fail-closed.

#### `promptUser(question, options?, allowCustom?) → Promise<string>`

Opens a **modal dialog** resolved with the user's picked answer or custom text. Fulfilled by the host via `runtime.resolvePendingDialog(answer)`; dismissed via `runtime.cancelPendingDialog(reason)` (or Esc).

```ts
const target = await api.promptUser(
  "Deploy to where?",
  ["staging", "prod"],
  false  // allowCustom: whether typing a free-text answer is allowed
);
```

**Single-flight and interactive-only** — these are the "rules that bite" for dialogs:

| Condition | Behavior |
|---|---|
| A second dialog while one is open | **Rejects immediately** — never queues, never hangs |
| Non-interactive mode (`--dashboard`, `--serve`) | **Rejects immediately** — no modal to answer, never hangs |
| Called during activation (factory execution) | **Rejects immediately** — no runtime is assigned yet to fulfill it |
| Session replacement while a dialog is pending | The pending promise **rejects** with the stale error — never hangs, never resolves into the wrong session |
| Called on a stale (pre-replacement) API | **Throws synchronously** |

- Options max `EXT_DIALOG_OPTIONS_MAX` (8); option max `EXT_DIALOG_OPTION_MAX` (80 chars); question max `EXT_DIALOG_QUESTION_MAX` (200 chars).
- If no options and `allowCustom` is not `true`, validation throws (nothing to answer with).

> **Why `registerCommand`'s `ctx.askUser` works but `api.promptUser` doesn't during activation:** Commands run **outside** the model turn loop, after the runtime is assigned, with the TUI fulfilling the modal. `api.promptUser` during activation fails because the runtime object is not yet bound to the host.

---

## Runtime model

`loadExtensions` returns an `ExtensionRuntime` object that is the **host-side** handle to the loaded extensions. It is distinct from the per-extension `ExtensionAPI` objects handed to factories.

### Runtime fields

| Field/Method | Type | Description |
|---|---|---|
| `loaded` | `LoadedExtension[]` | Successfully loaded extensions (`{ path, name }`) |
| `errors` | `ExtensionLoadError[]` | Failed loads (`{ path, error: string }`) — never throws |
| `skipped` | `ExtensionSkipped[]` | Skipped entries (`{ path, name, reason }`) — never imported |
| `generation` | `number` | Bumped by every `invalidate()` / `unload()` |
| `invalidate(message)` | `(message: string) => void` | Bumps generation, drops staged notices, rejects pending dialogs |
| `unload()` | `() => void` | Releases all global registrations, clears UI surface, invalidates APIs |
| `emit(event, info)` | `(event, info) => Promise<void>` | Fires lifecycle event to handlers in registration order |
| `setSessionId(id)` | `(id: string \| null) => void` | Rebinds `get/setSessionState` scope |
| `requestSwitch(info)` | `(info) => Promise<BeforeSwitchResult>` | Runs `onBeforeSwitch` handlers; first cancel wins |
| `getStatusSegments()` | `() => ExtensionStatusSegment[]` | Snapshot of status bar contributions |
| `getWidgets()` | `() => ExtensionWidgetRecord[]` | Snapshot of panel widgets |
| `drainNotifications()` | `() => ExtensionNotice[]` | Drains (clears) the staged transcript notices |
| `getPendingDialog()` | `() => ExtensionPendingDialog \| null` | Copy of the current open dialog spec |
| `subscribeUI(listener)` | `(listener: () => void) => () => void` | Render subscription (emits on every UI mutation) |
| `resolvePendingDialog(answer)` | `(answer: string) => boolean` | Host-side dialog fulfillment |
| `cancelPendingDialog(reason?)` | `(reason?: string) => boolean` | Host-side dialog dismissal |
| `disposeUI()` | `() => void` | Session-teardown cleanup (segments, widgets, notices) |

### Staged activation and atomicity

Every registration made during a factory's execution is **staged** in `pending*` arrays (pending tools, pending overrides, pending commands, pending hints, pending interceptors, pending provider hooks, pending compaction hooks, pending switch gates, pending UI). Only after the factory resolves **does** the commit phase flush them to the global stores, in a fixed order:

```text
tools → overrides → commands → hints → UI surface → before-tool-call →
after-tool-call → context-transform → before-request → after-response →
before-compact → before-switch → event handlers (on)
```

If any commit step throws (e.g. a duplicate tool name discovered at commit, a builtin collision), all registrations committed earlier in that same round are **rolled back** via their captured unregister closures. The exception is recorded in `runtime.errors` with the entry path, and loading proceeds to the next extension. **Nothing half-loads.**

### Generations and stale handles

**The stale-generation rule** is the most important safety property. Every session replacement (switch, `/new`, `/resume`, reload) calls `runtime.invalidate(message)`, which:

1. **Bumps the generation counter** (a module-level `let generation`).
2. **Drops all staged notices** from the dead lineage — so pre-switch `notify()` calls never print into the new session's transcript.
3. **Rejects any pending dialog** (prevents hangs across the boundary — the dialog never resolves into the wrong session).

Every `ExtensionAPI` object captured the generation at creation (`apiGeneration`). Each API method calls `staleCheck()` first — if `apiGeneration !== generation`, it throws `Error(message)`. This turns use-after-replacement into a **loud error**, not a silent wrong-session bug.

**Event handlers always receive a fresh API.** `runtime.emit` constructs a brand-new `ExtensionAPI` via `makeApi(...)` for each handler invocation, so `session_start` handlers on a fresh runtime get a live, current-generation API even if they were registered before an invalidate.

**The `on()` activation path** uses an `activationApi` captured with the `activationGeneration`. A handler registered during activation that fires on a stale runtime throws at call time — but the fresh API passed to `emit`-time handlers is always live.

### Reload support

`unload()` is the reload path. It:

1. Calls `doInvalidate("extension runtime unloaded (reload)")` — invalidates all handed-out APIs.
2. Releases **every committed global registration** best-effort (tools, overrides, commands, hints, interceptors, provider hooks, compaction hooks, switch gates) via their captured unregister closures in `committedUndos`.
3. Clears runtime-local UI surface (segments, widgets).
4. Leaves per-session extension state **untouched** — it rides the session record and survives reloads by design.

After `unload()`, the same entry paths load cleanly again — the fresh jiti importer in the next `loadExtensions` call evaluates current file contents.

### Session state lifecycle

Per-session extension state lives under the session store record's `metadata.extensions` field: `{ ..., extensions: { [extName]: state } }`. It is namespaced per extension by name, durable (persisted via the sessions store), and:

- Persists across `/resume` and reload (tied to the session, not the runtime).
- Is read fresh on every `getSessionState` call (the store re-reads the file — callers can never alias persisted state, but mutating the return value persists nothing).
- Is cleared via `setSessionState(undefined)` (removes the slot; if the bag is empty, the whole `extensions` key is deleted from metadata).
- The host re-binds the session id via `runtime.setSessionId(id)` on every session boundary (startup, `/new`, `/resume`, switch) **before** emitting `session_start`, so start handlers observe the new session's state.

---

## Rules that bite

### Staged activation is atomic

Validation runs eagerly; a factory that throws (or a duplicate/colliding name at commit) leaves **zero** registrations behind — nothing half-loads. The commit phase flushes to global stores in a fixed order (tools → overrides → commands → hints → UI → interceptors → provider hooks → compaction hooks → switch gates → event handlers), and any failure rolls back everything committed earlier in that round via captured unregister closures.

### Stale generation

Every session replacement invalidates handed-out APIs — captured handles throw loudly; event handlers always receive a fresh, current-generation API. `runtime.invalidate(message)` bumps the generation counter (accessible via `runtime.generation`), drops staged notices from the dead lineage, and rejects any pending dialog so it never resolves into the wrong session.

### Approval fail-closed

Custom tools require approval by default. Opt out only with `requireApproval: false` for pure side-effect-free helpers. The approval policy (`needsApproval` in `src/tools/registry.ts`) checks custom tools first — if `requireApproval` is undefined, it defaults to `true`. MCP server tools fail-closed too for the same reason: an invisible footprint is never auto-approved.

### Serial by default

Custom tools carry no scheduler effect metadata and run as serial singletons — one at a time, never batched. `executionMode: "sequential"` forces the whole sibling batch one-at-a-time; `"parallel"` is advisory and changes nothing today (the tool itself stays serial). This is enforced in the scheduler, not the extension host — the `ExecutionMode` hint is the only lever an extension has, and it only ever **adds** serialization.

### Deny-by-default overrides

An `overrideTool` cannot permanently block a builtin. The builtin stays reachable through `ctx.passthrough(...)` — you may deny a subset (by throwing or returning an `Error:` result) and pass the rest through, but deny-by-default shadowing is forbidden. `ctx.passthrough` calls `executeBuiltinTool` directly (never the override store), so recursion is impossible by construction. Builtin arg validation runs **before** the override and **re-validates inside passthrough**, so an override can never smuggle unvalidated args.

### Dialogs are single-flight and interactive-only

A second `promptUser` while one is open **rejects immediately** (never queues, never hangs). Headless paths reject immediately (no modal to answer). Activation-time prompts reject — commands work because they run outside activation with the TUI fulfilling the modal. A session replacement while a dialog is pending **rejects** the pending promise with the stale error — the dialog never hangs and never acts on the wrong session.

### Throws fail open or closed, by design

The failure semantics are deliberate and varied:

| Hook | Throw behavior | Rationale |
|---|---|---|
| `onBeforeToolCall` | **Fail-closed** (blocks the call) | An interceptor crash must never let unsafe execution proceed |
| `onAfterToolCall` | **Fail-open** (drops the patch) | A patch must never break the turn or desync call pairing |
| `onBeforeSwitch` | **Fail-open** (switch proceeds) | A buggy extension must never hold navigation hostage |
| `onBeforeCompact` cancel | **Fail-open** (builtin compaction proceeds) | A buggy veto must never hold compaction hostage or half-compact |
| `onTransformContext` | **Fail-open** (untransformed value) | A buggy redactor must never break the request |
| `onBeforeRequest` | **Fail-open** (skipped, chain continues) | One bad header injection must never fail the turn |
| `onAfterResponse` | **Fail-open** (dropped) | Observe-only; nothing to break |

### Builtins always win

- A custom tool whose name collides with a builtin **fails activation** (throws at commit). There is no shadowing of builtins by custom tools.
- An `overrideTool` that names a non-builtin **throws** ("only builtins can be overridden"). Overrides shadow builtins, never replace them.
- A slash command whose name collides with a builtin **fails activation** (loud error, nothing commits). App dispatch also routes builtins first as a backstop — a builtin is never shadowed, and there is no renamed form to discover.

### Deep copies across boundaries

To prevent aliasing corruption:

- Provider-hook context transforms receive a **deep copy** of the message array (`structuredClone` with JSON fallback) — in-place mutation never corrupts the live transcript.
- Compaction hooks receive **fresh deep copies** of the head/tail split per handler.
- Runtime reads (`getStatusSegments`, `getWidgets`, `drainNotifications`, `getPendingDialog`, `getToolNames`, etc.) return **copies** — callers can never alias live store state.
- Session state reads are **fresh parses** — mutating the return value persists nothing.

### `loadExtensions` never throws

This is the foundational invariant. Every failure path — missing file, syntax error, non-function export, factory throw, commit-time collision — is **recorded** on `runtime.errors` with the entry's absolute path and an error message string, and loading proceeds to the next entry. The caller always gets a usable `ExtensionRuntime` back with `loaded`, `errors`, and `skipped` populated. Per-extension load errors are surfaced in the startup summary line:

```text
(extensions: 1 loaded (hello), 1 error (broken-ext))
```
