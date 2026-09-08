# ADR-0001: Subagents v1 design (Claude Code parity, ATOM constraints)

Date: 2026-09-08. Status: accepted (pending implementation tickets in `.scratch/subagents/`).

Placement note: repo convention says `docs/adr/`, but `docs/` is gitignored in this repo, so this lives in `documentation/adr/` where git can see it.

## Decisions

1. **Reuse the skill-registry machinery for agent definitions** (discovery, precedence, description match, reference inlining). Agent files are nearly isomorphic to skill files; a second registry would drift.
2. **Depth 1, one-shot spawns.** No nesting, no resume IDs. The TUI runs one synchronous loop; stacked blocking turns multiply latency and spend. Nesting and resume are explicit later features, not flags.
3. **Children inherit the parent permission mode; `ask_question` and `delegate` are hard-removed from child pools.** Matches Claude Code (which strips `AskUserQuestion` and `Agent`-at-limit). No nested modals, no recursion on day one.
4. **Children load `AGENTS.md`; `explore`/`plan` skip it.** Repo instructions apply to workers, except the cost-sensitive read-only built-ins (Claude parity).
5. **Child model resolves per-invocation > frontmatter > parent model.** Same order as Claude Code.
6. **`05-state-and-registry` lands first.** Children on module-global state cross-talk by construction.

## Rejected

- Out-of-process children (IPC cost, zero isolation gain on one machine).
- Git-worktree isolation for v1 (doubles the surface: cwd scoping, merge-back). Reserved as a future spawn mode.
- Child `permissionMode` override for v1 (needs a policy language; inheritance + deny rules cover v1).
