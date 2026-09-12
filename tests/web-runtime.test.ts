// WebRuntime: validation, catalogs, and turn lifecycle guards. Model POSTs
// are never performed here (no network); the full turn path is covered by
// tests/web-server.test.ts with a stubbed transport.
import { describe, expect, test } from "vitest";
import { WebRuntime, classifyWriteOp, cutAtNewline, planModeRefusal, truncateEventText, validateSendBody } from "../src/web/runtime.js";

describe("validateSendBody", () => {
  test("accepts a plain content body", () => {
    expect(validateSendBody({ content: "hi" })).toBeNull();
  });

  test("rejects empty content, non-objects, and bad enums", () => {
    expect(validateSendBody({ content: "  " })).toMatch(/non-empty/);
    expect(validateSendBody({})).toMatch(/non-empty/);
    expect(validateSendBody(null)).toMatch(/object/);
    expect(validateSendBody("hi")).toMatch(/object/);
    expect(validateSendBody({ content: "hi", provider: "nope" })).toMatch(/provider/);
    expect(validateSendBody({ content: "hi", mode: "turbo" })).toMatch(/mode/);
    expect(validateSendBody({ content: "hi", effort: "ultra" })).toMatch(/effort/);
    expect(validateSendBody({ content: "hi", model: 42 })).toMatch(/model/);
  });

  test("accepts known providers, modes, and efforts", () => {
    expect(
      validateSendBody({ content: "hi", provider: "kilo", mode: "plan", effort: "low", model: "x" })
    ).toBeNull();
  });
});

describe("planModeRefusal", () => {
  test("matches the TUI guardedExecute text (frontends never drift)", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync("src/App.tsx", "utf8");
    // The TUI interpolates the tool name, so pin both halves, not the joint.
    expect(app).toContain("Error: plan mode is read-only — ");
    expect(app).toContain("blocked (no writes while planning).");
    expect(planModeRefusal("write")).toContain("Error: plan mode is read-only — ");
    expect(planModeRefusal("write")).toContain("write blocked (no writes while planning).");
    expect(planModeRefusal("bash").startsWith("Error:")).toBe(true);
  });
});

describe("truncateEventText", () => {
  test("passes short text through, caps long text honestly", () => {
    expect(truncateEventText("abc")).toEqual({ text: "abc", truncated: false, chars: 3 });
    const long = "x".repeat(5000);
    const capped = truncateEventText(long);
    expect(capped.truncated).toBe(true);
    expect(capped.chars).toBe(5000);
    expect(capped.text.length).toBeLessThan(5000);
  });
});

describe("classifyWriteOp / cutAtNewline", () => {
  test("null old text means created, anything else means modified", () => {
    expect(classifyWriteOp(null)).toBe("created");
    expect(classifyWriteOp("")).toBe("modified");
    expect(classifyWriteOp("old")).toBe("modified");
  });

  test("short text passes through; long text cuts at a newline honestly", () => {
    expect(cutAtNewline("abc")).toEqual({ text: "abc", truncated: false, chars: 3 });
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} padding padding`).join("\n");
    const cut = cutAtNewline(lines, 1000);
    expect(cut.truncated).toBe(true);
    expect(cut.chars).toBe(lines.length);
    expect(cut.text.length).toBeLessThanOrEqual(1000);
    expect(cut.text.endsWith("\n") || lines[cut.text.length] === "\n").toBe(true);
  });
});

describe("WebRuntime sessions", () => {
  test("creates sessions with a system history head and default settings", () => {
    const rt = new WebRuntime();
    const s = rt.createWebSession({ title: "web test" });
    expect(s.title).toBe("web test");
    expect(s.history[0]?.role).toBe("system");
    expect(typeof (s.history[0] as { content?: unknown })?.content).toBe("string");
    expect(rt.getSessionRecord(s.id)?.id).toBe(s.id);
    expect(rt.listSessions().some((x) => x.id === s.id)).toBe(true);
  });

  test("rejects empty messages and unknown sessions", async () => {
    const rt = new WebRuntime();
    const s = rt.createWebSession({});
    await expect(rt.sendMessage(s.id, "   ")).rejects.toThrow(/non-empty/);
    await expect(rt.sendMessage("ses_doesnotexist", "hi")).rejects.toThrow(/not found/);
  });

  test("refuses to start without a resolvable key (nothing is POSTed)", async () => {
    const rt = new WebRuntime();
    // openai-compatible is stored-only by construction (no env vars), and the
    // temp test home holds no stored keys — deterministic in any environment.
    const s = rt.createWebSession({ provider: "openai-compatible", model: "model-x" });
    await expect(rt.sendMessage(s.id, "hi")).rejects.toThrow(/missing API key/);
    expect(rt.isBusy(s.id)).toBe(false);
  });

  test("idle sessions have no pending gates and cancel false", () => {
    const rt = new WebRuntime();
    const s = rt.createWebSession({});
    expect(rt.cancelTurn(s.id)).toBe(false);
    expect(rt.getPendingApproval(s.id)).toBeNull();
    expect(rt.getPendingQuestion(s.id)).toBeNull();
    expect(rt.resolveApproval(s.id, "apr_1", "once")).toBe(false);
    expect(rt.answerQuestion(s.id, "q_1", "yes")).toBe(false);
  });
});

describe("WebRuntime catalogs", () => {
  test("provider catalog carries key presence, never key material", () => {
    const rt = new WebRuntime();
    const providers = rt.listProviders();
    expect(providers.length).toBeGreaterThan(0);
    const kilo = providers.find((p) => p.id === "kilo")!;
    expect(kilo.needsKey).toBe(false);
    const raw = JSON.stringify(providers);
    expect(raw).not.toContain("apiKey");
  });

  test("tool catalog names every executable tool with its approval class", () => {
    const rt = new WebRuntime();
    const tools = rt.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["read", "write", "edit", "grep", "glob", "bash", "webfetch", "websearch"]) {
      expect(byName.has(name)).toBe(true);
    }
    expect(byName.get("write")?.needsApproval).toBe(true);
    expect(byName.get("bash")?.needsApproval).toBe(true);
    expect(byName.get("read")?.needsApproval).toBe(false);
  });
});
