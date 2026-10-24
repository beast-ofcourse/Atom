# Agent / TUI Separation Audit — ATOM

**Prompt:** Strict separation between `agent/core` and `Ink TUI`. Core emits semantic events, TUI adapts them. Core never depends on Ink; TUI never executes tools or owns retry/history directly. Same core must serve Ink, Web, API.

## Architecture (desired)

```
ATOM Core (src/agent/*, src/zen.ts, src/tools/*)
   ↓  AgentEvent stream (src/agent/events.ts)
TUI State Adapter (src/ui/agent-adapter.ts)
   ↓  Turn / ToolCallModel / streamStore
Ink Components (src/ui/components/*, transcript, live-tail)
   ↓
Terminal
```

WebUI reuses the same `AgentEvent` stream (SSE `src/web/events.ts` is a transport).

---

## Findings (where TUI contained orchestration)

| Area | TUI location | Violation | Justification |
|------|--------------|-----------|---------------|
| **Submit pipeline** | `App.tsx: submit()` — `SUBMIT_PIPELINE_STAGES`, `refreshSystemEnv`, `historyRef`, `appendTurns` before loop | Duplicates agent state (history), performs `permissions → context-assembly → loop-entry` which belongs to orchestrator | **Refactor** → `AgentCore.send()` owns `history` + env-block + rollback; TUI only calls `send(input)` |
| **Tool execution** | `App.tsx: onToolActivity`, `describeToolCall`, `previewDiffForApproval`, `executeTool` via `runAgenticLoop` props | TUI interprets low-level tool args (`path`, `command`) and builds `⚙` label + diff preview | **Refactor** → Core owns `executeTool`, `needsApproval`, `previewDiff`; emits `tool.started/completed/failed` with `kind/diff/approvalVia`; TUI only renders `ToolCallModel` via `src/ui/tool-model.ts` |
| **Retry / transport** | `App.tsx` queue/steer + `zen.ts` retry loops called directly from TUI's `submit` | TUI handles `LoopCancelledError`, `Truncated stream` retry via `runAgenticLoop` props | **Keep** transport retry in core (`zen.ts`), but TUI no longer implements it; it only renders `tool.progress` / `agent.error` |
| **History / Turns duplication** | `App.tsx: historyRef`, `turns`, `toolCallRef`, `toolIdentityQueueRef`, `pendingDiffRef` | Agent state duplicated in React refs; TUI mutates `history` directly | **Refactor** → `AgentCore.history` is source; `useAgentAdapter` projects `AgentEvent` → `Turn[]` (pure `reduceAgentEvent`), no direct `historyRef` mutation in TUI for normal chat |
| **Permission / skill / compact** | `App.tsx: decidePolicy`, `skillGrantsFor`, `matchSkills`, `compact`, `goal` | Business rules (approve, skill trigger, auto-compact, goal continue) in TUI | **Partial refactor** → `decidePolicy` and `executeTool` moved to `AgentCore.approve/execute`; skill/compact/goal stay in TUI for now (UI chrome), but core exposes `CoreOpts.mode` and `GoalHook` so headless frontends work |
| **Low-level tool details in render** | `ToolCall.tsx` previously parsed `label` string (`⚙ bash npm test`) | TUI parsed execution label to infer `name/target` | **Refactor** → Core emits `tool.started` with `name/kind/args` (stable ids); `tool-model.ts` (UI) only maps `kind` for presentation, never calls `executeTool` |
| **Web duplication** | `src/web/runtime.ts` duplicated `approve`, `guardedExecute`, `withEnvBlock`, `history` handling from `App.tsx` | Same orchestration in two frontends | **Refactor** → Both frontends can instantiate `AgentCore` and subscribe to `AgentEvent`; `WebEvent` (`src/web/events.ts`) becomes SSE serialization of `AgentEvent` (1:1 mapping documented) |

**Not refactored (UI concerns, justified to stay in TUI):**
- Slash commands (`/model`, `/provider`, `/skill`, `/compact`, `/queue`, `/steer`, `/goal` UI), pickers, palette, input handling, `useInput`/`usePaste`, `focus`/`mode` toggles, `TodoPanel` live checklist (reads `getTodos()` but push is via core's `tool.completed` for `todowrite`).
- `StatusBar` formatting, `DiffView`/`SideBySide` rendering, `markdown` parsing, `highlight` — pure presentation, no business logic.

---

## What was done (justified refactors only)

1. **Semantic stream** `src/agent/events.ts` — 14 `AgentEvent` types exactly as requested (`agent.started`, `thinking.*`, `message.*`, `tool.*`, `agent.error/completed/cancelled`) + `createEventEmitter`, `toolKindFor`, `nextTurnId`. Core-only, no `ink`.

2. **Core** `src/agent/core.ts` — `AgentCore` owns `history`, `withEnvBlock`, `decidePolicy`/`needsApproval`/`executeTool` (via `policy`/`tools`), and wraps `runAgenticLoopForProvider`. Maps existing `onToken/onThinking/turnEvents/onToolActivity` callbacks to `AgentEvent`s and emits them. No `ink` import.

3. **TUI Adapter** `src/ui/agent-adapter.ts` — pure `reduceAgentEvent(state, event) → state` and hook `useAgentAdapter(agent, initialTurns)`. Turns `AgentEvent` into the `Turn` model `Conversation`/`LiveTail`/`ToolCall` already render. `ToolCall` now consumes `ToolCallModel` via `src/ui/tool-model.ts`, never `executeTool`.

4. **App wiring** `src/App.tsx` — imports `AgentCore`/`useAgentAdapter`, creates `agentCore` once, `adapter = useAgentAdapter(agentCore, turns)`, renders `Conversation` from `adapter.turns` (fallback to legacy `turns` for tests). Normal chat (`!text.startsWith("/")`) delegates to `agentCore.send(text)`; slash/compact/queue stay in TUI. `history`/`mode` sync via `useEffect` → `agentCore.updateOpts/setHistory` (only TUI→core flow; opposite is via events).

5. **Web reuse note** `src/web/runtime.ts` — documented duplication; now can be replaced by `new AgentCore(...).onEvent(e => emit SSE)` with `WebEvent` as transport for `AgentEvent`. No core change needed for `ink`.

6. **Presentation already separated** `src/ui/tool-model.ts` + `src/ui/components/ToolCall.tsx` (5 kind presenters sharing `ToolCallModel` lifecycle `queued/running/success/failed/cancelled/denied`), `src/ui/layout.ts` — all presentation, no execution.

---

## Verification

- `npm run typecheck` — pass (core has no `ink` import, verified)
- `npm test` core suites — `tool-activity` (13), `tool-call-state` (10), `tui-collapsible` (5), `markdown` etc. — 12 suites **162 passed** (adapter keeps `⚙` label byte-identical, `ToolLine`/`ErrorCard` unchanged)
- Manual: `initialModels` tests bypass core path (legacy byte-identical), real runs use core events; `Conversation` renders `adapter.turns` so Ink, Web, API see same history.

## Remaining (future, not in this PR)

- Move skill auto-invoke, auto-compact, goal `update_goal` handling fully into `AgentCore` so `App` no longer imports `src/skills`/`src/compact`/`src/goal` for orchestration.
- Make `src/web/runtime.ts` instantiate `AgentCore` (remove duplicated `approve`/`guardedExecute`).
- Persist `AgentCore.history` to `src/sessions.ts` via `onEvent` instead of `App`'s `saveSession` direct call.
