// Subscription status tracking (src/subscription-status.ts): defensive
// payload parsing, env-override endpoint resolution, transport failures that
// never throw and never leak the bearer token, usage-fraction math, and
// limit warnings. fetch is mocked — no network.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchSubscriptionStatus,
  forgetSubscriptionStatus,
  getRecordedStatus,
  parseSubscriptionStatus,
  recordSubscriptionStatus,
  subscriptionWarnings,
  usageFraction,
  USAGE_WARN_FRACTION,
} from "../src/subscription-status.js";

const TOKEN = "tok-SECRET-VALUE";
const STATUS_URL = "https://api.openai.com/v1/organization/usage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  forgetSubscriptionStatus("openai");
});

describe("parseSubscriptionStatus", () => {
  test("reads plan, account, usage triple and renewal from the contract shape", () => {
    const status = parseSubscriptionStatus({
      plan: "team",
      account_id: "acct-42",
      usage: { used: 45, limit: 100, unit: "requests" },
      renews_at: 1_800_000_000,
    });
    expect(status).toEqual({
      plan: "team",
      accountId: "acct-42",
      usage: { used: 45, limit: 100, unit: "requests" },
      renewsAt: 1_800_000_000,
    });
  });

  test("reads the percent_used shape as a 0–100 percent usage", () => {
    expect(parseSubscriptionStatus({ percent_used: 92 }).usage).toEqual({
      used: 92,
      limit: 100,
      unit: "%",
    });
    expect(
      parseSubscriptionStatus({ usage: { percent_used: 92 } }).usage
    ).toEqual({ used: 92, limit: 100, unit: "%" });
  });

  test("unwraps a single-record envelope and parses an ISO renewal date", () => {
    const status = parseSubscriptionStatus({
      data: { plan: "pro", renewal_date: "2030-01-01T00:00:00Z" },
    });
    expect(status.plan).toBe("pro");
    expect(status.renewsAt).toBe(Date.parse("2030-01-01T00:00:00Z") / 1000);
  });

  test("unknown payloads yield an empty status instead of throwing", () => {
    expect(parseSubscriptionStatus({ some: "unrelated", shape: 1 })).toEqual({});
    expect(parseSubscriptionStatus([1, 2, 3])).toEqual({});
    expect(parseSubscriptionStatus("a string")).toEqual({});
    expect(parseSubscriptionStatus(null)).toEqual({});
    expect(parseSubscriptionStatus({ used: "not-a-number", limit: -5 })).toEqual({});
  });
});

describe("fetchSubscriptionStatus", () => {
  test("GETs the status endpoint with a Bearer header and parses the body", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ plan: "pro", percent_used: 45 }))
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSubscriptionStatus("openai", TOKEN);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a successful status fetch");
    expect(result.status.plan).toBe("pro");
    expect(result.status.usage).toEqual({ used: 45, limit: 100, unit: "%" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(STATUS_URL);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("the env override wins over the table constant", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({}))
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ATOM_OPENAI_OAUTH_STATUS_URL", "https://env.example/status");

    const result = await fetchSubscriptionStatus("openai", TOKEN);

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://env.example/status");
  });

  test("a non-200 response fails concisely without leaking the token", async () => {
    vi.stubGlobal("fetch", (_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ error: "unauthorized" }, 401))
    );

    const result = await fetchSubscriptionStatus("openai", TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed status fetch");
    expect(result.error).toBe("status request failed: HTTP 401");
    expect(result.error).not.toContain(TOKEN);
  });

  test("a transport failure returns an error result instead of throwing", async () => {
    vi.stubGlobal("fetch", (_url: string, _init?: RequestInit) =>
      Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1"))
    );

    const result = await fetchSubscriptionStatus("openai", TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed status fetch");
    expect(result.error).toContain("status request failed:");
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.error).not.toContain(TOKEN);
  });

  test("a non-JSON 200 body fails concisely", async () => {
    vi.stubGlobal("fetch", (_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("<html>nope</html>", { status: 200 }))
    );

    const result = await fetchSubscriptionStatus("openai", TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed status fetch");
    expect(result.error).toBe("status endpoint returned a non-JSON response");
  });

  test("an unanswered fetch aborts at the timeout with a concise error", async () => {
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted"))
        );
      })
    );

    const result = await fetchSubscriptionStatus("openai", TOKEN, {
      timeoutMs: 20,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed status fetch");
    expect(result.error).toContain("status request failed:");
    expect(result.error).not.toContain(TOKEN);
  });

  test("an unconfigured provider reports it without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSubscriptionStatus("anthropic", TOKEN);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failed status fetch");
    expect(result.error).toBe("status endpoint not configured for anthropic");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("usageFraction and subscriptionWarnings", () => {
  test("usageFraction divides used by limit and is undefined without usable data", () => {
    expect(usageFraction({ usage: { used: 45, limit: 100, unit: "%" } })).toBe(0.45);
    expect(usageFraction({ usage: { used: 150, limit: 100, unit: "%" } })).toBe(1.5);
    expect(usageFraction({})).toBeUndefined();
    expect(usageFraction({ usage: { used: 1, limit: 0, unit: "%" } })).toBeUndefined();
  });

  test("no warnings below the threshold, one at or above it, limit-reached at or over 1", () => {
    const fraction = (used: number) => ({
      usage: { used, limit: 100, unit: "requests" },
    });
    expect(subscriptionWarnings(fraction(85), "OpenAI")).toEqual([]);
    expect(subscriptionWarnings(fraction(92), "OpenAI")).toEqual([
      "OpenAI subscription: 92% of the usage limit used",
    ]);
    expect(subscriptionWarnings(fraction(100), "OpenAI")).toEqual([
      "OpenAI subscription: usage limit reached (100%)",
    ]);
    expect(subscriptionWarnings({}, "OpenAI")).toEqual([]);
    expect(USAGE_WARN_FRACTION).toBe(0.9);
  });

  test("warnings and errors never contain the access token", async () => {
    vi.stubGlobal("fetch", (_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ error: `rejected token ${TOKEN}` }, 500))
    );
    const failed = await fetchSubscriptionStatus("openai", TOKEN);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).not.toContain(TOKEN);
    const warnings = subscriptionWarnings(
      { usage: { used: 99, limit: 100, unit: "requests" } },
      "OpenAI"
    );
    expect(warnings.join("\n")).not.toContain(TOKEN);
  });
});

describe("recorded status cache", () => {
  test("record, read, forget", () => {
    expect(getRecordedStatus("openai")).toBeUndefined();
    recordSubscriptionStatus("openai", { plan: "pro" });
    expect(getRecordedStatus("openai")).toEqual({ plan: "pro" });
    forgetSubscriptionStatus("openai");
    expect(getRecordedStatus("openai")).toBeUndefined();
  });
});
