// Submit-time pipeline order (ticket 02): pins the submit sequence
// permissions → context assembly → budget check → loop entry as an explicit
// ordered pipeline with a stated rollback-scope rule per stage.
// Structure-only pin: no behavior change — it fails if a stage is reordered,
// renamed, or loses its rollback rule, and if the matching `SUBMIT STAGE`
// markers inside submit() stop appearing in the same order.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBMIT_PIPELINE_STAGES } from "../src/App.js";

const WANT_ORDER = ["permissions", "context-assembly", "budget-check", "loop-entry"] as const;

describe("submit-time pipeline order", () => {
  test("descriptor pins the four stages in order, each with a rollback-scope rule", () => {
    expect(SUBMIT_PIPELINE_STAGES.map((s) => s.name)).toEqual([...WANT_ORDER]);
    for (const stage of SUBMIT_PIPELINE_STAGES) {
      expect(typeof stage.rollbackScope).toBe("string");
      expect(stage.rollbackScope.length).toBeGreaterThan(0);
    }
  });

  test("submit() implements the stages in the same order (marker scan, no behavior change)", () => {
    const src = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
    const submitIdx = src.indexOf("async function submit(value: string)");
    expect(submitIdx).toBeGreaterThan(-1);
    const body = src.slice(submitIdx);
    const markers = WANT_ORDER.map((_, i) => `SUBMIT STAGE ${i + 1}/4`);
    const positions = markers.map((m) => body.indexOf(m));
    for (const [i, pos] of positions.entries()) {
      expect(pos, `missing marker: ${markers[i]}`).toBeGreaterThan(-1);
    }
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
    // Each marker names its stage, so the scan pins stage-to-position too.
    for (const [i, name] of WANT_ORDER.entries()) {
      expect(body.slice(positions[i], positions[i]! + 120)).toContain(name);
    }
  });
});
