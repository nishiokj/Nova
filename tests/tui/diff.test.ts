/**
 * Tests for diff.tsx
 */

import { formatDiffAsText, computeDiff } from "tui/diff.js";

describe("formatDiffAsText", () => {
  describe("filename handling", () => {
    it("preserves snake_case filenames", () => {
      const oldStr = "line 1";
      const newStr = "line 1 modified";
      const filePath = "/path/to/my_snake_case_file.ts";

      const result = formatDiffAsText(oldStr, newStr, filePath);

      expect(result[0]).toContain("my_snake_case_file.ts");
      // Ensure underscores are preserved
      expect(result[0]).toMatch(/my_snake_case_file\.ts/);
    });

    it("preserves kebab-case filenames", () => {
      const oldStr = "line 1";
      const newStr = "line 1 modified";
      const filePath = "/path/to/my-kebab-case-file.ts";

      const result = formatDiffAsText(oldStr, newStr, filePath);

      expect(result[0]).toContain("my-kebab-case-file.ts");
      // Ensure hyphens are preserved
      expect(result[0]).toMatch(/my-kebab-case-file\.ts/);
    });

    it("preserves mixed case filenames", () => {
      const oldStr = "line 1";
      const newStr = "line 1 modified";
      const filePath = "/path/to/MyMixedCase_file-name.component.tsx";

      const result = formatDiffAsText(oldStr, newStr, filePath);

      expect(result[0]).toContain("MyMixedCase_file-name.component.tsx");
    });

    it("preserves paths with special characters", () => {
      const oldStr = "line 1";
      const newStr = "line 1 modified";
      const filePath = "/path/to/file with spaces/test_file-name.ts";

      const result = formatDiffAsText(oldStr, newStr, filePath);

      expect(result[0]).toContain("file with spaces");
      expect(result[0]).toContain("test_file-name.ts");
    });
  });

  describe("header format", () => {
    it("starts with file path (no brackets)", () => {
      const oldStr = "line 1";
      const newStr = "line 1 modified";
      const filePath = "/path/to/file.ts";

      const result = formatDiffAsText(oldStr, newStr, filePath);

      // Header should start with path, no brackets
      expect(result[0]).toMatch(/^\/path\/to\/file\.ts/);
      expect(result[0]).not.toContain("[FILE]");
    });

    it("has no end marker", () => {
      const oldStr = "line 1";
      const newStr = "line 1 modified";
      const filePath = "/path/to/file.ts";

      const result = formatDiffAsText(oldStr, newStr, filePath);

      // Last line should be a diff line, not an end marker
      expect(result[result.length - 1]).not.toContain("[/FILE]");
    });

    it("includes stats in header", () => {
      const oldStr = "line 1\nline 2";
      const newStr = "line 1 modified\nline 2\nline 3";
      const filePath = "/path/to/file.ts";

      const result = formatDiffAsText(oldStr, newStr, filePath);

      // Should show +N / -N format (no parentheses)
      expect(result[0]).toMatch(/\+\d+ \/ -\d+/);
    });
  });

  describe("width padding", () => {
    it("pads lines to specified width", () => {
      const oldStr = "short";
      const newStr = "short modified";
      const filePath = "/path/to/file.ts";
      const width = 80;

      const result = formatDiffAsText(oldStr, newStr, filePath, 3, width);

      // All lines should be exactly width characters
      for (const line of result) {
        expect(line.length).toBe(width);
      }
    });

    it("wraps long lines to width", () => {
      const oldStr = "x".repeat(100);
      const newStr = "y".repeat(100);
      const filePath = "/path/to/file.ts";
      const width = 50;

      const result = formatDiffAsText(oldStr, newStr, filePath, 3, width);

      // All lines should be at most width characters
      for (const line of result) {
        expect(line.length).toBeLessThanOrEqual(width);
      }

      // Long diff content should produce wrapped rows (more than header + 2 diff lines)
      expect(result.length).toBeGreaterThan(3);
    });

    it("does not pad when width is not specified", () => {
      const oldStr = "short";
      const newStr = "short modified";
      const filePath = "/path/to/file.ts";

      const result = formatDiffAsText(oldStr, newStr, filePath);

      // Lines should vary in length
      const lengths = result.map(line => line.length);
      const allSameLength = lengths.every(len => len === lengths[0]);
      expect(allSameLength).toBe(false);
    });
  });

  describe("diff line format", () => {
    it("uses + prefix for added lines", () => {
      const oldStr = "";
      const newStr = "new line";
      const filePath = "/path/to/file.ts";

      const result = formatDiffAsText(oldStr, newStr, filePath);

      // Find the line with the added content
      const addedLine = result.find(line => line.includes("new line"));
      expect(addedLine).toBeDefined();
      expect(addedLine).toMatch(/\+\s+new line/);
    });

    it("keeps diff prefix on wrapped continuation rows", () => {
      const oldStr = "";
      const newStr = "a".repeat(120);
      const width = 40;

      const result = formatDiffAsText(oldStr, newStr, "/path/to/file.ts", 3, width);

      // Skip header, inspect only diff rows
      const diffRows = result.slice(1);
      expect(diffRows.length).toBeGreaterThan(1);
      for (const row of diffRows) {
        expect(row).toMatch(/^\s*\d+\s\+\s/);
      }
    });

    it("uses - prefix for removed lines", () => {
      const oldStr = "old line";
      const newStr = "";
      const filePath = "/path/to/file.ts";

      const result = formatDiffAsText(oldStr, newStr, filePath);

      // Find the line with the removed content
      const removedLine = result.find(line => line.includes("old line"));
      expect(removedLine).toBeDefined();
      expect(removedLine).toMatch(/-\s+old line/);
    });

    it("uses space prefix for context lines", () => {
      const oldStr = "unchanged\nold";
      const newStr = "unchanged\nnew";
      const filePath = "/path/to/file.ts";

      const result = formatDiffAsText(oldStr, newStr, filePath);

      // Find the unchanged line
      const contextLine = result.find(line => line.includes("unchanged"));
      expect(contextLine).toBeDefined();
      // Context lines have space prefix, not + or -
      expect(contextLine).not.toMatch(/[+-]\s+unchanged/);
    });
  });
});

describe("computeDiff", () => {
  it("detects added lines", () => {
    const result = computeDiff("", "new line");

    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(0);
    expect(result.lines[0].type).toBe("added");
  });

  it("detects removed lines", () => {
    const result = computeDiff("old line", "");

    expect(result.stats.removed).toBe(1);
    expect(result.stats.added).toBe(0);
    expect(result.lines[0].type).toBe("removed");
  });

  it("detects context lines", () => {
    const result = computeDiff("unchanged\nold", "unchanged\nnew");

    expect(result.stats.context).toBe(1);
    const contextLines = result.lines.filter(l => l.type === "context");
    expect(contextLines.length).toBeGreaterThan(0);
  });
});
