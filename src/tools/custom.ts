// Extension-registered model-callable tools (ticket 02): the runtime store
// behind ExtensionAPI.registerTool. This module stays dependency-free apart
// from the sibling overrides store (which itself imports nothing), so the
// registry and the scheduler can still consult it without a runtime cycle.
import { isToolExecutionMode, type ToolExecutionMode } from "./overrides.js";
//
// A custom tool behaves like a builtin from the model's perspective: it has
// a name, a description, an OpenAI-style parameters schema, and an execute
// function. It deliberately carries NO scheduler effect metadata, so the
// planner fails safe to a serial singleton (see scheduler.ts) — an
// invisible footprint is never batched. The optional executionMode hint
// (ticket 06) only ever ADDS serialization: "sequential" forces the whole
// sibling batch one-at-a-time; "parallel" is advisory and changes nothing
// today (custom tools stay serial singletons either way).
export type CustomToolContext = {
  /** Working directory the tool call executes against (loop-provided). */
  cwd: string;
};

export type CustomToolExecute = (
  args: Record<string, unknown>,
  ctx: CustomToolContext
) => string | Promise<string>;

/** Registration shape an extension passes to api.registerTool. */
export type ExtensionToolDefinition = {
  /** Tool name as the model sees it: [A-Za-z0-9_-]{1,64}, no spaces. */
  name: string;
  /** One-paragraph description sent in the tool definitions. */
  description: string;
  /** OpenAI-style parameters schema (must be an object with type "object"). */
  parameters: Record<string, unknown>;
  /** Implementation: receives validated args, returns the model-visible result. */
  execute: CustomToolExecute;
  /**
   * Approval opt-out. Defaults to true (require approval): extension code
   * runs with full user privileges and its footprint is invisible to the
   * scheduler, so fail-closed is the only safe default. Set false only for
   * pure, side-effect-free helpers.
   */
  requireApproval?: boolean;
  /** One-line summary for the /tools list; defaults to the description head. */
  oneLiner?: string;
  /**
   * Scheduling hint (ticket 06). "sequential" forces the tool's whole
   * sibling batch to run one-at-a-time; "parallel" is advisory and changes
   * nothing today (the tool itself still runs as a serial singleton).
   */
  executionMode?: ToolExecutionMode;
};

export type CustomToolRecord = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: CustomToolExecute;
  requireApproval: boolean;
  oneLiner: string | null;
  executionMode: ToolExecutionMode | undefined;
};

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const store = new Map<string, CustomToolRecord>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeSummary(parameters: Record<string, unknown>): string {
  // Compact `{field: type}` hint for error details; falls back to raw JSON.
  try {
    const props = parameters["properties"];
    if (isRecord(props)) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(props)) {
        const t = isRecord(v) && typeof v["type"] === "string" ? (v["type"] as string) : "any";
        parts.push(`"${k}": ${t}`);
      }
      const required = Array.isArray(parameters["required"])
        ? ` (required: ${(parameters["required"] as unknown[]).map((r) => JSON.stringify(r)).join(", ")})`
        : "";
      return `{${parts.join(", ")}}${required}`;
    }
    const raw = JSON.stringify(parameters);
    return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  } catch {
    return "{}";
  }
}

/**
 * Validate a registration shape. Throws Error on any problem (bad name,
 * empty description, non-object schema, non-function execute). Duplicate
 * and builtin-collision checks live in the registry wrapper
 * (registerExtensionTool), which knows the builtin names.
 */
export function validateExtensionToolDef(def: ExtensionToolDefinition): void {
  if (!isRecord(def)) throw new Error("extension tool definition must be an object");
  if (typeof def.name !== "string" || !NAME_RE.test(def.name)) {
    throw new Error(
      `extension tool has an invalid name ${JSON.stringify(def.name)} (want 1-64 chars of A-Za-z0-9_-)`
    );
  }
  if (typeof def.description !== "string" || def.description.trim().length === 0) {
    throw new Error(`extension tool "${def.name}" needs a non-empty description`);
  }
  if (!isRecord(def.parameters) || def.parameters["type"] !== "object") {
    throw new Error(`extension tool "${def.name}" needs a parameters schema object with type "object"`);
  }
  if (typeof def.execute !== "function") {
    throw new Error(`extension tool "${def.name}" needs an execute function`);
  }
  if (def.requireApproval !== undefined && typeof def.requireApproval !== "boolean") {
    throw new Error(`extension tool "${def.name}" field "requireApproval" must be a boolean`);
  }
  if (def.oneLiner !== undefined && typeof def.oneLiner !== "string") {
    throw new Error(`extension tool "${def.name}" field "oneLiner" must be a string`);
  }
  if (def.executionMode !== undefined && !isToolExecutionMode(def.executionMode)) {
    throw new Error(`extension tool "${def.name}" field "executionMode" must be "sequential" or "parallel"`);
  }
}

function typeLabel(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function schemaTypeMatches(schema: Record<string, unknown>, value: unknown): boolean {
  const t = schema["type"];
  if (typeof t !== "string") return true; // untyped property: anything goes
  switch (t) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "null":
      return value === null;
    default:
      return true; // unknown type keyword: do not reject
  }
}

// Validate parsed args against the tool's parameters schema. Returns a
// detail string (without prefix) when malformed, or null when valid — the
// caller frames it with invalidCall so failures surface as inline
// model-visible errors and the tool never runs.
export function validateCustomToolArgs(
  name: string,
  args: Record<string, unknown>
): string | null {
  const rec = store.get(name);
  if (!rec) return null;
  if (!isRecord(args)) {
    return `arguments for tool "${name}" must be an object. Expected ${shapeSummary(rec.parameters)}`;
  }
  const exp = shapeSummary(rec.parameters);
  const schema = rec.parameters;
  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key !== "string") continue;
      if (args[key] === undefined) {
        return `missing required field "${key}" for tool "${name}". Expected ${exp}`;
      }
    }
  }
  const props = schema["properties"];
  if (isRecord(props)) {
    for (const [key, propSchema] of Object.entries(props)) {
      const value = args[key];
      if (value === undefined) continue;
      if (!isRecord(propSchema)) continue;
      if (!schemaTypeMatches(propSchema, value)) {
        const want = typeof propSchema["type"] === "string" ? (propSchema["type"] as string) : "matching value";
        return `field "${key}" for tool "${name}" must be a ${want} (got ${typeLabel(value)}). Expected ${exp}`;
      }
      const en = propSchema["enum"];
      if (Array.isArray(en) && !en.includes(value)) {
        return `field "${key}" for tool "${name}" must be one of ${JSON.stringify(en)} (got ${JSON.stringify(value)}). Expected ${exp}`;
      }
    }
  }
  if (schema["additionalProperties"] === false && isRecord(props)) {
    for (const key of Object.keys(args)) {
      if (!(key in props)) {
        return `unknown field "${key}" for tool "${name}". Expected ${exp}`;
      }
    }
  }
  return null;
}

/** Register a validated custom tool. Throws on duplicate names. */
export function registerCustomTool(def: ExtensionToolDefinition): () => void {
  validateExtensionToolDef(def);
  if (store.has(def.name)) {
    throw new Error(`extension tool "${def.name}" is already registered`);
  }
  const rec: CustomToolRecord = {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: def.execute,
    requireApproval: def.requireApproval ?? true,
    executionMode: def.executionMode,
    oneLiner:
      typeof def.oneLiner === "string" && def.oneLiner.length > 0
        ? def.oneLiner
        : def.description.split("\n")[0]!.slice(0, 120),
  };
  store.set(def.name, rec);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    if (store.get(def.name) === rec) store.delete(def.name);
  };
}

export function unregisterCustomTool(name: string): boolean {
  return store.delete(name);
}

export function getCustomTool(name: string): CustomToolRecord | undefined {
  return store.get(name);
}

export function isCustomTool(name: string): boolean {
  return store.has(name);
}

export function customToolNames(): string[] {
  return [...store.keys()];
}

export function listCustomTools(): CustomToolRecord[] {
  return [...store.values()];
}

/** Test seam: drop every custom tool (callers restore one-liners separately). */
export function clearCustomTools(): void {
  store.clear();
}
