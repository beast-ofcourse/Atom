// Renderable markdown seams: mermaid/svg fence block kinds, media
// descriptor paragraphs, and component fallback behavior (fallbacks stay
// byte-identical to the pre-feature plain-text paint).
import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { MarkdownText, parseMarkdown } from "../src/ui/markdown.js";
import { clearPaintCache } from "../src/ui/image-paint.js";

describe("parseMarkdown renderable blocks", () => {
  test("mermaid fence becomes a mermaid block", () => {
    const blocks = parseMarkdown("```mermaid\nflowchart LR\nA --> B\n```");
    expect(blocks.map((b) => b.kind)).toEqual(["mermaid"]);
  });

  test("svg fence becomes an svg block; unknown xml stays code", () => {
    expect(parseMarkdown("```svg\n<svg viewBox='0 0 4 4'></svg>\n```").map((b) => b.kind)).toEqual(["svg"]);
    expect(parseMarkdown("```image/svg+xml\n<svg viewBox='0 0 4 4'></svg>\n```").map((b) => b.kind)).toEqual(["svg"]);
    expect(parseMarkdown("```xml\n<root/>\n```").map((b) => b.kind)).toEqual(["code"]);
  });

  test("media descriptor paragraph becomes a media block; inline mention stays text", () => {
    const blocks = parseMarkdown("[media:abc123 image/png 512B]");
    expect(blocks.map((b) => b.kind)).toEqual(["media"]);
    const media = blocks[0];
    expect(media.kind === "media" && media.id).toBe("abc123");
    const inline = parseMarkdown("see [media:abc123 image/png 512B] above");
    expect(inline.map((b) => b.kind)).toEqual(["paragraph"]);
  });

  test("agent size hints parse into w/h; malformed hints fail open", () => {
    const hinted = parseMarkdown("[media:abc123 image/png 512B w=40 h=12]")[0]!;
    expect(hinted.kind === "media" && hinted.w === 40 && hinted.h === 12).toBe(true);
    const wOnly = parseMarkdown("[media:abc123 image/png 512B w=20]")[0]!;
    expect(wOnly.kind === "media" && wOnly.w === 20 && wOnly.h === undefined).toBe(true);
    // Malformed tail: still a media block, hints ignored (fail-open) —
    // the image paints at auto size and the raw text stays the fallback.
    const junk = parseMarkdown("[media:abc123 image/png 512B w=big junk]")[0]!;
    expect(junk.kind === "media" && junk.w === undefined && junk.h === undefined).toBe(true);
  });

  test("plain mermaid-less fences unchanged", () => {
    const blocks = parseMarkdown("```mermaidish\nstuff\n```");
    expect(blocks.map((b) => b.kind)).toEqual(["code"]);
  });
});

describe("MermaidBlock component", () => {
  test("renders a diagram for a subset flowchart", () => {
    clearPaintCache();
    // Round shapes paint rounded corners (╭); rects paint ┌.
    const app = render(<MarkdownText text={"```mermaid\nflowchart LR\nA(In) --> B(Out)\n```"} />);
    const frame = app.lastFrame() ?? "";
    app.unmount();
    expect(frame).toContain("╭");
    expect(frame).toContain("▸");
  });

  test("falls back to the code block for unsupported syntax", () => {
    clearPaintCache();
    const src = "```mermaid\nflowchart LR\nsubgraph S\nA --> B\nend\n```";
    const app = render(<MarkdownText text={src} />);
    const frame = app.lastFrame() ?? "";
    app.unmount();
    expect(frame).toContain("mermaid");
    expect(frame).toContain("subgraph");
    expect(frame).not.toContain("╭");
  });
});

describe("SvgBlock component", () => {
  test("renders a subset svg; declines unknown xml to the code block", () => {
    clearPaintCache();
    const app = render(
      <MarkdownText
        text={"```svg\n<svg viewBox='0 0 40 20'><rect x='2' y='2' width='30' height='12'/></svg>\n```"}
      />,
    );
    const frame = app.lastFrame() ?? "";
    app.unmount();
    expect(frame).toContain("┌");

    clearPaintCache();
    const fallback = render(<MarkdownText text={"```svg\n<svg viewBox='0 0 4 4'></svg>\n```"} />);
    const frame2 = fallback.lastFrame() ?? "";
    fallback.unmount();
    expect(frame2).toContain("svg");
    expect(frame2).not.toContain("┌");
  });
});
