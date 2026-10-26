// Mermaid subset: parse + layout + decline contract.
import { describe, expect, test } from "vitest";
import { parseFlowchart } from "../src/ui/mermaid-parse.js";
import { layoutFlowchart } from "../src/ui/mermaid-layout.js";

function textOf(rows: { runs: { text: string }[] }[]): string {
  return rows.map((r) => r.runs.map((x) => x.text).join("")).join("\n");
}

describe("parseFlowchart", () => {
  test("header, chained edges, shapes, labels", () => {
    const flow = parseFlowchart(
      ["flowchart LR", "A[Input] --> B(Process) --> C{Check}", "A -- ok --> D"].join("\n"),
    );
    expect(flow).not.toBeNull();
    expect(flow!.nodes.map((n) => n.label)).toEqual(["Input", "Process", "Check", "D"]);
    expect(flow!.nodes.map((n) => n.shape)).toEqual(["rect", "round", "diamond", "plain"]);
    expect(flow!.edges).toHaveLength(3);
    expect(flow!.edges[2]!.label).toBe("ok");
    expect(flow!.vertical).toBe(false);
  });

  test("vertical header + RL reversal + pipe labels + marks", () => {
    const flow = parseFlowchart(
      ["graph TD", "A o-->|yes| B", "C x--> D"].join("\n"),
    );
    expect(flow).not.toBeNull();
    expect(flow!.vertical).toBe(true);
    const labeled = flow!.edges.find((e) => e.label !== undefined);
    expect(labeled?.label).toBe("yes");
    expect(labeled?.startMark).toBe("o");
    const marked = flow!.edges.find((e) => e.from === "C");
    expect(marked?.startMark).toBe("x");
  });

  test("decoration lines skip; subgraph and junk decline", () => {
    const ok = parseFlowchart(
      ["flowchart LR", "%% comment", "classDef c fill:#f9f", "A --> B"].join("\n"),
    );
    expect(ok).not.toBeNull();
    expect(parseFlowchart(["flowchart LR", "subgraph X", "A --> B", "end"].join("\n"))).toBeNull();
    expect(parseFlowchart(["flowchart LR", "A --> B", "?? junk ??"].join("\n"))).toBeNull();
    expect(parseFlowchart(["flowchart LR", "sequenceDiagram"].join("\n"))).toBeNull();
  });

  test("self-loops and cycles decline at layout, not parse", () => {
    // Longest-path relaxation cannot settle cycles, so the structured flow
    // parses fine and the LAYOUT declines (caller keeps the code block).
    const selfLoop = parseFlowchart(["flowchart LR", "A --> B", "B --> A"].join("\n"));
    expect(selfLoop).not.toBeNull();
    expect(layoutFlowchart(selfLoop!, 80, 60)).toBeNull();
  });
});

describe("layoutFlowchart", () => {
  const simple = ["flowchart LR", "A[Input] --> B[Output]"].join("\n");

  test("deterministic output", () => {
    const flow = parseFlowchart(simple)!;
    const a = layoutFlowchart(flow, 80, 60);
    const b = layoutFlowchart(flow, 80, 60);
    expect(a).not.toBeNull();
    expect(textOf(a!)).toBe(textOf(b!));
  });

  test("straight LR arrow paints apex at the target border", () => {
    const flow = parseFlowchart(simple)!;
    const rows = textOf(layoutFlowchart(flow, 80, 60)!).split("\n");
    const joined = rows.join("\n");
    expect(joined).toContain("▸");
    // Rect shapes paint square corners (round shapes paint ╭):
    expect(joined).toContain("┌");
  });

  test("vertical diagram transposes (down arrow)", () => {
    const flow = parseFlowchart(["graph TD", "A[Top] --> B[Bottom]"].join("\n"))!;
    const joined = textOf(layoutFlowchart(flow, 80, 60)!);
    expect(joined).toContain("▾");
  });

  test("budget overflow declines; large budget paints", () => {
    const flow = parseFlowchart(simple)!;
    expect(layoutFlowchart(flow, 6, 60)).toBeNull();
    expect(layoutFlowchart(flow, 80, 4)).toBeNull();
    expect(layoutFlowchart(flow, 80, 60)).not.toBeNull();
  });

  test("edge label paints on the free band when it fits", () => {
    const flow = parseFlowchart(["flowchart LR", "A[In] -- go --> B[Out]"].join("\n"))!;
    const joined = textOf(layoutFlowchart(flow, 80, 60)!);
    expect(joined).toContain("go");
  });
});
