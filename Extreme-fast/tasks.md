# Extreme-fast — Make ATOM extremely fast at everything

Goal: make ATOM feel instant end to end — smooth 60 fps TUI rendering, a zero-overhead agent harness, and extremely fast tool executions — with measured budgets and no behavior change.

Scope covers three layers:

1. **TUI** — keystroke-to-paint latency, streaming token paints, transcript scrollback, widgets, input, status line.
2. **Harness** — agent loop per-step overhead, scheduler planning, tool pipeline stages, provider streaming, context accounting, telemetry, persistence.
3. **Tools** — `read` / `write` / `edit` / `grep` / `glob` / `bash` / `bash_output` / `webfetch` / `websearch` throughput and cache hit rates.

Non-goals: no model-quality changes, no new tools, no protocol changes, no behavior change to executors beyond speed. Every phase is measured before/after with the existing bench plus new micro-benches. Revert per phase with `git revert`.

> Rebuilt 2026-09-17 against the landed parallel track (ask batch queue,
> todo panel polish, bordered tool widgets, sequenced thinking/preview
> lanes, cancel freeze — see root `tasks.md`, all DONE). Items that track
> already delivered are marked DONE with their mechanism; the remaining
> work is adjusted so nothing is built twice. Do not re-discover the
> baseline below — verify-then-extend it.

## Baseline reality (verified 2026-09-17, rebuilt — do not re-discover)

### Entry / render config

- `src/cli.tsx` (L236, L254): `ink.render` with `incrementalRendering: true, maxFps: 30, concurrent: true`. Comment pins 30 fps as the keystroke-latency choice.
- `scripts/bench-render.mjs`: hermetic Ink bench measuring wall ms, frames, bytes, writes, full-screen clears, avg/max Yoga render ms across scenarios (`idle | burst | long | tools | paced`) × configs (A = current 30 fps incremental concurrent, B = 15 fps, C = full-frame, D = sync). Fake TTY streams, mocked fetch, temp `ATOM_HOME`. Run with `npm run bench` (`node scripts/bench-render.mjs`). Human-readable `cfg=X scen=Y …` lines (not JSON — parse with regex).
- `src/App.tsx` (~9.5k lines after the landed track): the only React owner. Hot constants: `DRAFT_THROTTLE_MS = 64` (L1063), paint scheduler wired with `intervalMs: DRAFT_THROTTLE_MS`, 1 s turn timer `setInterval` (`turnTimerRef`), `agentCore` memo, slash/model/skill/session/palette/checkpoint/goal memos. Input routing, pickers, modals, overlay zone, inspector all live here.
- `src/ui/paint-scheduler.ts` (`PAINT_INTERVAL_MS = 64`, L22): centralized streaming scheduler. One trailing timer for all live lanes (`draft` + `thinking`), latest-wins per lane, leading immediate paint after idle, trailing coalesce inside window, single `onFlush` so draft + thinking land in one React render, deterministic `flush()` / `cancel()` / `reset()`. Default matches `DRAFT_THROTTLE_MS`. Unchanged by the landed track — 1A builds on it.
- Sequenced lanes (LANDED, root `tasks.md` bugfix): `src/ui/stream-store.ts` snapshot is `{draft, thinking, activeLane}` with `getActiveLane()`; writes claim the lane, clearing falls back, `set()` takes an explicit override. `src/App.tsx` declares the owning lane synchronously in `onToken`/`onThinking` (`activeLaneRef`, mirrored into the store on every flush — zero App renders), freezes the outgoing lane first (suffix-only pins via `committedStreamRef` + POST generations `streamGenRef`), and paints live lanes as uncommitted SEGMENTS (`uncommittedDraftSegment` / `uncommittedThinkingSegment`). `src/ui/live-tail.tsx` renders ONLY the active lane (via `src/ui/live-host.tsx` snapshot passthrough). Effect already banked: thinking-only flushes skip the draft markdown re-parse and vice versa; transcript alternates thinking/preview blocks in arrival order; Esc/failed turns freeze reasoning above the rollback line.

### Transcript / markdown (already optimized — do not regress)

- `src/ui/transcript.tsx`: committed scrollback prints ONCE via `<Static>` (full-page reprint avoidance: measured ~8.3 KB + clear per single-line change vs ~40 bytes with `Static`). `SCROLLBACK_WINDOW = 300`, `SCROLL_PAGE_ITEMS = 10`, commit-frontier `end` model (PgUp / autoscroll-off freezes frontier, `↓ N new` indicator, End resumes). `admitStaticBatch` monotonic admission, banner once per `Static` identity, `TranscriptRow` memo with custom `transcriptRowEqual` (id + turn/label identity, render-fn stability), `transcriptRenderProbe` + `transcriptRowRenderProbe` for timer/row isolation tests.
- `src/ui/markdown.tsx`: zero-dep renderer. `parseMarkdown` linear, `parseMarkdownCached` bounded FIFO (`PARSE_CACHE_CAP = 300`, L346) for committed turns. `MarkdownDraft` parses fresh per paint with `closeStreamingMarkers` (never cached — partials churn), converges to committed shape. `streamParseProbe` counts parses. `ToolLine` keeps `⚙ name target` byte-identical, `TOOL_SLOW_MS = 2000` (L662). Tables degrade to stacked lists under 50 cols, cap cols at 70/100 breakpoints.
- Memo coverage is already broad: `LiveTailHost`, `LiveTail`, `InputBox`, `ToolCall` / `LiveToolCall` / `ToolResult`, `ApprovalBox` / `QuestionBox`, `PalettePanel`, `CommandPalette`, `StatusBar` / `StatusBarHost`, `DiffView` / `LineBody`, `SideBySideDiffView`, `CodeBlock`, `ThinkingBlock`, `Message`, `Modal` prompts. Parent-tick re-render with identical props must bail at each of these. (`LiveToolHint` in `live-tail.tsx` is intentionally NOT memoized — it re-derives from `toolHint`+elapsed props each live-tail render; memoize it if profiles show otherwise.)

### Widgets + panels (LANDED by the parallel track — audit, don't rebuild)

- `src/ui/components/ToolCall.tsx`: every committed tool is a round-bordered widget, frame color by status (`borderColorFor` in `src/ui/tool-model.ts`, phase-0 `border.tool` tokens; `ask_question` uses the magenta question frame). Header carries glyph/name/kind/status/duration/via/summary/`Ctrl+O`; shared `WidgetSummary` (dead per-kind presenters removed); `WidgetPreview` caps output at `TOOL_PREVIEW_LINES = 6` / `TOOL_PREVIEW_CHARS = 600` with a more-lines footer; diffs/`ErrorCard` render inside the frame; audit `ToolLine` byte-identical; non-audit chatter stays frameless. Committed widgets live INSIDE `Static` rows (one row = one box) — keep that invariant in every layout change below.
- `src/ui/live-tail.tsx`: the running tool mounts the same framed `LiveToolCall` (running/queued tint, `◉ Reading path` verb tail) via `modelForLive` + `activityText`; settles into the committed card without a visual jump. `src/ui/components/Activity.tsx` `Progress` is superseded (kept exported for compat — do not route new code through it; a future cleanup may delete it).
- `src/ui/todo-panel.tsx` (rewritten): `Todo — done/total` header with dim in-progress count, theme glyphs (green check / yellow wrench / dim circle), mark|label flex rows (hanging indent), shared caps (`TODO_TUI_MAX_VISIBLE = 8`, overflow threshold 12) with ellipsis overflow, no collapse state, hidden while the inspector owns the footer. `TODO_ECHO_CAP = 20` still caps store result text.
- `src/ui/tool-model.ts`: `borderColorFor`, `TOOL_PREVIEW_LINES`, `TOOL_PREVIEW_CHARS`, ask-answer summarizer. `src/ui/layout.ts`: `widgetWidth()`, `isVeryNarrow/isNarrow` breakpoints. `src/ui/theme.ts`: `border.tool{ok,fail,denied,running,queued}`, `color.question`, `spacing.widgetPadX`, `symbol.questionStep`.
- `src/tools/registry.ts`: `ask_question` batch (`questions[1-5]`, `ASK_QUESTION_MAX_BATCH = 5`) with sequential one-by-one TUI queue (`Q i/N`, Esc cancels current, Ctrl+C drains all).
- Measured gate from that track (2026-09-17, 20 bench pairs vs clean v1.5.5): `paced` bytes −15–22% / clears −30–45% (lanes + dedupe); `tools` bytes +16–35% (border chrome — expected) with avg render down 4–20%; `idle/burst/long` flat. `maxRenderMs` single-frame outliers on <30 ms absolutes are machine noise.

### Harness

- `src/agent/loop.ts` (`runLoopWithChat`): per-step work per model round — `chatFn` POST, `normalizeChatResult`, usage/reasoning forwarding, `noteModel` timing, `getTodos()` snapshot (already captured once per turn-end, Fix 3 comment), `evaluateTurnEnd` + `decideTurnEndAfterGates` (gates + optional `goalJudge` POST), `planBatches` per `tool_calls` block, serial `runSerialToolPipeline` vs parallel plan-then-`Promise.all` path, commit funnel `commitToolResult` (counters, error streak, goal progress, bottleneck, verification gate, history push, `onToolActivity`, `onToolFinished`). Telemetry + turn-event sinks are guarded observer-only. Repetition guard, error-streak tracker, empty-response repair (`MAX_EMPTY_ROUNDS = 2`), step/call budgets.
- `src/agent/tool-pipeline.ts` (`DEFAULT_TOOL_TIMEOUT_MS = 60_000`, L112): serial stages unknown-gate → before-hooks → validate → intercepted (`ask_question`/`update_goal`) → approval → `executeWithTimeout` → normalize → commit patches (after-interceptors + result hook, fail-open, veto support). `executeWithTimeout` races exec vs timeout timer (floor 1 s, `<=0`/NaN disables). `resolveApproval` per call. `planToolCall` + `runPlannedToolCall` shared by serial and parallel pre-pass (prompts resolve serially in call order, then members execute concurrently).
- `src/scheduler.ts`: `TOOL_EFFECTS` metadata table (missing metadata → serial singleton, fail-safe), `canonicalFileKey` (lexical resolve + `fs.realpathSync` + normalize + case-fold, null on unknown), `captureSchedulerSnapshot` once per block (freezes mutable extension registry inputs), `planBatches` (lenient JSON parse per call, `validateToolArgs` per call, interactive/exclusive/spawn/network-write → singleton, writes batch on disjoint canonical keys, reads batch freely except read-after-write on same key, extension `sequential` hint forces all-singletons, custom tools always singleton).
- `src/context-manager.ts` (`OUTPUT_RESERVE_TOKENS = 4096`, L140): `ContextLedger` Proxy-based incremental accounting (`trackHistory`, per-message footprint `WeakMap`, O(1) `ledgerStats`, O(n) `scanHistory` reference, `verifyLedger` for tests). `messageChars` counts content + `JSON.stringify(tool_calls)` + media wire chars. Budget math from verified window (`context-windows.ts`), `compactPct` default 0.83.
- `src/prompt-cache.ts`: stable-prefix assembly (`assemblePrefix` sha1 per POST, `splitSystemHead` env-tail split), capability declarations per provider. No cache state; wins come from providers honoring byte-stable prefixes.
- `src/adapters.ts`, `src/zen.ts`: transports, dispatch, prompt assembly, retry/backoff, stream timeout handling. Per-POST accumulators (`fullText`/`fullThinking` reset per stream) feed cumulative `onToken`/`onThinking` partials into the paint scheduler. `COMPACT_TOOL_OUTPUT_CAP = 2000` in `src/compact.ts`.
- `src/telemetry.ts`, `src/telemetry-dashboard.ts`, `src/telemetry-server.ts`: local traces, guarded sink calls, `Date.now()` + ISO + JSON per model/tool call.
- `src/sessions.ts`, `src/session.ts`, `src/snapshots.ts`: persistence + pre-mutation snapshots (every `write`/`edit` captures prior bytes — see tools below).
- `src/compact.ts`: compaction mechanics (summary-sized generation must fit alongside history).
- `src/ui/stream-store.ts`, `src/ui/agent-adapter.ts`, `src/ui/activity.ts`, `src/ui/layout.ts` (`useTerminalSize`, resize debounce), `src/ui/tool-model.ts`, `src/ui/tool-call-state.ts`, `src/ui/live-tail.tsx`, `src/ui/live-host.tsx`, `src/ui/status-bar.tsx`, `src/ui/input.tsx` + `input-model.ts`, `src/ui/pickers`: live-lane plumbing (sequenced — see above), activity model (thinking-gap + verb-mapped lines, elapsed-seconds liveness, no animated spinners), terminal-size propagation.

### Tools (executors)

- `src/tools/filesystem.ts`: `readTool` = `resolveSandbox` → `stat` → dir-listing branch → 12-byte media peek (`open` + `read` + `close`) → image/PDF branch → 1 MB OOM-guard `stat.size` check → `normalizeReadWindow` → `getCachedRead` (mtime+size validated) → `readFile` full + `readTextResult` (fingerprint, `split("\n")` window, 64 KB `READ_CHAR_CAP` + overflow spill). `writeTool`/`editTool` = `resolveSandbox` → validate → `capturePriorBytes` (snapshot read) → `mkdir`/`writeFile` → fingerprint + `invalidatePath` + `invalidateListingsForFile`. Edit re-reads full file, checks stale-read fingerprint, `split(oldString)` counting.
- `src/tools/read-cache.ts`: path+window keyed LRU (default 100 entries, 30 s TTL, `ATOM_READ_CACHE=0` kill switch), mtime+size validation per hit (one `stat`, caller already stats), successes only, stats counters.
- `src/tools/dir-cache.ts`: `listFiles` = mtime-validated cache (50 entries, 15 s TTL) → `git ls-files -z --cached --others --exclude-standard` in one invocation (15 s timeout) → walker fallback (`walkFiles`, `SKIP_DIRS` pruned). `clearDirListingCache` on every bash (foreground + background spawn). `invalidateListingsForFile` on write/edit. `ATOM_FAST_LIST=0` kill switch. Deliberate non-goal: no `rg --files` dependency (~80 ms spawn on Windows slower than walker on typical repos).
- `src/tools/search.ts` (`SCAN_CONCURRENCY = 32`, L142): `grepTool` = regex compile (+ `(?i)` prefix handling) → mode validate → `resolveSandbox` + `stat` → single-file fast path → `listFiles` + sort → allowed-set → ripgrep fast path (`rgAvailable()` + `sorted.length >= rgMinFiles()`, `scanWithRipgrep`) else `scanWithWalker` (bulk parallel reads, sequential regex pass, per-file `stat` OOM guard + full `readFile` + binary `includes("\0")` check). `files_with_matches`/`count` tails do per-file `mtimeMs` stats + sort. `globTool` = same listing + `matchesGlob` filter + per-match `mtimeMs` + recency sort, caps `GREP_MATCH_CAP = 100` / `GLOB_MATCH_CAP = 200` (`shared.ts`), 64 KB `capSearchOutput` safety net + overflow pointer.
- `src/tools/ripgrep.ts`: `rgContentHits` / `rgFileCounts` adapters, `rgAvailable`, `rgMinFiles`, `noteRgFallback`.
- `src/tools/shell.ts` (`BG_TASK_CAP = 20`, `BG_POLL_MS = 100`, L21–22): `bashTool` = validate → background branch (`spawn` + temp-file appends + `unref`) or foreground `exec` (cwd, `maxBuffer` 16 MB, default 60 s timeout, 0 = no timeout) → `clearDirListingCache` → `providerSecrets()` scan + `scrubSecrets` BEFORE truncation → 8 KB per-stream cap + overflow spill → JSON envelope. `bashOutputTool` polls output files every ~100 ms until exit/timeout (default wait 5 s), caps via `capBgStream` (presentation-layer scrub; raw bytes stay on disk).
- `src/tools/web.ts`: fetch/search with per-call `AbortController` timeouts, secret scrubbing, truncation + overflow.
- `src/tools/shared.ts`: `resolveSandbox`, `READ_CHAR_CAP` (64 KB), `OUTPUT_CAP` (8 KB), `READ_FILE_MAX_BYTES` (1 MB), `GREP_MATCH_CAP`, `GLOB_MATCH_CAP`, `SKIP_DIRS`, `truncateHead`.
- `src/tools/overflow.ts`, `src/tools/fingerprints.ts` (`contentHash`, `fingerprintKey`, `readFingerprints`): overflow-file spill + stale-read detection.
- `src/scheduler.ts` `canonicalFileKey`: `fs.realpathSync` per write planned (sync I/O on harness hot path — see Phase 2).
- `src/extensions.ts`, `src/extension-ui.ts`, `src/extension-commands.ts`, `src/skills.ts`, `src/mcp/*`: hook/interceptor snapshots per call, skill matcher per input, MCP timeouts per request.

### Test / type gates

- `npm test` → `vitest run` (`vitest.config.ts`: `setupFiles: tests/setup.ts`, 30 s per-test timeout, max 4 workers — TUI integration suites drive real Ink trees with real timers, 1 s+ waits). Known pre-existing timing flakes (identical names on clean v1.5.5, unrelated to perf work): goal, goal-surface, hostile-perf, observability ×2, smoothness ×2, streaming-stress, streaming.
- `npm run typecheck` → `tsc --noEmit`. `npm run build` → `tsc -p tsconfig.build.json` + `scripts/copy-web-ui.mjs`. `dist/` is gitignored generated output.
- `tests/architecture.test.ts` enforces: acyclic runtime graph, `react`/`ink` only in `cli.tsx`/`App.tsx`/`ui/*`, `policy.ts` → `permissions.ts` only, tools executors never import registry, `agent/*` never imports `zen` at runtime, scheduler reasons from `TOOL_EFFECTS` only.
- New suites from the landed track (keep green): `tests/question-queue.test.ts`, `tests/tool-widget.test.tsx`, `tests/stream-sequence.test.tsx` (sequenced lanes, suffix pins, Esc-freeze).

---

## Phase 0 — Measure first, set budgets, lock the harness — DONE 2026-09-18 (budgets set; keystroke budget on watch, see 1B.2)

- [x] 0.1 Baseline in `Extreme-fast/baseline.md` (20 rows, ASUS Vivobook Go E1504FA, Node v24.18.0, 100×30).
- [x] 0.2 Budgets per plan; two adjustments from measurement: `tools` bytes rebaselined post-widget-chrome; keystroke p95 ≤ 50 ms NOT MET (see 1B.2 — recorded, not waived).
- [x] 0.3 `scripts/bench-loop.mjs` (serial/parallel/mixed + plan-20call; per-round 0.8–2 ms, plan p50 5.5 ms — over the 2 ms budget, Phase 2 target) and `scripts/bench-tools.mjs` (8 cases p50/p95; read-warm 0.3 ms, glob-warm 0.8 ms, grep ~2–3 ms, bash-noop ~39 ms child-dominated, bash_output-immediate ~10 ms). Both < 2 min.
- [x] 0.4 `tests/extreme-perf.test.tsx` (tick isolation, one-row append, draft bailout, ⚙/slow pins) + incremental-parse budget tests. Green.
- [x] 0.5 `typecheck` clean; suites green modulo the 9 known timing flakes (goal, goal-surface, hostile-perf, observability ×2, smoothness ×2, streaming-stress, streaming — names recorded).

## Phase 1 — TUI smooth 60 fps rendering — DONE 2026-09-18 (two documented exceptions: 1A.3 stays 30 fps, keystroke budget unmet)

Measured config-A deltas vs `baseline.md` (final code): burst 17→16
frames, bytes +4.9%, avgRender −18%, clears flat; paced 92→113 frames
(+23%), bytes +12.6%, avgRender +7%, clears 14→16; tools bytes +5.5%,
frames flat, clears 0; input (new scenario) 21 frames / 20 keys,
keyP50 ≈ 105–111 ms, keyP95 ≈ 200–218 ms (config D sync: 86/119).

### 1A — Paint cadence

- [x] 1A.1 Adaptive scheduler DONE: hot 16 ms iff arrivals outpace the hot
  window, else idle 64 ms (`PAINT_HOT_INTERVAL_MS`, density rule measured —
  gap≤500 variant bloated sparse-stream bytes +13% with zero visible win).
  Single `onFlush`, leading/trailing/flush/cancel/reset semantics kept;
  `paint-scheduler.test.ts` extended (hot/cold decay, sparse stays idle,
  flood ≤ 2 flushes). App wires the constants explicitly.
- [x] 1A.3 maxFps DECISION (measured, not reverted blindly): 60 fps trial
  cost +33% bytes, +43% clears, +14% avgRender on paced with no latency win
  outside render quanta (latency is Ink's 20 ms input flush + App
  scheduling). Stays 30 fps per the plan's own gate; scheduler-hot paints
  downsample to 33 ms frames — the latency win without the byte/clear cost.
  Rationale recorded in `src/cli.tsx`.
- [x] 1A.4 Tests + bench DONE (above).

### 1B — Renders (verified-no-change except the parser)

- [x] 1B.1/1B.2 VERIFIED, no refactor: `Conversation`/`Composer` receive
  stable props (turns ref, clearGen, memo'd pickers gated on `selecting`),
  leaves bail per probe tests; the two smoothness timer tests fail at
  submit setup (`thinking…` timeout — environmental, pre-existing), not at
  probe assertions. App-body 1 Hz tick execution accepted (leaves skip).
  Slash filter already memo'd + gated (no per-keystroke rescan when idle).
- [x] 1B.3 Incremental streaming parse DONE (`parseMarkdownStreamIncremental`:
  blank-line split, single-entry head memo, full-parse fallback for missing
  boundary / open fence). Budget test: append-only stream bounds big parses
  to paragraphs+2; convergence test vs full parse (incl. fence fallback).
  Green with `markdown.test.tsx`.
- [x] 1B.4 VERIFIED, no change: inspector expanded view + tool preview render
  plain `Text` (zero markdown parses) — nothing to share; committed path
  already uses the bounded `parseMarkdownCached`.
- [x] 1B.5 VERIFIED, no change: 64 ms resize throttle ≤ 100 ms budget; no
  breakpoint-thrash evidence, no hysteresis added (would churn pinned
  narrow paths for a hypothetical).

### 1C — Layout + bytes (audit + evidence; keystroke budget open)

- [x] 1C.1 Audit DONE, no flatten: max nesting depth is 3 (widget
  frame > row > grow — the hanging-indent rows), everything else 0–2.
  `Static`-row invariant holds everywhere.
- [x] 1C.2 Byte budget: table above. Paced/tools growth is cadence physics
  (hot paints on dense streams), accepted per 1A.3 gate; per-paint bytes
  flat (no chrome bloat), clears 0 growth except paced +2 (noise watch).
- [x] Input-latency bench case DONE (`input` scenario in
  `scripts/bench-render.mjs`, 10 ms polls, keyP50/keyP95 rows). EVIDENCE
  vs budget: keyP50 ≈ 105–111 ms, keyP95 ≈ 200–218 ms (A); 86/119 ms (D
  sync) — budget ≤ 50 ms NOT MET. Root-caused, not App render cost:
  renders average ~2 ms and one-paint-per-key holds (21/20); Ink adds a
  20 ms input-flush delay + 33 ms render quanta by design, bare-Ink floor
  already ≈ 43/57 ms; the remaining ~60/150 ms App-side scheduling delta
  is un-isolated (cpu-prof implicates reconciler commit walk, inconclusive).
  Follow-up: instrument useInput→setState path; candidate re-test under
  production React. Left OPEN for Phase 5, not waived.

## Phase 2 — Harness: zero-overhead agent loop — DONE 2026-09-18 (measured; verify-only items recorded, not refactored)

Measured after: `bench-loop` per-round p50 0.48–0.83 ms (all cases,
budget ≤ 5 ms met with 6× headroom); `plan-20call` p50 0.22 ms
(was 5.5–6.7 ms — 25× win, budget ≤ 2 ms met). 203 tests green across
scheduler/pipeline/architecture/snapshots/tools/soak/telemetry/parity.

### 2A — Loop hot path — DONE (parse-once + fused emitters; rest verified)

- [x] 2A.2/2B.2 Parse-once + validate-twice→once: `planBatches` pre-parses
  once per call (`PlannedToolCall.{index, malformed, parsed}` — malformed
  mirrors `parseToolArguments` exactly incl. arrays/non-objects); loop
  serial path reuses member parsed/malformed (invalid-JSON routing
  identical); `runStagesWithDecision` drops its duplicate validation
  (`planToolCall` post-hook validation is the single gate; compat
  `runOneToolWithArgs` validates once at entry — no src/test callers).
- [x] 2A.3 Fused per-turn emitters: `onToken`/`onPhase`/`onThinking` +
  sink emit fused into one stable function each, hoisted per turn
  (opts/sink are turn-stable by contract — documented). Same order,
  same shape.
- [x] 2B.5 Index threading: `calls.indexOf` scans gone (serial, parallel
  pre-pass; truncated path already used its loop index).
- [x] 2A.1/2A.4/2A.5 VERIFIED, no refactor: `getTodos` already once per
  turn-end (+O(1) frozen cache); turn-end deep work is µs-scale pure
  functions (bench proves ≤ 2 ms/round total); `recentTurnsForJudge` is
  one bounded slice, judge-path only.

Goal: the loop itself disappears from profiles — model + tools dominate wall time, never framework overhead.

### 2A — Loop hot path — DONE (parse-once + fused emitters; rest verified)

- [x] 2A.2/2B.2 Parse-once + validate-once: `PlannedToolCall.{index,
  malformed, parsed}` threaded planner → loop → pipeline; loop serial path
  reuses member parse (invalid-JSON routing byte-identical incl.
  arrays/non-objects); `runStagesWithDecision` drops its duplicate gate
  (`planToolCall` post-hook validation is single; compat
  `runOneToolWithArgs` validates once at entry — zero src/test callers).
- [x] 2A.3 Fused per-turn emitters (turn-stable contract documented).
- [x] 2B.5 Index threading: all `calls.indexOf` scans gone.
- [x] 2A.1/2A.4/2A.5 VERIFIED, no refactor: single turn-end snapshot +
  O(1) cache; turn-end pure fns are µs (bench proves ≤ 2 ms/round total);
  judge slice bounded + judge-path only.

### 2B — Scheduler + pipeline — DONE (realpath cache; rest verified)

- [x] 2B.1 Realpath cache DONE (`cachedRealpath` in `dir-cache.ts`,
  cap 500, invalidation rides listing points, barrel export keeps the
  arch-test `scheduler == ["tools"]` edge): plan-20call p50 6.7 ms →
  0.22 ms (25×), zero fs on warm cache (pinned by stats test).
- [x] 2B.3/2B.4 VERIFIED, no change: interceptor snapshot is a tiny-array
  spread (hoisting would change mid-block registration semantics for
  nanoseconds); timeout disabled path already zero-alloc, default 60 s
  arming is the hung-tool contract (not overhead to remove).

### 2C — Provider streaming + prompt assembly — VERIFIED, no change

- [x] 2C.1/2C.2: App contract needs cumulative partials (rope needs a
  contract change — out of scope); SSE decode already incremental
  (partial-line buffer); toolDelta fires ~1–3×/call, App handler idempotent.
- [x] 2C.3/2C.4: sha1 + ~13 KB stringify per POST are tens of µs vs
  0.8–2 ms rounds — memo risk exceeds gain. No change.
- [x] 2C.5: env git status already per-turn (`refreshSystemEnv`), outside
  the hashed prefix. No change.

### 2D — Telemetry, sessions, persistence — DONE (telemetry gate + snapshot overlap)

- [x] 2D.1 Telemetry gate DONE: ISO/argsJson skipped when no sink handles
  them (byte-identical with handlers; sink tests pin values).
- [x] 2D.2 VERIFIED, no change: persist is per completed turn (not hot
  path); kill-safe save is a feature, debounce would trade durability.
  Display fields already stripped.
- [x] 2D.3 Snapshot overlap DONE: `capturePriorBytes(abs, label,
  priorText?)` — edit passes its pre-read (no second stat+read; spill
  contract identical incl. >256 KB overflow file). Write new-file path
  already stat-miss cheap. `/rewind` suites green.
- [x] 2D.4 Acceptance DONE: per-round p50 0.48–0.83 ms (≤ 5 ms, 6× margin);
  plan p50 0.22 ms (≤ 2 ms); 203 tests green (scheduler/pipeline/arch/
  snapshots/tools/soak/telemetry/parity/harness/intercept).

## Phase 3 — Extremely fast tool executions (disk, search, shell, web)

Goal: every tool call pays the minimum possible I/O. Caches win the common case; cold paths use the fastest engine available.

### 3A — Reads/writes (`src/tools/filesystem.ts`, `src/tools/read-cache.ts`, `src/tools/dir-cache.ts`, `src/tools/fingerprints.ts`)

- [ ] 3A.1 Single-syscall read path: today `readTool` pays `stat` + `open/read/close` (12-byte peek) + `readFile`. Fix: open once, `fstat` the handle, read peek from the handle, then stream the rest from the same handle (no second open, no separate `stat` syscall). Media branch reuses the buffered bytes. Expected: 3 syscalls → 1 on the cold path.
- [ ] 3A.2 Window without full split: `readTextResult` does `text.split("\n")` over the whole file then slices the window — O(file) per read even for `limit: 5`. Fix: for windows with small `limit`, scan line starts incrementally and slice only the window (bounded work ~offset+limit lines, not whole file). Keep line-number prefixes and 64 KB cap byte-identical. Large windows keep the current path.
- [ ] 3A.3 Read cache tuning: raise `DEFAULT_MAX_ENTRIES` 100 → 500 (entries are small strings; explore loops re-read shared context across parallel batches), keep TTL 30 s. Key insight: parallel 8-read batches of shared context should be 1 disk read + 7 cache hits — add a test pinning exactly that. Keep `ATOM_READ_CACHE=0` kill switch, successes-only, errors never poison.
- [ ] 3A.4 Fingerprint reuse: `contentHash` runs on every read + every edit-read. On cache hits the stored hash is reused (already) — extend: edit's pre-read hash feeds `capturePriorBytes` + post-write fingerprint without re-hashing (hash once per content version, carry it through).
- [ ] 3A.5 Directory listings: `readTool` on a directory does `readdir` directly (uncached — correct, already cheap). Keep; do NOT route through `dir-cache` (highly mutable, different contract).

### 3B — Search (`src/tools/search.ts`, `src/tools/dir-cache.ts`, `src/tools/ripgrep.ts`)

- [ ] 3B.1 Listing reuse across calls in one block: parallel `grep`+`glob` batches each call `listFiles` independently (same key → second call hits the mtime cache, but still pays a `stat` + map lookup each). Fix: share one `listFiles` promise per block via a per-tick inflight map (concurrent callers await the same promise — one git/walk, N consumers). Invalidate with the existing points.
- [ ] 3B.2 Git spawn cost: `git ls-files` one invocation per cold listing is correct but spawns a process (~tens of ms). Fix: keep git path for correctness, but prefer the mtime-cache hit (already first) and add a negative-cache for non-git dirs (remember `gitListFiles → null` per `absDir` for the TTL window — no re-spawn every call outside a repo). Keep `ATOM_FAST_LIST=0` forcing the walker.
- [ ] 3B.3 Walker fast reject: per-file `stat` (OOM guard) + full `readFile` + `includes("\0")` binary check reads every byte of every file. Fix: binary/oversize pre-check reads only the first 4 KB (`open` + partial read): NUL in head or `stat.size > 1 MB` → skip without reading the body. Text files pay one full read (unchanged); bundles/media skip after 4 KB instead of full megabytes.
- [ ] 3B.4 Regex fast path: literal patterns (no regex metachars) should use `String.includes` per line instead of `RegExp.test` (no regex engine setup, no `lastIndex` reset dance). Detect literal (no `.*+?^${}()|[]\`) at compile time; keep `(?i)` handling (lowercase-compare path). Byte-identical hits via the shared `formatGrepHit`.
- [ ] 3B.5 Sort only when needed: `files_with_matches` + `glob` pay per-match `mtimeMs` stats + sort (N stats syscalls). Fix: skip recency sort when results ≤ 20 (insertion/alpha order is fine at small N — verify parity expectation with existing tests first; if tests pin recency order at small N, keep sort but batch stats with limited concurrency instead of unbounded `Promise.all`).
- [ ] 3B.6 Ripgrep threshold tuning: measure `rgMinFiles()` crossover on this repo (spawn cost vs walker cost) and set the threshold from data, not guesswork. Log `noteRgFallback` counts in bench output so regressions in rg availability surface immediately.
- [ ] 3B.7 Glob matcher cache: `globToRegExp` recompiles per file per call (200 files × N patterns). Fix: compile each expanded pattern once per call (memo map pattern → RegExp), reuse across the file list. Brace expansion cap (128) stays.
- [ ] 3B.8 Acceptance: `node scripts/bench-tools.mjs` search cases meet Phase 0 budgets; second identical `grep`/`glob` in a row is ≥ 5× faster than the first (cache proof); `npm test` search/dir-cache/ripgrep suites green.

### 3C — Shell (`src/tools/shell.ts`)

- [ ] 3C.1 Exec overhead: `exec` default `maxBuffer` 16 MB, `providerSecrets()` rebuilds per call (iterates `PROVIDERS` env lists), `scrubSecrets` scans output per secret. Fix: cache the secrets list per process-env snapshot (recompute only when `process.env` key set changes — cheap check via a version counter on first access per call is overkill; simplest: memo with 5 s TTL). Keep scrub-BEFORE-truncate + overflow-spill order (security-critical — never reorder).
- [ ] 3C.2 Listing invalidation scope: every bash (even `echo hi`, even failed spawn) calls `clearDirListingCache` (full clear → next search re-enumerates). Fix: keep full clear for foreground `exec` (footprint genuinely unbounded — correct), but skip the clear when the command is provably read-only (`true`, `echo`, `pwd`, `node --version`-class: match a small allowlist of side-effect-free builtins; anything else clears as today). Background spawn keeps full clear. Document the allowlist next to the call.
- [ ] 3C.3 `bash_output` latency: 100 ms poll loop is correct but wake latency tails at ~100 ms + read. Fix: adaptive poll (20 ms for the first 500 ms after spawn — the interactive window — then 100 ms), and `readFile` stdout+stderr concurrently (`Promise.all`, already sequential today — verify). Cap `timeoutMs` handling unchanged (0/negative semantics pinned by tests).
- [ ] 3C.4 Sync appends: background task `appendFileSync` per chunk blocks the event loop under output floods. Fix: batch appends per task (accumulate chunks, flush on 16 KB or 50 ms trailing timer, synchronous flush on `close` before marking finished — preserves the no-flush-race contract documented at `close`).
- [ ] 3C.5 Acceptance: no-op `bash true` overhead ≤ 10 ms excluding child runtime; `bash_output` immediate-poll (already-finished task) ≤ 15 ms; flood test (1 MB background output) doesn't jank streaming paints (run `tools` + `paced` bench scenarios together).

### 3D — Web (`src/tools/web.ts`)

- [ ] 3D.1 Connection reuse: if each `webfetch`/`websearch` builds a fresh fetch with new `AbortController` + timeout (correct) but no keepalive, enable HTTP keepalive agent for the allowlisted destinations (network policy already governs). DNS + TLS handshake per call dominates small fetches — keepalive removes it.
- [ ] 3D.2 Timeout discipline: keep per-call timeouts (web path hangs are the classic harness stall — see loop `slowestModel` tracking), but fail fast on DNS (shorter connect timeout vs read timeout) so a dead host doesn't eat the full budget.
- [ ] 3D.3 Truncation before JSON: cap + overflow-spill already exists — verify the cap applies to the RAW bytes before any markdown/HTML transform (transforms can expand input; capping after transform wastes the parse).

## Phase 4 — Startup, memory, build (cold start → first paint)

- [ ] 4.1 Startup path audit: `tsx src/cli.tsx` (dev) vs `dist/cli.js` (built). Measure `time atom --help` and time-to-first-paint (banner). Lazy-load heavy subtrees: `web/` server + dashboard, `mcp/*`, telemetry-server, `skills.ts` discovery — none needed for first paint. Move their imports behind the flags/commands that use them (`--web`, `--serve`, `--dashboard`, `/skills`). Keep `tests/architecture.test.ts` import rules green (lazy `await import()` from `App`/CLI is UI-owned — allowed).
- [ ] 4.2 Skill/extension discovery: if project+home skill scans hit disk per startup, cache the directory listing via `dir-cache` primitives and skip hidden/ignored trees early (`SKIP_DIRS` + ignore files). `/model` + `/provider` pickers already memo (model/skill/session entry memos in `src/App.tsx`) — keep stable refs so picker opens don't rescan.
- [ ] 4.3 Memory ceilings: transcript `SCROLLBACK_WINDOW = 300` + inspector capped store (`MAX_TOOL_RECORDS = 50`, 32 KB/record) + tool-result 6-line/600-char preview + overflow files (not memory) are the ceilings — verify each has a test pinning the cap (add where missing). Long sessions must not grow heap via parse cache (300-entry FIFO — keep), read cache (500 after 3A.3 — bounded), listing cache (50 — bounded), realpath cache (500 new — bounded), bg tasks (20 records — bounded, temp files pruned).
- [ ] 4.4 Build: `tsc -p tsconfig.build.json` + `copy-web-ui.mjs` stays the publish path. No bundler migration in this track (esbuild/rollup would speed startup but risks the architecture-test import graph — separate proposal if Phase 4.1 numbers still miss budget after lazy-loading).
- [ ] 4.5 Acceptance: cold `atom --help` ≤ 800 ms on dev hardware; first interactive paint ≤ 1.5 s from source (`npm start`); heap flat over a 300-turn synthetic session (drive via bench harness, sample `process.memoryUsage`).

## Phase 5 — Integration, docs, close-out

- [ ] 5.1 Flicker/perf gates in CI: promote the probe tests (Phase 0.4) + bench budgets to hard gates — `npm run bench` before/after on the `burst`, `long`, `tools`, `paced` scenarios must show no > 10% regress in bytes/clears/avg-render (existing convention from the root `tasks.md` Phase 4.1) PLUS new gates: frames-per-token ≥ baseline at 60 fps config, loop overhead ≤ 5 ms, warm-read ≤ 1 ms. Record results in the PR. Baselines are post-widget-chrome (see note in 0.2) — never v1.5.5 raw.
- [ ] 5.2 Narrow-terminal pass: re-verify 48 / 80 / 140 cols after every layout change (banner hide < 50, table stack < 50, widget collapse < 50/70, todo overflow, single-lane live zone). One manual TUI pass: 3-question batch, 8-task todo flow, one tool per kind + one failure + Ctrl+O, interleaved thinking/content stream, Esc-cancel freeze, resize storm mid-stream.
- [ ] 5.3 Docs: update `documentation/` (CLI/TUI render behavior incl. sequenced lanes, tool cache + kill switches `ATOM_READ_CACHE` / `ATOM_FAST_LIST`, timeout knobs, telemetry off switch) + `CHANGELOG.md` entries per phase. Document the new env knobs (if any: paint interval override, secrets-cache TTL, read-cache size) in `.env.example` + `documentation/configuration.md`.
- [ ] 5.4 Full gate: `npm run typecheck && npm test && npm run build` green (modulo the 9 known timing flakes — record exact names); `node scripts/bench-render.mjs all A`, `node scripts/bench-loop.mjs`, `node scripts/bench-tools.mjs` all meet Phase 0 budgets; manual 60 fps feel check (streaming answer + running tool + ticking clock, no visible stutter).
- [ ] 5.5 Rollback plan: each phase ships as one commit (`perf(bench): …`, `perf(tui): 60fps paints`, `perf(harness): zero-overhead loop`, `perf(tools): fast io`, `perf(startup): lazy load`, `chore: docs+budgets`); revert = `git revert` single commit. No schema/data migration in any phase. Kill switches (`ATOM_READ_CACHE=0`, `ATOM_FAST_LIST=0`, `ATOM_TELEMETRY=0`) remain the runtime escape hatches.

## Build order

Phase 0 → Phase 1 (TUI) → Phase 2 (harness) → Phase 3 (tools) → Phase 4 (startup) → Phase 5 (close-out).

Phases 1/2/3 are independent after Phase 0 baselines exist and can parallelize across workers (different file sets, shared budgets). Suggested commits: `perf(bench): budgets+harness`, `perf(tui): 60fps paints`, `perf(harness): zero-overhead loop`, `perf(tools): fast io`, `perf(startup): lazy load`, `chore: docs+budgets`.

## File map (quick index for workers)

- TUI: `src/cli.tsx`, `src/App.tsx`, `src/ui/paint-scheduler.ts`, `src/ui/stream-store.ts`, `src/ui/transcript.tsx`, `src/ui/markdown.tsx`, `src/ui/live-tail.tsx`, `src/ui/live-host.tsx`, `src/ui/activity.ts`, `src/ui/layout.ts`, `src/ui/tool-model.ts`, `src/ui/tool-call-state.ts`, `src/ui/components/ToolCall.tsx`, `src/ui/todo-panel.tsx`, `src/ui/modals.tsx`, `src/ui/status-bar.tsx`, `src/ui/input.tsx`, `src/ui/theme.ts`
- Harness: `src/agent/loop.ts`, `src/agent/tool-pipeline.ts`, `src/scheduler.ts`, `src/agent/types.ts`, `src/agent/normalize.ts`, `src/agent/tool-result.ts`, `src/adapters.ts`, `src/zen.ts`, `src/providers.ts`, `src/context-manager.ts`, `src/context-windows.ts`, `src/prompt-cache.ts`, `src/system.ts`, `src/env-block.ts`, `src/compact.ts`, `src/telemetry.ts`, `src/sessions.ts`, `src/snapshots.ts`, `src/goal.ts`
- Tools: `src/tools/filesystem.ts`, `src/tools/search.ts`, `src/tools/ripgrep.ts`, `src/tools/shell.ts`, `src/tools/web.ts`, `src/tools/shared.ts`, `src/tools/read-cache.ts`, `src/tools/dir-cache.ts`, `src/tools/fingerprints.ts`, `src/tools/overflow.ts`, `src/tools/registry.ts`, `src/tools/intercept.ts`
- Bench/tests: `scripts/bench-render.mjs`, `scripts/bench-loop.mjs` (new), `scripts/bench-tools.mjs` (new), `tests/architecture.test.ts`, `tests/question-queue.test.ts`, `tests/tool-widget.test.tsx`, `tests/stream-sequence.test.tsx`, `tests/` perf probes, `vitest.config.ts`
