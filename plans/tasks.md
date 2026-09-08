# ATOM — Long-horizon multi-step coding: bottleneck diagnosis + fix plan

> Source of truth for this workstream. Execute tasks in order. Each task states
> scope, files, acceptance criteria, and verification. Do not improvise scope.
> Claim discipline: facts tagged VERIFIED (tool output this session) | RESEARCH
> (web sources this session) | INFERRED (reasoned, needs confirmation).

## 0. Goal

Make ATOM complete long-horizon, multi-step coding tasks (explore → plan →
implement across files → verify with tests/typecheck → report) instead of
stopping after 1–2 tool calls with a plausible-sounding early answer.

Non-goals: new providers, new TUI screens, MCP, prompt caching, cost
optimisation beyond what long-horizon correctness needs.

## 1. Bottleneck diagnosis (why it stops after 1–2 tools)

Ranked by leverage. All VERIFIED items were read from the repo this session.

### P0-1. The system prompt orders nothing (VERIFIED)

- `src/system.ts:8` — the entire base identity is one ~30-word line:

  ```ts
  "You are ATOM a AI coding agent , use tools properly you have read, write, edit, bash, grep, glob, todo , ask_question, web search and web fetch"
  ```

- No persistence order ("keep going until verified done"), no
  gather → act → verify loop, no todowrite discipline, no "never answer from
  memory", no reflection-after-tool-results instruction.
- `src/zen.ts:1219-1225` (`buildSystemPrompt`) appends the repo `AGENTS.md`,
  but that overlay is project instructions, not an agent operating contract —
  and the base stays one line.
- RESEARCH (Claude Code): every turn rebuilds a rich system prompt —
  identity + behavioral guidelines + environment block + tool definitions +
  project memory — plus an explicit three-phase loop (gather context, take
  action, verify results) and interleaved-thinking guidance ("after tool
  results, reflect, then take the best next action"). Tool descriptions alone
  don't steer weak models; the system prompt does.
- Effect: a free/weak model with no standing orders does the minimum that
  looks helpful — 1–2 reads, then a final text answer. The loop
  (`runLoopWithChat`, `src/zen.ts:1514-1642`) exits the moment the model
  returns zero `tool_calls` (`src/zen.ts:1577-1587`), so "answer early" always
  wins. **This is the primary bottleneck.**

### P0-2. The default model is the weakest link (VERIFIED + RESEARCH)

- `src/zen.ts:53` `DEFAULT_MODEL = "big-pickle"`; `src/providers.ts:62`
  zen `defaultModel: "big-pickle"` — a free-tier default.
- RESEARCH: the Nov-2025 inflection finding was that only frontier models
  (Sonnet/Opus-class and equivalents) with long-context coherence, reliable
  tool use, and error-recovery reasoning could "reliably complete real
  multi-step engineering tasks end-to-end". Free models satisfice early, drop
  parallel tool calls, and mishandle error recovery.
- INFERRED: most "stops after 1–2 tools" reports will reproduce on the
  default model and shrink on a strong model with the same harness. Confirm
  with Task 1's A/B probe before tuning anything else.

### P1-3. Step budget is 3–5× too small and the stop looks like success (VERIFIED)

- `src/tools.ts:13` `MAX_TOOL_STEPS = 10`, hard default for every turn
  (`src/zen.ts:1520`). RESEARCH: recommended `max_turns` is 20–30 for
  research/multi-step coding, 50 for extended autonomous workflows.
- A real task (explore 3–4 calls → plan → 3–5 edits → test → fix → re-test)
  needs 15–30 tool rounds. At step 10 ATOM appends
  `"(stopped: too many tool steps)"` (`src/zen.ts:1588-1598`) and returns —
  mid-task, framed as a turn end.
- No loop contract: no per-turn goal, no tool-checkable completion condition,
  no "todos incomplete → must continue" guard. RESEARCH: vague stopping rules
  cause early exits; the fix is a loop contract (goal, completion condition,
  allowed tools, step limit, escalation path) reviewed before the run.

### P1-4. Normal-mode approvals break autonomy (VERIFIED)

- `src/App.tsx:1414-1444` (`approve`): in `normal` mode (the default) every
  `write`/`edit`/`bash` pauses for an interactive y/a/n prompt; only `yolo`
  or session-`always` runs through. `src/tools.ts:20-21` confirms the
  read-only vs approval split.
- RESEARCH (Claude Code): three-tier permissions (always/ask/never) plus an
  auto-accept mode and pre-approved background subagents, so long runs don't
  block on every edit.
- Effect: even when the model wants to persist, a multi-edit task stalls on
  N human keypresses. Users read this as "the agent stopped".

### P2-5. No delegation — one context does everything (VERIFIED)

- Tool inventory is 13 flat tools (`toolNames()` from `TOOL_DEFINITIONS`,
  `src/tools.ts:1473-1837`): read/write/edit/grep/glob/bash/bash_output/
  webfetch/websearch/ask_question/todowrite/todo_get/todo_update. **No
  Task/subagent tool, no background agent, no Plan mode.**
- RESEARCH: Claude Code's long-horizon power is delegation — Explore
  (cheap, read-only, own context, no main-context pollution), Plan
  (read-only research phase), General-purpose (full tools), background
  execution, Coordinator/Leader/Worker fan-out. Every grep/read in ATOM
  pollutes the single main context instead.
- Effect: exploration crowds out implementation context; no parallel
  exploration; no way to isolate a risky sub-task.

### P2-6. The model is blind to repo state (VERIFIED)

- The system prompt carries no environment block. RESEARCH: Claude Code
  injects OS, shell, cwd, git branch/status, runtime versions fresh every
  turn. ATOM sends identity + AGENTS.md only.
- Effect: weak planning ("which files? which branch? tests green?") because
  the model never sees ground truth about where it is.

### P2-7. No verification or thinking discipline (VERIFIED + RESEARCH)

- `AGENTS.md` (repo overlay) mentions "verify: run tests/typecheck/build",
  but the base system prompt doesn't, and nothing enforces it — no hooks, no
  mandatory test gate, no "declare done only with evidence" rule.
- `reasoning_effort` is sent only for 6 zen models and defaults to omitting
  the param (`src/zen.ts:99-127`); there is no interleaved-reflection prompt
  for any other model/provider.
- RESEARCH: Claude Code's loop is gather → act → **verify** (ground truth
  from the environment each step); adaptive/interleaved thinking scales depth
  to step difficulty. ATOM has neither.

### What is NOT the bottleneck (VERIFIED)

- Context plumbing is already solid: deterministic history budget (100
  msgs / 200k chars, `src/zen.ts:62-63`), per-turn `truncateHistory` with
  pairing-safe user-turn drops, compaction with thrash guard (`src/compact.ts`
  + `src/App.tsx:1087-1208`). Don't rebuild this; build on it.

## 2. Claude Code comparison (RESEARCH, this session)

| Capability | Claude Code | ATOM today | Gap |
|---|---|---|---|
| System prompt | Rich, rebuilt per turn: identity, behavior, env block, tools, project memory | One-liner + AGENTS.md overlay | **P0 — rewrite** |
| Loop contract | gather → act → verify; explicit completion conditions | Ends on first no-tool-call reply | **P0 — add guard** |
| Step budget | 20–30 typical, 50 autonomous | 10 hard default | **P1 — raise + configure** |
| Delegation | Task tool: Explore (cheap RO), Plan, General, background, parallel | None — single flat loop | P2 — add after P0/P1 |
| Permissions | always/ask/never + auto mode + pre-approved bg agents | normal (ask every write) / yolo | **P1 — add trust tier** |
| Env grounding | OS/shell/cwd/git/versions every turn | None | P2 — inject block |
| Thinking | Adaptive + interleaved reflection guidance | effort param, 6 zen models only | P2 — prompt-level fix |
| Verification | Test/lint/typecheck gates, hooks, evidence handoff | Advisory text in AGENTS.md | P2 — enforce |
| Context mgmt | Compaction/summarization, prompt caching | Compaction + budget caps (good) | Keep |

## 3. Task list (execute in order)

Conventions per task: Objective, Scope (files), Constraints, Acceptance
criteria, Verification. Red baseline gate (§4) applies before Phase 1 and
after every phase.

### Phase 0 — Baseline

- [x] **Task 0. Red baseline + default-model probe**
  - Objective: prove the tree is green and reproduce the reported behavior
    with evidence, then A/B the default model vs a strong model.
  - Scope: run only — `npm test`, `npm run typecheck`, `npm run build`.
    Then one scripted long-horizon probe (e.g. "add a small feature across
    2 files + run tests") on `big-pickle` vs the strongest available model,
    counting tool calls per turn until final text.
  - Constraints: no code changes in this task. Record model ids, tool-call
    counts, and transcripts.
  - Acceptance: (a) suite green, or red reported with failing specs and work
    stops; (b) probe shows the 1–2-tool stop on the default model with
    numbers on file.
  - Verification: paste `npm test` / `typecheck` / `build` results; attach
    probe transcripts + counts to the task report.

### Phase 1 — Persistence (highest leverage, ship first)

- [x] **Task 1. Rewrite the base system prompt as an operating contract**
  - Objective: give the model standing orders to persist: plan, act through
    tools, verify with ground truth, and only then answer.
  - Scope: `src/system.ts` (only file). Keep the one-liner-ownership comment
    convention; the new prompt stays provider-agnostic (no model names).
  - Constraints: minimal blast radius — prompt text only, no loop changes.
    Must include: (1) long-horizon loop order (explore → plan with todowrite
    for 3+ steps → implement → verify with tests/typecheck → report with
    evidence); (2) "continue calling tools until verified done — never end
    with an unverified summary"; (3) "after each tool result, reflect then
    take the best next action"; (4) "ground claims in tool output, never
    memory"; (5) todowrite discipline (full list up front, one in_progress,
    complete immediately, never batch); (6) done means tests/typecheck pass
    or the blocker is named.
  - Acceptance: prompt contains all six clauses; existing prompt-assertion
    tests updated, none deleted silently.
  - Verification: `npm test`, `npm run typecheck`; re-run the Task 0 probe
    on the same models and show tool-call count increases or report honestly
    that it didn't.

- [x] **Task 2. Raise the step budget + make it configurable**
  - Objective: stop truncating real tasks at 10 rounds.
  - Scope: `src/tools.ts` (`MAX_TOOL_STEPS`), `src/zen.ts` (`runLoopWithChat`
    maxSteps plumbing), `README.md` + `AGENTS.md` env-knob docs.
  - Constraints: default 30 (RESEARCH-backed middle of 20–30); env override
    `ATOM_MAX_TOOL_STEPS` clamped 5–100; the `(stopped: too many tool steps)`
    notice must name the limit and suggest raising it.
  - Acceptance: default 30; override respected and clamped; stop notice
    accurate; docs updated.
  - Verification: unit test for clamp/default/notice; `npm test`,
    `npm run typecheck`.

- [x] **Task 3. Todo-completion guard against premature final text**
  - Objective: the loop may not end with text while todos are open — it must
    either continue with tool calls or return an explicit "blocked: …"
    statement naming the unfinished items.
  - Scope: `src/zen.ts` (`runLoopWithChat` no-tool-call branch),
    `src/tools.ts` (`getTodos` read path — reuse, don't duplicate state).
  - Constraints: single check at the no-tool-call exit; no new tools; the
    guard message must list open todo contents so the model can resume.
  - Acceptance: open todos + final-text attempt → guard fires (test-proven);
    clean list + final text → unchanged behavior.
  - Verification: new `tests/loop-todo-guard.test.ts` (or nearest existing
    loop suite); `npm test`.

### Phase 2 — Autonomy (unblock long runs)

- [x] **Task 4. Trust tier for write/edit/bash (auto-approve cwd)**
  - Objective: let long runs proceed without a keypress per edit, without
    forcing global yolo.
  - Scope: `src/App.tsx` (approve path + `/mode` surface), `src/tools.ts`
    (permission-class comments), docs (`README.md`, `AGENTS.md`).
  - Constraints: default stays `normal`; new per-session opt-in (e.g.
    `/yolo`-adjacent command or `always` scoping that actually covers a
    whole task); every auto-approved call still renders its `⚙` activity
    line; denial path unchanged.
  - Acceptance: a user can approve a whole task's edits once and the loop
    runs to verification unblocked; audit lines intact.
  - Verification: `npm test`; manual TUI walkthrough (approve-once →
    multi-edit run completes).

- [x] **Task 5. Default-model + effort policy**
  - Objective: stop routing long-horizon work to the weakest model by
    default, and document what to pick when.
  - Scope: `src/zen.ts` (`DEFAULT_MODEL`), `src/providers.ts`
    (zen `defaultModel`/`fallbackModels` ordering), `README.md`.
  - Constraints: pick the strongest tool-reliable zen default available at
    implementation time — verify against the live `/models` list, never from
    memory; keep free models listed as fallbacks, not defaults; document the
    Task-0 A/B numbers as the rationale.
  - Acceptance: new default is live-list-verified and tool-capable; README
    states when to use free vs strong models.
  - Verification: `npm test`, `npm run typecheck`; live-list check output in
    the report.

### Phase 3 — Grounding + verification discipline

- [x] **Task 6. Per-turn environment block**
  - Objective: ground every POST in repo reality: cwd, git branch/status
    (best-effort), node version, timestamp.
  - Scope: new small builder (or extend `buildSystemPrompt` call-site in
    `src/zen.ts` + `src/App.tsx` history init); must be cheap, sync-safe,
    failure-silent (missing git → block shrinks, never errors).
  - Constraints: block goes to the system message or a pinned prefix —
    never into user content; cap ~500 chars; cache git status per turn, not
    per POST.
  - Acceptance: block present on fresh turns; git-missing repos unaffected;
    no test regressions.
  - Verification: `npm test`; sample prompt dump in report.

- [x] **Task 7. Verification gate in the loop contract**
  - Objective: "done" requires evidence — tests/typecheck/build output — or
    a named blocker.
  - Scope: prompt-level first (extend Task 1's clause if it proves
    insufficient, add a lightweight post-loop check in `runLoopWithChat`
    that appends "unverified — run X" when the final text claims completion
    without a preceding bash test call — only if prompt-only fails, with
    explicit approval since this touches loop semantics).
  - Constraints: no new required tools; never block non-coding answers
    (questions, explanations) — gate applies only when files were written.
  - Acceptance: file-changing turns without a test/typecheck call get
    flagged, not silently accepted.
  - Verification: `npm test`; probe transcript showing the flag.

### Phase 4 — Delegation (only after P0/P1 verified)

- [ ] **Task 8. Design first: subagent/Task-tool RFC (no code)**
  - Objective: decide the minimal delegation primitive (spec-style: Explore
    read-only helper? background bash already exists — what composes?).
  - Scope: a `plans/delegation-rfc.md` doc only.
  - Constraints: must address context isolation, permission inheritance,
    result-size caps, and why not full Claude-style fan-out in v1.
  - Acceptance: RFC names the v1 primitive + explicit non-goals; user
    approves before any implementation task is added.
  - Verification: review sign-off (no tests — doc only).

## 4. Gates

- **Red baseline**: `npm test` + `npm run typecheck` + `npm run build` green
  before Phase 1 and after every task. Red → stop and report (unless the
  task's job is the baseline itself).
- **Evidence gate**: every task report pastes what ran and what changed
  (tool-call counts for probe tasks, test output for code tasks).
  "Should work" is not verification.
- **Blast-radius gate**: prompt/docs/config tasks must not touch loop
  semantics; loop-semantic changes (Tasks 3, 7) need their own tests.
- **RFC gate**: no delegation code before the Task 8 RFC is approved.

## 5. Residual risks

- Free-tier models may still satisfice on the hardest tasks even with a
  strong prompt — the Task 5 policy (route hard work to strong models) is
  the mitigation, not more prompt text.
- Approval UX changes (Task 4) trade safety for autonomy — default stays
  `normal`; document the trade-off in the task report.
- A too-strict verification gate (Task 7) could nag on trivial turns —
  scope it to file-changing turns only.
