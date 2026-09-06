// Local tool executors for the Ink chatbot's OpenAI-style function-calling loop.
// Node builtins only (fs/promises, path, child_process). Every executor
// returns a string and NEVER throws across the tool boundary: failures come
// back as "Error: ..." strings so the model can see and react to them.

import { exec } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as path from "node:path";

export const MAX_TOOL_STEPS = 10;
// Permission classes for the normal/yolo modes (see App + zen loop).
// Read-only tools auto-execute in every mode; approval tools (write/edit/
// bash) pause for user approval in `normal` mode and run immediately in
// `yolo` mode. ask_question never needs approval (it IS user interaction).
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob"]);
export const APPROVAL_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

export function needsApproval(name: string): boolean {
  return APPROVAL_TOOLS.has(name);
}
const READ_CHAR_CAP = 64 * 1024;
const OUTPUT_CAP = 8 * 1024;
const GREP_MATCH_CAP = 100;
const GLOB_MATCH_CAP = 200;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function err(msg: string): string {
  return `Error: ${msg}`;
}

// Resolve a user-supplied path against cwd. Absolute paths and escapes
// outside cwd are rejected with an error string (sandbox).
export function resolveSandbox(
  p: unknown,
  cwd: string = process.cwd()
): { abs?: string; error?: string } {
  if (typeof p !== "string" || p.length === 0) {
    return { error: "Error: path must be a non-empty string" };
  }
  if (p.includes("\0")) return { error: "Error: invalid path" };
  if (path.isAbsolute(p)) {
    return { error: `Error: absolute paths are not allowed (sandboxed to ${cwd}): ${p}` };
  }
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) {
    return { error: `Error: path escapes the working directory: ${p}` };
  }
  return { abs };
}

export type ReadArgs = { path: string; offset?: number; limit?: number };

// offset/limit are 1-based line numbers. Output capped at ~64KB.
export async function readTool(args: ReadArgs, cwd: string = process.cwd()): Promise<string> {
  try {
    const r = resolveSandbox(args?.path, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad path");
    let st;
    try {
      st = await fsp.stat(r.abs);
    } catch {
      return err(`no such file or directory: ${args.path}`);
    }
    if (st.isDirectory()) {
      const entries = await fsp.readdir(r.abs, { withFileTypes: true });
      const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return `Directory listing for ${args.path}:\n${lines.join("\n")}`;
    }
    let text: string;
    try {
      text = await fsp.readFile(r.abs, "utf8");
    } catch {
      return err(`cannot read file: ${args.path}`);
    }
    const offset = Math.max(1, Math.floor(args.offset ?? 1));
    const limit = Math.max(1, Math.floor(args.limit ?? Number.MAX_SAFE_INTEGER));
    let out = text.split("\n").slice(offset - 1, offset - 1 + limit).join("\n");
    if (out.length > READ_CHAR_CAP) {
      out = out.slice(0, READ_CHAR_CAP) + "\n[truncated: output exceeded 64KB]";
    }
    return out;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export type WriteArgs = { path: string; content: string };

export async function writeTool(args: WriteArgs, cwd: string = process.cwd()): Promise<string> {
  try {
    const r = resolveSandbox(args?.path, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad path");
    if (typeof args.content !== "string") return err("content must be a string");
    await fsp.mkdir(path.dirname(r.abs), { recursive: true });
    await fsp.writeFile(r.abs, args.content, "utf8");
    return `Wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export type EditArgs = { path: string; oldString: string; newString: string; replaceAll?: boolean };

export async function editTool(args: EditArgs, cwd: string = process.cwd()): Promise<string> {
  try {
    const r = resolveSandbox(args?.path, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad path");
    if (typeof args.oldString !== "string" || args.oldString.length === 0) {
      return err("oldString must be a non-empty string");
    }
    if (typeof args.newString !== "string") return err("newString must be a string");
    let text: string;
    try {
      text = await fsp.readFile(r.abs, "utf8");
    } catch {
      return err(`no such file or directory: ${args.path}`);
    }
    const count = text.split(args.oldString).length - 1;
    if (count === 0) return err(`no match for oldString in ${args.path}`);
    if (count > 1 && !args.replaceAll) {
      return err(`oldString matches ${count} times in ${args.path}; pass replaceAll=true to replace all`);
    }
    const next =
      args.replaceAll
        ? text.split(args.oldString).join(args.newString)
        : text.replace(args.oldString, args.newString);
    await fsp.writeFile(r.abs, next, "utf8");
    return `Edited ${args.path}: replaced ${args.replaceAll ? count : 1} occurrence(s)`;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// Minimal glob matcher: supports **, **/, *, ?. Used for grep `include`
// and the glob tool. Patterns without a slash match the basename.
function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more directories; bare "**" matches all.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesGlob(pattern: string, relPosix: string): boolean {
  const norm = pattern.replace(/\\/g, "/");
  if (!norm.includes("/")) {
    const base = relPosix.slice(relPosix.lastIndexOf("/") + 1);
    return globToRegExp(norm).test(base);
  }
  return globToRegExp(norm).test(relPosix);
}

async function walkFiles(absDir: string, cwd: string, out: string[]): Promise<void> {
  const entries = await fsp.readdir(absDir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(absDir, e.name);
    if (e.isDirectory()) {
      await walkFiles(full, cwd, out);
    } else if (e.isFile()) {
      out.push(path.relative(cwd, full).split(path.sep).join("/"));
    }
  }
}

export type GrepArgs = { pattern: string; include?: string; dir?: string };

// Line-regex search under dir (default "."). `include` is a glob like
// "*.ts". Returns "file:line: text" lines, capped at 100 matches.
export async function grepTool(args: GrepArgs, cwd: string = process.cwd()): Promise<string> {
  try {
    if (typeof args?.pattern !== "string") return err("pattern must be a string");
    let re: RegExp;
    try {
      re = new RegExp(args.pattern);
    } catch {
      return err(`invalid regex: ${args.pattern}`);
    }
    const dir = args.dir ?? ".";
    const r = resolveSandbox(dir, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad dir");
    let st;
    try {
      st = await fsp.stat(r.abs);
    } catch {
      return err(`no such directory: ${dir}`);
    }
    if (!st.isDirectory()) return err(`not a directory: ${dir}`);
    const files: string[] = [];
    await walkFiles(r.abs, cwd, files);
    const include = typeof args.include === "string" && args.include.length > 0 ? args.include : null;
    const hits: string[] = [];
    for (const rel of files.sort()) {
      if (include && !matchesGlob(include, rel)) continue;
      let text: string;
      try {
        text = await fsp.readFile(path.resolve(cwd, rel), "utf8");
      } catch {
        continue; // unreadable/binary — skip
      }
      if (text.includes("\0")) continue; // binary — skip
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        let line: string;
        try {
          if (!re.test(lines[i]!)) continue;
          line = lines[i]!;
        } catch {
          return err(`regex failed on input: ${args.pattern}`);
        }
        // Reset lastIndex in case the pattern is global/sticky.
        re.lastIndex = 0;
        hits.push(`${rel}:${i + 1}: ${line.length > 200 ? line.slice(0, 200) + "…" : line}`);
        if (hits.length >= GREP_MATCH_CAP) {
          return hits.join("\n") + "\n[truncated: more than 100 matches]";
        }
      }
    }
    return hits.length > 0 ? hits.join("\n") : "No matches.";
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export type GlobArgs = { pattern: string; dir?: string };

// List paths matching pattern under dir, capped at 200.
export async function globTool(args: GlobArgs, cwd: string = process.cwd()): Promise<string> {
  try {
    if (typeof args?.pattern !== "string" || args.pattern.length === 0) {
      return err("pattern must be a non-empty string");
    }
    const dir = args.dir ?? ".";
    const r = resolveSandbox(dir, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad dir");
    let st;
    try {
      st = await fsp.stat(r.abs);
    } catch {
      return err(`no such directory: ${dir}`);
    }
    if (!st.isDirectory()) return err(`not a directory: ${dir}`);
    const files: string[] = [];
    await walkFiles(r.abs, cwd, files);
    const matched = files.sort().filter((rel) => matchesGlob(args.pattern, rel));
    const capped = matched.slice(0, GLOB_MATCH_CAP);
    let out = capped.length > 0 ? capped.join("\n") : "No matches.";
    if (matched.length > GLOB_MATCH_CAP) out += "\n[truncated: more than 200 matches]";
    return out;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export type BashArgs = { command: string; timeoutMs?: number };

export type AskQuestionArgs = {
  question: string;
  options: string[];
  allowCustom?: boolean;
};

// Shared validation for ask_question args (used by executeTool and the
// agentic loop). Returns an error string, or null when valid.
export function validateAskQuestionArgs(args: Record<string, unknown>): string | null {
  const q = args as unknown as AskQuestionArgs;
  if (typeof q?.question !== "string" || q.question.trim().length === 0) {
    return err("question must be a non-empty string");
  }
  if (
    !Array.isArray(q?.options) ||
    q.options.length < 2 ||
    !q.options.every((o) => typeof o === "string" && o.length > 0)
  ) {
    return err("options must be an array of at least 2 strings");
  }
  return null;
}
// Run in the system shell with cwd=process.cwd() (or the caller's cwd),
// stdin closed. stdout/stderr each truncated to ~8KB. Returns JSON:
// {"exitCode": number, "stdout": string, "stderr": string, ...}.
// No sandbox beyond cwd+timeout+truncation — the model must treat this
// as a privileged operation.
export function bashTool(args: BashArgs, cwd: string = process.cwd()): Promise<string> {
  if (typeof args?.command !== "string" || args.command.trim().length === 0) {
    return Promise.resolve(err("command must be a non-empty string"));
  }
  const timeoutMs = Math.min(Math.max(Math.floor(args.timeoutMs ?? 60000), 1), 120000);
  return new Promise((resolve) => {
    exec(args.command, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      try {
        const e = error as (Error & { code?: unknown; killed?: boolean }) | null;
        const exitCode = e ? (typeof e.code === "number" ? e.code : 1) : 0;
        let out: string = typeof stdout === "string" ? stdout : String(stdout ?? "");
        let errText: string = typeof stderr === "string" ? stderr : String(stderr ?? "");
        let stdoutTruncated = false;
        let stderrTruncated = false;
        if (out.length > OUTPUT_CAP) {
          out = out.slice(0, OUTPUT_CAP) + "\n[truncated: stdout exceeded 8KB]";
          stdoutTruncated = true;
        }
        if (errText.length > OUTPUT_CAP) {
          errText = errText.slice(0, OUTPUT_CAP) + "\n[truncated: stderr exceeded 8KB]";
          stderrTruncated = true;
        }
        resolve(
          JSON.stringify({
            exitCode,
            stdout: out,
            stderr: errText,
            timedOut: e?.killed === true,
            stdoutTruncated,
            stderrTruncated,
          })
        );
      } catch (ex) {
        resolve(err(ex instanceof Error ? ex.message : String(ex)));
      }
    });
  });
}

// Dispatch by function name. Unknown tools and JSON-level failures are
// error strings, never throws.
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string = process.cwd()
): Promise<string> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read":
      return readTool(a as unknown as ReadArgs, cwd);
    case "write":
      return writeTool(a as unknown as WriteArgs, cwd);
    case "glob":
      return globTool(a as unknown as GlobArgs, cwd);
    case "grep":
      return grepTool(a as unknown as GrepArgs, cwd);
    case "edit":
      return editTool(a as unknown as EditArgs, cwd);
    case "bash":
      return bashTool(a as unknown as BashArgs, cwd);
    case "ask_question": {
      // No UI hook at this layer: the agentic loop intercepts ask_question
      // and serves it via its askUser hook. Direct calls validate, then
      // report the missing hook as a result string (never throw).
      const invalid = validateAskQuestionArgs(a);
      if (invalid) return invalid;
      return err("ask_question has no UI hook");
    }
    default:
      return err(`unknown tool: ${name}`);
  }
}

// One-line TUI label for a tool call, e.g. "⚙ read src/zen.ts".
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return `⚙ ${name} ${str(a["path"]) || "(no path)"}`.trim();
    case "glob":
      return `⚙ glob ${str(a["pattern"]) || "(no pattern)"}`.trim();
    case "grep":
      return `⚙ grep ${str(a["pattern"]) || "(no pattern)"}${a["include"] ? ` ${String(a["include"])}` : ""}`.trim();
    case "bash": {
      const cmd = str(a["command"]) || "(no command)";
      return `⚙ bash ${cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd}`.trim();
    }
    case "ask_question": {
      const q = str(a["question"]) || "(no question)";
      return `⚙ ask_question ${q.length > 80 ? q.slice(0, 80) + "…" : q}`.trim();
    }
    default:
      return `⚙ ${name}`;
  }
}

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

// OpenAI-style function schemas sent as `tools` on the chat POST.
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Read a UTF-8 text file (optional 1-based offset/limit line window) or list a directory. Paths are relative to the working directory; absolute paths and ../ escapes are rejected. Output capped at ~64KB.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file or directory path." },
          offset: { type: "number", description: "1-based first line to return (files only)." },
          limit: { type: "number", description: "Max lines to return (files only)." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description:
        "Create or overwrite a file with the given content (parents created). Path must be relative and inside the working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative destination path." },
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description:
        "Exact-match string replace in a file. Fails when oldString matches 0 times, or more than once unless replaceAll is true. Read the file first.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path." },
          oldString: { type: "string", description: "Exact text to find." },
          newString: { type: "string", description: "Replacement text." },
          replaceAll: { type: "boolean", description: "Replace all matches (default false)." },
        },
        required: ["path", "oldString", "newString"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search files under dir (default '.') for lines matching a JS regex. include is a glob like '*.ts'. Capped at 100 matches as 'file:line: text' lines.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regex source." },
          include: { type: "string", description: "Glob filter, e.g. '*.ts'." },
          dir: { type: "string", description: "Relative directory to search." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "List paths matching a glob (supports *, ?, **) under dir (default '.'). A pattern without a slash matches basenames at any depth. Capped at 200.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'." },
          dir: { type: "string", description: "Relative directory to search." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command with cwd=working directory, stdin closed; stdout/stderr truncated to ~8KB each. PRIVILEGED: no sandbox beyond cwd+timeout — prefer read/write/edit/grep/glob, and never run destructive or exfiltrating commands without explicit user approval.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
          timeoutMs: { type: "number", description: "Timeout in ms (default 60000, max 120000)." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_question",
      description:
        "Ask the user a clarifying question with 2+ options (interactive picker in the TUI: arrows+Enter to pick, Esc cancels, typing submits custom text when allowCustom is true). The pick returns as JSON {\"answer\": \"<selected>\"}. Use for genuine clarifications that unblock the work.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask the user." },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            description: "At least 2 options the user can pick from.",
          },
          allowCustom: {
            type: "boolean",
            description: "When true, the user may also type a custom answer.",
          },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    },
  },
];

// One-line summaries for the /tools command (single source of truth for
// the tool list shown in the TUI).
export const TOOL_ONE_LINERS: Record<string, string> = {
  read: "Read a file or list a directory.",
  write: "Create or overwrite a file.",
  edit: "Exact-match replace in a file.",
  grep: "Search files for a regex.",
  glob: "List paths matching a glob.",
  bash: "Run a shell command (privileged).",
  ask_question: "Ask the user to pick an option.",
};
