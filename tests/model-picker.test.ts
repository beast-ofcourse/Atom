// Unified /model picker pure helpers: cross-provider entries, text filter,
// visible window. No TUI, no network — local-only, like the picker open path.
import { describe, expect, test } from "vitest";
import {
  MODEL_PICKER_VISIBLE,
  filterModelEntries,
  modelPickerEntries,
  pickerWindow,
  type ModelPickerEntry,
} from "../src/App.js";
import { PROVIDERS, type ProviderId } from "../src/providers.js";

function setup(opts?: {
  active?: ProviderId;
  activeModels?: string[];
  keys?: ProviderId[];
  cachedLists?: Partial<Record<ProviderId, string[]>>;
  baseURLs?: Partial<Record<ProviderId, string>>;
}) {
  const active = opts?.active ?? "opencode-zen";
  const keys = new Set<ProviderId>(opts?.keys ?? []);
  const cachedLists = opts?.cachedLists ?? {};
  const baseURLs = opts?.baseURLs ?? {};
  return modelPickerEntries({
    activeProvider: active,
    activeModels: opts?.activeModels ?? ["zen-a", "zen-b"],
    cached: (id) => cachedLists[id],
    keyFor: (id) => (keys.has(id) ? "key" : ""),
    baseURLFor: (id) => baseURLs[id] ?? "",
  });
}

describe("modelPickerEntries", () => {
  test("active provider first; unkeyed providers excluded", () => {
    const entries = setup();
    expect(entries).toEqual([
      { providerId: "opencode-zen", model: "zen-a" },
      { providerId: "opencode-zen", model: "zen-b" },
    ]);
  });

  test("keyed providers append cached-or-fallback lists in registry order", () => {
    const entries = setup({
      keys: ["openai", "mistral"],
      cachedLists: { openai: ["o-live-1", "o-live-2"] },
    });
    const openaiDef = PROVIDERS.find((p) => p.id === "openai")!;
    const mistralDef = PROVIDERS.find((p) => p.id === "mistral")!;
    expect(entries.slice(0, 2).map((e) => e.model)).toEqual(["zen-a", "zen-b"]);
    expect(entries.slice(2, 4)).toEqual([
      { providerId: "openai", model: "o-live-1" },
      { providerId: "openai", model: "o-live-2" },
    ]);
    expect(entries.slice(4).map((e) => e.model)).toEqual([...mistralDef.fallbackModels]);
    expect(openaiDef.fallbackModels.length).toBeGreaterThan(0);
  });

  test("openai-compatible needs both key and baseURL", () => {
    const keyOnly = setup({ keys: ["openai-compatible"] });
    expect(keyOnly.some((e) => e.providerId === "openai-compatible")).toBe(false);
    const keyPlusURL = setup({
      keys: ["openai-compatible"],
      baseURLs: { "openai-compatible": "https://x.example/v1" },
    });
    expect(keyPlusURL.some((e) => e.providerId === "openai-compatible")).toBe(true);
  });
});

describe("filterModelEntries", () => {
  const entries: ModelPickerEntry[] = [
    { providerId: "opencode-zen", model: "deepseek-v4-pro" },
    { providerId: "openai", model: "gpt-5.6-terra" },
    { providerId: "mistral", model: "mistral-small-latest" },
  ];

  test("empty query returns the list as-is", () => {
    expect(filterModelEntries(entries, "")).toBe(entries);
    expect(filterModelEntries(entries, "   ")).toEqual(entries);
  });

  test("case-insensitive substring over model id", () => {
    expect(filterModelEntries(entries, "GPT").map((e) => e.model)).toEqual(["gpt-5.6-terra"]);
    expect(filterModelEntries(entries, "latest").map((e) => e.model)).toEqual([
      "mistral-small-latest",
    ]);
  });

  test("provider id narrows to that section", () => {
    expect(filterModelEntries(entries, "mistral").map((e) => e.model)).toEqual([
      "mistral-small-latest",
    ]);
  });

  test("no match yields an empty list", () => {
    expect(filterModelEntries(entries, "zzz-no-such-model")).toEqual([]);
  });
});

describe("pickerWindow", () => {
  test("short lists render whole (no clipping indicators)", () => {
    expect(pickerWindow(0, 0)).toEqual({ start: 0, end: 0 });
    expect(pickerWindow(7, 0)).toEqual({ start: 0, end: 7 });
    expect(pickerWindow(MODEL_PICKER_VISIBLE, 9)).toEqual({
      start: 0,
      end: MODEL_PICKER_VISIBLE,
    });
  });

  test("long lists scroll with the highlight, pinned at both ends", () => {
    const total = 60;
    // Top: pinned, highlight visible at the top.
    expect(pickerWindow(total, 0)).toEqual({ start: 0, end: MODEL_PICKER_VISIBLE });
    // Middle: highlight stays inside the window.
    const mid = pickerWindow(total, 30);
    expect(mid.end - mid.start).toBe(MODEL_PICKER_VISIBLE);
    expect(mid.start).toBeLessThanOrEqual(30);
    expect(30).toBeLessThan(mid.end);
    // Bottom: pinned to the end.
    expect(pickerWindow(total, 59)).toEqual({
      start: total - MODEL_PICKER_VISIBLE,
      end: total,
    });
    // Out-of-range highlights clamp instead of producing NaN.
    expect(pickerWindow(total, -5)).toEqual({ start: 0, end: MODEL_PICKER_VISIBLE });
    expect(pickerWindow(total, 999)).toEqual({
      start: total - MODEL_PICKER_VISIBLE,
      end: total,
    });
  });
});
