// Phase 4 item 4.1 — dock default ON.
//
// Only the exact string "0" opts back to the legacy footer. Unset and any
// other value enable the dock.

export function isDockEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ATOM_DOCK !== "0";
}
