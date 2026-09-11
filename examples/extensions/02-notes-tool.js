// 02-notes-tool — model-callable notes tool.
//
// Registers a brand-new tool the model can call exactly like a builtin: it
// appears in the tool definitions, validates args inline (bad args are an
// `Error: invalid call: ...` result and the implementation never runs), and
// dispatches through the shared loop.
//
// Gallery sample for documentation/extensions.md — that guide references
// this file by name and never duplicates it. Covered by
// tests/extension-gallery.test.ts, which loads this exact file through the
// real loadExtensions path.
const notes = [];

module.exports = function notesTool(api) {
  api.registerTool({
    name: "gallery_notes",
    description: "Save a short note and read it back. Use it to remember user preferences across the turn.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (args) => {
      notes.push(String(args.text));
      return `saved note #${notes.length}: ${notes[notes.length - 1]}`;
    },
    // Pure, side-effect-free helper (in-memory only): safe to run without an
    // approval prompt. Anything with a real footprint keeps the default.
    requireApproval: false,
  });
};
