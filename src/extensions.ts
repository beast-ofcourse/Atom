// Extension host skeleton (ticket 01): discovery, loading, lifecycle.
//
// An extension is a local .ts/.js file exporting a factory function that
// receives an ExtensionAPI and registers subscriptions. Loading is
// same-process dynamic import via jiti (TypeScript-capable, no sandbox):
// extension code runs with full user privileges, exactly like app code.
// The ONLY gate is install scope (global vs project dirs + explicit paths);
// trust enforcement arrives in a later ticket.
//
// Generations (stale-use rule): every session replacement (switch, /new,
// /resume) invalidates the runtime, bumping a generation counter. API
// objects captured before the bump throw on any further use; event handlers
// always receive a fresh, current-generation API. This makes
// use-after-replacement a loud error instead of a silent wrong-session bug.
//
// This module never throws out of loadExtensions: per-extension failures are
// recorded on the runtime. It never touches React, the TUI, or LLM clients.

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { createJiti } from "jiti";
import { atomDir } from "./auth.js";

export const EXTENSIONS_DIRNAME = "extensions";

// Extra extension paths from the environment (path.delimiter-separated).
// Explicit configuration; honored alongside the two discovered scopes.
export const EXTENSIONS_ENV = "ATOM_EXTENSIONS";

export type ExtensionEventName = "session_start" | "session_shutdown";

export type ExtensionEventInfo = {
  /** Startup, session switch, /new, /resume, reload, quit — open string for future reasons. */
  reason: string;
};

export type ExtensionEventHandler = (
  api: ExtensionAPI,
  info: ExtensionEventInfo
) => void | Promise<void>;

/** Minimal v1 capability surface. Later tickets extend this interface. */
export type ExtensionAPI = {
  /** Extension name (directory/file stem fallback, see resolveExtensionName). */
  readonly name: string;
  /**
   * Subscribe to a lifecycle event. Throws when called on a stale (pre-
   * replacement) API object. Returns an unsubscribe function.
   */
  on(event: ExtensionEventName, handler: ExtensionEventHandler): () => void;
};

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export type LoadedExtension = {
  /** Absolute path of the loaded entry file. */
  path: string;
  name: string;
};

export type ExtensionLoadError = {
  /** Absolute path (or attempted path) of the failed entry. */
  path: string;
  error: string;
};

export type ExtensionRuntime = {
  loaded: LoadedExtension[];
  errors: ExtensionLoadError[];
  /** Emit a lifecycle event to handlers in registration order; per-handler failures are recorded, never thrown. */
  emit(event: ExtensionEventName, info: ExtensionEventInfo): Promise<void>;
  /**
   * Invalidate all previously handed-out API objects (session replacement).
   * After this, any use of a captured API throws Error(message).
   */
  invalidate(message: string): void;
  /** Current generation (bumped by every invalidate). */
  generation: number;
};

type HandlerRecord = {
  extensionPath: string;
  handler: ExtensionEventHandler;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function globalExtensionsDir(home?: string): string {
  return path.join(atomDir(home), EXTENSIONS_DIRNAME);
}

export function projectExtensionsDir(cwd?: string): string {
  const base = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
  return path.join(base, ".atom", EXTENSIONS_DIRNAME);
}

const ENTRY_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);
const INDEX_BASENAMES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

function isEntryFile(name: string): boolean {
  return ENTRY_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Manifest field for extension-package subdirectories (mirrors the Pi `pi` field convention). */
function readAtomManifest(dir: string): string[] | null {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, "package.json"), "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const atom = data["atom"];
  if (!isRecord(atom)) return null;
  const extensions = atom["extensions"];
  if (!Array.isArray(extensions)) return null;
  const out: string[] = [];
  for (const e of extensions) {
    if (typeof e === "string" && e.length > 0) {
      out.push(path.resolve(dir, e));
    }
  }
  return out;
}

/** Resolve one discovered path to loadable entry files (no recursion beyond one level). */
function resolveEntries(entryPath: string): string[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(entryPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return isEntryFile(path.basename(entryPath)) ? [entryPath] : [];
  }
  if (!stat.isDirectory()) return [];
  const manifest = readAtomManifest(entryPath);
  if (manifest) return manifest;
  for (const base of INDEX_BASENAMES) {
    const candidate = path.join(entryPath, base);
    try {
      if (statSync(candidate).isFile()) return [candidate];
    } catch {
      // try next basename
    }
  }
  return [];
}

function discoverInDir(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of [...names].sort()) {
    if (name.startsWith(".")) continue;
    out.push(...resolveEntries(path.join(dir, name)));
  }
  return out;
}

export type DiscoverOptions = {
  home?: string;
  cwd?: string;
  /** Explicit extra paths (files or directories); highest precedence, listed last. */
  extraPaths?: string[];
};

/**
 * Ordered, deduplicated entry files: project scope, global scope, then
 * explicit paths (env ATOM_EXTENSIONS + extraPaths). Missing scopes are
 * silently skipped — never throws.
 */
export function discoverExtensionPaths(opts: DiscoverOptions = {}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (p: string): void => {
    const abs = path.resolve(p);
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  };
  for (const p of discoverInDir(projectExtensionsDir(opts.cwd))) push(p);
  for (const p of discoverInDir(globalExtensionsDir(opts.home))) push(p);
  const envRaw = process.env[EXTENSIONS_ENV];
  if (typeof envRaw === "string" && envRaw.length > 0) {
    for (const p of envRaw.split(path.delimiter)) {
      const trimmed = p.trim();
      if (trimmed.length === 0) continue;
      for (const e of resolveEntries(path.resolve(trimmed))) push(e);
    }
  }
  for (const p of opts.extraPaths ?? []) {
    for (const e of resolveEntries(path.resolve(p))) push(e);
  }
  return out;
}

export function resolveExtensionName(entryPath: string): string {
  const base = path.basename(entryPath);
  const stem = base.replace(/\.(ts|js|mjs|cjs)$/i, "");
  if (stem.toLowerCase() !== "index") return stem;
  const parent = path.basename(path.dirname(entryPath));
  return parent.length > 0 ? parent : stem;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "unknown error");
}

export type LoadOptions = DiscoverOptions & {
  /** Pre-resolved entry files (skips discovery when provided). */
  entryPaths?: string[];
};

let jitiInstance: ReturnType<typeof createJiti> | null = null;

function jiti(): ReturnType<typeof createJiti> {
  if (!jitiInstance) {
    jitiInstance = createJiti(import.meta.url);
  }
  return jitiInstance;
}

function resolveFactory(mod: unknown): ExtensionFactory | null {
  if (typeof mod === "function") return mod as ExtensionFactory;
  if (isRecord(mod)) {
    const def = (mod as { default?: unknown }).default;
    if (typeof def === "function") return def as ExtensionFactory;
  }
  return null;
}

/**
 * Load every discovered extension. Never throws: each failure is recorded
 * in runtime.errors with its path, and loading continues with the rest.
 */
export async function loadExtensions(opts: LoadOptions = {}): Promise<ExtensionRuntime> {
  const entryPaths = opts.entryPaths ?? discoverExtensionPaths(opts);
  const handlers = new Map<ExtensionEventName, HandlerRecord[]>();
  const loaded: LoadedExtension[] = [];
  const errors: ExtensionLoadError[] = [];
  let generation = 0;
  let staleMessage: string | null = null;

  const makeApi = (name: string, extensionPath: string): ExtensionAPI => {
    // Generation captured at creation: any use after a later invalidate
    // throws, while APIs minted fresh at emit time stay live.
    const apiGeneration = generation;
    const staleCheck = (): void => {
      if (apiGeneration !== generation) {
        throw new Error(staleMessage ?? "extension context is stale after a session replacement");
      }
    };
    return {
      name,
      on: (event, handler) => {
        staleCheck();
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": handler for "${event}" must be a function`);
        }
        let list = handlers.get(event);
        if (!list) {
          list = [];
          handlers.set(event, list);
        }
        const record: HandlerRecord = { extensionPath, handler };
        list.push(record);
        return () => {
          const current = handlers.get(event);
          if (!current) return;
          const idx = current.indexOf(record);
          if (idx >= 0) current.splice(idx, 1);
        };
      },
    };
  };

  const runtime: ExtensionRuntime = {
    loaded,
    errors,
    get generation() {
      return generation;
    },
    invalidate(message: string): void {
      staleMessage = message;
      generation += 1;
    },
    async emit(event, info): Promise<void> {
      const list = handlers.get(event) ?? [];
      for (const record of [...list]) {
        const api = makeApi(resolveExtensionName(record.extensionPath), record.extensionPath);
        try {
          await record.handler(api, info);
        } catch (e) {
          errors.push({ path: record.extensionPath, error: `${event} handler failed: ${errorText(e)}` });
        }
      }
    },
  };

  const importer = jiti();
  for (const entryPath of entryPaths) {
    const name = resolveExtensionName(entryPath);
    let mod: unknown;
    try {
      mod = await importer.import(entryPath, { default: true });
    } catch (e) {
      errors.push({ path: entryPath, error: `import failed: ${errorText(e)}` });
      continue;
    }
    const factory = resolveFactory(mod);
    if (!factory) {
      errors.push({ path: entryPath, error: "does not export a factory function (default export must be a function)" });
      continue;
    }
    // A factory that throws during activation fails alone: activation runs
    // before commit, so nothing from this extension is ever registered.
    const pendingHandlers: Array<{ event: ExtensionEventName; handler: ExtensionEventHandler }> = [];
    const activationGeneration = generation;
  const activationApi: ExtensionAPI = {
      name,
      on: (event, handler) => {
        if (activationGeneration !== generation) {
          throw new Error(staleMessage ?? "extension context is stale after a session replacement");
        }
        if (typeof handler !== "function") {
          throw new Error(`extension "${name}": handler for "${event}" must be a function`);
        }
        pendingHandlers.push({ event, handler });
        return () => {
          const idx = pendingHandlers.findIndex((p) => p.event === event && p.handler === handler);
          if (idx >= 0) pendingHandlers.splice(idx, 1);
        };
      },
    };
    try {
      await factory(activationApi);
    } catch (e) {
      errors.push({ path: entryPath, error: `activation failed: ${errorText(e)}` });
      continue;
    }
    // Commit: activation succeeded, registrations go live atomically.
    for (const p of pendingHandlers) {
      let list = handlers.get(p.event);
      if (!list) {
        list = [];
        handlers.set(p.event, list);
      }
      list.push({ extensionPath: entryPath, handler: p.handler });
    }
    loaded.push({ path: entryPath, name });
  }
  return runtime;
}
