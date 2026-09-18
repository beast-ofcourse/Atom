// Phase 3 item 3.1 — borderless (framed) mode for Composer + InputBox.
// framed defaults true (standalone frame byte-identical);
// framed={false} suppresses border/padding for docked use.
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { Composer } from "../src/ui/components/Composer.js";
import { InputBox } from "../src/ui/input.js";

const FRAME_GLYPHS = ["╭", "╮", "╰", "╯"];

function frameOf(node: React.ReactElement): string {
  const app = render(node);
  const frame = app.lastFrame() ?? "";
  app.unmount();
  return frame;
}

function hasFrame(frame: string): boolean {
  return FRAME_GLYPHS.some((g) => frame.includes(g));
}

describe("InputBox framed mode (Phase 3.1)", () => {
  test("framed default is unchanged (omitted == framed={true}, byte-identical)", () => {
    const a = frameOf(<InputBox input="draft idle text" cursor={15} columns={80} />);
    const b = frameOf(
      <InputBox input="draft idle text" cursor={15} columns={80} framed />,
    );
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
    expect(hasFrame(a)).toBe(true);
  });

  test("framed={false} renders without frame but keeps text", () => {
    const framed = frameOf(
      <InputBox input="draft idle text" cursor={15} columns={80} />,
    );
    const borderless = frameOf(
      <InputBox input="draft idle text" cursor={15} columns={80} framed={false} />,
    );
    expect(hasFrame(borderless)).toBe(false);
    expect(borderless).toContain("draft idle text");
    expect(borderless).toContain("›");
    // Borderless drops at least the top+bottom border rows.
    expect(borderless.split("\n").length).toBeLessThan(
      framed.split("\n").length,
    );
  });
});

describe("Composer framed mode (Phase 3.1)", () => {
  test("framed default is unchanged (omitted == framed={true}, byte-identical)", () => {
    const a = frameOf(<Composer input="draft idle text" cursor={15} columns={80} />);
    const b = frameOf(
      <Composer input="draft idle text" cursor={15} columns={80} framed />,
    );
    expect(a).toBe(b);
    expect(hasFrame(a)).toBe(true);
  });

  test("framed={false} renders without frame but keeps text + indicator lines", () => {
    const borderless = frameOf(
      <Composer
        input="draft idle text"
        cursor={15}
        columns={80}
        framed={false}
        queue={["follow-up one"]}
        steerPending="steer text"
      />,
    );
    expect(hasFrame(borderless)).toBe(false);
    expect(borderless).toContain("draft idle text");
    expect(borderless).toContain("Queued (1): follow-up one");
    expect(borderless).toContain("Steering: steer text");
  });
});
