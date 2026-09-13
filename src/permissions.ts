// Scoped allow/deny rules for tool approval (ticket 03).
// Pure module: pattern matching over tool name + arguments. No UI imports.
//
// Rule syntax: `tool` or `tool:glob`
//   - `write`            matches any write call (tool-only rule)
//   - `bash:npm test*`   matches bash calls whose command starts with "npm test"
//   - `write:src/**`     matches writes under src/
//   - `my-mcp*`          matches every tool whose NAME starts with "my-mcp"
//                        (both the tool part and the glob part accept the
//                        `*`/`?` dialect below, so one rule allowlists a whole
//                        MCP server's `<server>_<tool>` family)
// The glob applies to the tool's primary string (the same primary shown in
// the `⚙` audit line): path for read/write/edit, pattern for glob/grep,
// command for bash, url/query for webfetch/websearch, taskId for
// bash_output, question for ask_question. MCP server tools (and any other
// tool without a primary) read as "": a `name:*` glob or a tool-only rule
// matches them; use `serverprefix_*` tool patterns to scope a whole server.
// Glob dialect: `*` matches any sequence (including `/` and spaces), `?`
// matches exactly one char, everything else is literal. Case-sensitive.
//
// Effect is decided at the approve() call site (App.tsx): deny is checked
// first and wins over yolo/session-trust/always/skill grants; allow runs the
// call without prompting. With no rules the verdict is null and the existing
// y/a/n + /trust flow is byte-identical. Rules only take effect on
// approval-gated calls (write/edit/bash) because read-only tools never
// consult approve() — a rule naming another tool is accepted but inert.

export type RuleKind = "allow" | "deny";

export type PermissionRule = {
  kind: RuleKind;
  /** Tool name, e.g. "bash". */
  tool: string;
  /** Glob over the primary string, or null for a tool-only rule. */
  glob: string | null;
  /** Original pattern text as typed (for list output). */
  pattern: string;
};

export type RuleVerdict = "allow" | "deny" | null;

// Parse one user-typed pattern (`tool` or `tool:glob`). Returns null when the
// pattern has no usable tool name (empty, whitespace, or a colon first).
export function parseRuleInput(pattern: string, kind: RuleKind): PermissionRule | null {
  const raw = pattern.trim();
  if (raw.length === 0) return null;
  const colon = raw.indexOf(":");
  const tool = (colon === -1 ? raw : raw.slice(0, colon)).trim();
  // Tool names are lowercase tokens, but either side may carry the `*`/`?`
  // glob dialect (e.g. `my-mcp*` scopes a whole MCP server family);
  // anything else is a typo worth rejecting loudly rather than a rule that
  // silently never matches.
  if (!/^[a-z0-9_*?-]+$/.test(tool)) return null;
  let glob: string | null = null;
  if (colon !== -1) {
    const rest = raw.slice(colon + 1).trim();
    glob = rest.length > 0 ? rest : null;
  }
  return { kind, tool, glob, pattern: tool + (glob === null ? "" : `:${glob}`) };
}

// Glob match: `*` = any sequence, `?` = one char, else literal.
// Case-sensitive (commands and paths are). Empty pattern matches only "".
export function matchGlob(pattern: string, value: string): boolean {
  let px = 0;
  let vx = 0;
  let star = -1;
  let starVx = 0;
  while (vx < value.length) {
    const p = pattern[px];
    if (px < pattern.length && (p === "?" || p === value[vx])) {
      px += 1;
      vx += 1;
    } else if (px < pattern.length && p === "*") {
      star = px;
      starVx = vx;
      px += 1;
    } else if (star !== -1) {
      starVx += 1;
      vx = starVx;
      px = star + 1;
    } else {
      return false;
    }
  }
  while (px < pattern.length && pattern[px] === "*") px += 1;
  return px === pattern.length;
}

// Primary string for a tool call: the same primary describeToolCall shows in
// the `⚙` audit line, so what you allow is what you see. Non-string or
// missing primaries read as "" (a glob can still match "" explicitly, e.g.
// `*` — a tool-only rule is the clearer way to say "any").
export function primaryTarget(name: string, args: Record<string, unknown>): string {
  const a = args ?? {};
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return str(a["path"]);
    case "glob":
    case "grep":
      return str(a["pattern"]);
    case "bash":
      return str(a["command"]);
    case "bash_output":
      return str(a["taskId"]);
    case "webfetch":
      return str(a["url"]);
    case "websearch":
      return str(a["query"]);
    case "ask_question":
      return str(a["question"]);
    default:
      return "";
  }
}

function ruleMatches(rule: PermissionRule, name: string, args: Record<string, unknown>): boolean {
  // The tool part is a glob over the tool NAME (exact names match exactly —
  // matchGlob without wildcards is equality — so `write` never matches
  // `writer`, while `my-mcp*` covers a whole MCP server family).
  if (!matchGlob(rule.tool, name)) return false;
  if (rule.glob === null) return true;
  return matchGlob(rule.glob, primaryTarget(name, args));
}

// First deny match wins (even over allows and over trust/yolo at the call
// site); otherwise the first allow match auto-approves; otherwise null
// (fall through to the normal prompt flow).
export function checkRules(
  rules: PermissionRule[],
  name: string,
  args: Record<string, unknown>
): RuleVerdict {
  for (const rule of rules) {
    if (rule.kind === "deny" && ruleMatches(rule, name, args)) return "deny";
  }
  for (const rule of rules) {
    if (rule.kind === "allow" && ruleMatches(rule, name, args)) return "allow";
  }
  return null;
}

export function formatRule(rule: PermissionRule): string {
  return `${rule.kind === "allow" ? "allow" : "deny"}: ${rule.pattern}`;
}

export function formatRules(rules: PermissionRule[]): string {
  if (rules.length === 0) return "(no rules)";
  return `Rules (${rules.length}):\n${rules.map((r, i) => `${i + 1}. ${formatRule(r)}`).join("\n")}`;
}
