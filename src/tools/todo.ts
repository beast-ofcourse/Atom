// Re-export shim (todo-refactor 01): the single todo store owns all
// state and logic now. This path stays so existing importers
// (`./tools/todo.js`, the `src/tools.ts` barrel) keep working untouched.
export * from "../todo-store.js";
