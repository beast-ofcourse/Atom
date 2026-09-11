# Harness Comparision: ATOM vs Pi

Method: code reading only — no runs, no modifications to either repo.
ATOM paths are `src/...` (single-package repo). Pi paths are
`packages/<agent|ai|coding-agent|tui|telemetry|...>/src/...` (monorepo,
`@earendil-works/*`). Every claim below names the file it was read from.
"Not found" means not found by reading, not proven absent.

## 1. Architecture at a glance

| | ATOM | Pi |
|---|---|---|
| Shape | Single package, one agent loop (`src/agent/loop.ts` → `runLoopWithChat`), thin TUI client over it | Monorepo (11 packages); TWO loop implementations: simple evented loop (`packages/agent/src/agent-loop.ts`) + durable lane/reducer harness (`packages/agent/src/harness/`) |
| Lines of harness | ~700 (loop) + small satellites | 803 (simple loop) + ~50-file durable runtime |
| State model | In-memory history array + module-global todos/fingerprints; `~/.atom/session.json` per completed turn | Session store (JSONL codec, sqlite backend): entries, values, memos, branches, forks, replay; lanes run concurrently |
| Transport | Direct `fetch` to provider chat endpoints | `StreamFn` abstraction + `packages/ai` provider catalog; RPC-capable client/server split |
| UI | Ink React TUI, memo discipline + render probes | Own differential-rendering TUI lib (`pi-tui`) with native backends (darwin/linux/win32) |

Pi is a platform (multi-lane, resumable, RPC-served); ATOM is a single sharp loop
with a TUI client. That one sentence explains most differences below.

## 2. Agent loop core

**Pi simple loop** (`agent/agent-loop.ts`): outer follow-up loop + inner tool
loop. Extension seams everywhere, all optional hooks: `getSteeringMessages`,
`getFollowUpMessages`, `prepareNextTurn` (may swap context/model/reasoning),
`shouldStopAfterTurn`, `transformContext`, `convertToLlm`. Assistant messages
stream as typed partial events (`text_*`, `thinking_*`, `toolcall_*`,
`message_update`) with in-place partial replacement. `length` stopReason
(truncated output) fails every tool call of that message as errors and
CONTINUES the turn. `error`/`aborted` stop ends the agent.

**ATOM loop** (`agent/loop.ts`): single `for(;;)` over tool-round steps.
`drainSteer` hook per step, todo + verification turn-end gates, error-streak
hold, repetition guard (opt-in), empty-response recovery (bounded), step
budget (30) + total-call budget (200). Transport failures throw → caller rolls
back the turn.

Comparison:
- Pi's loop is hook-configurable (stop conditions, context swaps, model swaps
  are caller policy); ATOM's are hardcoded gates (todo/verification) + budgets.
- Pi survives truncated-arg responses by failing calls inline; ATOM aborts the
  whole POST on truncation/empty (ATOM added bounded empty-recovery, but
  truncation still kills the turn — Pi's behavior is strictly more resilient
  here).
- Pi has no built-in step budget visible in the simple loop (relies on
  `shouldStopAfterTurn` + harness lane control); ATOM's budgets are explicit
  and always on.
- Both: steering injection without aborting the current step; cancel = abort
  signal; pairing kept valid.

## 3. Parallel tool execution

- **Pi**: parallel by default; any tool may declare `executionMode:
  "sequential"` to force serial (`agent-loop.ts`); global `toolExecution`
  config switch. Results commit in call order via `Promise.all` over ordered
  slots. Durable runtime additionally serializes **per-file** mutations through
  a realpath-keyed queue (`file-mutation-queue.ts`) — cross-file writes run
  concurrently.
- **ATOM**: effect-aware scheduler (`scheduler.ts`) — reads batch on disjoint
  tool+target keys; writes/edit/bash/ask/todos always run as serial
  singletons. All writes serialize GLOBALLY (not per file).

Verdict: both parallelize reads deterministically. Pi parallelizes
independent writes; ATOM deliberately does not (bash can touch anything).
Pi's per-file mutation queue is the better design if ATOM ever relaxes this.

## 4. Tool results, errors, malformed handling

- **Pi**: structured results — content blocks + `details` + `usage` +
  `terminate` flag. Thrown executor errors become error results (never throw
  across the boundary). Unknown tools → inline error. Untyped (JS-extension)
  results with null content are normalized. `beforeToolCall` (block/approve)
  + `afterToolCall` (rewrite content/details/usage/isError) hooks.
  Truncated-argument calls → per-call errors, turn continues.
- **ATOM**: results are STRINGS; failures are `Error: ...` text the model
  reads. `normalize.ts` coerces non-strings + caps at 128KB; unknown tools,
  validation failures, denials are inline errors. `approve` hook (yolo/normal/
  plan + always-allowed + skill grants). Truncated/empty POSTs throw → turn
  aborts (caller rolls back); bounded empty-recovery was added.

Verdict: Pi's structured results + rewrite hooks are more expressive
(per-tool usage attribution, terminate signaling). ATOM's string contract is
simpler and every executor obeys "never throws" — but it cannot attribute
tokens per tool or end a turn from a result without prose parsing (ATOM's
turn-end gates re-derive verification state instead).

## 5. Approvals / permissions

- **Pi**: `before_tool` gate hook + project-trust store
  (`trust-manager.ts`: per-project allow/session-only decisions). No y/a/t/n
  prompt found in the loop layer (UI-owned).
- **ATOM**: three modes (normal/yolo/plan), interactive y/a/t/n prompt,
  session trust-all, always-allowed set, skill-scoped grants, plan-mode
  read-only gate. No project-trust persistence (trust is in-memory per
  session).

Verdict: ATOM's interactive approval UX is richer; Pi's project-trust
persistence (remember this repo is safe) is the piece ATOM lacks.

## 6. Context management and budgets

- **Pi**: `AgentMessage` domain model, translated to provider messages only at
  the LLM boundary (`convertToLlm`); caller-supplied `transformContext`
  hook; window-aware trimming lives in the harness drive/structural path.
- **ATOM**: OpenAI-shaped history throughout; `ContextManager` derives caps
  from the real model window (5% margin, 4096 output reserve); incremental
  `Proxy` ledger (O(1) accounting); stable-prefix split (`splitSystemHead`)
  for implicit prompt caching; todo-needle pinning; first-turn + latest-turn
  never dropped.

Verdict: equivalent goals, different instruments. ATOM's ledger + derived
budgets are the more careful accounting; Pi's boundary translation +
transform hook are the more flexible architecture.

## 7. Token accounting

- **Pi**: REAL tokens — usage-anchored estimates
  (`estimateContextTokens`: last provider usage + trailing estimates),
  `cacheRead`/`cacheWrite` tracked, per-turn usage rows in telemetry.
- **ATOM**: 4-chars-per-token heuristic everywhere; usage forwarded only when
  the provider reports it, never synthesized.

Verdict: Pi measures where ATOM estimates. ATOM's honesty rule (never present
estimates as measurements) is principled; Pi's anchoring (real usage + measured
tail) is strictly more accurate for budget decisions.

## 8. Compaction / summarization

- **Pi**: threshold = `window − reserveTokens(16384)`, keeps ~20K recent
  tokens, reasons `manual|threshold|overflow`; compaction entries record
  **readFiles + modifiedFiles**; branch summarization for forks; usage-gated
  (only post-compaction assistant usage counts).
- **ATOM**: auto-compact at 83% of verified window, keeps ~8K-token tail
  (tool outputs capped 2K), summary POST with tools disabled capped at 4096
  tokens, overflow-retry once, thrash guard (3 strikes disables auto).

Verdict: same shape. Pi keeps 2.5× more tail and remembers WHICH files were
touched (ATOM tracks unverified paths for its gate but drops the file list
from summaries — borrowing the file-list idea would improve ATOM resumes).

## 9. Retries, transports, streaming

- **Pi**: validated `RetryPolicy` (base/max-agent-delay), `retry_scheduled`
  / `retry_start` / `retry_end` events, per-provider streaming adapters
  (46 provider files incl. OAuth: Anthropic, GitHub Copilot), model catalog
  generation.
- **ATOM**: 10 retries, 1s→2s→… backoff honoring `Retry-After` (30s cap),
  three SSE readers (OpenAI/Anthropic/Gemini shapes), per-read stall race +
  data-silence bound (60s, `ATOM_STALL_TIMEOUT_MS`), 8 providers via registry,
  live Kilo catalog with TTL.

Verdict: Pi's provider breadth (46 incl. OAuth + catalog tooling) dwarfs
ATOM's 8 registries. ATOM's stall handling (byte race + data-silence bound,
live-proven against free-tier queue floods) is the more battle-tested
streaming edge — Pi has retry events but no observed equivalent of ATOM's
stall guard.

## 10. Cancellation and timeouts

- **Pi**: `AbortSignal` plumbed through prepare/execute/finalize; abort
  yields synthetic results; **interrupted tools keep durable progress
  checkpoints** (`INTERRUPTION_MARKER` + checkpointed partial output);
  effect-gate capability expiry.
- **ATOM**: `LoopCancelledError`, in-flight tool runs to completion and its
  result IS recorded, then the turn stops before the next batch/POST; caller
  rolls back; streamed partial preserved on display. Bash 60s + outer 60s
  tool timeouts.
- Notable: Pi bash has **no default timeout**; ATOM's 60s default is safer.

Verdict: Pi's cancel-with-checkpoint is superior for long tools (progress
survives); ATOM's finish-current-then-stop is simpler and fully predictable.

## 11. Loop guards, runaway protection, completion

- **Pi**: `shouldStopAfterTurn` hook, result `terminate` flag, lane control
  states, retry budgets, compaction overflow reason.
- **ATOM**: step budget 30, total-call budget 200, opt-in repetition guard
  (polling exclusions), error-streak hold (3), empty-recovery (2),
  verification rounds (3), todo + verification gates with explicit
  blocked/unverified end labels.

Verdict: ATOM has more built-in, always-on guardrails with user-readable end
labels; Pi delegates stopping to configuration. ATOM's are better defaults
for a coding agent; Pi's are better primitives for a platform.

## 12. State, sessions, persistence

- **Pi**: session store with JSONL codec, entry/value/memo model, branches,
  forks, navigation (`tree`/`fork`/`clone`), import/export/share,
  sqlite backend, crash restore with replay (`replay: "safe"` tools re-run;
  otherwise interrupted-outcome synthesis).
- **ATOM**: `session.json` per completed turn (failed turns never touch it),
  file snapshots + `/rewind`, telemetry JSONL-ish files. No forks, no replay,
  no resume-mid-turn.

Verdict: Pi is in another league (durable, replayable, branchable). ATOM's
kill-safe save + rewind covers the 90% case at 5% of the machinery.

## 13. Telemetry / observability

- **Pi**: OpenTelemetry-style spans (`pi-telemetry`, conformance tests),
  per-turn usage rows, compaction/retry/steering events on the bus.
- **ATOM**: local JSON traces (turns/iterations/model+tool calls with
  durations, retries, outcomes), `LoopStats` rollup (cache hits, guard hits,
  bottleneck, context growth), self-rendered HTML dashboard, no network.

Verdict: Pi instruments for distributed tracing; ATOM instruments for local
debugging. ATOM's LoopStats answers "why was this turn slow" faster; Pi's
spans answer it across services.

## 14. Tool set

- **Pi** (`coding-agent/src/core/tools`): read, write, edit (+edit-diff),
  bash, **powershell**, find, grep (**ripgrep binary, auto-downloaded**),
  ls, truncate (2000 lines / 50KB, never partial lines), output-accumulator
  (bounded streaming tail + temp file), file-mutation-queue, renderers.
- **ATOM** (`src/tools`): read (64KB + line window), write, edit
  (stale-read fingerprints), grep/glob (walker + git fast path +
  single-pass), bash (+detached background tasks), webfetch (SSRF-gated),
  websearch, ask_question (interactive), todowrite/todo_get/todo_update,
  read-cache + dir-listing cache, overflow spill files.

Verdict: Pi wins search (ripgrep, no contest) and shell dedicatedness
(powershell tool); ATOM wins interactive planning (ask_question, todos),
background tasks, web retrieval with SSRF policy, and caching layers. Both
cap outputs; Pi's line+byte dual cap with no-partial-lines is the cleaner
contract (ATOM's 64KB read cap can split lines).

## 15. Skills and prompt construction

- Both inject skill catalogs into the system prompt. Pi XML-escapes
  name/description/location blocks; ATOM uses a deterministic local matcher
  (Tier-1 catalog, Tier-2 bodies on demand, 12KB caps) so skill metadata
  never enters the prefix unsolicited — the more cache-conscious design.
- Pi `/thinking` sets reasoning effort; ATOM's `/thinking` toggles thinking
  *visibility* (different feature, same name — funny).

## 16. TUI and interaction

- **Pi**: bespoke differential TUI library + native clipboard/backends,
  session tree navigation, export/import/share, fork/clone, model cycling.
- **ATOM** (Ink): memoized leaves + render probes, slash menu + palette +
  8 pickers, queue/steer while busy, autoscroll, thinking toggle, tool
  inspector, todo panel, rewind UI, ask_question modal, approval diff
  preview. Richer interactive surface; less rendering machinery.

## 17. Steering and follow-ups

- **Pi**: `getSteeringMessages` (inject mid-turn) + `getFollowUpMessages`
  (auto-continue after stop) hooks + lane steering modes.
- **ATOM**: `/steer` at step boundaries + `/queue` auto-send + drainSteer.
  Functionally equivalent; Pi's is API, ATOM's is UX.

## 18. Evals and tests

- **Pi**: `packages/evals` (harness-table, artifacts, smoke) — agent-level
  evaluation as a first-class package.
- **ATOM**: ~1000 unit/integration tests, zero committed agent-eval harness
  (a throwaway bench exists in `.scratch`, not committed).

## 19. Benchmark table (code-derived)

| Dimension | ATOM | Pi | Edge |
|---|---|---|---|
| Loop simplicity | 1 loop, ~700 lines | simple 803 + durable runtime (~50 files) | ATOM for hackability, Pi for embedding |
| Default parallelism | reads on disjoint keys | all tools unless flagged | Pi (broader) |
| Write parallelism | global serial | per-file queues | Pi |
| Search engine | walker + git + cache | ripgrep binary | Pi, decisively |
| Read cap | 64KB, may split lines | 2000 lines / 50KB, never partial lines | Pi |
| Tool timeout default | 60s | none | ATOM (safer) |
| Truncated response | abort turn (+bounded empty retry) | fail calls inline, continue | Pi |
| Stalled stream | fail fast @60s no-output | retry events, no observed stall bound | ATOM |
| Token accounting | 4ch heuristic, honest n/a | usage-anchored real tokens | Pi |
| Compaction tail | ~8K tokens | ~20K tokens + file lists | Pi |
| Cancel semantics | finish current, record, stop | abort + checkpoint snapshot | Pi (progress survives) |
| Guards out of box | budgets + gates + labels | hooks + flags (opt-in) | ATOM (defaults) |
| Persistence | session.json + rewind | JSONL/sqlite + forks + replay | Pi, decisively |
| Providers | 8, registry | 46 files + OAuth + catalog gen | Pi, decisively |
| Interactive planning | ask_question + todos | not found | ATOM |
| Approval UX | modes + y/a/t/n + grants | hook + project trust | ATOM (interactive), Pi (memory) |
| Background tasks | detached + poll | not observed | ATOM |
| Web retrieval | SSRF-gated fetch + search | not observed | ATOM |
| Caching | read + listing caches, prefix split | prefix via adapters (unverified here) | ATOM (measured) |
| Evals | unit tests only | evals package | Pi |

## 20. What ATOM should borrow (justified, not copied)

1. **ripgrep-backed grep** (keep walker fallback): Pi proves the pattern;
   ATOM's own benchmarks show content search is the last 3–7× gap. The 80ms
   Windows spawn tax argues for size-gated routing, not against rg.
2. **Per-file mutation queue**: relaxes ATOM's global write serialization
   without touching the bash-mutates-anything rule. Directly enables parallel
   multi-file edits the scheduler currently forbids.
3. **Truncated-argument calls → inline error + continue**: strictly more
   resilient than aborting the POST; ATOM's empty-recovery already concedes
   the principle.
4. **No-partial-lines truncation + dual line/byte caps**: cleaner contract
   than ATOM's byte caps; small, safe.
5. **Compaction file lists** (read/modified): ATOM already tracks
   unverified paths — persist them into summaries for better resumes.
6. **`afterToolCall`-style result hook**: enables result compression and
   policy redaction without touching executors.
7. **Project-trust persistence**: remember safe repos across sessions.

Deliberately NOT borrowed: lane/reducer/session-store machinery (ATOM's
scale doesn't pay for it), 46-provider catalog weight, no-default-timeout
bash, fork/clone/share surface.

## 21. What ATOM already does better (keep)

Interactive ask_question + todos, empty-response recovery, SSE stall guard,
read/listing caches with exact invalidation, LoopStats instrumentation,
verification gates with explicit end labels, plan read-only mode, background
shell tasks, SSRF-gated web tools, always-on budgets, 60s default timeouts.

## 22. Verdict

Pi is the better **platform** (durable, replayable, multi-lane, 46
providers, real tokens, ripgrep, evals). ATOM is the better **out-of-box
coding agent loop** (guards, recovery, approvals, planning tools, caching,
stall handling all on by default). The gap that matters most for ATOM users
is three items: ripgrep search, per-file write parallelism, and truncated-
response resilience — all proven above, all portable without Pi's machinery.
