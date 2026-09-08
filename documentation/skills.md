# Skills

Claude-Code-style `SKILL.md` adoption. Discovery, listing, invocation, and turn-scoped tool grants build on one registry (`src/skills.ts`).

## Where skills live

Two roots, scanned every call (no cache, edits take effect without restart):

- Project: `<projectDir>/.claude/skills/<name>/SKILL.md`
- Global: `~/.claude/skills/<name>/SKILL.md` (`$HOME` via OS homedir)

A missing skills directory is normal and silent. Per-skill failures surface as warning strings, never throws.

## SKILL.md contract

Frontmatter fields (single-line `key: value`, folded and literal continuations supported):

| Field | Meaning |
|---|---|
| `name` | Skill name. Defaults to the directory name when absent |
| `description` | Trigger description. Defaults to the first non-heading paragraph when absent. Required: empty body plus no description means skipped |
| `user-invocable` | `false` hides the skill from manual `/name` invocation. Default `true` |
| `disable-model-invocation` | `true` excludes the skill from auto-match. Default `false` |
| `allowed-tools` | Space and/or comma-separated tool names. Lowercased, deduped. Turn-scoped auto-approvals on invoke. Unknown names match nothing |

Boolean forms accepted: `true`/`false`, `yes`/`no`, `on`/`off`, `1`/`0`, any case. Unrecognized values fall back to defaults.

Support files: `references/<...>` and `scripts/<...>` mentions inside the body are inlined on demand (first 3 unique mentions, 8KB each, traversal outside the skill dir dropped, missing files skipped silently).

## Listing and precedence

`/skills` prints `Skills (N):` with one `/name` plus description plus source per line. Model-only skills show `[auto-only]` instead of hiding. Notes and warnings ride along visibly. Empty with no warnings prints the install hint (`add SKILL.md skills under .claude/skills/ or ~/.claude/skills/`).

Name clashes: global (personal) wins over project on exact-name matches, with a visible note. Same-level duplicates keep the first with a note. Pure function `resolveSkills`, covered by `tests/skills.test.ts`.

## Invocation

- Manual: `/skill-name` loads the body (plus inlined references) into context for that turn. `allowed-tools` in frontmatter become turn-scoped auto-approvals. User-invocable `false` entries reject manual invocation
- Auto: deterministic description match. Distinct `name` plus `description` words (length 3 or more, stopwords dropped) hitting the message as substrings, at least 2 hits, best score first, capped at 2 skills per turn. `disable-model-invocation` skills never match. See `matchSkills` in `src/skills.ts`
- Deny rules still win over skill grants. See [Permissions](permissions.md)

## Authoring checklist

1. Create `.claude/skills/<name>/SKILL.md` with `name` and `description`
2. Keep the body self-contained; reference large helpers via `references/...` so they inline only when needed
3. Declare least-privilege `allowed-tools`
4. Set `user-invocable: false` for auto-only helpers, `disable-model-invocation: true` for manual-only helpers
5. Verify with `/skills` listing plus `tests/skills*.test.ts` patterns
