// WebUI HTTP server: routes, validation, and the cancel lifecycle.
// Real HTTP to 127.0.0.1 with ephemeral ports; servers always close. The
// model transport is stubbed (hangs until aborted) so the busy → 409 →
// cancel → rollback path runs with zero network.
import { afterEach, describe, expect, test } from "vitest";
import {
  parseWebPort,
  resolveWebPort,
  startWebServer,
  type WebServer,
} from "../src/web/server.js";
import { WebRuntime } from "../src/web/runtime.js";

let servers: WebServer[] = [];
const realFetch = globalThis.fetch;

async function start(opts?: { runtime?: WebRuntime }): Promise<WebServer> {
  const s = await startWebServer({ port: 0, ...opts });
  servers.push(s);
  return s;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const s of servers) {
    try {
      await s.close();
    } catch {
      // close is best-effort in teardown
    }
  }
  servers = [];
});

// Hang every non-loopback POST (the model transport) until aborted; pass
// loopback traffic (the server under test) through untouched.
function stubHangingTransport(): void {
  globalThis.fetch = (async (url: unknown, init?: { signal?: AbortSignal }) => {
    if (String(url).includes("127.0.0.1")) {
      return realFetch(url as string, init as RequestInit);
    }
    const signal = init?.signal as AbortSignal | undefined;
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
}

async function post(s: WebServer, p: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await realFetch(`${s.url}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let json: unknown = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("parseWebPort / resolveWebPort", () => {
  test("validates range, rejects garbage", () => {
    expect(parseWebPort("8080")).toBe(8080);
    expect(parseWebPort(0)).toBeNull();
    expect(parseWebPort(70000)).toBeNull();
    expect(parseWebPort("abc")).toBeNull();
    expect(parseWebPort(undefined)).toBeNull();
  });

  test("precedence: CLI > env > ephemeral", () => {
    expect(resolveWebPort({ ATOM_WEB_PORT: "9001" } as NodeJS.ProcessEnv, "9002")).toBe(9002);
    expect(resolveWebPort({ ATOM_WEB_PORT: "9001" } as NodeJS.ProcessEnv, "junk")).toBe(9001);
    expect(resolveWebPort({} as NodeJS.ProcessEnv, undefined)).toBe(0);
  });
});

describe("web catalog + health routes", () => {
  test("health, providers, tools; providers leak no key material", async () => {
    const s = await start();
    const health = await (await realFetch(`${s.url}api/health`)).json();
    expect(health).toMatchObject({ ok: true, service: "atom-web", sessions: 0 });

    const providers = (await (await realFetch(`${s.url}api/providers`)).json()) as Array<{
      id: string;
      needsKey: boolean;
    }>;
    expect(providers.length).toBeGreaterThan(0);
    expect(JSON.stringify(providers)).not.toContain("apiKey");

    const tools = (await (await realFetch(`${s.url}api/tools`)).json()) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain("bash");

    expect((await realFetch(`${s.url}api/nope`)).status).toBe(404);
    expect((await realFetch(`${s.url}api/health`, { method: "POST" })).status).toBe(405);
  });

  test("serves the frontend shell", async () => {
    const s = await start();
    const res = await realFetch(s.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("ATOM WebUI");
    const js = await realFetch(`${s.url}app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
  });
});

describe("web session routes", () => {
  test("create → get → patch → list summaries (light, no histories)", async () => {
    const s = await start();
    const created = (await (await realFetch(`${s.url}api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "hello" }),
    })).json()) as { id: string; title: string };
    expect(created.title).toBe("hello");

    const one = (await (await realFetch(`${s.url}api/sessions/${created.id}`)).json()) as {
      id: string;
      busy: boolean;
      history: Array<unknown>;
    };
    expect(one.id).toBe(created.id);
    expect(one.busy).toBe(false);
    expect(one.history.length).toBeGreaterThan(0);

    const patched = (await (await realFetch(`${s.url}api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "plan" }),
    })).json()) as { mode: string };
    expect(patched.mode).toBe("plan");

    const list = (await (await realFetch(`${s.url}api/sessions`)).json()) as Array<
      Record<string, unknown>
    >;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.id, turnCount: 0 });
    expect("history" in list[0]!).toBe(false);

    expect((await realFetch(`${s.url}api/sessions/ses_missing`)).status).toBe(404);
  });

  test("message validation: 400 empty/unknown, 404 missing session", async () => {
    const s = await start();
    const created = (await (await realFetch(`${s.url}api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })).json()) as { id: string };

    const empty = await post(s, `api/sessions/${created.id}/messages`, { content: "  " });
    expect(empty.status).toBe(400);
    const missing = await post(s, "api/sessions/ses_missing/messages", { content: "hi" });
    expect(missing.status).toBe(404);
    const noKey = await post(s, `api/sessions/${created.id}/messages`, {
      content: "hi",
      provider: "openai-compatible",
      model: "model-x",
    });
    expect(noKey.status).toBe(400);
    expect(String((noKey.json as { error?: string }).error)).toMatch(/missing API key/);
  });
});

describe("web turn lifecycle (stubbed transport)", () => {
  test("busy → 409 → cancel → conversation rollback, failed turns never persist", async () => {
    stubHangingTransport();
    const runtime = new WebRuntime();
    const s = await start({ runtime });
    const created = runtime.createWebSession({ provider: "kilo", model: "kilo-auto/free" });

    const first = await post(s, `api/sessions/${created.id}/messages`, { content: "take your time" });
    expect(first.status).toBe(202);
    await waitFor(
      async () =>
        ((await (await realFetch(`${s.url}api/sessions/${created.id}`)).json()) as { busy: boolean })
          .busy === true,
      "turn to start"
    );

    // Refresh-while-running: the live view shows the in-flight user echo
    // (in-memory state, not just the persisted record).
    const live = (await (await realFetch(`${s.url}api/sessions/${created.id}`)).json()) as {
      busy: boolean;
      turns: Array<{ role: string; content: string }>;
      history: Array<{ role: string; content: string }>;
    };
    expect(live.busy).toBe(true);
    expect(live.turns.at(-1)).toMatchObject({ role: "user", content: "take your time" });
    expect(live.history.at(-1)).toMatchObject({ role: "user", content: "take your time" });

    const concurrent = await post(s, `api/sessions/${created.id}/messages`, { content: "second" });
    expect(concurrent.status).toBe(409);

    const cancelled = await post(s, `api/sessions/${created.id}/cancel`, {});
    expect(cancelled).toMatchObject({ status: 200, json: { cancelled: true } });

    await waitFor(
      async () =>
        ((await (await realFetch(`${s.url}api/sessions/${created.id}`)).json()) as { busy: boolean })
          .busy === false,
      "turn to cancel"
    );
    const after = (await (await realFetch(`${s.url}api/sessions/${created.id}`)).json()) as {
      history: Array<unknown>;
      turns: Array<{ role: string; content: string }>;
    };
    // Rollback: history back to the system head; the cancelled-turn line is
    // display-only (like the TUI) and states the no-revert scope outright.
    expect(after.history).toHaveLength(1);
    expect(after.turns.at(-1)?.content).toContain("(cancelled)");
    expect(after.turns.at(-1)?.content).toContain("NOT reverted");

    // Idle cancel / gates resolve false, never throw.
    expect(await post(s, `api/sessions/${created.id}/cancel`, {})).toMatchObject({
      status: 200,
      json: { cancelled: false },
    });
    expect(
      await post(s, `api/sessions/${created.id}/approve`, { id: "apr_9", decision: "once" })
    ).toMatchObject({ status: 200, json: { resolved: false } });
    expect(
      await post(s, `api/sessions/${created.id}/answer`, { id: "q_9", answer: "yes" })
    ).toMatchObject({ status: 200, json: { resolved: false } });
  });

  test("tool_result carries real args end to end (read tool, canned transport)", async () => {
    // Canned non-streaming transport: first POST returns a read call for a
    // file that exists in the checkout, second POST returns final text. The
    // runtime executes the REAL read executor — args and results are never
    // fabricated.
    let posts = 0;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("127.0.0.1")) {
        return realFetch(url as string);
      }
      posts += 1;
      const payload =
        posts === 1
          ? {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: { name: "read", arguments: JSON.stringify({ path: "package.json" }) },
                      },
                    ],
                  },
                },
              ],
            }
          : { choices: [{ message: { content: "done-reading", tool_calls: [] } }] };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
    }) as typeof fetch;

    const runtime = new WebRuntime();
    const s = await start({ runtime });
    const created = runtime.createWebSession({ provider: "kilo", model: "kilo-auto/free" });
    const seen: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const unsub = runtime.subscribe(created.id, (e) => seen.push({ kind: e.kind, data: e.data }));

    const res = await post(s, `api/sessions/${created.id}/messages`, { content: "read the file" });
    expect(res.status).toBe(202);
    await waitFor(
      async () =>
        ((await (await realFetch(`${s.url}api/sessions/${created.id}`)).json()) as { busy: boolean })
          .busy === false,
      "turn to finish"
    );
    unsub();

    const kinds = seen.map((e) => e.kind);
    expect(kinds).toContain("tool_started");
    expect(kinds).toContain("tool_finished");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("done");
    const result = seen.find((e) => e.kind === "tool_result")!;
    expect(result.data["name"]).toBe("read");
    expect((result.data["args"] as Record<string, unknown>)["path"]).toBe("package.json");
    expect(result.data["isError"]).toBe(false);
    expect(String(result.data["result"])).toContain("atom-agent");

    const after = (await (await realFetch(`${s.url}api/sessions/${created.id}`)).json()) as {
      history: Array<{ role: string }>;
      turns: Array<{ role: string; content: string }>;
    };
    expect(after.turns.at(-1)).toMatchObject({ role: "assistant", content: "done-reading" });
    expect(after.history.map((m) => m.role)).toContain("tool");
  });

  test("approval_request carries computed hunks for edit (normal mode)", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "atom-web-apr-"));
    const target = join(dir, "notes.txt");
    await writeFile(target, "hello\n");
    try {
      // First model step calls edit (needs approval in normal mode), second
      // step ends the turn after the browser approves once.
      let posts = 0;
      globalThis.fetch = (async (url: unknown) => {
        if (String(url).includes("127.0.0.1")) {
          return realFetch(url as string);
        }
        posts += 1;
        const payload =
          posts === 1
            ? {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: "call_e",
                          type: "function",
                          function: {
                            name: "edit",
                            arguments: JSON.stringify({
                              path: target,
                              oldString: "hello\n",
                              newString: "hello\nworld\n",
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
              }
            : { choices: [{ message: { content: "edited", tool_calls: [] } }] };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
      }) as typeof fetch;

      const runtime = new WebRuntime();
      const s = await start({ runtime });
      const created = runtime.createWebSession({ provider: "kilo", model: "kilo-auto/free" });
      const seen: Array<{ kind: string; data: Record<string, unknown> }> = [];
      const unsub = runtime.subscribe(created.id, (e) => seen.push({ kind: e.kind, data: e.data }));

      expect((await post(s, `api/sessions/${created.id}/messages`, { content: "edit it" })).status).toBe(
        202,
      );
      await waitFor(
        () => seen.some((e) => e.kind === "approval_request"),
        "approval request",
      );
      const req = seen.find((e) => e.kind === "approval_request")!;
      expect(req.data["name"]).toBe("edit");
      const diff = req.data["diff"] as Record<string, unknown>;
      expect(Array.isArray(diff["hunks"])).toBe(true);
      expect((diff["hunks"] as Array<unknown>).length).toBeGreaterThan(0);
      expect(diff["adds"]).toBe(1);
      expect(diff["dels"]).toBe(0);
      expect(diff["path"]).toBe(target);

      expect(
        await post(s, `api/sessions/${created.id}/approve`, {
          id: req.data["id"],
          decision: "once",
        }),
      ).toMatchObject({ status: 200, json: { resolved: true } });
      await waitFor(
        async () =>
          ((await (await realFetch(`${s.url}api/sessions/${created.id}`)).json()) as { busy: boolean })
            .busy === false,
        "approved turn to finish"
      );
      unsub();
      expect(seen.some((e) => e.kind === "done")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("file_diff created→modified across write then edit (temp file, yolo)", async () => {
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "atom-web-diff-"));
    const target = join(dir, "notes.txt");
    try {
      // Scripted turns: write a new file, then edit it. Yolo mode keeps the
      // turn self-driving (no browser approvals in tests).
      const script = [
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_w",
                    type: "function",
                    function: { name: "write", arguments: JSON.stringify({ path: target, content: "hello\n" }) },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ message: { content: "wrote it", tool_calls: [] } }] },
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_e",
                    type: "function",
                    function: {
                      name: "edit",
                      arguments: JSON.stringify({ path: target, oldString: "hello\n", newString: "hello\nworld\n" }),
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ message: { content: "edited it", tool_calls: [] } }] },
      ];
      let posts = 0;
      globalThis.fetch = (async (url: unknown) => {
        if (String(url).includes("127.0.0.1")) {
          return realFetch(url as string);
        }
        const payload = script[Math.min(posts, script.length - 1)];
        posts += 1;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
      }) as typeof fetch;

      const runtime = new WebRuntime();
      const s = await start({ runtime });
      const created = runtime.createWebSession({ provider: "kilo", model: "kilo-auto/free", mode: "yolo" });
      const seen: Array<{ kind: string; data: Record<string, unknown> }> = [];
      const unsub = runtime.subscribe(created.id, (e) => seen.push({ kind: e.kind, data: e.data }));

      expect((await post(s, `api/sessions/${created.id}/messages`, { content: "write it" })).status).toBe(202);
      await waitFor(
        async () =>
          ((await (await realFetch(`${s.url}api/sessions/${created.id}`)).json()) as { busy: boolean })
            .busy === false,
        "write turn to finish"
      );
      expect((await post(s, `api/sessions/${created.id}/messages`, { content: "edit it" })).status).toBe(202);
      await waitFor(
        async () =>
          ((await (await realFetch(`${s.url}api/sessions/${created.id}`)).json()) as { busy: boolean })
            .busy === false,
        "edit turn to finish"
      );
      unsub();

      // No approval prompts in yolo; the real executors ran.
      expect(seen.some((e) => e.kind === "approval_request")).toBe(false);
      const diffs = seen.filter((e) => e.kind === "file_diff");
      expect(diffs).toHaveLength(2);
      expect(diffs[0]!.data).toMatchObject({ path: target, op: "created", isNewFile: true });
      expect(diffs[1]!.data).toMatchObject({ path: target, op: "modified", isNewFile: false });
      const hunks = diffs[0]!.data["hunks"] as Array<{ lines: Array<{ kind: string; text: string }> }>;
      expect(hunks.length).toBeGreaterThan(0);
      expect(hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add").map((l) => l.text)).toContain("hello");
      const rows = diffs[1]!.data["rows"] as Array<{ kind: string }>;
      expect(rows.some((r) => r.kind === "change")).toBe(true);
      expect(await readFile(target, "utf8")).toBe("hello\nworld\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("events endpoint streams SSE headers", async () => {
    const runtime = new WebRuntime();
    const s = await start({ runtime });
    const created = runtime.createWebSession({});
    const controller = new AbortController();
    const res = await realFetch(`${s.url}api/sessions/${created.id}/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
    expect((await realFetch(`${s.url}api/sessions/ses_missing/events`)).status).toBe(404);
  });
});

describe("web skills + MCP routes (TUI /skill + /mcp parity)", () => {
  test("skills catalog lists without bodies; unknown skill invoke is 404", async () => {
    const runtime = new WebRuntime();
    const s = await start({ runtime });
    const res = await realFetch(`${s.url}api/skills`);
    expect(res.status).toBe(200);
    const skills = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(skills)).toBe(true);
    // Catalog rows carry metadata only — no bodies, no dir paths, no keys.
    for (const sk of skills) {
      expect(Object.keys(sk).sort()).toEqual([
        "description",
        "name",
        "source",
        "userInvocable",
      ]);
    }
    expect((await realFetch(`${s.url}api/skills`, { method: "POST" })).status).toBe(405);

    const created = runtime.createWebSession({});
    expect(
      (await post(s, `api/sessions/${created.id}/skill`, { name: "nope-not-a-skill" })).status,
    ).toBe(404);
    expect((await post(s, `api/sessions/${created.id}/skill`, { name: "" })).status).toBe(400);
    expect((await post(s, `api/sessions/ses_missing/skill`, { name: "x" })).status).toBe(404);
  });

  test("mcp snapshot lists; toggle validates body + unknown names", async () => {
    const runtime = new WebRuntime();
    const s = await start({ runtime });
    const res = await realFetch(`${s.url}api/mcp`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
    expect((await realFetch(`${s.url}api/mcp`, { method: "POST" })).status).toBe(405);
    // No "mcp" key in this checkout's config → unknown name is 404, bad
    // bodies are 400, never a crash.
    expect((await post(s, `api/mcp/nope-not-a-server/toggle`, { enabled: true })).status).toBe(
      404,
    );
    expect((await post(s, `api/mcp/anything/toggle`, { enabled: "yes" })).status).toBe(400);
    expect((await post(s, `api/mcp/anything/toggle`, {})).status).toBe(400);
  });
});
