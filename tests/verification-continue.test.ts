// Verification gate as a loop driver (not a labeler): a code write followed
// by final text CONTINUES the turn so the model actually verifies, instead
// of ending with a mere "(unverified: …)" report. Labeled endings survive
// only for exhausted budget/rounds, with the reason stated. No fetch, no repo
// writes — scripted chatFn, real module-global todo list kept empty so the
// todo guard stays out of the way.
import { afterEach, describe, expect, test } from "vitest";
import {
  LoopCancelledError,
  isCodePath,
  MAX_VERIFY_ROUNDS,
  runLoopWithChat,
  type AgenticOpts,
  type ChatMessage,
  type ChatResult,
} from "../src/zen.js";
import { clearTodos } from "../src/tools.js";

afterEach(() => {
  clearTodos();
});

function baseHistory(): ChatMessage[] {
  return [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
  ];
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function scriptedChat(script: ChatResult[]) {
  const posts: ChatMessage[][] = [];
  let n = 0;
  const chat = async (h: ChatMessage[], _o?: AgenticOpts): Promise<ChatResult> => {
    posts.push([...h]);
    return script[Math.min(n++, script.length - 1)]!;
  };
  return { chat, posts };
}

function bashOk(): string {
  return JSON.stringify({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
}

function bashFail(): string {
  return JSON.stringify({ exitCode: 1, stdout: "", stderr: "1 failed", timedOut: false });
}

describe("isCodePath", () => {
  test("source files require verification; docs/configs/data do not", () => {
    for (const p of ["src/a.ts", "app.tsx", "main.py", "lib.rs", "run.sh", "A.JS", "dir/file.Go"]) {
      expect(isCodePath(p)).toBe(true);
    }
    for (const p of [
      "README.md",
      "notes.txt",
      "config.json",
      "data.yaml",
      ".env",
      "Makefile",
      "Dockerfile",
      "",
      null,
      42,
    ]) {
      expect(isCodePath(p)).toBe(false);
    }
  });
});

describe("verified completion", () => {
  test("write → final → passing check → final ends clean, no flag", async () => {
    const history = baseHistory();
    const { chat, posts } = scriptedChat([
      toolCall("w1", "write", { path: "src/a.ts", content: "hi" }),
      { content: "done, running tests" },
      toolCall("b1", "bash", { command: "npm test" }),
      { content: "done, tests pass" },
    ]);
    const reply = await runLoopWithChat(chat, history, {
      execute: async (name) => (name === "bash" ? bashOk() : "ok"),
      sleep: async () => {},
    });
    expect(reply).toBe("done, tests pass");
    expect(reply).not.toContain("(unverified:");
    expect(reply).not.toContain("(blocked:");
    // Write round + first final + check round + verified final.
    expect(posts).toHaveLength(4);
    expect(history.at(-1)).toEqual({ role: "assistant", content: "done, tests pass" });
  });

  test("docs-only writes finish immediately with no nagging", async () => {
    const history = baseHistory();
    const { chat, posts } = scriptedChat([
      toolCall("w1", "write", { path: "README.md", content: "hi" }),
      { content: "docs updated" },
    ]);
    const reply = await runLoopWithChat(chat, history, {
      execute: async () => "ok",
      sleep: async () => {},
    });
    expect(reply).toBe("docs updated");
    expect(posts).toHaveLength(2);
  });
});

describe("unverified mutation", () => {
  test("model that never verifies ends labeled after bounded rounds, naming the file", async () => {
    const history = baseHistory();
    let calls = 0;
    const chat = async (h: ChatMessage[], _o?: AgenticOpts): Promise<ChatResult> => {
      calls += 1;
      if (calls === 1) return toolCall("w1", "write", { path: "src/a.ts", content: "hi" });
      return { content: "done, trust me" };
    };
    const reply = await runLoopWithChat(chat, history, {
      execute: async () => "ok",
      sleep: async () => {},
    });
    // One tool round + (MAX_VERIFY_ROUNDS + 1) final attempts, then stop.
    expect(calls).toBe(1 + MAX_VERIFY_ROUNDS + 1);
    expect(reply).toContain("done, trust me");
    expect(reply).toContain("(unverified:");
    expect(reply).toContain("src/a.ts");
    expect(reply).toContain("npm test");
    expect(history.at(-1)).toEqual({ role: "assistant", content: reply });
  });
});

describe("verification failure", () => {
  test("failing check keeps the gate armed; passing run finishes clean", async () => {
    const history = baseHistory();
    const seen: string[] = [];
    const { chat } = scriptedChat([
      toolCall("w1", "write", { path: "src/a.ts", content: "hi" }),
      { content: "done?" },
      toolCall("b1", "bash", { command: "npm test" }),
      { content: "tests failed, fixing" },
      toolCall("b2", "bash", { command: "npm test" }),
      { content: "done, green now" },
    ]);
    let runs = 0;
    const reply = await runLoopWithChat(chat, history, {
      execute: async (name, args) => {
        if (name === "bash") {
          runs += 1;
          const out = runs === 1 ? bashFail() : bashOk();
          seen.push(out);
          return out;
        }
        return "ok";
      },
      sleep: async () => {},
    });
    expect(reply).toBe("done, green now");
    expect(reply).not.toContain("(unverified:");
    // The model saw the red output before the green run.
    expect(history.some((m) => JSON.stringify(m).includes("1 failed"))).toBe(true);
  });
});

describe("verification unavailable", () => {
  test("spent budget ends blocked with the reason, never hanging", async () => {
    const history = baseHistory();
    let calls = 0;
    const chat = async (h: ChatMessage[], _o?: AgenticOpts): Promise<ChatResult> => {
      calls += 1;
      if (calls === 1) return toolCall("w1", "write", { path: "src/a.ts", content: "hi" });
      return { content: "done" };
    };
    const reply = await runLoopWithChat(chat, history, {
      execute: async () => "ok",
      sleep: async () => {},
      maxSteps: 1,
    });
    // Step 0 ran the write; step 1 >= maxSteps ends blocked, naming the file.
    expect(reply).toContain("(blocked:");
    expect(reply).toContain("src/a.ts");
    expect(calls).toBe(2);
  });
});

describe("cancellation during verification", () => {
  test("abort mid-verification-round rejects, never commits, no extra POSTs", async () => {
    const history = baseHistory();
    const controller = new AbortController();
    let calls = 0;
    const chat = async (_h: ChatMessage[], o?: AgenticOpts): Promise<ChatResult> => {
      calls += 1;
      if (calls === 1) return toolCall("w1", "write", { path: "src/a.ts", content: "hi" });
      if (calls === 2) return { content: "done?" };
      // The continued verification round hangs like a real in-flight POST —
      // aborting rejects it exactly the way fetch would.
      await new Promise<never>((_resolve, reject) => {
        const sig = o?.signal ?? null;
        if (sig?.aborted) {
          reject(new DOMException("This operation was aborted", "AbortError"));
          return;
        }
        sig?.addEventListener(
          "abort",
          () => reject(new DOMException("This operation was aborted", "AbortError")),
          { once: true }
        );
      });
      throw new Error("unreachable");
    };
    const run = runLoopWithChat(chat, history, {
      execute: async () => "ok",
      sleep: async () => {},
      signal: controller.signal,
    });
    // Let the write round + first final land (gate continues into the nag
    // round), then abort mid-flight of the verification round's POST.
    for (;;) {
      if (calls >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // One tick so the continued round's POST is actually in flight.
    await new Promise((r) => setTimeout(r, 25));
    controller.abort();
    // The cancel wins over the nag round: rejection (never a commit), and
    // nothing proceeds afterwards.
    await expect(run).rejects.toThrowError(LoopCancelledError);
    const frozen = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(frozen);
  });
});
