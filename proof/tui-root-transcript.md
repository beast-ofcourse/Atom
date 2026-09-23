# Proof — tui-root-transcript

Branch: `next-best-improvement/tui-root-transcript`
Mode: yolo. Fragment: TUI root / transcript flow (`src/App.tsx`, 10,466-line god-file).
Extreme pick (axis: architecture): extract slash-menu pure engine to
`src/ui/slash-menu.ts` deep module; App keeps thin import + re-export shim;
`ui/mentions` drops its local fuzzyScore copy for shared matcher.
Why this wins: largest cohesive pure cluster in god-file, zero behavior change,
test-locked, unblocks further splits.

## Diff stat (tracked)

```
src/App.tsx        | 386 +++++------------------------------------------------
src/ui/mentions.ts |  21 +--
2 files changed, 33 insertions(+), 374 deletions(-)
```

Untracked (new): `src/ui/slash-menu.ts` (360 lines, zero imports),
`tests/slash-menu-module.test.ts` (93 lines).

## Before / After

- Before: `src/App.tsx` 10,466 lines / 442,066 chars; matcher logic in two
  places (`App.fuzzyScore` + byte-identical local copy in `ui/mentions.ts`
  kept to dodge an App cycle); 9 test files import engine from `../src/App.js`.
- After: `src/App.tsx` 10,144 lines / 429,172 chars (-322 lines, -12,894 chars);
  `ui/mentions.ts` 230 → 211 lines (-19); one matcher in `ui/slash-menu.ts`
  with no internal imports (cycle impossible); all prior `App.js` imports keep
  working via re-export (reference-identity pinned by test).

Key hunk (`src/ui/mentions.ts`): local 19-line `fuzzyScore` copy deleted,
replaced by `import { fuzzyScore } from "./slash-menu.js";`.

## Benchmarks

| Check | Before | After | Delta |
|---|---|---|---|
| `src/App.tsx` lines | 10,466 | 10,144 | -322 |
| `src/ui/mentions.ts` lines | 230 | 211 | -19 |
| `npx tsc --noEmit` | exit 0 | exit 0 | no type errors |
| vitest targeted (slash-menu, slash-menu-module, slash-polish, palette, render-cache, architecture, mentions) | — | 7 files, 63 tests pass | green |
| vitest importers (footer-cluster, extension-commands, goal-prompt-surface, session-picker, model-picker, skills-slash, plan-mode, rewind) | — | 8 files pass | green |
| `tests/goal-surface.test.ts` > busy bar keeps full phase text | 1 failed (baseline, clean tree) | 1 failed (same test) | no regression |

## Validation

```
npx tsc --noEmit → exit 0, no output
npx vitest run (7 files) → Test Files 7 passed (7), Tests 63 passed (63)
npx vitest run (9 files incl. goal-surface) → 1 failed | 116 passed (117);
  sole failure = pre-existing on clean tree (verified via git stash),
  status-bar truncation assertion, untouched by this change.
```

Full suite not run (exceeds 120s tool budget; `npm test` timed out pre-change too).
Architecture DAG test passes: new edges App → ui/slash-menu,
ui/mentions → ui/slash-menu, no cycles, no runtime → UI imports.
