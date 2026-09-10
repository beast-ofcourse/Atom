// Local tool executors for the Ink chatbot's OpenAI-style function-calling loop.
// Node builtins + global fetch only. Every executor returns a string and
// NEVER throws across the tool boundary: failures come back as "Error: ..."
// strings so the model can see and react to them.
//
// Organization: one responsibility per module under src/tools/ (shared kernel,
// overflow spills, read fingerprints, filesystem/search/shell/web/todo
// executors, and the registry that owns names, validation, and dispatch).
// This file is a pure barrel so every existing `from "./tools.js"` /
// `"../src/tools.js"` import keeps working untouched.
export * from "./tools/filesystem.js";
export * from "./tools/fingerprints.js";
export * from "./tools/dir-cache.js";
export * from "./tools/overflow.js";
export * from "./tools/read-cache.js";
export * from "./tools/registry.js";
export * from "./tools/search.js";
export * from "./tools/shared.js";
export * from "./tools/shell.js";
export * from "./tools/todo.js";
export * from "./tools/web.js";
