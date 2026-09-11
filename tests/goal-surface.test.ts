// Ticket 09 goal-surface tests: status-bar segment, telemetry goal fields,
// dashboard conditional render, and /help registry pinning. All hermetic
// (pure renders + in-memory recorder, no TUI, no network).
import { describe, expect, test } from "vitest";
import {
  fitGoalSegment,
  formatGoalSegment,
  truncateGoalObjective,
} from "../src/ui/status-bar.js";
import {
  cleanGoalSnapshot,
  createTelemetryRecorder,
  summarizeTelemetry,
} from "../src/telemetry.js";
import { buildDashboardHtml } from "../src/telemetry-dashboard.js";
import {
  GOAL_USAGE,
  commandUsage,
  helpListText,
  SLASH_COMMANDS,
} from "../src/App.js";

describe("goal status segment", () => {
  test("active goal renders compact segment with state marker", () => {
    expect(formatGoalSegment({ objective: "Ship v2", active: true })).toBe(
      "goal: Ship v2 [active]"
    );
  });

  test("paused reads distinct from active", () => {
    expect(formatGoalSegment({ objective: "Ship v2", active: false })).toBe(
      "goal: Ship v2 [paused]"
    );
  });

  test("no goal renders nothing (null segment)", () => {
    expect(formatGoalSegment(null)).toBeNull();
    expect(formatGoalSegment(undefined as never)).toBeNull();
    expect(formatGoalSegment({ objective: "", active: true })).toBeNull();
  });

  test("long objectives truncate with ellipsis tail", () => {
    const long = "x".repeat(100);
    const seg = formatGoalSegment({ objective: long, active: true });
    expect(seg).not.toBeNull();
    expect(seg!.length).toBeLessThan(`goal: ${long} [active]`.length);
    expect(seg).toContain("…");
    expect(seg).toContain("[active]");
  });

  test("truncateGoalObjective keeps short text verbatim", () => {
    expect(truncateGoalObjective("Ship v2")).toBe("Ship v2");
  });

  test("fitGoalSegment drops whole when no room (never displaces)", () => {
    const goal = { objective: "Ship v2", active: true };
    expect(fitGoalSegment(goal, 0)).toBeNull();
    expect(fitGoalSegment(goal, 4)).toBeNull();
    expect(fitGoalSegment(null, 100)).toBeNull();
  });

  test("fitGoalSegment keeps full text when it fits", () => {
    const goal = { objective: "Ship v2", active: false };
    expect(fitGoalSegment(goal, 200)).toBe("goal: Ship v2 [paused]");
  });

  test("busy bar keeps the full phase text when the goal cannot fit beside it", async () => {
    // Regression pin: at narrow widths the busy goal segment drops whole
    // instead of starving the activity/phase text (a TUI pause-mid-run
    // test waits on the lowercase "thinking…" phase paint).
    const { render } = await import("ink-testing-library");
    const { StatusBar } = await import("../src/ui/status-bar.js");
    const base = {
      provider: "p",
      model: "m",
      usageTotals: null,
      contextLoad: null,
      reasoningDisplay: "auto",
      mode: "normal",
      trustAll: false,
      busy: true,
      activity: null,
      phaseLabel: "thinking…",
      elapsedSecs: 12,
      stalled: false,
      approvalPending: false,
    } as const;
    const narrow = render(
      (await import("react")).createElement(StatusBar, {
        ...base,
        columns: 100,
        goal: { objective: "pause-keeps-qqq", active: true },
      })
    );
    try {
      expect(narrow.lastFrame()).toContain("thinking…");
    } finally {
      narrow.unmount();
    }
    const wide = render(
      (await import("react")).createElement(StatusBar, {
        ...base,
        columns: 200,
        goal: { objective: "pause-keeps-qqq", active: true },
      })
    );
    try {
      expect(wide.lastFrame()).toContain("goal: pause-keeps-qqq [active]");
      expect(wide.lastFrame()).toContain("thinking…");
    } finally {
      wide.unmount();
    }
  });
});

describe("goal telemetry fields", () => {
  test("cleanGoalSnapshot keeps objective + flag + counters", () => {
    const snap = cleanGoalSnapshot({
      objective: "Ship v2",
      active: true,
      turns: 2,
      requests: 5,
      tokens: 1200,
      workMs: 9000,
    });
    expect(snap).toEqual({
      objective: "Ship v2",
      active: true,
      turns: 2,
      requests: 5,
      tokens: 1200,
      workMs: 9000,
    });
  });

  test("cleanGoalSnapshot is tolerant (absent/malformed reads as no-goal)", () => {
    expect(cleanGoalSnapshot(undefined)).toBeUndefined();
    expect(cleanGoalSnapshot(null)).toBeUndefined();
    expect(cleanGoalSnapshot({})).toBeUndefined();
    expect(cleanGoalSnapshot({ objective: "", active: true })).toBeUndefined();
    expect(cleanGoalSnapshot("Ship v2")).toBeUndefined();
  });

  test("recorder carries the goal snapshot onto the turn trace", () => {
    const rec = createTelemetryRecorder({ enabled: true, now: () => 1000 });
    const id = rec.startTurn("do it", {
      provider: "p",
      model: "m",
      effort: "auto",
      mode: "normal",
      goal: { objective: "Ship v2", active: true, turns: 1 },
    });
    expect(id).not.toBeNull();
    rec.endTurn(id, "completed", "done");
    const snap = rec.getSnapshot();
    expect(snap.turns).toHaveLength(1);
    expect(snap.turns[0]!.goal?.objective).toBe("Ship v2");
    expect(snap.turns[0]!.goal?.active).toBe(true);
  });

  test("recorder omits the goal field with no live goal (never a fake claim)", () => {
    const rec = createTelemetryRecorder({ enabled: true, now: () => 1000 });
    const id = rec.startTurn("hi", {
      provider: "p",
      model: "m",
      effort: "auto",
      mode: "normal",
    });
    rec.endTurn(id, "completed", "hi");
    expect(rec.getSnapshot().turns[0]!.goal).toBeUndefined();
  });

  test("summarizeTelemetry counts goal-engaged turns", () => {
    const withGoal = createTelemetryRecorder({ enabled: true, now: () => 1000 });
    const a = withGoal.startTurn("do it", {
      provider: "p",
      model: "m",
      effort: "auto",
      mode: "normal",
      goal: { objective: "Ship v2", active: false },
    });
    withGoal.endTurn(a, "completed", "done");
    const plain = createTelemetryRecorder({ enabled: true, now: () => 1000 });
    const b = plain.startTurn("hi", {
      provider: "p",
      model: "m",
      effort: "auto",
      mode: "normal",
    });
    plain.endTurn(b, "completed", "hi");
    const agg = summarizeTelemetry([withGoal.getSnapshot(), plain.getSnapshot()]);
    expect(agg.turns).toBe(2);
    expect(agg.goalTurns).toBe(1);
  });
});

describe("goal dashboard fragments", () => {
  function sessionWithGoal(active: boolean) {
    const rec = createTelemetryRecorder({ enabled: true, now: () => 1000 });
    const id = rec.startTurn("do it", {
      provider: "p",
      model: "m",
      effort: "auto",
      mode: "normal",
      goal: { objective: "Ship v2", active, turns: 1, requests: 2 },
    });
    rec.endTurn(id, "completed", "done");
    return rec.getSnapshot();
  }

  function sessionWithoutGoal() {
    const rec = createTelemetryRecorder({ enabled: true, now: () => 1000 });
    const id = rec.startTurn("hi", {
      provider: "p",
      model: "m",
      effort: "auto",
      mode: "normal",
    });
    rec.endTurn(id, "completed", "hi");
    return rec.getSnapshot();
  }

  test("goal card + turn fragment render only when a goal was present", () => {
    const html = buildDashboardHtml([sessionWithGoal(true)]);
    expect(html).toContain("Goal turns");
    expect(html).toContain("Ship v2");
    expect(html).toContain("active");
  });

  test("paused state renders distinctly in the turn fragment", () => {
    const html = buildDashboardHtml([sessionWithGoal(false)]);
    expect(html).toContain("paused");
  });

  test("zero goal turns omit the card entirely (no fake claim)", () => {
    const html = buildDashboardHtml([sessionWithoutGoal()]);
    expect(html).not.toContain("Goal turns");
  });
});

describe("/help goal entry", () => {
  test("/goal is registered with subcommand descriptions", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === "/goal");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toContain("pause");
    expect(cmd!.description).toContain("resume");
    expect(cmd!.description).toContain("clear");
  });

  test("generated help text lists /goal with the accurate paragraph", () => {
    const help = helpListText();
    expect(help).toContain("/goal");
    expect(help).toContain("/goal resume");
    expect(help).toContain("/goal clear");
    expect(help).toContain("no turn cap");
  });

  test("commandUsage reuses the exact /goal usage string", () => {
    expect(commandUsage("/goal")).toBe(GOAL_USAGE);
    expect(GOAL_USAGE).toContain("/goal pause");
    expect(GOAL_USAGE).toContain("/goal resume");
  });
});
