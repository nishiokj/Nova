/**
 * Tests for TUI rendering/formatting helpers
 *
 * Run with: bun test packages/tui/rendering.test.ts
 */

import { describe, it, expect } from "bun:test";
import { applyVisualSpacing, parseTextSegments } from "./formatting.js";
import type { HistoryLine } from "./store.js";

const joinText = (segments: { text: string }[]) => segments.map((s) => s.text).join("");

describe("parseTextSegments", () => {
  it("parses mixed inline markdown without dropping segments", () => {
    const segments = parseTextSegments("Hello **bold** and *italic* then `code`.");
    const text = joinText(segments).trimEnd();
    expect(text).toBe("Hello bold and italic then code.");
    expect(segments.some((s) => s.bold)).toBe(true);
    expect(segments.some((s) => s.italic)).toBe(true);
  });

  it("renders markdown links as link text with underline", () => {
    const segments = parseTextSegments("[OpenAI](https://openai.com)");
    const text = joinText(segments).trimEnd();
    expect(text).toBe("OpenAI");
    expect(segments.some((s) => s.underline)).toBe(true);
  });

  it("formats headers as emphasized text", () => {
    const segments = parseTextSegments("## Title");
    const text = joinText(segments).trim();
    expect(text).toBe("Title");
    expect(segments.some((s) => s.bold && s.underline)).toBe(true);
  });

  it("formats list bullets", () => {
    const segments = parseTextSegments("- item one");
    const text = joinText(segments).trimStart();
    expect(text.startsWith("•")).toBe(true);
  });

  it("formats blockquotes", () => {
    const segments = parseTextSegments("> quoted text");
    const text = joinText(segments).trimStart();
    expect(text.startsWith("│")).toBe(true);
    expect(segments.some((s) => s.italic)).toBe(true);
  });

  it("highlights URLs in plain text", () => {
    const segments = parseTextSegments("See https://example.com for details");
    expect(segments.some((s) => s.underline)).toBe(true);
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
