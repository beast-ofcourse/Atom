// Canonical diff engine lives in src/diff-engine.ts — this module re-exports
// it so existing UI/web/registry/test imports (`src/ui/diff.ts`) keep working
// without duplication. Keep diff-engine as the single source of truth.
export * from "../diff-engine.js";
