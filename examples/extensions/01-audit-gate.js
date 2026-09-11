// 01-audit-gate — destructive-command audit gate.
//
// Blocks risky shell commands BEFORE they run. The returned reason commits
// as the normal model-visible result (approval is skipped, the turn
// continues); anything this hook does not block runs untouched.
//
// Gallery sample for documentation/extensions.md — that guide references
// this file by name and never duplicates it. Covered by
// tests/extension-gallery.test.ts, which loads this exact file through the
// real loadExtensions path.
module.exports = function auditGate(api) {
  api.onBeforeToolCall(({ name, args }) => {
    if (name !== "bash") return;
    const command = String(args?.command ?? "");
    const DESTRUCTIVE = ["rm -rf /", "rm -rf ~", "rm -rf .", "mkfs", ":(){:|:&};:"];
    if (DESTRUCTIVE.some((sig) => command.includes(sig))) {
      return {
        block:
          "destructive shell commands need explicit confirmation — " +
          "narrow the command or confirm it with the user first",
      };
    }
  });
};
