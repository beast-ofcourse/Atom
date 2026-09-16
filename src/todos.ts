// Re-export shim (todo-refactor 01): the single todo store owns all
// state, pure CRUD, and persistence helpers now. This path stays so
// existing importers (`./todos.js`) keep working untouched.
export * from "./todo-store.js";
