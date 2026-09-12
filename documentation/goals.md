# Goals

One pinned session goal that keeps the agent working turn-to-turn until it is done, stuck, paused, or cleared.

## Commands

| Input | Effect |
|---|---|
| `/goal <objective>` | Pin the objective (replacing any live goal resets its counters) |
| `/goal` (bare) | Show text, state (`active`/`paused`), and cumulative stats (turns · requests · tokens · work) |
| `/goal pause` | Halt the run; objective and stats are kept |
| `/goal resume` | Re-arm a paused goal: when idle it starts a continuation turn; when busy it resumes at the current turn's end (no turn is injected while busy) |
| `/goal clear` | End the goal |

## How the run works

- **No turn cap.** The goal continues turn-to-turn until it is paused, cleared, ends in a `complete`/`blocked` verdict, or a thrown failure stops the turn.
- **Pause never clears.** Cancel (`Esc`/`Ctrl+C`) and spent step/tool-call budgets pause the goal with its objective, stats, todos, and history intact; `/goal resume` continues. Only `/goal clear`, `/clear`, and `/new` end it (`/clear` and `/new` wipe the conversation, so the goal cannot survive them).
- **The model reports each turn** with the goal-scoped `update_goal` tool: `continue` with the next action, or `complete`/`blocked` with a reason. Only the first terminal report per turn sticks; calls outside a goal turn record nothing.
- **Report-less turns** get one bounded judge call when a judge is configured, otherwise the goal continues. An unclear or failed judge pauses with the goal preserved.
- **Stall redirect.** Three consecutive repeated tool results push a replan nudge instead of repeating; the goal stays active.
- **Honest completion.** A `complete` with unverified code changes or open todos continues the turn instead of stopping; `blocked` stops unconditionally. Checks the model could not run ride the `complete` report as `unverified` (at most 10 items, 200 chars each) and print openly in the closing verdict — recorded, never a gate.

## Surfacing

- **Status line:** `goal: <objective> [active|paused]` while a goal is live (truncated to fit; lowest-priority segment — it drops before anything else moves, and hides entirely with no goal).
- **Telemetry:** each turn trace carries the live goal (objective, state, counters); the dashboard shows a per-turn goal fragment and a Goal-turns overview card only when goal turns exist.
- **Persistence:** the live goal rides every session save with its stats intact — `/resume` and session switches restore it; corrupt data loads as no goal.
- **Compaction:** the summary gains a `Goal:` line (text, state, stats, open todos) as the model's context backstop; record restore stays the restore path.

## Known limits

- The `update_goal` schema rides the chat-payload `tools` list only while a goal turn is live (hidden on non-goal turns so it cannot be misused); the model discovers it through the continuation message prose plus the live tool definition.
- Multi-turn goal behavior against live models is unproven; the loop, judge, and gate paths are covered by mocked suites.

## Code

- State machine, notices, stats, judge parsing, stall guard, persistence shape, compaction block: `src/goal.ts`
- Commands, resume kickoff, stats accrual, session save/restore: `src/App.tsx` (`runGoalCommand`, `submit`)
- Turn-end protocol, evaluator fallback, stall redirect, honesty gate: `src/agent/loop.ts`
- Evaluator transport: `src/agent/goal-evaluator.ts`
