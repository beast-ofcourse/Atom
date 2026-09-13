// Policy/Security layer tests: the explicit trust boundaries for a powerful
// local agent. Pure unit tests (no TUI); network never touched — webfetch
// tests inject stub resolvers and a mocked fetch.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  SECRET_MIN_LENGTH,
  classifyIp,
  decidePolicy,
  defaultNetworkPolicy,
  isRedirectStatus,
  parseNetworkPolicy,
  scrubSecrets,
  skillGrantsFor,
  zoneForAddresses,
  type PolicyContext,
} from "../src/policy.js";
import { checkUrlAgainstPolicy, describeToolCall, providerSecrets, webfetchTool } from "../src/tools.js";
import type { PermissionRule } from "../src/permissions.js";

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    mode: "normal",
    trustAll: false,
    rules: [],
    alwaysAllowed: new Set(),
    skillGrants: new Set(),
    approvalGated: true,
    ...over,
  };
}

const denyBash: PermissionRule = { kind: "deny", tool: "bash", glob: null, pattern: "bash" };
const allowBash: PermissionRule = { kind: "allow", tool: "bash", glob: null, pattern: "bash" };

describe("decidePolicy order", () => {
  test("deny wins over everything, including plan mode and allow rules", () => {
    expect(
      decidePolicy("bash", { command: "x" }, ctx({ mode: "plan", rules: [denyBash, allowBash] }))
    ).toEqual({ kind: "deny" });
    expect(
      decidePolicy("bash", { command: "x" }, ctx({ mode: "yolo", trustAll: true, rules: [denyBash] }))
    ).toEqual({ kind: "deny" });
  });

  test("plan mode passes approval-gated tools through without prompting", () => {
    expect(decidePolicy("bash", {}, ctx({ mode: "plan" }))).toEqual({
      kind: "allow",
      via: "plan-passthrough",
    });
    // Read-only tools are not gated: normal flow (prompt only if nothing else allows).
    expect(
      decidePolicy("read", {}, ctx({ mode: "plan", approvalGated: false }))
    ).toEqual({ kind: "prompt" });
  });

  test("allow rule beats yolo/trust/always/skill grants (first match wins)", () => {
    const c = ctx({
      mode: "yolo",
      trustAll: true,
      rules: [allowBash],
      alwaysAllowed: new Set(["bash"]),
      skillGrants: new Set(["bash"]),
    });
    expect(decidePolicy("bash", {}, c)).toEqual({ kind: "allow", via: "allow-rule" });
  });

  test("yolo, trust, always, skill-grant in order, then prompt", () => {
    expect(decidePolicy("bash", {}, ctx({ mode: "yolo" }))).toEqual({ kind: "allow", via: "yolo" });
    expect(decidePolicy("bash", {}, ctx({ trustAll: true }))).toEqual({
      kind: "allow",
      via: "trust",
    });
    expect(decidePolicy("bash", {}, ctx({ alwaysAllowed: new Set(["bash"]) }))).toEqual({
      kind: "allow",
      via: "always",
    });
    expect(decidePolicy("bash", {}, ctx({ skillGrants: new Set(["bash"]) }))).toEqual({
      kind: "allow",
      via: "skill-grant",
    });
    expect(decidePolicy("bash", {}, ctx())).toEqual({ kind: "prompt" });
  });
});

describe("skillGrantsFor trust boundary", () => {
  test("global (user-controlled) skills arm grants verbatim", () => {
    expect(skillGrantsFor("global", ["bash", "write", "read"])).toEqual({
      grants: ["bash", "write", "read"],
      blocked: [],
    });
  });

  test("project-local content never arms grants; sensitive tools are reported blocked", () => {
    expect(skillGrantsFor("project", ["bash", "write", "read"])).toEqual({
      grants: [],
      blocked: ["bash", "write"],
    });
    expect(skillGrantsFor("project", ["read"])).toEqual({ grants: [], blocked: [] });
    expect(skillGrantsFor("project", [])).toEqual({ grants: [], blocked: [] });
  });
});

describe("classifyIp", () => {
  const cases: Array<[string, string]> = [
    ["127.0.0.1", "localhost"],
    ["127.1.2.3", "localhost"],
    ["0.0.0.0", "localhost"],
    ["10.0.0.1", "private"],
    ["192.168.1.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.15.0.1", "public"],
    ["172.32.0.1", "public"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "private"],
    ["192.0.2.1", "private"],
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["224.0.0.1", "invalid"],
    ["240.0.0.1", "invalid"],
    ["0177.0.0.1", "invalid"], // octal-looking: fail closed, not decimal localhost
    ["0x7f.0.0.1", "invalid"], // hex: fail closed
    ["999.1.1.1", "invalid"],
    ["1.2.3", "invalid"],
    ["::1", "localhost"],
    ["::", "localhost"],
    ["fe80::1", "link-local"],
    ["fc00::1", "private"],
    ["2001:db8::1", "private"],
    ["ff02::1", "invalid"],
    ["::ffff:127.0.0.1", "localhost"], // mapped loopback cannot slip past v4 rules
    ["::ffff:7f00:1", "localhost"], // hex form (what the URL parser produces)
    ["::ffff:a0a:a0a", "private"], // hex-mapped 10.10.10.10
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:8.8.8.8", "public"],
    ["not-an-ip", "invalid"],
  ];
  for (const [input, want] of cases) {
    test(`${input} → ${want}`, () => {
      expect(classifyIp(input)).toBe(want);
    });
  }
});

describe("zoneForAddresses", () => {
  test("worst zone wins; invalid counts as blocked", () => {
    expect(zoneForAddresses(["8.8.8.8"])).toBe("public");
    expect(zoneForAddresses(["8.8.8.8", "10.0.0.1"])).toBe("private");
    expect(zoneForAddresses(["10.0.0.1", "127.0.0.1"])).toBe("localhost");
    expect(zoneForAddresses(["127.0.0.1", "169.254.169.254"])).toBe("link-local");
    expect(zoneForAddresses(["8.8.8.8", "0177.0.0.1"])).toBe("blocked");
    expect(zoneForAddresses([])).toBe("public");
  });
});

describe("parseNetworkPolicy", () => {
  test("defaults allow public + localhost only", () => {
    expect(defaultNetworkPolicy()).toEqual({
      allowPublic: true,
      allowLocalhost: true,
      allowPrivate: false,
      allowLinkLocal: false,
    });
    expect(parseNetworkPolicy(undefined)).toEqual({ policy: defaultNetworkPolicy(), warnings: [] });
  });

  test("partial objects merge; invalid values warn and keep defaults", () => {
    const { policy, warnings } = parseNetworkPolicy({ allowPrivate: true, allowPublic: "yes" });
    expect(policy.allowPrivate).toBe(true);
    expect(policy.allowPublic).toBe(true);
    expect(warnings.length).toBe(1);
    expect(parseNetworkPolicy("nope").warnings.length).toBe(1);
  });
});

describe("isRedirectStatus", () => {
  test("301/302/303/307/308 only", () => {
    for (const s of [301, 302, 303, 307, 308]) expect(isRedirectStatus(s)).toBe(true);
    for (const s of [200, 204, 304, 404, 500]) expect(isRedirectStatus(s)).toBe(false);
  });
});

describe("scrubSecrets", () => {
  test("redacts occurrences; skips short values; idempotent", () => {
    const secret = "sk-ant-secret-value-123";
    expect(scrubSecrets(`key=${secret} end`, [secret])).toBe("key=[redacted] end");
    expect(scrubSecrets("nothing here", [secret])).toBe("nothing here");
    const short = "x".repeat(SECRET_MIN_LENGTH - 1);
    expect(scrubSecrets(`short ${short}`, [short])).toBe(`short ${short}`);
    const once = scrubSecrets(`a ${secret}`, [secret]);
    expect(scrubSecrets(once, [secret])).toBe(once);
  });

  test("longest-first so overlapping values mask fully", () => {
    const long = "abcdefghij1234";
    const short = "abcdefghij";
    expect(scrubSecrets(`v=${long}`, [short, long])).toBe("v=[redacted]");
  });
});

// ---- SSRF gate (stub DNS, stub fetch — never real network) ----

const stubResolve = (table: Record<string, string[]>) => async (host: string) => table[host] ?? [];

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

const savedFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = savedFetch;
});

describe("checkUrlAgainstPolicy", () => {
  const policy = defaultNetworkPolicy();

  test("rejects credentials, bad schemes, garbage, unresolvable hosts", async () => {
    const resolve = stubResolve({ "example.com": ["93.184.215.14"] });
    expect((await checkUrlAgainstPolicy("https://user:pass@example.com/", policy, resolve)).ok).toBe(
      false
    );
    expect((await checkUrlAgainstPolicy("ftp://example.com/x", policy, resolve)).ok).toBe(false);
    expect((await checkUrlAgainstPolicy("not a url", policy, resolve)).ok).toBe(false);
    expect((await checkUrlAgainstPolicy("https://nope.invalid/", policy, resolve)).ok).toBe(false);
  });

  test("default policy: public + localhost pass, private/link-local blocked", async () => {
    const resolve = stubResolve({
      "example.com": ["93.184.215.14"],
      localhost: ["127.0.0.1"],
      lan: ["192.168.1.10"],
      meta: ["169.254.169.254"],
    });
    expect((await checkUrlAgainstPolicy("https://example.com/", policy, resolve)).ok).toBe(true);
    // Localhost dev servers stay reachable by default (explicit zone allow).
    expect((await checkUrlAgainstPolicy("http://127.0.0.1:3000/", policy, resolve)).ok).toBe(true);
    expect((await checkUrlAgainstPolicy("http://localhost:3000/", policy, resolve)).ok).toBe(true);
    expect((await checkUrlAgainstPolicy("http://lan/", policy, resolve)).ok).toBe(false);
    expect((await checkUrlAgainstPolicy("http://meta/latest", policy, resolve)).ok).toBe(false);
    // And a locked-down policy refuses localhost with a zone-named error.
    const locked = { ...policy, allowLocalhost: false };
    const refused = await checkUrlAgainstPolicy("http://127.0.0.1:3000/", locked, resolve);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/blocks localhost/);
  });

  test("literal IP obfuscation cannot smuggle loopback as public", async () => {
    const resolve = stubResolve({});
    // The WHATWG URL parser canonicalizes octal/hex dotted forms before we
    // ever see them: 0177.0.0.1 IS 127.0.0.1, so it classifies localhost —
    // never public — and a localhost-blocking policy refuses it.
    const octal = await checkUrlAgainstPolicy("http://0177.0.0.1/", policy, resolve);
    expect(octal.ok).toBe(true);
    if (octal.ok) expect(octal.zone).toBe("localhost");
    const locked = { ...policy, allowLocalhost: false };
    expect((await checkUrlAgainstPolicy("http://0177.0.0.1/", locked, resolve)).ok).toBe(false);
    expect((await checkUrlAgainstPolicy("http://0x7f.0.0.1/", locked, resolve)).ok).toBe(false);
    // Mapped loopback is localhost (allowed by default), never public.
    const hop = await checkUrlAgainstPolicy("http://[::ffff:127.0.0.1]/", policy, resolve);
    expect(hop.ok).toBe(true);
    if (hop.ok) expect(hop.zone).toBe("localhost");
  });

  test("multi-address host gated by worst zone", async () => {
    const resolve = stubResolve({ "mixed.example": ["93.184.215.14", "10.0.0.5"] });
    expect((await checkUrlAgainstPolicy("https://mixed.example/", policy, resolve)).ok).toBe(false);
  });

  test("explicit opt-in opens private/localhost", async () => {
    const open = { ...policy, allowPrivate: true, allowLocalhost: true };
    const resolve = stubResolve({ lan: ["192.168.1.10"] });
    expect((await checkUrlAgainstPolicy("http://lan/", open, resolve)).ok).toBe(true);
    expect((await checkUrlAgainstPolicy("http://127.0.0.1/", open, resolve)).ok).toBe(true);
  });
});

describe("webfetchTool redirect gating", () => {
  const opts = (table: Record<string, string[]>) => ({
    policy: defaultNetworkPolicy(),
    resolveHost: stubResolve(table),
  });

  test("redirect into a blocked zone is refused and never fetched", async () => {
    const fetched: string[] = [];
    globalThis.fetch = (async (url: string) => {
      fetched.push(url);
      if (url === "https://example.com/") return redirectTo("http://127.0.0.1:3000/admin");
      return new Response("should never arrive", { status: 200 });
    }) as typeof fetch;
    // Localhost disallowed here: the public → localhost hop must die at the
    // gate, before the second fetch.
    const out = await webfetchTool(
      { url: "https://example.com/", format: "html" },
      { policy: { ...defaultNetworkPolicy(), allowLocalhost: false }, resolveHost: stubResolve({ "example.com": ["93.184.215.14"] }) }
    );
    expect(out).toMatch(/^Error:.*network policy blocks localhost/);
    expect(fetched).toEqual(["https://example.com/"]);
  });

  test("public → public redirect is followed with a note", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "https://example.com/") return redirectTo("https://cdn.example.com/page");
      return new Response("<html><body><p>hi</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;
    const out = await webfetchTool(
      { url: "https://example.com/", format: "html" },
      opts({ "example.com": ["93.184.215.14"], "cdn.example.com": ["93.184.215.15"] })
    );
    expect(out).toContain("[note: followed 1 redirect(s)");
    expect(out).toContain("hi");
  });

  test("loops and redirect floods are refused", async () => {
    globalThis.fetch = (async () => redirectTo("https://example.com/")) as typeof fetch;
    const o = opts({ "example.com": ["93.184.215.14"] });
    expect(await webfetchTool({ url: "https://example.com/" }, o)).toMatch(/loop|too many/);
  });

  test("credentialed URLs rejected before any fetch", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("x", { status: 200 });
    }) as typeof fetch;
    const out = await webfetchTool(
      { url: "https://user:pass@example.com/" },
      opts({ "example.com": ["93.184.215.14"] })
    );
    expect(out).toMatch(/^Error:.*credentials/);
    expect(called).toBe(false);
  });
});

describe("providerSecrets + shell scrub wiring", () => {
  test("providerSecrets collects live env values", () => {
    process.env["OPENAI_API_KEY"] = "sk-test-scrub-value-123456";
    try {
      expect(providerSecrets()).toContain("sk-test-scrub-value-123456");
    } finally {
      delete process.env["OPENAI_API_KEY"];
    }
    expect(providerSecrets()).not.toContain("sk-test-scrub-value-123456");
  });

  test("bash output echoing a provider key comes back redacted", async () => {
    const { bashTool } = await import("../src/tools.js");
    process.env["OPENAI_API_KEY"] = "sk-test-scrub-value-789012";
    try {
      const raw = await bashTool({
        command: `${JSON.stringify(process.execPath)} -e "console.log(process.env.OPENAI_API_KEY)"`,
      });
      expect(raw).not.toContain("sk-test-scrub-value-789012");
      expect(raw).toContain("[redacted]");
    } finally {
      delete process.env["OPENAI_API_KEY"];
    }
  });
});

describe("describeToolCall read window + search dir", () => {
  test("read names its window; unbounded reads stay byte-identical", () => {
    expect(describeToolCall("read", { path: "src/App.tsx", offset: 5086, limit: 50 })).toBe(
      "⚙ read src/App.tsx [offset=5086, limit=50]"
    );
    expect(describeToolCall("read", { path: "a.txt", offset: 3 })).toBe("⚙ read a.txt [offset=3]");
    expect(describeToolCall("read", { path: "a.txt", limit: 10 })).toBe("⚙ read a.txt [limit=10]");
    expect(describeToolCall("read", { path: "a.txt" })).toBe("⚙ read a.txt");
    // Non-positive bounds are not real windows — no suffix.
    expect(describeToolCall("read", { path: "a.txt", offset: 0, limit: -2 })).toBe("⚙ read a.txt");
    // Window is read-only: writes never carry it.
    expect(describeToolCall("write", { path: "a.txt", offset: 1 })).toBe("⚙ write a.txt");
  });
  test("grep/glob name their dir; dir-less calls stay byte-identical", () => {
    expect(describeToolCall("grep", { pattern: "foo", dir: "src" })).toBe("⚙ grep foo src");
    expect(describeToolCall("grep", { pattern: "foo" })).toBe("⚙ grep foo");
    expect(describeToolCall("glob", { pattern: "*.ts", dir: "src" })).toBe("⚙ glob *.ts src");
    expect(describeToolCall("glob", { pattern: "*.ts" })).toBe("⚙ glob *.ts");
  });
});
describe("describeToolCall symlink display", () => {
  test("absolute symlink shows target; plain/missing/relative stay as-is", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-policy-"));
    try {
      const target = path.join(dir, "real.txt");
      await fsp.writeFile(target, "x", "utf8");
      const link = path.join(dir, "link.txt");
      try {
        await fsp.symlink(target, link);
      } catch {
        // Windows without symlink privilege (EPERM): the symlink half cannot
        // be built here — still assert the never-mislead halves below.
        expect(describeToolCall("read", { path: target })).not.toContain("→");
        expect(describeToolCall("read", { path: "relative.txt" })).toBe("⚙ read relative.txt");
        return;
      }
      const shown = describeToolCall("read", { path: link });
      expect(shown).toContain("link.txt");
      expect(shown).toContain("→");
      expect(shown).toContain("real.txt");
      expect(describeToolCall("read", { path: target })).not.toContain("→");
      expect(describeToolCall("read", { path: path.join(dir, "missing.txt") })).not.toContain("→");
      expect(describeToolCall("read", { path: "relative.txt" })).toBe("⚙ read relative.txt");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
