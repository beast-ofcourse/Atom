// WebUI slash commands: runs the REAL client script (src/web/ui/app.js) in
// a vm sandbox with minimal DOM stubs and asserts the ported registry /
// fuzzy matcher / submit routing behave like the TUI contract (exact wins,
// prefix tier, fuzzy fallback, unknown slash never reaches the model).
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

type StubEl = {
  children: StubEl[];
  style: Record<string, string>;
  dataset: Record<string, string>;
  hidden: boolean;
  value: string;
  textContent: string;
  innerHTML: string;
  disabled: boolean;
  title: string;
  classList: { add: () => void; remove: () => void; toggle: () => void; contains: () => boolean };
  addEventListener: () => void;
  removeEventListener: () => void;
  appendChild: (c: StubEl) => StubEl;
  prepend: () => void;
  remove: () => void;
  // Real DOM returns an element; tests that render into it need the same.
  querySelector: () => StubEl;
  closest: () => null;
  click: () => void;
  focus: () => void;
  setAttribute: () => void;
  scrollTop: number;
  scrollHeight: number;
  selectionStart: number;
  selectionEnd: number;
  requestSubmit: () => void;
};

function stubEl(): StubEl {
  const el: StubEl = {
    children: [],
    style: {},
    dataset: {},
    hidden: true,
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    title: "",
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    prepend() {},
    remove() {},
    // Real DOM returns an element; tests that render into it need the same.
    querySelector() {
      return stubEl();
    },
    closest() {
      return null;
    },
    click() {},
    focus() {},
    setAttribute() {},
    scrollTop: 0,
    scrollHeight: 0,
    selectionStart: 0,
    selectionEnd: 0,
    requestSubmit() {},
  };
  return el;
}

function loadClient() {
  const ids = new Map<string, StubEl>();
  const byId = (id: string): StubEl => {
    if (!ids.has(id)) ids.set(id, stubEl());
    return ids.get(id)!;
  };
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: byId,
      createElement: () => stubEl(),
      querySelector: () => stubEl(),
      addEventListener() {},
    },
    window: {
      innerWidth: 1400,
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
      prompt: () => null,
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
    },
    fetch: () => Promise.reject(new Error("no network in slash tests")),
    EventSource: class {
      addEventListener() {}
      close() {}
    },
    navigator: {},
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    console,
  };
  sandbox["globalThis"] = sandbox;
  const src = readFileSync("src/web/ui/app.js", "utf8");
  // Appended driver runs in the same scope: exposes internals plus a
  // session injector (test-file code only — nothing ships in app.js).
  const driver = `;globalThis.__test = { fuzzyScore, filterSlashCommands, WEB_COMMANDS, trySlashSubmit, _setSession: (id) => { state.sessionId = id; } };`;
  vm.createContext(sandbox);
  vm.runInContext(src + driver, sandbox, { filename: "app.js" });
  return { api: (sandbox as Record<string, unknown>)["__test"] as never, byId };
}

describe("web slash registry", () => {
  test("lists only commands with a WebUI backend (no faked TUI-only entries)", () => {
    const { api } = loadClient();
    const names = (api as { WEB_COMMANDS: Array<{ name: string }> }).WEB_COMMANDS.map((c) => c.name);
    expect(names).toEqual(["/model", "/provider", "/effort", "/mode", "/tools", "/thinking", "/rename", "/new", "/help"]);
    for (const banned of ["/goal", "/compact", "/allow", "/deny", "/skills", "/queue", "/steer", "/rewind"]) {
      expect(names).not.toContain(banned);
    }
  });
});

describe("ported fuzzy matcher (src/App.tsx contract)", () => {
  test("exact input wins outright, even with prefix siblings", () => {
    const { api } = loadClient();
    const t = api as { filterSlashCommands: (p: string) => Array<{ name: string }> };
    expect(t.filterSlashCommands("/model").map((c) => c.name)).toEqual(["/model"]);
    expect(t.filterSlashCommands("/effort").map((c) => c.name)).toEqual(["/effort"]);
  });

  test("prefix tier keeps registry order (fuzzy may follow, as in the TUI)", () => {
    const { api } = loadClient();
    const t = api as { filterSlashCommands: (p: string) => Array<{ name: string }> };
    expect(t.filterSlashCommands("/").map((c) => c.name)[0]).toBe("/model");
    expect(t.filterSlashCommands("/m").map((c) => c.name).slice(0, 2)).toEqual(["/model", "/mode"]);
  });

  test("fuzzy subsequence matches typos, rejects garbage", () => {
    const { api } = loadClient();
    const t = api as {
      fuzzyScore: (q: string, target: string) => number | null;
      filterSlashCommands: (p: string) => Array<{ name: string }>;
    };
    expect(t.fuzzyScore("mdl", "model")).not.toBeNull();
    expect(t.fuzzyScore("zzz", "model")).toBeNull();
    expect(t.filterSlashCommands("/mdl").map((c) => c.name)).toContain("/model");
    expect(t.filterSlashCommands("/zzz")).toEqual([]);
  });
});

describe("slash submit routing", () => {
  test("unknown slash is an inline error, plain text passes through", () => {
    const { api, byId } = loadClient();
    const t = api as { trySlashSubmit: (text: string) => boolean };
    const transcript = byId("transcript");
    const before = transcript.children.length;
    expect(t.trySlashSubmit("/nope")).toBe(true);
    expect(transcript.children.length).toBeGreaterThan(before);
    expect(t.trySlashSubmit("hello")).toBe(false);
    expect(t.trySlashSubmit("/usr/bin/ls")).toBe(true);
  });

  test("/help renders locally with zero network", () => {
    const { api, byId } = loadClient();
    const t = api as { trySlashSubmit: (text: string) => boolean; _setSession: (id: string) => void };
    t._setSession("ses_test");
    const transcript = byId("transcript");
    const before = transcript.children.length;
    expect(t.trySlashSubmit("/help")).toBe(true);
    expect(transcript.children.length).toBeGreaterThan(before);
  });
});
