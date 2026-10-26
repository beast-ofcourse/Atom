// SVG subset rendering: element support, coordinate mapping, declines.
import { describe, expect, test } from "vitest";
import { renderSvg } from "../src/ui/svg-char.js";

function textOf(rows: { runs: { text: string }[] }[]): string {
  return rows.map((r) => r.runs.map((x) => x.text).join("")).join("\n");
}

describe("renderSvg", () => {
  test("rect paints a box-drawing outline", () => {
    const svg = '<svg viewBox="0 0 40 20"><rect x="2" y="2" width="36" height="16" stroke="#00ff00"/></svg>';
    const rows = renderSvg(svg, 80, 40);
    expect(rows).not.toBeNull();
    const joined = textOf(rows!);
    expect(joined).toContain("┌");
    expect(joined).toContain("└");
  });

  test("axis-aligned line uses box glyphs; text paints", () => {
    const svg =
      '<svg viewBox="0 0 40 10">' +
      '<line x1="2" y1="2" x2="20" y2="2" stroke="red"/>' +
      '<text x="4" y="8" fill="#00ffff">hi</text>' +
      "</svg>";
    const joined = textOf(renderSvg(svg, 80, 40)!);
    expect(joined).toContain("─");
    expect(joined).toContain("hi");
  });

  test("XML entities in <text> decode (and &amp;lt; stays literal)", () => {
    const svg =
      '<svg viewBox="0 0 40 10">' +
      '<text x="4" y="6">a&lt;b &amp;c &quot;d&quot; &apos;e&apos; &#39;f&#39;</text>' +
      "</svg>";
    const joined = textOf(renderSvg(svg, 80, 40)!);
    expect(joined).toContain("a<b &c \"d\" 'e' 'f'");
    // &amp;lt; is a literal "&lt;" — decoded &amp; LAST must not unwrap it.
    const nested = textOf(renderSvg('<svg viewBox="0 0 40 10"><text x="4" y="6">&amp;lt;</text></svg>', 80, 40)!);
    expect(nested).toContain("&lt;");
  });

  test("path with M/L and curve sampling paints", () => {
    const svg = '<svg viewBox="0 0 40 20"><path d="M2 2 L10 2 C15 2 18 8 20 18" stroke="#fff"/></svg>';
    const rows = renderSvg(svg, 80, 40);
    expect(rows).not.toBeNull();
    const joined = textOf(rows!);
    expect(joined).toContain("─");
    expect(joined).toContain("·");
  });

  test("polygon closes; g translate applies; unknown elements skip", () => {
    const svg =
      '<svg viewBox="0 0 40 20">' +
      "<foreignObject>ignored</foreignObject>" +
      '<g transform="translate(1,1)" stroke="blue"><polygon points="2,2 8,2 8,8"/></g>' +
      "</svg>";
    const joined = textOf(renderSvg(svg, 80, 40)!);
    expect(joined).toContain("┐");
  });

  test("declines: no viewBox, no elements, absurd dims", () => {
    expect(renderSvg("<svg><rect x='0' y='0' width='4' height='4'/></svg>", 80, 40)).toBeNull();
    expect(renderSvg('<svg viewBox="0 0 40 20"></svg>', 80, 40)).toBeNull();
    expect(renderSvg('<svg viewBox="0 0 9999 20"><line x1="1" y1="1" x2="2" y2="2"/></svg>', 80, 40)).toBeNull();
    expect(renderSvg("<not-svg/>", 80, 40)).toBeNull();
  });
});
