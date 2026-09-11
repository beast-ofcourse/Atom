// 03-custom-command — custom slash command with a dialog.
//
// Registers a real `/gallery-plan` command: it asks the user to pick a
// target in a modal dialog, then posts the plan to the transcript. The
// workflow logic lives in the pure summarizeChoice helper (no modal, no
// transcript) so the dialog flow is testable headless — tests drive the
// command with a stub askUser and unit-test the helper directly.
//
// Gallery sample for documentation/extensions.md — that guide excerpts
// this file and references it by name. Covered by
// tests/extension-gallery.test.ts, which loads this exact file through the
// real loadExtensions path.
function summarizeChoice(choice, extra) {
  const scope = String(extra ?? "").trim();
  return scope.length > 0 ? `deploying to ${choice} (${scope})` : `deploying to ${choice}`;
}

function galleryCommand(api) {
  api.registerCommand({
    name: "gallery-plan",
    description: "Pick a deploy target and post the plan.",
    handler: async (ctx) => {
      const choice = await ctx.askUser("Which environment?", ["staging", "prod"]);
      const plan = summarizeChoice(choice, ctx.args);
      ctx.say(plan);
      return `plan posted for ${choice}`;
    },
  });
}

module.exports = galleryCommand;
module.exports.summarizeChoice = summarizeChoice;
