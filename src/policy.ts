// Policy / Security layer: explicit trust boundaries for a powerful local
// coding agent. Filesystem access and shell execution are INTENTIONAL
// capabilities (never silently removed); this module makes the decisions
// governing them explicit, testable, and centralized:
//
//   Tool request → decidePolicy() → approval if needed → execution
//
// Pure module (no I/O except injected resolvers, no UI): the App owns prompts
// and side effects, tools own execution. Covers three surfaces:
//
// 1. Approval decisions — one ordered rule (deny → plan → allow → yolo →
//    trust → always → skill grants → prompt) replacing the previously inline
//    if-chain in App.approve. Same order, same outcomes, now unit-tested.
// 2. Skill-grant trust — project-local skill content is untrusted: only
//    global (user-controlled) skills may arm turn-scoped tool grants.
//    Project skills never silently escalate to shell/filesystem/network.
// 3. Network zones + policy — SSRF surface for webfetch: every URL (initial
//    and every redirect hop) classifies into public/localhost/private/
//    link-local/blocked, gated by an explicit configurable policy.
// 4. Secret scrubbing — shell outputs pass through scrubSecrets so a pasted
//    or env-provided provider key echoed by a command never rides back to
//    the model (and into saved transcripts) verbatim.

import { checkRules, type PermissionRule, type RuleVerdict } from "./permissions.js";
import type { PermissionMode } from "./zen.js";
import type { SkillSource } from "./skills.js";

// ---- 1. Approval decisions ----

export type PolicyContext = {
  mode: PermissionMode;
  trustAll: boolean;
  rules: PermissionRule[];
  alwaysAllowed: ReadonlySet<string>;
  skillGrants: ReadonlySet<string>;
  // Whether this tool consults approval at all (write/edit/bash). Read-only
  // tools never reach the prompt; the plan passthrough only applies to
  // approval-gated ones.
  approvalGated: boolean;
};

export type PolicyOutcome =
  | { kind: "deny" }
  | {
      kind: "allow";
      via: "allow-rule" | "plan-passthrough" | "yolo" | "trust" | "always" | "skill-grant";
    }
  | { kind: "prompt" };

export function decidePolicy(
  name: string,
  args: Record<string, unknown>,
  ctx: PolicyContext
): PolicyOutcome {
  const verdict: RuleVerdict = checkRules(ctx.rules, name, args);
  // Deny wins over everything, including plan mode.
  if (verdict === "deny") return { kind: "deny" };
  // Plan mode is read-only: mutations skip the prompt and flow to the
  // execute gate, which refuses them pre-execution with a replan note.
  if (ctx.mode === "plan" && ctx.approvalGated) {
    return { kind: "allow", via: "plan-passthrough" };
  }
  if (verdict === "allow") return { kind: "allow", via: "allow-rule" };
  if (ctx.mode === "yolo") return { kind: "allow", via: "yolo" };
  if (ctx.trustAll) return { kind: "allow", via: "trust" };
  if (ctx.alwaysAllowed.has(name)) return { kind: "allow", via: "always" };
  if (ctx.skillGrants.has(name)) return { kind: "allow", via: "skill-grant" };
  return { kind: "prompt" };
}

// ---- 2. Skill-grant trust boundary ----

// Approval-gated tools: the dangerous capabilities a grant can unlock
// (shell, filesystem mutation; network/process execution ride bash).
export const SKILL_GRANT_SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "bash",
]);

export type SkillGrantDecision = {
  // Tool names armed as turn-scoped auto-approvals.
  grants: string[];
  // Sensitive tools refused because of source (for the visible notice).
  blocked: string[];
};

// Explicit trust policy (not a scattered special case):
// - global skills live under the user's own ~/.claude|~/.agents: user
//   controlled, so allowed-tools arm turn-scoped grants per existing policy.
// - project skills live in repo content, which may be untrusted (a cloned
//   repo's SKILL.md can declare anything): they NEVER arm grants. Approval
//   tools invoked under them prompt normally (or via /trust); read-only
//   tools auto-run regardless, so nothing functional is lost.
export function skillGrantsFor(
  source: SkillSource,
  allowedTools: string[]
): SkillGrantDecision {
  if (source === "global") return { grants: [...allowedTools], blocked: [] };
  return {
    grants: [],
    blocked: allowedTools.filter((t) => SKILL_GRANT_SENSITIVE_TOOLS.has(t)),
  };
}

// ---- 3. Network zones + policy ----

export type NetworkZone = "public" | "localhost" | "private" | "link-local" | "blocked";

export type NetworkPolicy = {
  allowPublic: boolean;
  allowLocalhost: boolean;
  allowPrivate: boolean;
  allowLinkLocal: boolean;
};

export function defaultNetworkPolicy(): NetworkPolicy {
  return {
    // ATOM is a local agent: public docs plus localhost dev servers stay
    // reachable; private LAN and link-local (cloud metadata) stay closed
    // until the owner opens them in atom.json.
    allowPublic: true,
    allowLocalhost: true,
    allowPrivate: false,
    allowLinkLocal: false,
  };
}

export function parseNetworkPolicy(raw: unknown): { policy: NetworkPolicy; warnings: string[] } {
  const policy = defaultNetworkPolicy();
  const warnings: string[] = [];
  if (raw === undefined) return { policy, warnings };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`network: must be an object — ignored`);
    return { policy, warnings };
  }
  const o = raw as Record<string, unknown>;
  (Object.keys(policy) as Array<keyof NetworkPolicy>).forEach((key) => {
    const v = o[key];
    if (v === undefined) return;
    if (typeof v !== "boolean") {
      warnings.push(`network: ignoring invalid "${key}" (must be a boolean)`);
      return;
    }
    policy[key] = v;
  });
  return { policy, warnings };
}

export function zoneAllows(zone: NetworkZone, policy: NetworkPolicy): boolean {
  switch (zone) {
    case "public":
      return policy.allowPublic;
    case "localhost":
      return policy.allowLocalhost;
    case "private":
      return policy.allowPrivate;
    case "link-local":
      return policy.allowLinkLocal;
    case "blocked":
      return false;
  }
}

// Redirect statuses followed manually (GET-only client, so 303's method
// rewrite is moot). Anything else with a Location is left alone.
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// Hostname → resolved addresses. Injected (not imported) so tests never
// touch real DNS; production passes the dns.lookup wrapper in tools.ts.
export type ResolveHost = (host: string) => Promise<string[]>;

// Fail-closed IP classifier (pure, no DNS). Returns "invalid" for anything
// unparseable — callers treat invalid as blocked.
export function classifyIp(raw: string): NetworkZone | "invalid" {
  let ip = raw.trim().toLowerCase();
  // Bracketed IPv6 literals as carried by URL.hostname.
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  // Zone IDs (fe80::1%eth0, encoded %25eth0) describe the interface, not the
  // address: classify the address part.
  const pct = ip.indexOf("%");
  if (pct !== -1) ip = ip.slice(0, pct);
  if (ip.includes(":")) return classifyIpv6(ip);
  return classifyIpv4(ip);
}

function parseDecOctet(part: string): number | null {
  if (!/^\d+$/.test(part)) return null;
  // Leading zeros would be octal to getaddrinfo ("010" = 8, "0177" = 127):
  // a strict decimal read could call 0177.0.0.1 public while the resolver
  // reaches localhost. Fail closed instead.
  if (part.length > 1 && part.startsWith("0")) return null;
  const n = Number(part);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

function classifyIpv4(ip: string): NetworkZone | "invalid" {
  const parts = ip.split(".");
  if (parts.length !== 4) return "invalid";
  const octets: number[] = [];
  for (const p of parts) {
    const n = parseDecOctet(p);
    if (n === null) return "invalid";
    octets.push(n);
  }
  const [o1 = 0, o2 = 0, o3 = 0] = octets;
  if (o1 === 127) return "localhost"; // 127.0.0.0/8 loopback
  if (o1 === 0 && o2 === 0 && o3 === 0) return "localhost"; // 0.0.0.0 unspecified
  if (o1 === 10) return "private"; // 10.0.0.0/8 RFC1918
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return "private"; // 172.16.0.0/12
  if (o1 === 192 && o2 === 168) return "private"; // 192.168.0.0/16
  if (o1 === 169 && o2 === 254) return "link-local"; // 169.254.0.0/16 (cloud metadata lives here)
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return "private"; // 100.64.0.0/10 CGNAT shared space
  if (
    (o1 === 192 && o2 === 0 && o3 === 2) ||
    (o1 === 198 && o2 === 51 && o3 === 100) ||
    (o1 === 203 && o2 === 0 && o3 === 113)
  ) {
    return "private"; // TEST-NET documentation ranges: unroutable, fail closed
  }
  if (o1 >= 224) return "invalid"; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return "public";
}

function expandIpv6(ip: string): number[] | null {
  // Embedded IPv4 tail (::ffff:1.2.3.4) is handled by the caller.
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parseGroup = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const groups = parseGroup(halves[0]!);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = parseGroup(halves[0]!);
  const tail = parseGroup(halves[1]!);
  if (!head || !tail || head.length + tail.length > 7) return null;
  const zeros = new Array<number>(8 - head.length - tail.length).fill(0);
  return [...head, ...zeros, ...tail];
}

function classifyIpv6(ip: string): NetworkZone | "invalid" {
  // Dotted mapped tail (::ffff:1.2.3.4): expandIpv6 cannot parse dots, so
  // unwrap before expansion. (Real URLs never reach this branch — the URL
  // parser normalizes dotted tails to hex — but direct callers might.)
  const dotted = ip.match(/^(?:::ffff:)(.+)$/);
  if (dotted && dotted[1]!.includes(".")) return classifyIpv4(dotted[1]!);
  // Embedded dotted tail in other positions is not a valid literal here.
  if (ip.includes(".")) return "invalid";
  const g = expandIpv6(ip);
  if (!g || g.length !== 8) return "invalid";
  // IPv4-mapped ::ffff:0:0/96 in hex form (::ffff:7f00:1 — the shape the URL
  // parser produces): classify the embedded IPv4 address, so mapped
  // loopback/private cannot slip past the v4 rules as "public".
  if (
    g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 &&
    g[5] === 0xffff
  ) {
    const hi = g[6]!;
    const lo = g[7]!;
    return classifyIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (g.every((x) => x === 0)) {
    // :: unspecified — like 0.0.0.0, connections stay on the machine.
    return "localhost";
  }
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "localhost"; // ::1
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique-local
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "private"; // 2001:db8::/32 documentation
  if ((g[0]! & 0xff00) === 0xff00) return "invalid"; // ff00::/8 multicast
  return "public";
}

// Classify a hostname's resolved addresses, worst zone wins (fail closed):
// link-local > localhost > private > public. A hostname straddling zones is
// gated by its most sensitive address, which also blunts DNS-rebinding
// races (at most one lookup happens per check; see webfetchTool).
const ZONE_RANK: Record<NetworkZone, number> = {
  blocked: 4,
  "link-local": 3,
  localhost: 2,
  private: 1,
  public: 0,
};

export function zoneForAddresses(addresses: string[]): NetworkZone {
  let worst: NetworkZone = "public";
  for (const addr of addresses) {
    const zone = classifyIp(addr);
    const effective: NetworkZone = zone === "invalid" ? "blocked" : zone;
    if (ZONE_RANK[effective] > ZONE_RANK[worst]) worst = effective;
  }
  return worst;
}

// ---- 4. Secret scrubbing ----

// Minimum secret length worth redacting: shorter values would nuke ordinary
// words (a 1-char "secret" redacts every matching letter).
export const SECRET_MIN_LENGTH = 8;

// Redact every occurrence of each known secret. Longest-first so overlapping
// values mask fully; split/join (never regex) so values cannot inject
// patterns. Idempotent. Pure.
export function scrubSecrets(text: string, secrets: string[]): string {
  const ordered = [...new Set(secrets)]
    .filter((s) => typeof s === "string" && s.length >= SECRET_MIN_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return text;
  let out = text;
  for (const s of ordered) out = out.split(s).join("[redacted]");
  return out;
}
