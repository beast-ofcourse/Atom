// Status-bar unit tests: quiet positional layout, cwd shortening, branch
// conditionality, and busy-state prioritization. App-level segment pins
// live in tests/status.test.tsx.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar, shortenCwd } from "../src/ui/status-bar.js";

function frameOf(node: React.ReactNode): string {
  const app = render(<>{node}</>);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

const base = {
  provider: "opencode-zen",
  model: "big-pickle",
  usageTotals: null,
  contextLoad: null,
  reasoningDisplay: "default",
  mode: "normal",
  trustAll: false,
  phaseLabel: "thinking…",
  elapsedSecs: 0,
  stalled: false,
  approvalPending: false,
};

describe("shortenCwd", () => {
  test("home collapses and long tails cut", () => {
    expect(shortenCwd("/home/u/p", "/home/u")).toBe("~/p");
    expect(shortenCwd("/x/y", "/home/u")).toBe("/x/y");
    const long = `/home/u/${"a".repeat(40)}`;
    const short = shortenCwd(long, "/home/u");
    expect(short.length).toBeLessThanOrEqual(20);
    expect(short.startsWith("…/")).toBe(true);
  });
  test("location yields under width pressure, fixed segments never do", () => {
    const wide = frameOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch="main" columns={200} />
    );
    expect(wide).toContain("~/proj : main");
    // Tight: branch drops first, cwd tail shrinks, mode stays contiguous.
    const tight = frameOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch="main" columns={85} />
    );
    expect(tight).not.toContain(": main");
    expect(tight).toContain("mode: normal");
    // Starved: the whole location drops rather than wrap fixed segments.
    const starved = frameOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch="main" columns={40} />
    );
    expect(starved).not.toContain("~/proj");
    expect(starved).toContain("mode: normal");
  });
});

describe("idle layout", () => {
  test("positional segments, branch only for repos", () => {
    const frame = frameOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch="main" />
    );
    expect(frame).toContain("opencode-zen/big-pickle");
    expect(frame).toContain("token: n/a");
    expect(frame).toContain("~/proj : main");
    expect(frame).toContain("reasoning: default");
    expect(frame).toContain("mode: normal");
    expect(frame).not.toContain("provider:");
    const bare = frameOf(
      <StatusBar {...base} busy={false} activity={null} cwd="~/proj" branch={null} />
    );
    expect(bare).toContain("~/proj");
    expect(bare).not.toContain(" : ");
  });
});

describe("busy layout", () => {
  test("activity, clock, token, and interrupt hint only", () => {
    const frame = frameOf(
      <StatusBar
        {...base}
        busy
        activity="Reading src/x.ts"
        elapsedSecs={12}
        cwd="~/proj"
        branch="main"
      />
    );
    expect(frame).toContain("Reading src/x.ts");
    expect(frame).toContain("12s");
    expect(frame).toContain("esc stops");
    expect(frame).not.toContain("big-pickle");
    expect(frame).not.toContain("~/proj");
  });
  test("phase label fallback when no activity text", () => {
    const frame = frameOf(
      <StatusBar {...base} busy activity={null} elapsedSecs={3} cwd="" branch={null} />
    );
    expect(frame).toContain("thinking…");
  });
});
