# Extensions

Write a local file, trust the project, restart — your code runs inside ATOM with the full ExtensionAPI. Three copy-paste samples under `examples/extensions/` prove each surface; the guide names them, the tests load them.

## Install location (global vs project)

| Scope | Directory | Trust |
|---|---|---|
| Global | `~/.atom/extensions/` (`ATOM_HOME` overrides home) | Implicitly trusted — user-owned, like your own config |
| Project | `<cwd>/.atom/extensions/` | Gated — never executes until the project is trusted |
| Explicit | `ATOM_EXTENSIONS` env (delimiter-separated paths) | Gated, like project scope |

Each scope entry is a `.ts`, `.js`, `.mjs`, or `.cjs` file, or a subdirectory holding an `index.ts`/`index.js`/`index.mjs`/`index.cjs` (or a `package.json` with an `atom.extensions` manifest listing entry files). Dotfiles are skipped. Order is project, global, explicit.

## Minimal file shape (factory export)

One file, one factory — CJS or TS, both load same-process via jiti:

```js
// hello.js — put in ~/.atom/extensions/ (trusted) or <cwd>/.atom/extensions/ (gated)
module.exports = function (api) {
  api.notify("hello extension loaded");
};
```

```ts
// hello.ts — same contract, typed
import type { ExtensionAPI } from "../../src/extensions.js";
export default function (api: ExtensionAPI) {
  api.notify("hello extension loaded");
}
```

The export must be a function (or a default-exported function). Anything else is a recorded load error, not a crash — `loadExtensions` never throws; per-extension failures land on `runtime.errors` and the rest still load.

## Trust prompt expectation

With a project-scope extension present and the project not yet trusted, startup asks once via the question modal:

```text
This project contains 1 extension(s) (hello) that run unsandboxed with your full user privileges — they can read/write your files and run commands as you. Load them?
```

Answers are `Trust and load` (persists a per-project grant in `~/.atom/trusted-projects.json`) and `Keep disabled` (nothing executes, a visible skipped notice posts, asks again next boot). Esc declines. Extension code runs with your full privileges — no sandbox — so read anything you install first.

## Enable, disable, lockdown

- `--enable-extension <glob>` (repeatable): allowlist — only matching names load, the rest skip as `not-enabled`.
- `--disable-extension <glob>` (repeatable): wins over enable; matches skip as `disabled`.
- `atom.json` `extensions: { enabled: [...], disabled: [...] }`: same patterns in config; CLI wins over config when set; project config wins over global. See [Configuration](configuration.md).
- `--no-extensions` (`--lockdown` alias): boots with zero third-party extensions — project, global, and explicit paths alike skip as `lockdown`. Builtins are untouched.

Precedence, highest first: lockdown > untrusted-project > disabled > enabled > load.

## How to see it loaded

Startup posts one info line when anything loaded or failed:

```text
(extensions: 1 loaded (hello))
```

Skipped extensions stay visible with the fix:

```text
(extensions: 1 skipped (hello) — the project is not trusted; trust the project when asked on next startup to load them)
```

Then confirm the surface: `/tools` lists registered custom tools, the command palette (`Ctrl+P`) and the `/` menu list registered slash commands, the status line shows contributed segments.

## Gallery (copy-paste samples)

Single source of truth: the files under `examples/extensions/`. The guide excerpts them; the tests (`tests/extension-gallery.test.ts`) load the checked-in files through the real `loadExtensions` path — never a mock API, never a copy.

**`01-audit-gate.js`** — destructive-command audit gate via `onBeforeToolCall`. Returning `{ block: reason }` vetoes the call: the reason commits as the model-visible result, approval is skipped, the tool never runs.

```js
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
```

**`02-notes-tool.js`** — model-callable tool via `registerTool` with a parameters schema and `execute`. Bad args are an inline `Error: invalid call: ...` and the implementation never runs; the tool dispatches through the shared loop like a builtin.

```js
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
  requireApproval: false,
});
```

**`03-custom-command.js`** — real slash command via `registerCommand` with a modal dialog plus transcript posts. The workflow logic is a pure helper (`summarizeChoice`) so the dialog flow is testable headless — tests drive the command with a stub `askUser` and unit-test the helper directly.

```js
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
```

## API surface (`src/extensions.ts`)

Exact `ExtensionAPI` methods — nothing else exists:

| Method | What it does |
|---|---|
| `on(event, handler)` | `session_start` / `session_shutdown` lifecycle |
| `registerTool(def)` | New model-callable tool (`name`, `description`, `parameters`, `execute`, `requireApproval?`) |
| `overrideTool(def)` | Audited, reversible builtin shadow (deny a subset or `ctx.passthrough`) |
| `addPromptHint(hint)` | Model-facing guidance appended under "Extension hints" |
| `registerCommand(def)` | Real `/name args` slash command (builtins always win name collisions) |
| `onBeforeToolCall(handler)` | Rewrite `{ args }` or veto `{ block: reason }` pre-validation/pre-approval |
| `onAfterToolCall(handler)` | Patch committed results (`string` or `{ content }`) |
| `onBeforeSwitch(handler)` | Veto a pending session switch (throws fail open) |
| `onTransformContext(handler)` | Replace the per-POST message array |
| `onBeforeRequest(handler)` | Replace payload / mutate headers per POST |
| `onAfterResponse(handler)` | Observe-only provider response hook |
| `onBeforeCompact(handler)` | Veto compaction or replace the summary |
| `getSessionState()` / `setSessionState(value)` | Per-session namespaced state (durable, JSON-serializable) |
| `isProjectTrusted()` | Whether this load is trusted (degrade gracefully when false) |
| `setStatusSegment(text)` | One status-bar slot per extension (upsert by owner) |
| `setWidget(def)` | Panel widget (`placement: "panel"`, keyed by owner + id) |
| `notify(message)` | Transient `(name) message` transcript line |
| `promptUser(question, options?, allowCustom?)` | Modal dialog; rejects headless, during activation, or while one is open |

Stores behind the API: `src/tools/custom.ts`, `intercept.ts`, `overrides.ts`, `provider-hooks.ts`, `compaction-hooks.ts`, `src/extension-commands.ts`, `src/extension-ui.ts`, `src/project-trust.ts`.

## Rules that bite

- **Staged activation is atomic.** Validation runs eagerly; a factory that throws (or a duplicate/colliding name at commit) leaves zero registrations behind — nothing half-loads.
- **Stale generation.** Every session replacement invalidates handed-out APIs; captured handles throw loudly, event handlers always receive a fresh API.
- **Approval fail-closed.** Custom tools require approval by default; opt out only with `requireApproval: false` for pure side-effect-free helpers.
- **Serial by default.** Custom tools carry no scheduler metadata and run as serial singletons; `executionMode: "sequential"` forces the whole sibling batch one-at-a-time.
- **Dialogs are single-flight and interactive-only.** A second request rejects, headless rejects, activation-time prompts reject — never a hang. Command `askUser` works because commands run outside activation with the TUI fulfilling the modal.
