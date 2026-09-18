// Phase 4 item 4.1 + Phase 3 items 3.2/3.3/3.4 — ATOM_DOCK flag: default
// renders the live dock (real Composer + live pills + action chips +
// legacy overlays above), exact "0" opts back to the legacy footer
// byte-identically.
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

describe("ATOM_DOCK flag (Phase 4.1)", () => {
  test("flag parsing: only exact 0 opts out, default on", () => {
    expect(isDockEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isDockEnabled({ ATOM_DOCK: "0" })).toBe(false);
    expect(isDockEnabled({ ATOM_DOCK: "true" })).toBe(true);
    expect(isDockEnabled({ ATOM_DOCK: "1" })).toBe(true);
    expect(isDockEnabled({ ATOM_DOCK: "" })).toBe(true);
  });

  test("opt-out (=0) renders the legacy footer, no dock frame", async () => {
    process.env.ATOM_DOCK = "0";
    const app = render(<App {...baseProps()} />);
    try {
      const frame = await waitForFrame(app, "big-pickle");
      expect(frame).toContain("big-pickle");
      expect(frame).toContain("mode: normal");
      // Legacy status bar present (reasoning segment lives only there),
      // dock display-only action chips absent.
      expect(frame).toContain("reasoning:");
      expect(frame).not.toContain("/provider");
      expect(frame).not.toContain("/goal");
      // Phase 2 static placeholder is gone (live wiring replaced it).
      expect(frame).not.toContain("dock preview");
      expect(frame).not.toContain("dock-model");
    } finally {
      app.unmount();
    }
  });

  test.each([["unset", undefined], ["flag-on (=1)", "1"], ["other (true)", "true"]] as const)(
    "default-on renders the live dock (%s: Composer + live pills + chips)",
    async (_label, value) => {
      if (value === undefined) delete process.env.ATOM_DOCK;
      else process.env.ATOM_DOCK = value;
      const app = render(<App {...baseProps()} />);
      try {
        const frame = await waitForFrame(app, "big-pickle");
      // Dock frame present with live model pill (provider/model, same data
      // as the legacy status bar) plus token + mode pills.
      expect(frame).toContain("╭");
      expect(frame).toContain("opencode-zen/big-pickle");
      expect(frame).toContain("token: n/a");
      expect(frame).toContain("mode: normal");
      // Reasoning pill lives in the dock (parity with legacy status bar).
      expect(frame).toContain("reasoning:");
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
  },
  );
});
