# 1.5.8 — step-sequenced live TUI

## Version: 1.5.8

### Release prep

- Version bumped to 1.5.8 in `package.json` and `package-lock.json`
- Changelog entry added (`CHANGELOG.md`, 1.5.8 — 2026-09-23)
- Build verified (`npm run build`); pack list verified (`npm pack --dry-run`)
- Test status: typecheck clean; targeted suites green; full suite matches
  the known baseline (pre-existing timer/MutationObserver flakes only,
  proven identical at the pristine base)
- **🛑 HELD — not published.** Awaiting explicit approval before npm publish and GitHub release

### Step-sequenced live TUI

- **Ordered block model** (`src/ui/step-blocks.ts`): thinking/text/tool
  stream as per-step blocks in arrival order — interleaved thinking and
  text never fight over one lane; tool calls render running (name +
  elapsed) then flip to the audit line + output on completion
- **Per-block commit + collapse** (`src/App.tsx`, `src/ui/transcript.tsx`):
  finished blocks commit as own transcript turns in list order, each
  collapsible (default expanded) beside the global thinking toggle;
  single-lane freeze/pin machinery retired
- **Sequencing cleanup** (`src/ui/components/live-rows.tsx`,
  `src/ui/agent-adapter.ts`): one shared live tool row + speaker header,
  one block-to-turn owner for App and core paths, same-ref no-op paints,
  render benches cover multi-block streaming with gates green

### Publish checklist (on approval)

1. `git push origin main` — code already pushed; push the release-prep commit
2. `npm publish` (runs `prepublishOnly` → `npm run build`)
3. `gh release create v1.5.8 --title "1.5.8" --notes-file scripts/release-notes-1.5.8.md`
