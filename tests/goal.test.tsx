// Ticket 01 goal tests: set / status / clear / replace / clear-when-absent
// plus ordinary-messages-untouched. Follows the tests/smoothness.test.tsx
// autoscroll-block pattern (render App, write stdin, waitForFrame).
// Network is ALWAYS mocked here — never hit live APIs.
import { afterEach, describe, expect, test, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import {
  goalClearNotice,
  goalSetNotice,
  goalStatusText,
  parseGoalCommand,
} from "../src/goal.js";

const ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 5000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}:\n${app.lastFrame()}`
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function mountApp() {
  return render(
    <App
      apiKey="test-key"
      endpoint={ENDPOINT}
      initialModel="big-pickle"
      initialModels={["big-pickle"]}
    />
  );
}

async function submitLine(
  app: { stdin: { write: (s: string) => void } },
  line: string
): Promise<void> {
  app.stdin.write(line);
  await new Promise((r) => setTimeout(r, 40));
  app.stdin.write("\r");
  await new Promise((r) => setTimeout(r, 40));
}

describe("goal state helpers (pure, no TUI)", () => {
  test("parse: bare shows status, clear ends, rest is the objective verbatim", () => {
    expect(parseGoalCommand("/goal")).toEqual({ kind: "status" });
    expect(parseGoalCommand("/goal   ")).toEqual({ kind: "status" });
    expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
    expect(parseGoalCommand("/goal CLEAR")).toEqual({ kind: "clear" });
    expect(parseGoalCommand("/goal Ship v2")).toEqual({
      kind: "set",
      objective: "Ship v2",
    });
  });

  test("status carries text plus state, or the none-hint when absent", () => {
    expect(goalStatusText(null)).toContain("set one with /goal");
    const shown = goalStatusText({ objective: "Ship v2", active: true });
    expect(shown).toContain("Ship v2");
    expect(shown).toContain("active");
  });

  test("set echoes; replace names both; clear is harmless when absent", () => {
    expect(goalSetNotice("Ship v2", null)).toContain("Ship v2");
    const replaced = goalSetNotice("B", { objective: "A", active: true });
    expect(replaced).toContain("replaced");
    expect(replaced).toContain("A");
    expect(replaced).toContain("B");
    expect(goalClearNotice(null)).toContain("nothing to clear");
    const cleared = goalClearNotice({ objective: "Ship v2", active: true });
    expect(cleared).toContain("cleared");
    expect(cleared).toContain("Ship v2");
  });
});

describe("goal command", () => {
  test("set echoes the objective; bare shows text plus state", async () => {
    const app = mountApp();
    try {
      await submitLine(app, "/goal Ship v2");
      await waitForFrame(app, "goal set");
      await waitForFrame(app, "Ship v2");
      await submitLine(app, "/goal");
      await waitForFrame(app, "active");
      expect(app.lastFrame()).toContain("Ship v2");
    } finally {
      app.unmount();
    }
  });

  test("bare with no goal shows the none-hint", async () => {
    const app = mountApp();
    try {
      await submitLine(app, "/goal");
      await waitForFrame(app, "set one with /goal");
    } finally {
      app.unmount();
    }
  });

  test("second set replaces the first with a visible notice", async () => {
    const app = mountApp();
    try {
      await submitLine(app, "/goal First thing");
      await waitForFrame(app, "First thing");
      await submitLine(app, "/goal Second thing");
      await waitForFrame(app, "replaced");
      await waitForFrame(app, "Second thing");
      // Status now shows the replacement, not the original.
      await submitLine(app, "/goal");
      await waitForFrame(app, "Second thing");
      expect(app.lastFrame()).toContain("Second thing");
    } finally {
      app.unmount();
    }
  });

  test("clear ends the goal; status after shows the none-hint", async () => {
    const app = mountApp();
    try {
      await submitLine(app, "/goal Ship v2");
      await waitForFrame(app, "Ship v2");
      await submitLine(app, "/goal clear");
      await waitForFrame(app, "cleared");
      await submitLine(app, "/goal");
      await waitForFrame(app, "set one with /goal");
    } finally {
      app.unmount();
    }
  });

  test("clear with no goal is a harmless notice", async () => {
    const app = mountApp();
    try {
      await submitLine(app, "/goal clear");
      await waitForFrame(app, "nothing to clear");
      await submitLine(app, "/goal");
      await waitForFrame(app, "set one with /goal");
    } finally {
      app.unmount();
    }
  });

  test("ordinary messages never touch goal state (runs while busy)", async () => {
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}) // never resolves: turn stays busy
    );
    const app = mountApp();
    try {
      await submitLine(app, "/goal Ship v2");
      await waitForFrame(app, "Ship v2");
      await submitLine(app, "hello there");
      await waitForFrame(app, "thinking…");
      // View/state-only like /autoscroll: status still works mid-turn and
      // the ordinary message left the goal intact.
      await submitLine(app, "/goal");
      await waitForFrame(app, "active");
      expect(app.lastFrame()).toContain("Ship v2");
    } finally {
      app.unmount();
    }
  });
});
