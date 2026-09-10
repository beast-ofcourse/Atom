// SSE stall-timeout tests: a 200-OK stream that stops emitting bytes must
// fail the turn loudly instead of hanging it. Mocked bodies only, never live.
import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_SSE_STALL_TIMEOUT_MS,
  isStallError,
  readAnthropicSSEMessage,
  readWithStall,
  sseStallTimeoutMs,
} from "../src/adapters.js";
import { readSSEMessage } from "../src/zen.js";

const SAVED_STALL = process.env.ATOM_STALL_TIMEOUT_MS;

afterEach(() => {
  if (SAVED_STALL === undefined) delete process.env.ATOM_STALL_TIMEOUT_MS;
  else process.env.ATOM_STALL_TIMEOUT_MS = SAVED_STALL;
});

function hangingReaderBody(): unknown {
  return {
    getReader: () => ({
      read: () => new Promise<{ done: boolean }>(() => {}),
      releaseLock: () => {},
    }),
  };
}

describe("sseStallTimeoutMs", () => {
  test("default 60s; explicit values honored; max-clamped; invalid → default", () => {
    delete process.env.ATOM_STALL_TIMEOUT_MS;
    expect(sseStallTimeoutMs()).toBe(DEFAULT_SSE_STALL_TIMEOUT_MS);
    expect(DEFAULT_SSE_STALL_TIMEOUT_MS).toBe(60_000);
    process.env.ATOM_STALL_TIMEOUT_MS = "50";
    expect(sseStallTimeoutMs()).toBe(50);
    process.env.ATOM_STALL_TIMEOUT_MS = "99999999";
    expect(sseStallTimeoutMs()).toBe(300_000);
    for (const bad of ["0", "-5", "abc", ""]) {
      process.env.ATOM_STALL_TIMEOUT_MS = bad;
      expect(sseStallTimeoutMs()).toBe(DEFAULT_SSE_STALL_TIMEOUT_MS);
    }
  });
});

describe("readWithStall", () => {
  test("fast reads pass through with their value", async () => {
    await expect(readWithStall(async () => 42, 50)).resolves.toBe(42);
    await expect(readWithStall(async () => "x")).resolves.toBe("x");
  });

  test("silent reads throw a Truncated stall error (permanent contract)", async () => {
    const err = await readWithStall(() => new Promise<string>(() => {}), 30).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith("Truncated stream")).toBe(true);
    expect((err as Error).message).toContain("stall");
    expect(isStallError(err)).toBe(true);
    expect(isStallError(new Error("Truncated stream from model (connection aborted)."))).toBe(false);
    expect(isStallError(new Error("boom"))).toBe(false);
  });

  test("genuine read failures propagate unchanged (never reframed as stalls)", async () => {
    const boom = new Error("socket reset");
    const err = await readWithStall(() => Promise.reject<string>(boom), 1000).catch((e) => e);
    expect(err).toBe(boom);
    expect(isStallError(err)).toBe(false);
  });
});

describe("readSSEMessage stall", () => {
  test("hanging getReader stream fails fast with a stall error", async () => {
    process.env.ATOM_STALL_TIMEOUT_MS = "40";
    const res = { body: hangingReaderBody() } as unknown as Response;
    const t0 = Date.now();
    const err = await readSSEMessage(res).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith("Truncated stream")).toBe(true);
    expect((err as Error).message).toContain("stall");
  });

  test("trickling streams reset the clock (slow models are fine)", async () => {
    process.env.ATOM_STALL_TIMEOUT_MS = "200";
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    let i = 0;
    const res = {
      body: {
        getReader: () => ({
          read: async () => {
            // 100ms between chunks: under the 200ms budget, so no stall.
            await new Promise((r) => setTimeout(r, 100));
            return i < chunks.length
              ? { done: false, value: chunks[i++]! }
              : { done: true, value: undefined };
          },
          releaseLock: () => {},
        }),
      },
    } as unknown as Response;
    const out = await readSSEMessage(res);
    expect(out.content).toBe("hi");
  });
});

describe("anthropic SSE stall", () => {
  test("hanging body fails fast with a Truncated error", async () => {
    process.env.ATOM_STALL_TIMEOUT_MS = "40";
    const res = { body: hangingReaderBody() } as unknown as Response;
    const t0 = Date.now();
    const err = await readAnthropicSSEMessage(res).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith("Truncated stream")).toBe(true);
  });
});
