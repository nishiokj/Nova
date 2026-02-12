/**
 * Tests for TUI rendering/formatting helpers
 *
 * Run with: bun test packages/apps/tui/rendering.test.ts
 */

import { applyVisualSpacing, parseTextSegments } from "tui/formatting.js";
import { getColors } from "tui/theme.js";
import type { HistoryLine } from "tui/store.js";

const joinText = (segments: { text: string }[]) => segments.map((s) => s.text).join("");

describe("parseTextSegments", () => {
  it("parses mixed inline markdown without dropping segments", () => {
    const segments = parseTextSegments("Hello **bold** and *italic* then `code`.");
    const text = joinText(segments).trimEnd();
    expect(text).toBe("Hello bold and italic then code.");
    expect(segments.some((s) => s.bold)).toBe(true);
    expect(segments.some((s) => s.italic)).toBe(true);
  });

  it("renders markdown links as link text", () => {
    const segments = parseTextSegments("[OpenAI](https://openai.com)");
    const text = joinText(segments).trimEnd();
    expect(text).toBe("OpenAI");
    expect(segments.some((s) => s.underline)).toBe(false);
  });

  it("formats headers as emphasized text", () => {
    const segments = parseTextSegments("## Title");
    const text = joinText(segments).trim();
    expect(text).toBe("Title");
    expect(segments.some((s) => s.bold)).toBe(true);
    expect(segments.some((s) => s.underline)).toBe(false);
  });

  it("formats list bullets", () => {
    const segments = parseTextSegments("- item one");
    const text = joinText(segments).trimStart();
    expect(text.startsWith("\u2022")).toBe(true);
  });

  it("formats blockquotes", () => {
    const segments = parseTextSegments("> quoted text");
    const text = joinText(segments).trimStart();
    expect(text.startsWith("\u2502")).toBe(true);
    expect(segments.some((s) => s.italic)).toBe(true);
  });

  it("highlights URLs in plain text without underline", () => {
    const segments = parseTextSegments("See https://example.com for details");
    expect(segments.some((s) => s.underline)).toBe(false);
  });

  it("styles plain-text paths with theme path color", () => {
    const colors = getColors();
    const segments = parseTextSegments("updated /tmp/demo/file.ts successfully", colors.text);
    const pathSegment = segments.find((s) => s.text.includes("/tmp/demo/file.ts"));
    expect(pathSegment).toBeDefined();
    expect(pathSegment?.color).toBe(colors.path);
  });

  it("styles plain-text function calls with theme func color", () => {
    const colors = getColors();
    const segments = parseTextSegments("Call renderPane() then continue", colors.text);
    const fnSegment = segments.find((s) => s.text.includes("renderPane()"));
    expect(fnSegment).toBeDefined();
    expect(fnSegment?.color).toBe(colors.func);
  });
});

describe("applyVisualSpacing", () => {
  it("collapses multiple blank lines", () => {
    const lines: HistoryLine[] = [
      { id: "1", text: "First" },
      { id: "2", text: "" },
      { id: "3", text: "" },
      { id: "4", text: "Second" },
    ];
    const result = applyVisualSpacing(lines);
    const blankCount = result.filter((line) => (line.text ?? "").trim().length === 0).length;
    expect(blankCount).toBe(1);
  });
});
