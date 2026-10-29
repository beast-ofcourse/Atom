// Phase 5 — theme overrides: parseThemeFile validation, resolveTheme deep
// merge (no base mutation), mergeOverrides precedence, themeOverrideFromTui
// mapping, loadUserThemeFile disk behavior — plus the App resolution proof:
// an atom.json `tui` block reaches the active theme state; a broken block
// falls back to the default with the /context warnings. Disk never touches a
// real home (temp dirs only); network is never hit (initialModels skips the
// live fetch).
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { classicTheme } from "../src/ui/themes/classic.js";
import {
  loadUserThemeFile,
  mergeOverrides,
  parseThemeFile,
  resolveTheme,
  themeOverrideFromTui,
} from "../src/ui/theme-override.js";

const realFetch = globalThis.fetch;
let dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

// ink-testing-library's stdout is NOT a TTY, so chalk strips every color
// escape — paint assertions are impossible here, though raw text survives.
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("resolveTheme", () => {
  test("deep merge keeps siblings and never mutates the base", () => {
    const before = JSON.parse(JSON.stringify(classicTheme));
    const result = resolveTheme(classicTheme, {
      color: { selection: "cyan", question: "blue" },
      spacing: { pickerPadX: 3 },
      layout: { overlayReserve: { dock: 7 } },
    });
    // Replaced leaves…
    expect(result.color.selection).toBe("cyan");
    expect(result.color.question).toBe("blue");
    expect(result.spacing.pickerPadX).toBe(3);
    expect(result.layout.overlayReserve.dock).toBe(7);
    // …siblings survive at every depth…
    expect(result.color.user).toBe(classicTheme.color.user);
    expect(result.spacing.turnGap).toBe(classicTheme.spacing.turnGap);
    expect(result.layout.overlayReserve.composer).toBe(4);
    expect(result.symbol.select).toBe(classicTheme.symbol.select);
    // …and the base object is untouched (registry entries are shared).
    expect(JSON.parse(JSON.stringify(classicTheme))).toEqual(before);
    expect(result).not.toBe(classicTheme);
  });

  test("an empty override returns the base values", () => {
    expect(resolveTheme(classicTheme, {})).toEqual(classicTheme);
  });

  test("unknown override keys never reach the output", () => {
    // The type-level guarantee, forced at runtime: resolveTheme walks the
    // BASE's keys, so a smuggled key cannot surface.
    const smuggled = {
      color: { selection: "cyan" },
      MadeUp: { nope: 1 },
    } as unknown as typeof classicTheme;
    const out = resolveTheme(classicTheme, smuggled) as unknown as Record<
      string,
      unknown
    >;
    expect(out["MadeUp"]).toBeUndefined();
  });
});

describe("mergeOverrides", () => {
  test("null sides pass through; upper wins leaf-wise", () => {
    expect(mergeOverrides(null, null)).toBeNull();
    expect(mergeOverrides(null, { color: { selection: "cyan" } })).toEqual({
      color: { selection: "cyan" },
    });
    expect(mergeOverrides({ color: { selection: "cyan" } }, null)).toEqual({
      color: { selection: "cyan" },
    });
  });

  test("deep merge: file value wins, config-only keys survive", () => {
    const merged = mergeOverrides(
      { color: { selection: "green" }, spacing: { pickerPadX: 2 } },
      { color: { selection: "cyan" }, symbol: { select: ">" } },
    );
    expect(merged).toEqual({
      color: { selection: "cyan" },
      spacing: { pickerPadX: 2 },
      symbol: { select: ">" },
    });
  });
});

describe("parseThemeFile", () => {
  test("valid JSON object yields a validated override", () => {
    const { theme: result, warnings } = parseThemeFile(
      JSON.stringify({ color: { selection: "cyan" }, spacing: { pickerPadX: 3 } }),
    );
    expect(warnings).toEqual([]);
    expect(result).toEqual({
      color: { selection: "cyan" },
      spacing: { pickerPadX: 3 },
    });
  });

  test("invalid JSON and non-objects warn, never throw", () => {
    expect(parseThemeFile("{nope")).toEqual({
      theme: undefined,
      warnings: ["themes override: not valid JSON — ignored"],
    });
    expect(parseThemeFile([1, 2])).toEqual({
      theme: undefined,
      warnings: ["themes override: must be a JSON object — ignored"],
    });
    expect(parseThemeFile(42)).toEqual({
      theme: undefined,
      warnings: ["themes override: must be a JSON object — ignored"],
    });
  });

  test("unknown namespaces and unknown leaf keys warn and drop; valid siblings stay", () => {
    const { theme: result, warnings } = parseThemeFile(
      JSON.stringify({
        notANamespace: { anything: "goes" },
        color: { selection: "cyan", notAColorKey: "red" },
        spacing: { pickerPadX: 3, lieAboutThis: true },
      }),
    );
    expect(result).toEqual({ color: { selection: "cyan" }, spacing: { pickerPadX: 3 } });
    const joined = warnings.join("\n");
    expect(joined).toContain('unknown key "notANamespace"');
    expect(joined).toContain('unknown key "color.notAColorKey"');
    expect(joined).toContain('unknown key "spacing.lieAboutThis"');
  });

  test("structural leaves validate one level deep (border.tool, layout.overlayReserve)", () => {
    const { theme: result, warnings } = parseThemeFile(
      JSON.stringify({
        border: {
          tool: { ok: "cyan", unknown: "dropped" },
          picker: "not-an-object-below",
        },
        layout: { overlayReserve: { dock: 7, ghost: 1 } },
      }),
    );
    expect(result).toEqual({
      border: { tool: { ok: "cyan" }, picker: "not-an-object-below" },
      layout: { overlayReserve: { dock: 7 } },
    });
    const joined = warnings.join("\n");
    expect(joined).toContain('unknown key "border.tool.unknown"');
    expect(joined).toContain('unknown key "layout.overlayReserve.ghost"');
  });

  test("wrong-leaf-type values warn and drop", () => {
    const { theme: result, warnings } = parseThemeFile(
      JSON.stringify({ color: { selection: null }, symbol: { select: ["❯"] } }),
    );
    expect(result).toBeUndefined();
    const joined = warnings.join("\n");
    expect(joined).toContain('"color.selection"');
    expect(joined).toContain('"symbol.select"');
  });

  test("a bare scalar over a namespace name warns and drops", () => {
    const { theme: result, warnings } = parseThemeFile(
      JSON.stringify({ color: "red" }),
    );
    expect(result).toBeUndefined();
    expect(warnings.join("\n")).toContain('ignoring "color"');
  });
});

describe("themeOverrideFromTui", () => {
  test("undefined tui and tui without visual keys give null", () => {
    expect(themeOverrideFromTui(undefined)).toBeNull();
    expect(
      themeOverrideFromTui({ theme: "classic", density: "cozy", backgroundMode: "tint" }),
    ).toBeNull();
  });

  test("background/foreground map onto color; terminal means no paint", () => {
    expect(
      themeOverrideFromTui({ background: "#00FF00", foreground: "terminal" }),
    ).toEqual({ color: { background: "#00FF00" } });
    expect(
      themeOverrideFromTui({ background: "terminal", foreground: "#ABCDEF" }),
    ).toEqual({ color: { foreground: "#ABCDEF" } });
  });

  test("flat dotted layout tokens expand into the nested namespace (review MAJOR-1)", () => {
    expect(
      themeOverrideFromTui({
        layout: { widgetMaxColumns: 130, "overlayReserve.dock": 5, pickerVisibleRows: 8 },
      }),
    ).toEqual({
      layout: {
        widgetMaxColumns: 130,
        pickerVisibleRows: 8,
        overlayReserve: { dock: 5 },
      },
    });
  });
});

// Resolution level (the mapping test alone is what let the inert dotted-key
// bug through): the config's `tui.layout` must actually MOVE the resolved
// theme's tokens — the same shape config.ts validates and docs promise.
describe("resolveTheme on a tui-derived override (Phase 5 end-to-end shape)", () => {
  test("overlayReserve.dock reaches the nested base key; no flat junk key", () => {
    const override = themeOverrideFromTui({ layout: { "overlayReserve.dock": 5 } });
    const resolved = resolveTheme(classicTheme, override!) as unknown as {
      layout: Record<string, unknown>;
    };
    expect(resolved.layout.overlayReserve).toEqual({
      composer: 4,
      picker: 1,
      inspector: 1,
      palette: 1,
      ledger: 1,
      dock: 5,
    });
    // The flat key never leaks beside the nested record.
    expect(Object.hasOwn(resolved.layout, "overlayReserve.dock")).toBe(false);
  });

  test("non-dotted layout tokens still replace their leaves", () => {
    const override = themeOverrideFromTui({ layout: { widgetMaxColumns: 130 } });
    const resolved = resolveTheme(classicTheme, override!) as unknown as {
      layout: Record<string, unknown> & { widgetMaxColumns: number; overlayReserve: unknown };
    };
    expect(resolved.layout.widgetMaxColumns).toBe(130);
    expect(resolved.layout.overlayReserve).toEqual(classicTheme.layout.overlayReserve);
  });
});

describe("loadUserThemeFile", () => {
  test("absent file is silent null; no home is silent null", async () => {
    const home = await tmpDir("atom-thm-h-");
    expect(loadUserThemeFile(home, "classic")).toEqual({ override: null, warnings: [] });
    expect(loadUserThemeFile(undefined, "classic")).toEqual({
      override: null,
      warnings: [],
    });
  });

  test("a valid file loads an override; a broken file warns", async () => {
    const home = await tmpDir("atom-thm-h-");
    const themesDir = path.join(home, ".atom", "themes");
    await fsp.mkdir(themesDir, { recursive: true });
    await fsp.writeFile(
      path.join(themesDir, "classic.json"),
      JSON.stringify({ color: { selection: "cyan" } }),
      "utf8",
    );
    expect(loadUserThemeFile(home, "classic")).toEqual({
      override: { color: { selection: "cyan" } },
      warnings: [],
    });
    expect(loadUserThemeFile(home, "ember")).toEqual({
      override: null,
      warnings: [],
    });
    await fsp.writeFile(path.join(themesDir, "bad.json"), "{nope", "utf8");
    const loaded = loadUserThemeFile(home, "bad");
    expect(loaded.override).toBeNull();
    expect(loaded.warnings).toEqual(["themes override: not valid JSON — ignored"]);
  });
});

describe("App renders the configured tui block (Phase 5 resolution)", () => {
  function baseProps(configDirs: { projectDir: string; homeDir: string }) {
    return {
      apiKey: "test-key",
      endpoint: "https://opencode.ai/zen/v1/chat/completions",
      initialModel: "big-pickle",
      initialModels: ["big-pickle"],
      configDirs,
      authHome: configDirs.homeDir,
    };
  }

  // Resolution proof, NOT a vacuous text match: the /theme notice names the
  // ACTIVE theme resolved out of the config — a config `tui.theme` reaches
  // themeName, and the ThemeProvider at the App root receives the matching
  // registry entry. (The visible pixel switch awaits the planned consumer
  // migration — every ui component still imports the legacy singleton, so
  // no rendered surface differs between themes yet; that harvest is the
  // flagged gap in this phase's report, and switching it on silently
  // rebrands the default.)
  async function themeNotice(config: unknown): Promise<{ notice: string; projectDir: string; homeDir: string }> {
    const project = await tmpDir("atom-thm-p");
    const home = await tmpDir("atom-thm-h");
    await fsp.writeFile(path.join(project, "atom.json"), JSON.stringify(config), "utf8");
    const inst = render(<App {...baseProps({ projectDir: project, homeDir: home })} />);
    inst.stdin.write("/theme");
    inst.stdin.write("\r");
    const start = Date.now();
    let rendered = "";
    for (;;) {
      rendered = stripAnsi(inst.frames.join(""));
      if (rendered.includes("themes:") && rendered.includes("(current)")) break;
      if (Date.now() - start > 15000) {
        inst.unmount();
        throw new Error("theme notice never rendered");
      }
      await sleep(50);
    }
    inst.unmount();
    const at = rendered.indexOf("themes:");
    return { notice: rendered.slice(at), projectDir: project, homeDir: home };
  }

  test("a tui block resolves classic as the active theme", async () => {
    const { notice } = await themeNotice({ tui: { theme: "classic" } });
    expect(notice).toContain("classic (current)");
    expect(notice).not.toContain("ember (current)");
  }, 30000);

  test("a broken tui block falls back to the default theme and warns", async () => {
    const { notice, projectDir, homeDir } = await themeNotice({
      tui: { theme: "solarized", density: "tight" },
    });
    expect(notice).toContain("ember (current)");
    expect(notice).not.toContain("classic (current)");
    // The invalid keys produce the exact /context warning surface.
    const { loadAtomConfig } = await import("../src/config.js");
    const loaded = loadAtomConfig(projectDir, homeDir);
    expect(loaded.warnings.join("\n")).toContain('"tui.theme"');
    expect(loaded.warnings.join("\n")).toContain('"tui.density"');
  }, 30000);
});
