# Skills

Claude-Code-style `SKILL.md` adoption. Discovery, listing, invocation, and turn-scoped tool grants build on one registry (`src/skills.ts`).
## Where skills live

Two levels, four roots:

- Project: `<projectDir>/.claude/skills/<name>/SKILL.md`
- Project: `<projectDir>/.agents/skills/<name>/SKILL.md` (where `skills.sh` installs)
- Global: `~/.claude/skills/<name>/SKILL.md` (`$HOME` via OS homedir)
- Global: `~/.agents/skills/<name>/SKILL.md` (`skills.sh` global installs)

## SkillRegistry (cached metadata)

The TUI reads skills through `createSkillRegistry` (`src/skills.ts`), not raw rescans: parsed Tier-1 metadata (name, description, invocation flags, `allowed-tools`) is cached in memory per App instance. Each `refresh()` revalidates with one `stat` (mtime + size) per `SKILL.md` and re-reads only added or modified entries — per-message cost drops from ~1MB of file reads to a directory listing plus stats. A missing/unreadable file, a fixed file, or a deleted skill takes effect on the very next refresh (no restart, never stale); vanished roots drop silently. Bodies and `references/` stay lazy (`loadSkillBody`, on activation only). The uncached `discoverSkills` remains for one-shot/headless use with byte-identical parsing.

A missing skills directory is normal and silent. Per-skill failures surface as warning strings, never throws.

## SKILL.md contract

Frontmatter fields (single-line `key: value`, folded and literal continuations supported):

| Field | Meaning |
|---|---|
| `name` | Skill name. Defaults to the directory name when absent |
| `description` | Trigger description. Defaults to the first non-heading paragraph when absent. Required: empty body plus no description means skipped |
| `user-invocable` | `false` hides the skill from manual `/name` invocation. Default `true` |
| `disable-model-invocation` | `true` excludes the skill from auto-match. Default `false` |
| `allowed-tools` | Space and/or comma-separated tool names. Lowercased, deduped. Turn-scoped auto-approvals on invoke — global skills only (see trust note below). Unknown names match nothing |

Boolean forms accepted: `true`/`false`, `yes`/`no`, `on`/`off`, `1`/`0`, any case. Unrecognized values fall back to defaults.

Support files: `references/<...>` and `scripts/<...>` mentions inside the body are inlined on demand (first 3 unique mentions, 8KB each, traversal outside the skill dir dropped, missing files skipped silently).

## Listing and precedence

`/skills` opens the searchable picker (names only, type to filter, arrows to browse, `Enter` stages for confirm). `skillsListText` (headless use) prints `Skills (N):` with one runnable `/skill:name` plus source per line — no descriptions in either surface. Model-only skills show `[auto-only]` instead of hiding. Notes and warnings ride along visibly. Empty with no warnings prints the install hint (`add SKILL.md skills under .claude/skills/, .agents/skills/, or the ~/. counterparts`).

Name clashes: global (personal) wins over project on exact-name matches, with a visible note. Same-level duplicates keep the first with a note. Pure function `resolveSkills`, covered by `tests/skills.test.ts`.

## Invocation (progressive disclosure, Claude-Code-style)

Three tiers: (1) name plus description of every skill is known to the matcher at all times; (2) the `SKILL.md` body loads only on activation; (3) `references/` and `scripts/` files load on demand (inlined for explicit manual loads; the model reads them via `read` for auto loads). The transcript always shows one plain line per load (`deploy loaded`), never the body.

- Manual: `/skill:name` (canonical; legacy `/skill-name` still works) loads the full body plus inlined references into context for that turn. Discovery without dispatch: the `/skills` picker (type to filter, arrows to browse, `Enter` stages `/skill:name` into the input — nothing is sent) and the `/` slash menu (skill rows complete on first `Enter`, run on the second) both confirm before loading; a fully typed `/skill:name` or `/skill-name` runs on first `Enter`. `allowed-tools` in frontmatter become turn-scoped auto-approvals. User-invocable `false` entries reject manual invocation
- Auto: deterministic whole-word description match with a high bar — distinct `name` plus `description` words (length 3 or more, stopwords dropped) appearing as whole message words, at least 3 hits, best score first, at most 1 skill per turn. Auto loads Tier 2 only (body without inlined references, truncated at 12KB with a read pointer). `disable-model-invocation` skills never match. See `matchSkills` in `src/skills.ts`
- Deny rules still win over skill grants. See [Permissions](permissions.md)

Grant trust (`skillGrantsFor` in `src/policy.ts`, covered by `tests/policy.test.ts`): global skills live under your own `~/.claude|~/.agents`, so their `allowed-tools` arm turn-scoped auto-approvals as before. Project skills live in repo content — possibly a cloned repo you have never audited — so they never arm grants: sensitive names (`write`/`edit`/`bash`) are announced as still-needing-approval, everything else behaves identically (read-only tools auto-run either way, nothing functional is lost).

## Authoring checklist

1. Create `.claude/skills/<name>/SKILL.md` (or `.agents/skills/<name>/SKILL.md`) with `name` and `description`
2. Keep the body self-contained; reference large helpers via `references/...` so they inline only when needed
3. Declare least-privilege `allowed-tools`
4. Set `user-invocable: false` for auto-only helpers, `disable-model-invocation: true` for manual-only helpers
5. Verify with `/skills` listing plus `tests/skills*.test.ts` patterns
