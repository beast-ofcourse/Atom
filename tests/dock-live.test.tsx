// Phase 3 items 3.2 + 3.3 + 3.4 — live dock pills unit tests.
//
// buildDockPills is pure (same data as StatusBarHost, formatting via
// src/ui/pills.js helpers): live content, drop order goal → branch → mode
// at narrow widths, xs floor (model + token only), busy/approval/stall
// states, plus the display-only action-chip array and one Dock render
// proving the Composer + pills + chips composition.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import {
  buildDockPills,
  DOCK_ACTIONS,
  type DockPillInput,
} from "../src/App.js";
import { Dock, type Pill } from "../src/ui/components/Dock.js";
import { Composer } from "../src/ui/components/Composer.js";
import { formatStatusTokenSegment } from "../src/ui/pills.js";

function baseInput(over: Partial<DockPillInput> = {}): DockPillInput {
  return {
    provider: "opencode-zen",
    model: "big-pickle",
    usageTotals: null,
    contextLoad: null,
    loadEstimated: null,
    branch: "main",
    mode: "normal",
    trustAll: false,
    busy: false,
    elapsedSecs: 0,
    stalled: false,
    approvalPending: false,
    goal: null,
    columns: 100,
    ...over,
  };
}

function keysOf(pills: Pill[]): string[] {
  return pills.map((p) => p.key);
}

function frameOf(pills: Pill[], columns: number): string {
  const app = render(
    <Dock
      inputZone={
        <Composer input="hello dock" cursor={10} columns={80} framed={false} />
      }
      pills={pills}
      actions={DOCK_ACTIONS}
      state={{ busy: false, columns }}
    />,
  );
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

describe("dock live pills content (Phase 3.2)", () => {
  test("idle pills carry live model/token/branch/mode values", () => {
    const pills = buildDockPills(baseInput());
    expect(keysOf(pills)).toEqual(["model", "token", "branch", "mode"]);
    const byKey = Object.fromEntries(pills.map((p) => [p.key, p]));
    expect(byKey.model!.value).toBe("opencode-zen/big-pickle");
    expect(byKey.token!.value).toBe("n/a");
    expect(byKey.branch!.value).toBe("main");
    expect(byKey.mode!.value).toBe("normal");
  });

  test("token pill reuses the StatusBar formatter (same data, stripped label)", () => {
    for (const input of [
      baseInput(),
      baseInput({
        usageTotals: { total_tokens: 45056 },
        contextLoad: 45056,
        loadEstimated: true,
      }),
    ]) {
      const [token] = buildDockPills(input).filter((p) => p.key === "token");
      expect(token!.label).toBe("token:");
      expect(token!.value).toBe(
        formatStatusTokenSegment(
          input.usageTotals,
          input.model,
          input.contextLoad,
          input.loadEstimated,
        ).replace(/^token: /, ""),
      );
    }
    // Estimated load keeps the (~P%) honesty marker behind the label.
    const est = buildDockPills(
      baseInput({
        usageTotals: { total_tokens: 45056 },
        contextLoad: 45056,
        loadEstimated: true,
      }),
    ).find((p) => p.key === "token")!;
    expect(est.value).toBe("44K");
  });

  test("goal pill mirrors StatusBar state text, truncates long objectives", () => {
    const active = buildDockPills(
      baseInput({
        branch: null,
        goal: { objective: "Ship v2", active: true },
        columns: 120,
      }),
    ).find((p) => p.key === "goal")!;
    expect(active.value).toBe("Ship v2 [active]");
    const paused = buildDockPills(
      baseInput({
        branch: null,
        goal: { objective: "Ship v2", active: false },
        columns: 120,
      }),
    ).find((p) => p.key === "goal")!;
    expect(paused.value).toBe("Ship v2 [paused]");
    const long = buildDockPills(
      baseInput({
        branch: null,
        goal: { objective: "x".repeat(100), active: true },
        columns: 120,
      }),
    ).find((p) => p.key === "goal")!;
    expect(long.value).toContain("…");
    expect(long.value).toContain("[active]");
  });

  test("trust suffix follows the status-bar rule (hidden in plan mode)", () => {
    const trusted = buildDockPills(baseInput({ trustAll: true })).find(
      (p) => p.key === "mode",
    )!;
    expect(trusted.value).toBe("normal+trust");
    const plan = buildDockPills(
      baseInput({ trustAll: true, mode: "plan" }),
    ).find((p) => p.key === "mode")!;
    expect(plan.value).toBe("plan");
  });
});

describe("dock drop order at narrow widths (Phase 3.2)", () => {
  // Fat values so each width step drops exactly one more pill.
  const fat = () =>
    baseInput({ branch: "feature/ember-dock", columns: 110 });

  test("wide keeps branch+mode, goal yields first", () => {
    expect(keysOf(buildDockPills(fat()))).toEqual([
      "model",
      "token",
      "branch",
      "mode",
    ]);
  });

  test("narrower drops branch, mode stays", () => {
    expect(keysOf(buildDockPills(fat()))).toContain("mode");
    expect(keysOf(buildDockPills(baseInput({ ...fat(), columns: 70 })))).toEqual(
      ["model", "token", "mode"],
    );
  });

  test("starved drops mode too, model+token pin", () => {
    expect(
      keysOf(buildDockPills(baseInput({ ...fat(), columns: 60 }))),
    ).toEqual(["model", "token"]);
  });

  test("drop order invariant holds across every width", () => {
    for (let columns = 40; columns <= 130; columns += 1) {
      const keys = keysOf(
        buildDockPills(
          baseInput({
            branch: "feature/ember-dock",
            goal: { objective: "x".repeat(30), active: true },
            columns,
          }),
        ),
      );
      // Model + token never drop.
      expect(keys).toContain("model");
      expect(keys).toContain("token");
      // Drop order goal → branch → mode (mode drops last): branch present
      // implies mode present; mode absent implies goal and branch absent.
      // Goal is a width-guest and may yield even while branch stays, so
      // branch present does NOT imply goal present.
      if (keys.includes("branch")) expect(keys).toContain("mode");
      if (!keys.includes("mode")) {
        expect(keys).not.toContain("goal");
        expect(keys).not.toContain("branch");
      }
      // Display order always model, token, goal?, branch?, mode?, states.
      const order = ["model", "token", "goal", "branch", "mode"];
      const present = keys.filter((k) => order.includes(k));
      expect([...present].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(present);
    }
  });

  test("xs floor renders model + token only, even when busy with approval", () => {
    const pills = buildDockPills(
      baseInput({
        busy: true,
        elapsedSecs: 8,
        stalled: true,
        approvalPending: true,
        branch: "main",
        goal: { objective: "Ship v2", active: true },
        columns: 40,
      }),
    );
    expect(keysOf(pills)).toEqual(["model", "token"]);
  });
});

describe("dock busy/approval states (Phase 3.2)", () => {
  test("busy pins the elapsed clock pill", () => {
    const pills = buildDockPills(
      baseInput({ busy: true, elapsedSecs: 8, columns: 120, branch: null }),
    );
    const elapsed = pills.find((p) => p.key === "elapsed")!;
    expect(elapsed.value).toBe("8s");
  });

  test("approval pins a waiting-approval pill", () => {
    const pills = buildDockPills(
      baseInput({ approvalPending: true, columns: 120, branch: null }),
    );
    const approval = pills.find((p) => p.key === "approval")!;
    expect(`${approval.label} ${approval.value}`).toBe("waiting approval");
  });

  test("stall shows waiting unless approval owns the keyboard", () => {
    const stalled = buildDockPills(
      baseInput({ stalled: true, columns: 120, branch: null }),
    ).find((p) => p.key === "stalled")!;
    expect(stalled.label).toBe("waiting");
    const withApproval = buildDockPills(
      baseInput({
        stalled: true,
        approvalPending: true,
        columns: 120,
        branch: null,
      }),
    );
    expect(keysOf(withApproval)).not.toContain("stalled");
    expect(keysOf(withApproval)).toContain("approval");
  });

  test("state pills pin under width pressure (never drop)", () => {
    const pills = buildDockPills(
      baseInput({
        branch: "feature/ember-dock",
        busy: true,
        elapsedSecs: 8,
        approvalPending: true,
        columns: 60,
      }),
    );
    expect(keysOf(pills)).toContain("elapsed");
    expect(keysOf(pills)).toContain("approval");
    expect(keysOf(pills)).toContain("model");
    expect(keysOf(pills)).toContain("token");
  });
});

describe("dock action chips + composition (Phase 3.3)", () => {
  test("chips come from the data array, display only", () => {
    expect(DOCK_ACTIONS.map((a) => a.command)).toEqual([
      "model",
      "provider",
      "goal",
      "help",
    ]);
  });

  test("Dock renders Composer inputZone + live pills + chips in the frame", () => {
    const flat = frameOf(buildDockPills(baseInput({ columns: 80 })), 80).replace(
      /\s+/g,
      " ",
    );
    expect(flat).toContain("hello dock");
    expect(flat).toContain("opencode-zen/big-pickle");
    expect(flat).toContain("mode: normal");
    expect(flat).toContain("/model");
    expect(flat).toContain("/provider");
    expect(flat).toContain("/goal");
    expect(flat).toContain("/help");
  });
});
