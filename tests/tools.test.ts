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
  bashTool,
  describeToolCall,
  editTool,
  executeTool,
  globTool,
  grepTool,
  needsApproval,
  parseDdgResults,
  readTool,
  resolveSandbox,
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
    expect(await readTool({ path: "sub/a.txt" }, cwd)).toBe("hello");
    const listing = await readTool({ path: "sub" }, cwd);
    expect(listing).toContain("a.txt");
    expect(await readTool({ path: "missing.txt" }, cwd)).toMatch(/^Error:/);
  });

  test("read supports offset/limit line windows", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "f.txt", content: "l1\nl2\nl3\nl4" }, cwd);
    expect(await readTool({ path: "f.txt", offset: 2, limit: 2 }, cwd)).toBe("l2\nl3");
  });
});

describe("sandbox", () => {
  test("absolute paths and ../ escapes are rejected by every tool", async () => {
    const cwd = await tmpDir();
    const abs = path.join(cwd, "x.txt");
    for (const r of [
      await readTool({ path: abs }, cwd),
      await writeTool({ path: abs, content: "x" }, cwd),
      await editTool({ path: abs, oldString: "a", newString: "b" }, cwd),
      await grepTool({ pattern: "a", dir: abs }, cwd),
      await globTool({ pattern: "*", dir: abs }, cwd),
    ]) {
      expect(r).toMatch(/^Error:/);
    }
    expect(await readTool({ path: "../outside.txt" }, cwd)).toMatch(/^Error:/);
    expect(await writeTool({ path: "..\\outside.txt", content: "x" }, cwd)).toMatch(/^Error:/);
    expect(resolveSandbox(abs, cwd).error).toMatch(/absolute/);
    expect(resolveSandbox("../x", cwd).error).toMatch(/escapes/);
  });
});

describe("edit", () => {
  test("0 matches and multi-match without replaceAll are errors", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "e.txt", content: "foo foo" }, cwd);
    expect(await editTool({ path: "e.txt", oldString: "zzz", newString: "y" }, cwd)).toMatch(/^Error:.*no match/);
    expect(await editTool({ path: "e.txt", oldString: "foo", newString: "y" }, cwd)).toMatch(/^Error:.*2 times/);
    expect(await editTool({ path: "e.txt", oldString: "foo", newString: "y", replaceAll: true }, cwd)).toContain("2 occurrence");
    expect(await readTool({ path: "e.txt" }, cwd)).toBe("y y");
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

  test("glob lists matching paths, capped", async () => {
    const cwd = await tmpDir();
    await writeTool({ path: "src/zen.ts", content: "x" }, cwd);
    await writeTool({ path: "src/App.tsx", content: "x" }, cwd);
    const out = await globTool({ pattern: "src/*.ts" }, cwd);
    expect(out).toContain("src/zen.ts");
    expect(out).not.toContain("App.tsx");
    const base = await globTool({ pattern: "*.ts" }, cwd);
    expect(base).toContain("src/zen.ts");
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
  test("all 9 tools have OpenAI function schemas and dispatch", async () => {
    expect(TOOL_DEFINITIONS.map((t) => t.function.name).sort()).toEqual(
      ["ask_question", "bash", "edit", "glob", "grep", "read", "webfetch", "websearch", "write"]
    );
    for (const t of TOOL_DEFINITIONS) {
      expect(t.type).toBe("function");
      expect(typeof t.function.description).toBe("string");
      expect(t.function.parameters).toMatchObject({ type: "object" });
    }
    const cwd = await tmpDir();
    await writeTool({ path: "d.txt", content: "data" }, cwd);
    expect(await executeTool("read", { path: "d.txt" }, cwd)).toBe("data");
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
    expect(out).toContain("[truncated: output exceeded 64KB]");
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
