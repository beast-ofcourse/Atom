// Phase 2 item 2.3 — ATOM_DOCK flag plumbing (no visual change by default).
//
// Strict check: only the exact string "1" enables the dock. Unset, "0", and
// any other value render the legacy footer byte-identically.

export function isDockEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ATOM_DOCK === "1";
}
