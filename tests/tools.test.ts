// Executor tests: each tool runs in a fresh temp dir (never the repo).
// Errors come back as strings, never thrown.
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  READ_ONLY_TOOLS,
  TOOL_DEFINITIONS,
  TOOL_ONE_LINERS,
  bashOutputTool,
  bashTool,
  describeToolCall,
  editTool,
  executeTool,
  getTodos,
  globTool,
  grepTool,
  needsApproval,
  parseDdgResults,
  readTool,
  resolveSandbox,
  todowriteTool,
  webfetchTool,
  websearchTool,
  writeTool,
} from "../src/tools.js";

let dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "atom-tools-"));
  dirs.push(d);
  return d;
}

const savedFetch = globalThis.fetch;

function mockFetch(fn: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = fn as typeof fetch;
}

afterEach(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
  dirs = [];
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

describe("read/write", () => {
  test("write creates parents, read returns content, directory lists entries", async () => {
    const cwd = await tmpDir();
    expect(await writeTool({ path: "sub/a.txt", content: "hello" }, cwd)).toContain("Wrote 5 bytes");
    expect(await readTool({ path: "sub/a.txt" }, cwd)).toBe("1: hello");
    const listing = await readTool({ path: "sub" }, cwd);
    expect(listing).toContain("a.txt");
    expect(await readTool({ path: "missing.txt" }, cwd)).toMatch(/^Error:/);
  });

  test("read supports offset/limit line windows", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "f.txt", content: "l1\nl2\nl3\nl4" }, cwd);
    expect(await readTool({ path: "f.txt", offset: 2, limit: 2 }, cwd)).toBe("2: l2\n3: l3");
  });
});

describe("anywhere access (no cwd sandbox)", () => {
  test("absolute paths and ../ escapes work in every file tool", async () => {
    const cwd = await tmpDir();
    const outside = await tmpDir(); // outside cwd
    const absFile = path.join(outside, "x.txt");
    await fsp.writeFile(absFile, "outside-content", "utf8");
    // read/write/edit via absolute paths outside cwd.
    expect(await readTool({ path: absFile }, cwd)).toBe("1: outside-content");
    expect(
      await writeTool({ path: path.join(outside, "new.txt"), content: "hi" }, cwd)
    ).toContain("Wrote");
    expect(await readTool({ path: path.join(outside, "new.txt") }, cwd)).toBe("1: hi");
    expect(
      await editTool({ path: absFile, oldString: "outside", newString: "inside" }, cwd)
    ).toContain("Edited");
    expect(await readTool({ path: absFile }, cwd)).toBe("1: inside-content");
    // ../ escape relative to a nested cwd.
    const sub = path.join(cwd, "sub");
    await fsp.mkdir(sub, { recursive: true });
    expect(await writeTool({ path: "../escape.txt", content: "esc" }, sub)).toContain("Wrote");
    expect(await readTool({ path: "escape.txt" }, cwd)).toBe("1: esc");
    // grep/glob with an absolute dir outside cwd.
    const hits = await grepTool({ pattern: "inside", dir: outside }, cwd);
    expect(hits).toContain("x.txt:1:");
    const listed = await globTool({ pattern: "*.txt", dir: outside }, cwd);
    expect(listed).toContain("x.txt");
    // resolveSandbox resolves without restriction.
    expect(resolveSandbox(absFile, cwd).abs).toBe(path.resolve(absFile));
    expect(resolveSandbox("../x", cwd).abs).toBe(path.resolve(cwd, "../x"));
  });

  test("validation errors kept: empty path, null byte, missing file", async () => {
    const cwd = await tmpDir();
    expect(await readTool({ path: "" }, cwd)).toMatch(/^Error: path must be/);
    expect(await readTool({ path: "a\0b" }, cwd)).toMatch(/^Error: invalid path/);
    expect(await readTool({ path: "missing.txt" }, cwd)).toMatch(/^Error: no such file/);
    expect(resolveSandbox("", cwd).error).toMatch(/non-empty/);
    expect(resolveSandbox("a\0b", cwd).error).toMatch(/invalid path/);
  });
});

describe("edit", () => {
  test("0 matches and multi-match without replaceAll are errors", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "e.txt", content: "foo foo" }, cwd);
    expect(await editTool({ path: "e.txt", oldString: "zzz", newString: "y" }, cwd)).toMatch(/^Error:.*no match/);
    expect(await editTool({ path: "e.txt", oldString: "foo", newString: "y" }, cwd)).toMatch(/^Error:.*2 times/);
    expect(await editTool({ path: "e.txt", oldString: "foo", newString: "y", replaceAll: true }, cwd)).toContain("2 occurrence");
    expect(await readTool({ path: "e.txt" }, cwd)).toBe("1: y y");
    expect(await editTool({ path: "nope.txt", oldString: "a", newString: "b" }, cwd)).toMatch(/^Error:/);
  });
});

describe("grep/glob", () => {
  test("grep finds file:line matches, respects include; invalid regex is an error", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "a.ts", content: "const x = 1;\n// todo here" }, cwd);
    await writeTool({ path: "b.md", content: "todo in md" }, cwd);
    const all = await grepTool({ pattern: "todo" }, cwd);
    expect(all).toContain("a.ts:2:");
    expect(all).toContain("b.md:1:");
    const filtered = await grepTool({ pattern: "todo", include: "*.ts" }, cwd);
    expect(filtered).toContain("a.ts:2:");
    expect(filtered).not.toContain("b.md");
    expect(await grepTool({ pattern: "([invalid" }, cwd)).toMatch(/^Error:.*invalid regex/);
  });

  test("glob lists matching paths newest-first, capped", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "src/zen.ts", content: "x" }, cwd);
    await writeTool({ path: "src/App.tsx", content: "x" }, cwd);
    const out = await globTool({ pattern: "src/*.ts" }, cwd);
    expect(out).toContain("src/zen.ts");
    expect(out).not.toContain("App.tsx");
    const base = await globTool({ pattern: "*.ts" }, cwd);
    expect(base).toContain("src/zen.ts");
  });

  test("glob sorts newest-first by modification time", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "old.txt", content: "o" }, cwd);
    await writeTool({ path: "new.txt", content: "n" }, cwd);
    const now = Date.now() / 1000;
    await fsp.utimes(path.join(cwd, "old.txt"), now - 100, now - 100);
    await fsp.utimes(path.join(cwd, "new.txt"), now, now);
    const out = (await globTool({ pattern: "*.txt" }, cwd)).split("\n");
    expect(out[0]).toContain("new.txt");
    expect(out[1]).toContain("old.txt");
  });

  test("grep outputMode files_with_matches lists paths newest-first with a header", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "old.ts", content: "needle here" }, cwd);
    await writeTool({ path: "new.ts", content: "needle here too" }, cwd);
    await writeTool({ path: "clean.ts", content: "nothing" }, cwd);
    const now = Date.now() / 1000;
    await fsp.utimes(path.join(cwd, "old.ts"), now - 100, now - 100);
    await fsp.utimes(path.join(cwd, "new.ts"), now, now);
    const out = await grepTool({ pattern: "needle", outputMode: "files_with_matches" }, cwd);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Found 2 file(s)");
    expect(lines[1]).toContain("new.ts");
    expect(lines[2]).toContain("old.ts");
    expect(out).not.toContain("clean.ts");
  });

  test("grep outputMode count returns per-file counts plus totals", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "a.txt", content: "x\nx\nx" }, cwd);
    await writeTool({ path: "b.txt", content: "x" }, cwd);
    const out = await grepTool({ pattern: "x", outputMode: "count" }, cwd);
    expect(out).toContain("a.txt:3");
    expect(out).toContain("b.txt:1");
    expect(out).toContain("Found 4 total match(es) across 2 file(s).");
    // default stays content-shaped; bad modes are model mistakes.
    expect(await grepTool({ pattern: "x" }, cwd)).toContain("a.txt:1:");
    expect(await executeTool("grep", { pattern: "x", outputMode: "nope" }, cwd)).toMatch(
      /^Error: invalid call:.*outputMode/
    );
  });
});

describe("bash", () => {
  test("captures exit code, stdout and stderr as a JSON string", async () => {
    const cwd = await tmpDir();
    const ok = JSON.parse(
      await bashTool({ command: `${JSON.stringify(process.execPath)} -e "console.log('hi-out'); console.error('hi-err')"` }, cwd)
    ) as { exitCode: number; stdout: string; stderr: string };
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("hi-out");
    expect(ok.stderr).toContain("hi-err");
    const code = JSON.parse(
      await bashTool({ command: `${JSON.stringify(process.execPath)} -e "process.exit(3)"` }, cwd)
    ) as { exitCode: number };
    expect(code.exitCode).toBe(3);
    expect(await bashTool({ command: "" }, cwd)).toMatch(/^Error:/);
  });
});

describe("schemas/dispatch", () => {
  test("all 13 tools have OpenAI function schemas and dispatch", async () => {
    expect(TOOL_DEFINITIONS.map((t) => t.function.name).sort()).toEqual(
      ["ask_question", "bash", "bash_output", "edit", "glob", "grep", "read", "todo_get", "todo_update", "todowrite", "webfetch", "websearch", "write"]
    );
    for (const t of TOOL_DEFINITIONS) {
      expect(t.type).toBe("function");
      expect(typeof t.function.description).toBe("string");
      expect(t.function.parameters).toMatchObject({ type: "object" });
    }
    const cwd = await tmpDir();
    await writeTool({ path: "d.txt", content: "data" }, cwd);
    expect(await executeTool("read", { path: "d.txt" }, cwd)).toBe("1: data");
    expect(await executeTool("nope", {}, cwd)).toMatch(/^Error:.*unknown tool/);
    expect(describeToolCall("read", { path: "src/zen.ts" })).toBe("⚙ read src/zen.ts");
  });
});

function htmlResponse(body: string, status = 200, contentType = "text/html"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

const DDG_PAGE = `<html><body>
<div class="result results_links results_links_deep web-result ">
<div class="links_main links_deep result__body">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
</h2>
<div class="result__extras"></div>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">The example documentation snippet.</a>
</div>
</div>
<div class="result results_links results_links_deep web-result ">
<div class="links_main links_deep result__body">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="https://direct.example.com/page">Direct Page</a>
</h2>
<a class="result__snippet" href="https://direct.example.com/page">A directly linked snippet.</a>
</div>
</div>
<div class="result results_links results_links_deep web-result ">
<div class="links_main links_deep result__body">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="https://nosnip.example.com/">No Snippet</a>
</h2>
</div>
</div>
</body></html>`;

describe("webfetch", () => {
  test("markdown strips scripts/styles/tags and decodes entities", async () => {
    mockFetch(async () =>
      htmlResponse(
        `<html><head><title>T</title><style>.x{color:red}</style><script>var s = "<p>evil</p>";</script></head>` +
          `<body><noscript>no-js</noscript><template><p>tpl</p></template>` +
          `<h1>Hello &amp; &lt;world&gt;</h1><p>it&#39;s &#65;&#x42; &quot;q&quot;&nbsp;end</p></body></html>`
      )
    );
    const out = await webfetchTool({ url: "https://example.com/" });
    expect(out).toContain("Hello & <world>");
    expect(out).toContain(`it's AB "q" end`);
    expect(out).not.toContain("evil");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("no-js");
    expect(out).not.toContain("tpl");
    expect(out).not.toContain("<h1>");
    expect(out).not.toContain("<script>");
  });

  test("html format passes the raw body through", async () => {
    mockFetch(async () => htmlResponse(`<html><body><p class="x">hi</p></body></html>`));
    const out = await webfetchTool({ url: "https://example.com/", format: "html" });
    expect(out).toContain(`<p class="x">hi</p>`);
  });

  test("non-HTML content-types pass through as text for markdown", async () => {
    mockFetch(async () => htmlResponse(`{"a":1}`, 200, "application/json"));
    expect(await webfetchTool({ url: "https://example.com/data" })).toBe(`{"a":1}`);
  });

  test("long output is capped at ~64KB with a note", async () => {
    mockFetch(async () => htmlResponse(`<p>${"y ".repeat(40000)}</p>`));
    const out = await webfetchTool({ url: "https://example.com/" });
    expect(out).toContain("[truncated: output exceeded 64KB; showing ");
    expect(out.length).toBeLessThan(70 * 1024);
  });

  test("downloads over ~1MB are aborted with a note", async () => {
    mockFetch(async () => htmlResponse(`<p>${"z".repeat(1024 * 1024 + 100)}</p>`));
    const out = await webfetchTool({ url: "https://example.com/big", format: "html" });
    expect(out).toContain("[truncated: download exceeded ~1MB]");
  });

  test("http:// is upgraded to https:// and noted", async () => {
    let seen = "";
    mockFetch(async (url) => {
      seen = url;
      return htmlResponse(`<p>ok</p>`);
    });
    const out = await webfetchTool({ url: "http://example.com/" });
    expect(seen).toBe("https://example.com/");
    expect(out).toContain("[note: upgraded http:// to https://]");
    expect(out).toContain("ok");
  });

  test("non-http schemes are rejected without fetching", async () => {
    let called = false;
    mockFetch(async () => {
      called = true;
      return htmlResponse("x");
    });
    for (const url of ["file:///etc/passwd", "ftp://example.com/f", "data:text/plain,hi", "not a url"]) {
      expect(await webfetchTool({ url })).toMatch(/^Error:/);
    }
    expect(called).toBe(false);
    expect(await webfetchTool({ url: "" })).toMatch(/^Error:/);
    expect(await webfetchTool({ url: "https://example.com/", format: "pdf" })).toMatch(/^Error:.*format/);
  });

  test("HTTP errors and timeouts are error strings, never throws", async () => {
    mockFetch(async () => htmlResponse("nope", 404));
    expect(await webfetchTool({ url: "https://example.com/missing" })).toMatch(
      /^Error: webfetch HTTP 404/
    );
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("This operation was aborted");
            e.name = "AbortError";
            reject(e);
          });
        })
    );
    await expect(webfetchTool({ url: "https://example.com/", timeoutMs: 50 })).resolves.toMatch(
      /^Error: webfetch timed out/
    );
  });
});

describe("websearch", () => {
  test("parses DDG redirect + direct results into numbered blocks", async () => {
    let seen = "";
    mockFetch(async (url) => {
      seen = url;
      return htmlResponse(DDG_PAGE);
    });
    const out = await websearchTool({ query: "example docs" });
    expect(seen).toContain(`q=${encodeURIComponent("example docs")}`);
    expect(out).toContain("1. Example Docs — https://example.com/docs");
    expect(out).toContain("The example documentation snippet.");
    expect(out).toContain("2. Direct Page — https://direct.example.com/page");
    expect(out).toContain("3. No Snippet — https://nosnip.example.com/");
  });

  test("numResults caps blocks; query is capped at ~500 chars", async () => {
    mockFetch(async () => htmlResponse(DDG_PAGE));
    const two = await websearchTool({ query: "x", numResults: 2 });
    expect(two).toContain("2. Direct Page");
    expect(two).not.toContain("3. No Snippet");
    const one = await websearchTool({ query: "x", numResults: 0 });
    expect(one).toContain("1. Example Docs");
    expect(one).not.toContain("2. Direct Page");

    let seen = "";
    mockFetch(async (url) => {
      seen = url;
      return htmlResponse(DDG_PAGE);
    });
    await websearchTool({ query: `${"q".repeat(600)}` });
    const q = new URL(seen).searchParams.get("q") ?? "";
    expect(q.length).toBe(500);
  });

  test("site scopes one domain via a site: operator", async () => {
    let seen = "";
    mockFetch(async (url) => {
      seen = url;
      return htmlResponse(DDG_PAGE);
    });
    const out = await websearchTool({ query: "example docs", site: "example.com" });
    const q = new URL(seen).searchParams.get("q") ?? "";
    expect(q).toContain("site:example.com");
    expect(out).toContain("1. Example Docs");
    expect(await executeTool("websearch", { query: "x", site: 5 })).toMatch(
      /^Error: invalid call:.*site/
    );
  });

  test("empty results say so; empty query and 403/HTTP errors are Error strings", async () => {
    mockFetch(async () => htmlResponse(`<html><body><div class="no-results">nothing</div></body></html>`));
    expect(await websearchTool({ query: "zzz-no-match" })).toBe("No results.");
    expect(parseDdgResults("<html></html>")).toEqual([]);

    let called = false;
    mockFetch(async () => {
      called = true;
      return htmlResponse("x");
    });
    expect(await websearchTool({ query: "   " })).toMatch(/^Error:/);
    expect(called).toBe(false);

    mockFetch(async () => htmlResponse("blocked", 403));
    expect(await websearchTool({ query: "x" })).toMatch(/^Error:.*403/);
    mockFetch(async () => htmlResponse("err", 500));
    expect(await websearchTool({ query: "x" })).toMatch(/^Error: websearch HTTP 500/);
    mockFetch(async () => {
      throw new Error("boom");
    });
    expect(await websearchTool({ query: "x" })).toMatch(/^Error: websearch failed/);
  });
});

describe("read line numbers", () => {
  test("every content line is prefixed with its 1-based number; listings stay plain", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "n.txt", content: "a\nb\nc" }, cwd);
    expect(await readTool({ path: "n.txt" }, cwd)).toBe("1: a\n2: b\n3: c");
    // offset math counts from the file start, not the window start.
    expect(await readTool({ path: "n.txt", offset: 3 }, cwd)).toBe("3: c");
    expect(await readTool({ path: "n.txt", offset: 2, limit: 1 }, cwd)).toBe("2: b");
    // offset past the end yields no lines.
    expect(await readTool({ path: "n.txt", offset: 9 }, cwd)).toBe("");
    // empty files stay empty (no phantom "1: " line).
    await writeTool({ path: "empty.txt", content: "" }, cwd);
    expect(await readTool({ path: "empty.txt" }, cwd)).toBe("");
    // directory listings keep plain entry names.
    const listing = await readTool({ path: "." }, cwd);
    expect(listing).toContain("n.txt");
    expect(listing).not.toMatch(/^\d+: /m);
  });
});

describe("bash background execution", () => {
  test("start returns an id immediately; poll completes with stdout/stderr and stays readable", async () => {
    const cwd = await tmpDir();
    const started = JSON.parse(
      await executeTool(
        "bash",
        {
          command: `${JSON.stringify(process.execPath)} -e "console.log('bg-out'); console.error('bg-err')"`,
          runInBackground: true,
        },
        cwd
      )
    ) as { backgroundTaskId: string; status: string; hint: string };
    expect(typeof started.backgroundTaskId).toBe("string");
    expect(started.backgroundTaskId.length).toBeGreaterThan(0);
    expect(started.status).toBe("running");
    expect(started.hint).toContain("bash_output");
    const polled = JSON.parse(
      await bashOutputTool({ taskId: started.backgroundTaskId, timeoutMs: 10000 })
    ) as {
      taskId: string;
      running: boolean;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    };
    expect(polled.taskId).toBe(started.backgroundTaskId);
    expect(polled.running).toBe(false);
    expect(polled.exitCode).toBe(0);
    expect(polled.stdout).toContain("bg-out");
    expect(polled.stderr).toContain("bg-err");
    expect(polled.timedOut).toBe(false);
    // finished tasks stay readable (immediate re-poll).
    const again = JSON.parse(await bashOutputTool({ taskId: started.backgroundTaskId, timeoutMs: 0 })) as {
      running: boolean;
      exitCode: number | null;
    };
    expect(again.running).toBe(false);
    expect(again.exitCode).toBe(0);
  });

  test("short poll while running returns running:true; later poll completes (single ~2s sleep)", async () => {
    const cwd = await tmpDir();
    const started = JSON.parse(
      await bashTool(
        {
          command: `${JSON.stringify(process.execPath)} -e "setTimeout(()=>console.log('late-hi'), 2000)"`,
          runInBackground: true,
        },
        cwd
      )
    ) as { backgroundTaskId: string };
    const early = JSON.parse(await bashOutputTool({ taskId: started.backgroundTaskId, timeoutMs: 300 })) as {
      running: boolean;
      exitCode: number | null;
      timedOut: boolean;
    };
    expect(early.running).toBe(true);
    expect(early.exitCode).toBeNull();
    expect(early.timedOut).toBe(true);
    const late = JSON.parse(await bashOutputTool({ taskId: started.backgroundTaskId, timeoutMs: 15000 })) as {
      running: boolean;
      exitCode: number;
      stdout: string;
      timedOut: boolean;
    };
    expect(late.running).toBe(false);
    expect(late.exitCode).toBe(0);
    expect(late.stdout).toContain("late-hi");
    expect(late.timedOut).toBe(false);
  });

  test("unknown taskId is an error string, never throws", async () => {
    await expect(bashOutputTool({ taskId: "does-not-exist" })).resolves.toMatch(
      /^Error: unknown background task/
    );
    expect(await executeTool("bash_output", { taskId: "does-not-exist" })).toMatch(
      /^Error: unknown background task/
    );
  });

  test("invalid background args never spawn; foreground path untouched", async () => {
    expect(await executeTool("bash", { command: "echo hi", runInBackground: "yes" })).toMatch(
      /^Error: invalid call:/
    );
    expect(await executeTool("bash_output", {})).toMatch(/^Error: invalid call:.*taskId/);
    expect(await executeTool("bash_output", { taskId: "x", timeoutMs: "5000" })).toMatch(
      /^Error: invalid call:/
    );
    const cwd = await tmpDir();
    expect(await bashTool({ command: "", runInBackground: true }, cwd)).toMatch(/^Error:/);
    const fg = JSON.parse(
      await bashTool({ command: `${JSON.stringify(process.execPath)} -e "console.log('fg-hi')"` }, cwd)
    ) as { exitCode: number; stdout: string };
    expect(fg.exitCode).toBe(0);
    expect(fg.stdout).toContain("fg-hi");
  });
});

describe("bash_output wiring", () => {
  test("read-only classification, one-liner, describe, and schema", () => {
    expect(READ_ONLY_TOOLS.has("bash_output")).toBe(true);
    expect(needsApproval("bash_output")).toBe(false);
    expect(TOOL_ONE_LINERS["bash_output"]).toBe("Poll a background shell task.");
    expect(describeToolCall("bash_output", { taskId: "abc123" })).toBe("⚙ bash_output abc123");
    expect(describeToolCall("bash_output", {})).toBe("⚙ bash_output (no task)");
    const def = TOOL_DEFINITIONS.find((t) => t.function.name === "bash_output")!;
    expect(def.type).toBe("function");
    expect(def.function.parameters).toMatchObject({ type: "object" });
  });

  test("descriptions steer like Claude/opencode and stay truthful", () => {
    const desc = (n: string): string =>
      TOOL_DEFINITIONS.find((t) => t.function.name === n)!.function.description;
    // read: line numbers + read-before-edit + honest truncation.
    expect(desc("read")).toContain("line numbers");
    expect(desc("read")).toContain("read first");
    expect(desc("read")).toContain("WHEN NOT to use");
    expect(desc("read")).toContain("truncates");
    // write: full-content creation, partial edits directed to edit.
    expect(desc("write")).toContain("WHEN NOT to use");
    expect(desc("write")).toContain("use edit");
    expect(desc("write")).toContain("approval in normal mode");
    // edit: exact match + replaceAll + stale-read guard + display-only numbers.
    expect(desc("edit")).toContain("exact-match");
    expect(desc("edit")).toContain("replaceAll");
    expect(desc("edit")).toContain("stale-read guard");
    expect(desc("edit")).toContain("display-only");
    // bash: background pointer + file-tool preference + honest truncation.
    expect(desc("bash")).toContain("runInBackground");
    expect(desc("bash")).toContain("bash_output");
    expect(desc("bash")).toContain("reading/writing/searching files");
    expect(desc("bash")).toContain("truncate");
    // Shell identity (benchmark evidence: models burn rounds guessing
    // ls-vs-dir and probing pwd/whoami without it).
    expect(desc("bash")).toContain("cmd.exe");
    expect(desc("bash")).toContain("quote paths containing spaces");
    // bash_output: read-only polling; unknown ids are a runtime error string.
    expect(desc("bash_output")).toContain("read-only");
    expect(desc("bash_output")).toContain("WHEN to use");
    expect(desc("bash_output")).toContain("stay readable");
  });

  test("prompt bulk stays budgeted: behavior in, guarantee restatements out", () => {
    // Harness guarantees (never-throws, caps, approvals) live in runtime
    // error strings + one system-prompt line — not repeated per tool. Bump
    // these caps deliberately, never by pasting guarantee prose back in.
    const descs = TOOL_DEFINITIONS.map((t) => t.function.description);
    expect(descs.reduce((n, d) => n + d.length, 0)).toBeLessThan(6500);
    expect(JSON.stringify(TOOL_DEFINITIONS).length).toBeLessThan(13000);
    for (const d of descs) {
      expect(d).not.toContain("Failures return");
      expect(d).not.toContain("Never throws");
    }
  });
});

describe("web tools wiring", () => {
  test("dispatcher, one-liners, describe, and read-only approval", async () => {
    mockFetch(async (url) =>
      String(url).includes("duckduckgo")
        ? htmlResponse(DDG_PAGE)
        : htmlResponse(`<p>page <b>text</b></p>`)
    );
    expect(await executeTool("webfetch", { url: "https://example.com/" })).toContain("page text");
    expect(await executeTool("websearch", { query: "x", numResults: 1 })).toContain(
      "1. Example Docs — https://example.com/docs"
    );
    expect(TOOL_ONE_LINERS["webfetch"]).toBe("Fetch a web page as text (retrieval).");
    expect(TOOL_ONE_LINERS["websearch"]).toBe("Search the web, best-effort (discovery).");
    expect(describeToolCall("webfetch", { url: "https://example.com/" })).toBe(
      "⚙ webfetch https://example.com/"
    );
    expect(describeToolCall("websearch", { query: "q" })).toBe("⚙ websearch q");
    const long = `https://example.com/${"p".repeat(100)}`;
    expect(describeToolCall("webfetch", { url: long })).toBe(`⚙ webfetch ${long.slice(0, 80)}…`);
    expect(describeToolCall("websearch", { query: "q".repeat(100) })).toBe(
      `⚙ websearch ${"q".repeat(80)}…`
    );
    expect(READ_ONLY_TOOLS.has("webfetch")).toBe(true);
    expect(READ_ONLY_TOOLS.has("websearch")).toBe(true);
    expect(needsApproval("webfetch")).toBe(false);
    expect(needsApproval("websearch")).toBe(false);
    expect(needsApproval("write")).toBe(true);
  });
});

describe("todowrite", () => {
  test("whole-list replace with echo-back, priorities and activeForm", async () => {
    const out = await todowriteTool({
      todos: [
        { content: "First task", status: "in_progress", priority: "high", activeForm: "Doing first" },
        { content: "Second task", status: "pending" },
      ],
    });
    expect(out).toContain("Todos have been modified successfully");
    expect(out).toContain("[in_progress] First task (high)");
    expect(out).toContain("[pending] Second task");
    expect(getTodos()).toEqual([
      { content: "First task", status: "in_progress", priority: "high", activeForm: "Doing first" },
      { content: "Second task", status: "pending" },
    ]);
    // dispatch replaces the whole list (no merge with the previous one).
    expect(await executeTool("todowrite", { todos: [{ content: "Only", status: "pending" }] })).toContain(
      "Todo list (1)"
    );
    expect(getTodos()).toHaveLength(1);
  });

  test("malformed lists are invalid calls and leave state untouched", async () => {
    await todowriteTool({ todos: [{ content: "seed", status: "pending" }] });
    expect(await executeTool("todowrite", { todos: "nope" })).toMatch(
      /^Error: invalid call:.*todos.*must be an array/
    );
    expect(await executeTool("todowrite", {})).toMatch(/^Error: invalid call:.*todos/);
    expect(await executeTool("todowrite", { todos: [{ content: "", status: "pending" }] })).toMatch(
      /^Error: invalid call:.*content/
    );
    expect(await executeTool("todowrite", { todos: [{ content: "x", status: "done" }] })).toMatch(
      /^Error: invalid call:.*status/
    );
    expect(
      await executeTool("todowrite", { todos: [{ content: "x", status: "pending", priority: "urgent" }] })
    ).toMatch(/^Error: invalid call:.*priority/);
    expect(getTodos()).toEqual([{ content: "seed", status: "pending" }]);
  });

  test("all-completed and empty arrays clear the list", async () => {
    await todowriteTool({
      todos: [
        { content: "a", status: "pending" },
        { content: "b", status: "pending" },
      ],
    });
    const done = await todowriteTool({
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "completed" },
      ],
    });
    expect(done).toContain("cleared");
    expect(getTodos()).toEqual([]);
    await todowriteTool({ todos: [{ content: "x", status: "pending" }] });
    expect(await todowriteTool({ todos: [] })).toContain("cleared");
    expect(getTodos()).toEqual([]);
  });
});

describe("todowrite wiring", () => {
  test("read-only classification, one-liner, describe, and schema", () => {
    expect(READ_ONLY_TOOLS.has("todowrite")).toBe(true);
    expect(needsApproval("todowrite")).toBe(false);
    expect(TOOL_ONE_LINERS["todowrite"]).toBe("Track session tasks on a checklist.");
    expect(describeToolCall("todowrite", { todos: [{ content: "a", status: "pending" }] })).toBe(
      "⚙ todowrite 1 task(s)"
    );
    const def = TOOL_DEFINITIONS.find((t) => t.function.name === "todowrite")!;
    expect(def.type).toBe("function");
    expect(def.function.parameters).toMatchObject({ type: "object" });
  });

  test("descriptions steer like Claude/opencode and stay truthful", () => {
    const desc = (n: string): string =>
      TOOL_DEFINITIONS.find((t) => t.function.name === n)!.function.description;
    expect(desc("todowrite")).toContain("ENTIRE list");
    expect(desc("todowrite")).toContain("ONE item to in_progress");
    expect(desc("todowrite")).toContain("WHEN NOT to use");
    expect(desc("grep")).toContain("outputMode");
    expect(desc("grep")).toContain("files_with_matches");
    expect(desc("glob")).toContain("newest-first");
    expect(desc("websearch")).toContain("site");
    expect(desc("websearch")).toContain("snippets are not content");
    expect(desc("webfetch")).toContain("untrusted data");
    expect(desc("ask_question")).toContain("one-by-one");
  });
});
