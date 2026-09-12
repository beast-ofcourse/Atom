// Vision-input (image attachment) tests: magic-byte sniffing, read-tool
// ingest paths, POST-time lowering per provider kind, strip mode, the
// text-only-model fallback retry, and honest context accounting.
// Network ALWAYS mocked; ATOM_HOME is hermetic per tests/setup.ts.
import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAnthropicBody, buildGeminiBody } from "../src/adapters.js";
import { messageChars } from "../src/context-manager.js";
import {
  hasMediaRefs,
  historyHasMedia,
  isImageRejection,
  loadMedia,
  lowerOpenAIContent,
  MEDIA_MAX_BYTES,
  mediaDescriptor,
  mediaWireChars,
  resolveMediaRefs,
  saveMedia,
  sniffImageMime,
  sniffPdf,
  stripMedia,
} from "../src/media.js";
import { readTool } from "../src/tools/filesystem.js";
import { chatCompletionForProvider, type ChatMessage } from "../src/zen.js";
import { requestCompactSummary } from "../src/compact.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// 1x1 transparent PNG (68 bytes) — real magic + decodable shape.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

function headOf(buf: Buffer, n = 12): Uint8Array {
  return buf.subarray(0, n);
}

async function writeTmp(dir: string, name: string, data: Buffer | string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, data);
  return p;
}

describe("sniffImageMime", () => {
  test("recognizes PNG, JPEG, GIF, WebP by magic bytes", () => {
    expect(sniffImageMime(headOf(PNG_1X1))).toBe("image/png");
    expect(
      sniffImageMime(headOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])))
    ).toBe("image/jpeg");
    expect(sniffImageMime(headOf(Buffer.from("GIF89a", "ascii")))).toBe("image/gif");
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from("WEBP", "ascii"),
    ]);
    expect(sniffImageMime(headOf(webp))).toBe("image/webp");
  });
  test("rejects text, PDF, and truncated magic", () => {
    expect(sniffImageMime(headOf(Buffer.from("hello world", "utf8")))).toBeNull();
    expect(sniffImageMime(headOf(Buffer.from("%PDF-1.7", "ascii")))).toBeNull();
    expect(sniffImageMime(headOf(Buffer.from([0x89, 0x50])))).toBeNull();
    expect(sniffImageMime(headOf(Buffer.alloc(0)))).toBeNull();
  });
});

describe("sniffPdf", () => {
  test("%PDF magic true, PNG false", () => {
    expect(sniffPdf(headOf(Buffer.from("%PDF-1.7", "ascii")))).toBe(true);
    expect(sniffPdf(headOf(PNG_1X1))).toBe(false);
  });
});

describe("readTool media paths", () => {
  test("PNG reads as vision input with a descriptor token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atom-media-"));
    const p = await writeTmp(dir, "diagram.png", PNG_1X1);
    const out = await readTool({ path: p }, dir);
    expect(out).toContain("Image read successfully");
    expect(out).toContain("image/png");
    expect(hasMediaRefs(out)).toBe(true);
    // The stored bytes round-trip through the media store.
    const tok = /\[media:([A-Za-z0-9_-]+) ([a-z]+\/[a-z0-9.+-]+) (\d+)B\]/.exec(out)!;
    expect(tok).toBeTruthy();
    const loaded = loadMedia(tok[1]!);
    expect(loaded?.mime).toBe("image/png");
    expect(loaded?.bytes).toBe(PNG_1X1.length);
    expect(Buffer.from(loaded!.base64, "base64").equals(PNG_1X1)).toBe(true);
  });
  test("PDF is rejected with convert-first guidance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atom-media-"));
    const p = await writeTmp(dir, "doc.pdf", Buffer.from("%PDF-1.7 fake", "ascii"));
    const out = await readTool({ path: p }, dir);
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("PDF");
    expect(out).toContain("pdftoppm");
    expect(hasMediaRefs(out)).toBe(false);
  });
  test("oversize image is rejected with the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atom-media-"));
    const big = Buffer.alloc(MEDIA_MAX_BYTES + 1, 0);
    PNG_1X1.copy(big, 0); // real magic, over-cap size
    const p = await writeTmp(dir, "huge.png", big);
    const out = await readTool({ path: p }, dir);
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("over the");
    expect(hasMediaRefs(out)).toBe(false);
  });
  test("plain text still reads with line numbers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atom-media-"));
    const p = await writeTmp(dir, "a.txt", "hello\nworld");
    const out = await readTool({ path: p }, dir);
    expect(out).toBe("1: hello\n2: world");
  });
});

describe("descriptor helpers", () => {
  test("mediaWireChars charges ceil(bytes*4/3) per token", () => {
    const tok = mediaDescriptor("abc123", "image/png", 300);
    expect(mediaWireChars(tok)).toBe(Math.ceil(300 / 3) * 4);
    expect(mediaWireChars("no tokens here")).toBe(0);
    expect(hasMediaRefs(tok)).toBe(true);
    expect(historyHasMedia([{ role: "tool", tool_call_id: "c", content: tok }])).toBe(true);
    expect(historyHasMedia([{ role: "user", content: "plain" }])).toBe(false);
  });
  test("stripMedia replaces tokens with markers", () => {
    const tok = mediaDescriptor("abc123", "image/png", 300);
    expect(stripMedia(`see ${tok} now`)).toBe("see [image omitted: image/png] now");
  });
  test("isImageRejection matches vision 400s, not effort 400s", () => {
    expect(isImageRejection("400 image input is not supported for this model")).toBe(true);
    expect(isImageRejection("vision is not enabled on this deployment")).toBe(true);
    expect(isImageRejection('reasoning_effort is not supported by "x"')).toBe(false);
    expect(isImageRejection("rate limited, retry later")).toBe(false);
  });
  test("resolveMediaRefs degrades missing files to placeholders", () => {
    const r = resolveMediaRefs("see [media:nope123 image/png 10B] end");
    expect(r.media).toHaveLength(1);
    expect(r.media[0]).toEqual({ ok: false, id: "nope123" });
    expect(r.text).toContain("[image unavailable: nope123]");
  });
});

describe("messageChars stays honest with media", () => {
  test("descriptor adds wire cost on top of text length", () => {
    const tok = mediaDescriptor("abc123", "image/png", 300);
    const m = { role: "tool", tool_call_id: "c1", content: `img ${tok}` } as ChatMessage;
    // messageChars = content + base64 wire cost + tool_call_id.
    const expected = `img ${tok}`.length + Math.ceil(300 / 3) * 4 + "c1".length;
    expect(messageChars(m)).toBe(expected);
  });
});

describe("lowerOpenAIContent", () => {
  test("no descriptors → identical string (payload-stable)", async () => {
    expect(lowerOpenAIContent("user", "plain text")).toBe("plain text");
  });
  test("media expands to text + image_url parts", async () => {
    const { id } = await saveMedia(PNG_1X1, "image/png", "diagram.png");
    const tok = mediaDescriptor(id, "image/png", PNG_1X1.length);
    const out = lowerOpenAIContent("tool", `look: ${tok}`);
    expect(Array.isArray(out)).toBe(true);
    const parts = out as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "text", text: "look: [image: diagram.png]" });
    const img = parts[1]!["image_url"] as Record<string, string>;
    expect(img["url"]!.startsWith("data:image/png;base64,")).toBe(true);
  });
  test("system role always strips; missing files become placeholders", async () => {
    const { id } = await saveMedia(PNG_1X1, "image/png", "s.png");
    const tok = mediaDescriptor(id, "image/png", PNG_1X1.length);
    expect(lowerOpenAIContent("system", `x ${tok}`)).toBe("x [image omitted: image/png]");
    expect(lowerOpenAIContent("user", "y [media:ghost1 image/png 10B]", "strip")).toBe(
      "y [image omitted: image/png]"
    );
    const missing = lowerOpenAIContent("user", "y [media:ghost1 image/png 10B]");
    expect(Array.isArray(missing)).toBe(true);
    expect((missing as Array<Record<string, unknown>>)).toHaveLength(1);
    expect(
      ((missing as Array<Record<string, unknown>>)[0]!["text"] as string)
    ).toContain("[image unavailable: ghost1]");
  });
});

describe("anthropic builder media", () => {
  test("no-media history keeps string content (byte-identical path)", () => {
    const body = buildAnthropicBody(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [] },
        { role: "tool", tool_call_id: "c1", content: "result" },
      ] as ChatMessage[],
      "claude-x"
    );
    const user = body.messages.filter((m) => m.role === "user");
    expect(user[0]).toEqual({ role: "user", content: "hi" });
    expect(user[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: "result" }],
    });
  });
  test("tool-result image becomes text + base64 image blocks", async () => {
    const { id } = await saveMedia(PNG_1X1, "image/png", "shot.png");
    const tok = mediaDescriptor(id, "image/png", PNG_1X1.length);
    const body = buildAnthropicBody(
      [{ role: "tool", tool_call_id: "c1", content: `see ${tok}` }] as ChatMessage[],
      "claude-x"
    );
    const blocks = (body.messages[0] as { content: Array<Record<string, unknown>> }).content[0] as Record<
      string,
      unknown
    >;
    expect(blocks["type"]).toBe("tool_result");
    const inner = blocks["content"] as Array<Record<string, unknown>>;
    expect(inner[0]).toEqual({ type: "text", text: "see [image: shot.png]" });
    expect(inner[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: PNG_1X1.toString("base64"),
      },
    });
  });
  test("strip mode keeps strings with markers", async () => {
    const { id } = await saveMedia(PNG_1X1, "image/png", "shot.png");
    const tok = mediaDescriptor(id, "image/png", PNG_1X1.length);
    const body = buildAnthropicBody(
      [{ role: "tool", tool_call_id: "c1", content: `see ${tok}` }] as ChatMessage[],
      "claude-x",
      { stripMedia: true }
    );
    const blocks = (body.messages[0] as { content: Array<Record<string, unknown>> }).content[0] as Record<
      string,
      unknown
    >;
    expect(blocks["content"]).toBe("see [image omitted: image/png]");
  });
});

describe("gemini builder media", () => {
  test("no-media history keeps single text parts", () => {
    const body = buildGeminiBody([{ role: "user", content: "hi" }], "gemini-x");
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });
  test("user image rides as inline_data; strip mode stays text", async () => {
    const { id } = await saveMedia(PNG_1X1, "image/png", "g.png");
    const tok = mediaDescriptor(id, "image/png", PNG_1X1.length);
    const body = buildGeminiBody(
      [{ role: "user", content: `look ${tok}` }] as ChatMessage[],
      "gemini-x"
    );
    expect(body.contents[0]).toEqual({
      role: "user",
      parts: [
        { text: "look [image: g.png]" },
        { inline_data: { mime_type: "image/png", data: PNG_1X1.toString("base64") } },
      ],
    });
    const stripped = buildGeminiBody(
      [{ role: "user", content: `look ${tok}` }] as ChatMessage[],
      "gemini-x",
      { stripMedia: true }
    );
    expect(stripped.contents).toEqual([
      { role: "user", parts: [{ text: "look [image omitted: image/png]" }] },
    ]);
  });
});

describe("openai-chat POST integration (mocked fetch)", () => {
  function okJson(content: string): Response {
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
  }
  test("descriptor tool result posts as image_url parts", async () => {
    const { id } = await saveMedia(PNG_1X1, "image/png", "post.png");
    const tok = mediaDescriptor(id, "image/png", PNG_1X1.length);
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      return okJson("described");
    });
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "what is this" },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "c1", content: `Image read successfully.\n${tok}` },
    ];
    const res = await chatCompletionForProvider("opencode-zen", "k", "big-pickle", history);
    expect(res.content).toBe("described");
    const msgs = seen[0]!["messages"] as Array<Record<string, unknown>>;
    const tool = msgs.find((m) => m["role"] === "tool")!;
    const parts = tool["content"] as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({
      type: "text",
      text: "Image read successfully.\n[image: post.png]",
    });
    expect((parts[1]!["image_url"] as Record<string, string>)["url"]).toBe(
      `data:image/png;base64,${PNG_1X1.toString("base64")}`
    );
  });
  test("image 400 retries once stripped", async () => {
    const { id } = await saveMedia(PNG_1X1, "image/png", "retry.png");
    const tok = mediaDescriptor(id, "image/png", PNG_1X1.length);
    const seen: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    let n = 0;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      n += 1;
      seen.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      if (n === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => "400 image input is not supported for this model",
        } as Response;
      }
      return okJson("ok without images");
    });
    const history: ChatMessage[] = [{ role: "user", content: `look ${tok}` }];
    const res = await chatCompletionForProvider("opencode-zen", "k", "big-pickle", history, {
      onWarning: (w) => warnings.push(w),
    });
    expect(res.content).toBe("ok without images");
    expect(n).toBe(2);
    expect(warnings.some((w) => w.includes("not supported"))).toBe(true);
    const retryMsgs = seen[1]!["messages"] as Array<Record<string, unknown>>;
    expect(retryMsgs[0]!["content"]).toBe("look [image omitted: image/png]");
  });
  test("compaction summary POST strips media end to end", async () => {
    const { id } = await saveMedia(PNG_1X1, "image/png", "sum.png");
    const tok = mediaDescriptor(id, "image/png", PNG_1X1.length);
    const seen: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
      return okJson("summary text");
    });
    const summary = await requestCompactSummary({
      provider: "opencode-zen",
      apiKey: "k",
      model: "big-pickle",
      systemContent: "sys",
      head: [
        { role: "user", content: "work" },
        { role: "assistant", content: "doing" },
        { role: "tool", tool_call_id: "c1", content: `img ${tok}` },
      ],
    });
    expect(summary).toBe("summary text");
    const payload = JSON.stringify(seen[0]);
    expect(payload).not.toContain("image_url");
    expect(payload).toContain("[image omitted: image/png]");
  });
});
