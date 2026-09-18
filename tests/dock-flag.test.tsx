// Phase 2 item 2.3 + Phase 3 items 3.2/3.3/3.4 — ATOM_DOCK flag: default
// renders legacy footer byte-identically, flag-on renders the live dock
// (real Composer + live pills + action chips + legacy overlays above).
// Runs alongside tests/footer-baseline.test.tsx only. Full-App mount (same
// hermetic baseProps pattern as tests/app.test.tsx): initialModels skips live
// discovery so no network is touched.
import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { isDockEnabled } from "../src/ui/dock-flag.js";

const MODELS = ["big-pickle", "kimi-k2.5", "glm-5.3-flash"];
const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";

const SAVED_DOCK = process.env.ATOM_DOCK;

afterEach(() => {
  if (SAVED_DOCK === undefined) delete process.env.ATOM_DOCK;
  else process.env.ATOM_DOCK = SAVED_DOCK;
});

function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialProvider: "opencode-zen" as const,
    initialModel: "big-pickle",
    initialModels: MODELS,
  };
}

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 5000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const frame = app.lastFrame() ?? "";
    if (frame.includes(needle)) return frame;
    if (Date.now() - start > timeout) {
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}:\n${frame}`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("ATOM_DOCK flag (Phase 2.3)", () => {
  test("flag parsing: unset/0/other off, exact 1 on", () => {
    expect(isDockEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isDockEnabled({ ATOM_DOCK: "0" })).toBe(false);
    expect(isDockEnabled({ ATOM_DOCK: "true" })).toBe(false);
    expect(isDockEnabled({ ATOM_DOCK: "1" })).toBe(true);
  });

  test("flag-off (unset vs 0) pixels unchanged: legacy footer, no dock frame", async () => {
    delete process.env.ATOM_DOCK;
    const offUnset = render(<App {...baseProps()} />);
    let frameUnset = "";
    try {
      frameUnset = await waitForFrame(offUnset, "big-pickle");
    } finally {
      offUnset.unmount();
    }

    process.env.ATOM_DOCK = "0";
    const offZero = render(<App {...baseProps()} />);
    let frameZero = "";
    try {
      frameZero = await waitForFrame(offZero, "big-pickle");
    } finally {
      offZero.unmount();
    }

    for (const frame of [frameUnset, frameZero]) {
      expect(frame).toContain("big-pickle");
      expect(frame).toContain("mode: normal");
      expect(frame).not.toContain("dock preview");
      expect(frame).not.toContain("dock-model");
    }
    expect(frameZero).toBe(frameUnset);
  });

  test("flag-on renders the live dock (Composer + live pills + chips)", async () => {
    process.env.ATOM_DOCK = "1";
    const app = render(<App {...baseProps()} />);
    try {
      const frame = await waitForFrame(app, "big-pickle");
      // Dock frame present with live model pill (provider/model, same data
      // as the legacy status bar) plus token + mode pills.
      expect(frame).toContain("╭");
      expect(frame).toContain("opencode-zen/big-pickle");
      expect(frame).toContain("token: n/a");
      expect(frame).toContain("mode: normal");
      // Display-only action chips from the data array.
      expect(frame).toContain("/model");
      expect(frame).toContain("/provider");
      expect(frame).toContain("/goal");
      expect(frame).toContain("/help");
      // Phase 2 static placeholder is gone (live wiring replaced it).
      expect(frame).not.toContain("dock preview");
      expect(frame).not.toContain("dock-model");
    } finally {
      app.unmount();
    }
  });
});
