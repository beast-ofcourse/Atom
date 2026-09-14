// Shell mode helper — pure logic for the `!` shell trigger (06 parity slice 2).
// Matches opencode: `!` at offset 0 when mode==="normal" && no picker/autocomplete/modal/busy owns keyboard
// enters shell mode; placeholder changes to "Run a command…", status shows SHELL.

export const SHELL_PLACEHOLDER = "Run a command\u2026";

// Strip a single leading `!` used to enter shell mode. Keeps remainder verbatim
// (including leading spaces after !? — the trigger is exactly one `!` at 0, so
// `!echo hi` → `echo hi`, `!` → ``).
export function stripShellBang(text: string): string {
  return text.startsWith("!") ? text.slice(1) : text;
}
