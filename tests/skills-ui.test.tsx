// /skill TUI test: the unified command renders the registry header with
// zero fetches (pure local filesystem read). The header always renders, so
// the assertion holds regardless of what lives in ~/.claude/skills on the
// machine running the suite.
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { waitForFrame, waitForFrameAbsent } from "./helpers/wait-for-frame.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});



function baseProps() {
  return {
    apiKey: "test-key",
    endpoint: ENDPOINT,
    initialModel: "big-pickle",
    initialModels: ["big-pickle"],
  };
}

describe("/skill", () => {
  test("renders the registry header with zero fetches", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch call (local commands must be zero-fetch)");
    });
    globalThis.fetch = fetchMock;
    const app = render(<App {...baseProps()} />);
    try {
      app.stdin.write("/skill");
      app.stdin.write("\r");
      await waitForFrame(app, "Skills (");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      app.unmount();
    }
  });
});
