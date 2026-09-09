# Architecture

ATOM is a flat-modules codebase with a few directories where a real seam
exists. The rule is responsibility + dependency direction, never line counts:
coherent single-file modules stay single files.

## Module map

```text
cli.tsx -> ui/app (App) -> everything (UI root, the only React owner)
                              |
ui/{transcript,input,todo-panel}  (prop-driven memo leaves, no App import)
                              |
agent/loop  ->  agent/gates  ->  tools/* (getTodos)
    |    \--->  agent/types (types only)
    |    \--->  scheduler -> tools (validators)
    |    \--->  config, context-manager, tools (executors)
    v
zen.ts (transports, dispatch, prefs, prompt assembly)
    ├── re-exports agent/* + context-manager surface (compat)
    └── imports agent/loop (one direction only)
                              |
tools.ts (pure barrel)
    ├── tools/registry (names, validation, dispatch, schemas)
    ├── tools/filesystem (read/write/edit + snapshots + fingerprints)
    ├── tools/search (grep/glob)   tools/shell (bash/tasks)
    ├── tools/web (fetch/search)   tools/todo (checklist state)
    └── tools/shared, tools/overflow, tools/fingerprints (kernel)
                              |
context/{manager, compaction, cache, env-block, windows}   (already modular)
session/{persistence (session.ts), snapshots (snapshots.ts)}
permissions/{policy (policy.ts + rollback.ts), approval (permissions.ts)}
skills/{registry, loader, matcher (skills.ts — intentionally one file:
        discovery and parsing must stay byte-identical)}
providers/{types, adapters (providers.ts, adapters.ts)}
```

## Dependency rules (enforced by tests/architecture.test.ts)

- The runtime import graph is acyclic (type-only imports don't count —
  they erase at compile).
- `react`/`ink` live only in `cli.tsx`, `App.tsx`, `ui/*`. No runtime
  module imports the UI; tools, providers, context-manager, policy,
  scheduler, and everything under `agent/` are UI-free.
- `policy.ts` depends only on `permissions.ts` at runtime (plus types):
  it stays usable by future subagents with no fs/net/UI baggage.
- Inside `tools/`, executors never import the registry — the registry
  owns names/validation/dispatch and sits above them.
- Inside `agent/`, loop/gates/types never import `zen` at runtime —
  `zen.ts` re-exports them for compatibility, never the reverse.
- The scheduler reasons from `TOOL_EFFECTS` metadata, not per-tool
  branches; missing metadata fails safe to serial.

## What was deliberately NOT split

- `skills.ts`: registry + loader + matcher share one parser that must
  stay byte-identical across paths (says so in its header).
- `App.tsx` beyond the `ui/` leaves: the rest is hooks-entangled
  session state — splitting it further would be prop-drilling, not
  boundaries. Pure helpers already live at module scope and are
  directly unit-tested (slash menu, pickers, filters).
- `zen.ts` transports: one dispatch + per-kind wire functions belong
  together; the loop, gates, and types now live in `agent/`.
- Flat coherent modules (`config`, `session`, `snapshots`, `compact`,
  `prompt-cache`, `env-block`, `auth`, `system`): renaming them into
  directories would be motion without meaning.

## Verification

`tests/architecture.test.ts` scans the real source on every run, so
drift fails loudly with the exact file + edge. Behavior is pinned by
the full suite (53+ files): every extraction above kept all
importer paths working (barrels + re-exports), and the suite is the
proof — no behavior change was made or needed.
