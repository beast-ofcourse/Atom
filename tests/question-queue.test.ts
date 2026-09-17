// Phase 1: ask_question batch (one-by-one) + queue contract.
import { describe, expect, test, vi } from "vitest";
import {
  ASK_QUESTION_MAX_BATCH,
  runInterceptedTool,
  validateToolArgs,
} from "../src/tools.js";
import { widgetWidth } from "../src/ui/layout.js";
import { theme } from "../src/ui/theme.js";

const Q = (q: string) => ({ question: q, options: ["A", "B"] });

describe("ask_question batch schema", () => {
  test("single shape stays valid (back-compat)", () => {
    expect(validateToolArgs("ask_question", Q("Which?"))).toBeNull();
  });
  test("batch of 3 validates", () => {
    expect(
      validateToolArgs("ask_question", { questions: [Q("1?"), Q("2?"), Q("3?")] }),
    ).toBeNull();
  });
  test("rejects: empty question, single option, >max, mixed shapes", () => {
    expect(validateToolArgs("ask_question", { question: "", options: ["A", "B"] })).toMatch(/^field "question"/);
    expect(validateToolArgs("ask_question", { question: "q?", options: ["only"] })).toMatch(/^field "options"/);
    const many = Array.from({ length: ASK_QUESTION_MAX_BATCH + 1 }, (_, i) => Q(`${i}?`));
    expect(validateToolArgs("ask_question", { questions: many })).toMatch(/^field "questions"/);
    expect(
      validateToolArgs("ask_question", { question: "q?", options: ["A", "B"], questions: [Q("x?")] }),
    ).toMatch(/either/);
    expect(validateToolArgs("ask_question", { questions: [] })).toMatch(/questions/);
  });
});

describe("ask_question batch executor", () => {
  test("batch loops askUser sequentially with index/total meta, returns {answers}", async () => {
    const seen: Array<{ q: string; meta: unknown }> = [];
    const askUser = vi.fn(async (q: string, _o: string[], _c?: boolean, meta?: { index: number; total: number }) => {
      seen.push({ q, meta });
      return `pick-${meta?.index}`;
    });
    const out = await runInterceptedTool(
      "ask_question",
      { questions: [Q("1?"), Q("2?"), Q("3?")] },
      { askUser: askUser as never },
    );
    expect(out?.decision).toBe("ask-question");
    expect(out?.result).toBe(JSON.stringify({ answers: ["pick-1", "pick-2", "pick-3"] }));
    expect(seen.map((s) => s.meta)).toEqual([
      { index: 1, total: 3 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ]);
  });
  test("Esc on item 2 returns per-question cancel, no partial JSON", async () => {
    const askUser = vi.fn(async (_q: string, _o: string[], _c?: boolean, meta?: { index: number; total: number }) => {
      if (meta?.index === 2) throw new Error("question cancelled by user");
      return "ok";
    });
    const out = await runInterceptedTool(
      "ask_question",
      { questions: [Q("1?"), Q("2?"), Q("3?")] },
      { askUser: askUser as never },
    );
    expect(out?.result).toBe("Error: question 2 cancelled by user");
    expect(askUser).toHaveBeenCalledTimes(2);
  });
  test("single cancel keeps legacy message", async () => {
    const askUser = vi.fn(async () => {
      throw new Error("question cancelled by user");
    });
    const out = await runInterceptedTool("ask_question", Q("Which?"), { askUser: askUser as never });
    expect(out?.result).toBe("Error: question cancelled by user");
  });
});

describe("phase 0 shared contracts", () => {
  test("widgetWidth clamps to terminal", () => {
    expect(widgetWidth(80)).toBe(76);
    expect(widgetWidth(200)).toBe(100);
    expect(widgetWidth(20)).toBeGreaterThanOrEqual(10);
  });
  test("theme tokens exist", () => {
    expect(theme.border.tool.ok).toBe("green");
    expect(theme.border.tool.fail).toBe("red");
    expect(theme.spacing.widgetPadX).toBe(1);
    expect(theme.symbol.questionStep).toBe("Q");
  });
});
