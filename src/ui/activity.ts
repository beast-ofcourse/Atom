// Working-state activity model: what is ATOM doing right now, in words.
//
// Pure data layer (no JSX) mapping loop signals to human activity lines:
// - thinking: busy with no tokens, thinking text, or tool yet (the gap
//   between submit and first output — previously silent in the live zone).
// - tool: a tool call is executing; the audit label (`⚙ name target`)
//   becomes a present-participle line (`Reading src/x.ts`).
// - streaming/thinking-text: carried by the draft/thinking blocks, so no
//   activity line competes with them (noise discipline).
// - approval/question: carried by their modals + a status-bar segment.
// - completed/failed/cancelled: carried by the reply, error, and
//   `(cancelled)` lines — no extra outcome chrome.
//
// Liveness proof is honest elapsed seconds on the 1s busy tick, never a
// fake spinner: an animated glyph would need extra timers and redraws for
// zero information, and 1fps frame-stepping reads as broken, not alive.
export const TOOL_VERBS: Record<string, string> = {
  read: "Reading",
  write: "Writing",
  edit: "Editing",
  grep: "Searching",
  glob: "Finding",
  bash: "Running",
  bash_output: "Checking",
  webfetch: "Fetching",
  websearch: "Searching",
  todowrite: "Planning",
  todo_update: "Updating",
  todo_get: "Loading",
  ask_question: "Asking",
};

export type Activity =
  | { kind: "thinking" }
  | { kind: "tool"; name: string; target: string }
  | { kind: "none" };

// The live hint is either a bare tool name (onToolDelta) or a full audit
// label (onPhase detail); both reduce to name + target.
export function parseActivityHint(hint: string): { name: string; target: string } {
  const stripped = hint.replace(/^⚙\s*/, "").trim();
  const space = stripped.indexOf(" ");
  if (space === -1) return { name: stripped, target: "" };
  return { name: stripped.slice(0, space), target: stripped.slice(space + 1).trim() };
}

export function activityVerb(name: string): string | null {
  return TOOL_VERBS[name] ?? null;
}

// One line for the running tool, e.g. `Reading src/zen.ts` or — for tools
// with no verb mapping — the bare `name target` (never a mangled guess).
export function activityText(hint: string): string {
  const { name, target } = parseActivityHint(hint);
  const verb = activityVerb(name);
  const action = verb ?? name;
  return target ? `${action} ${target}` : action;
}
