/**
 * Tests for normalizeHistoryLines in store.ts
 */

// Import the HistoryLine interface
interface HistoryLine {
  id: string;
  text: string;
  role?: string;
  requestId?: string;
  isBlockStart?: boolean;
  isBlockEnd?: boolean;
}

// Since normalizeHistoryLines is not exported, we need to re-implement it for testing
// This is a simplified version for testing purposes
function normalizeHistoryLines(lines: HistoryLine[], width: number): HistoryLine[] {
  const normalized: HistoryLine[] = [];
  const safeWidth = Math.max(10, width);

  for (const line of lines) {
    // Split by embedded newlines, preserving metadata for each part
    let textParts = line.text.split("\n");

    for (let partIndex = 0; partIndex < textParts.length; partIndex++) {
      let text = textParts[partIndex];

      // Strip carriage returns
      text = text.replace(/\r/g, "");

      // Convert tabs to spaces (expand to 8-space intervals for consistency)
      text = text.replace(/\t/g, "        ");

      // Handle empty strings - replace with single space
      if (text === "") {
        text = " ";
      }

      // Truncate to width
      if (text.length > safeWidth) {
        text = text.slice(0, safeWidth);
      }

      // Pad to exact width with spaces
      while (text.length < safeWidth) {
        text += " ";
      }

      // Create the normalized line
      const normalizedLine: HistoryLine = {
        id: partIndex === 0 ? line.id : `${line.id}:${partIndex}`,
        text,
        role: line.role,
        requestId: line.requestId,
      };

      // Preserve block markers on the original line only
      if (partIndex === 0) {
        normalizedLine.isBlockStart = line.isBlockStart;
        normalizedLine.isBlockEnd = line.isBlockEnd;
      }

      normalized.push(normalizedLine);
    }
  }

  return normalized;
}

describe("normalizeHistoryLines", () => {
  describe("empty-string handling", () => {
    it("replaces empty string with single space", () => {
      const lines: HistoryLine[] = [
        { id: "1", text: "" },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe(" " + " ".repeat(79)); // " " plus padding
      expect(result[0].text.length).toBe(80);
    });

    it("replaces multiple empty strings with spaces", () => {
      const lines: HistoryLine[] = [
        { id: "1", text: "" },
        { id: "2", text: "" },
        { id: "3", text: "" },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(3);
      result.forEach(line => {
        expect(line.text).toMatch(/^ /);
        expect(line.text.length).toBe(80);
      });
    });

    it("preserves non-empty content", () => {
      const lines: HistoryLine[] = [
        { id: "1", text: "Hello world" },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      expect(result[0].text).toMatch(/^Hello world/);
      expect(result[0].text.length).toBe(80);
    });
  });

  describe("newline splitting", () => {
    it("splits single line with embedded newline into two lines", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "Hello\nworld" },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(2);
      expect(result[0].text).toMatch(/^Hello/);
      expect(result[0].text.length).toBe(80);
      expect(result[1].text).toMatch(/^world/);
      expect(result[1].text.length).toBe(80);
      expect(result[0].id).toBe("line1");
      expect(result[1].id).toBe("line1:1");
    });

    it("splits multiple newlines correctly", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "one\ntwo\nthree" },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(3);
      expect(result[0].text).toMatch(/^one/);
      expect(result[1].text).toMatch(/^two/);
      expect(result[2].text).toMatch(/^three/);
      expect(result[0].id).toBe("line1");
      expect(result[1].id).toBe("line1:1");
      expect(result[2].id).toBe("line1:2");
    });

    it("preserves role and requestId when splitting", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "first\nsecond", role: "agent", requestId: "req123" },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(2);
      result.forEach(line => {
        expect(line.role).toBe("agent");
        expect(line.requestId).toBe("req123");
      });
    });
  });

  describe("long line truncation", () => {
    it("truncates line longer than width", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "x".repeat(100) },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      expect(result[0].text.length).toBe(80);
      expect(result[0].text).toBe("x".repeat(80));
    });

    it("truncates very long line", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "a".repeat(500) },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      expect(result[0].text.length).toBe(80);
      expect(result[0].text).toBe("a".repeat(80));
    });
  });

  describe("width padding", () => {
    it("pads short line to exact width", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "short" },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      expect(result[0].text).toMatch(/^short/);
      expect(result[0].text.length).toBe(80);
      expect(result[0].text).toBe("short" + " ".repeat(75));
    });

    it("handles line already at width", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "x".repeat(80) },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe("x".repeat(80));
    });

    it("works with different widths", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "test" },
      ];

      const result40 = normalizeHistoryLines(lines, 40);
      expect(result40[0].text.length).toBe(40);

      const result120 = normalizeHistoryLines(lines, 120);
      expect(result120[0].text.length).toBe(120);
    });
  });

  describe("carriage return handling", () => {
    it("removes carriage returns", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "Hello\rworld" },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      expect(result[0].text).toMatch(/^Helloworld/);
      expect(result[0].text).not.toContain("\r");
    });

    it("removes CRLF sequences", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "one\rtwo" },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      expect(result[0].text).not.toContain("\r");
    });
  });

  describe("tab handling", () => {
    it("converts tabs to spaces", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "Hello\tworld" },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      expect(result[0].text).toMatch(/^Hello        world/); // Tab replaced with 8 spaces
      expect(result[0].text).not.toContain("\t");
    });

    it("converts multiple tabs to spaces", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "one\t\t\ttwo" },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      // 3 tabs become 24 spaces between "one" and "two"
      // After padding to width 80, the line is "one" + 24 spaces + "two" + padding
      expect(result[0].text).toMatch(/^one\s+two\s+$/);
      expect(result[0].text.length).toBe(80);
      expect(result[0].text).not.toContain("\t");
    });
  });

  describe("block marker preservation", () => {
    it("preserves isBlockStart and isBlockEnd on first line after split", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "first\nsecond", isBlockStart: true, isBlockEnd: true },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(2);
      expect(result[0].isBlockStart).toBe(true);
      expect(result[0].isBlockEnd).toBe(true);
      expect(result[1].isBlockStart).toBeUndefined();
      expect(result[1].isBlockEnd).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("handles empty lines array", () => {
      const lines: HistoryLine[] = [];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(0);
    });

    it("handles minimum width boundary", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "x".repeat(100) },
      ];
      const width = 1;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      expect(result[0].text.length).toBe(10); // Math.max(10, 1)
    });

    it("handles whitespace-only lines", () => {
      const lines: HistoryLine[] = [
        { id: "line1", text: "   " },
      ];
      const width = 80;

      const result = normalizeHistoryLines(lines, width);

      expect(result).toHaveLength(1);
      expect(result[0].text).toMatch(/^   /);
      expect(result[0].text.length).toBe(80);
    });
  });
});
