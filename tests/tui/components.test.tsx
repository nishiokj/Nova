describe("Text wrapping utility", () => {
  const wrapText = (text: string, maxWidth: number): string[] => {
    if (!text) return [""];
    const words = text.split(" ");
    const lines: string[] = [];
    let currentLine = "";
    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxWidth) {
        currentLine += (currentLine ? " " : "") + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.length > 0 ? lines : [""];
  };

  it("wraps text at specified width", () => {
    const text = "This is a long string that should wrap";
    const result = wrapText(text, 20);
    expect(result.length).toBeGreaterThan(1);
    result.forEach((line) => {
      expect(line.length).toBeLessThanOrEqual(20);
    });
  });

  it("handles empty text", () => {
    const result = wrapText("", 20);
    expect(result).toEqual([""]);
  });
});

describe("Theme", () => {
  it("can import and get colors", async () => {
    const { getColors } = await import("tui/theme.js");
    const colors = getColors();

    expect(colors.text).toBeDefined();
    expect(colors.muted).toBeDefined();
    expect(colors.accent).toBeDefined();
    expect(colors.success).toBeDefined();
    expect(colors.error).toBeDefined();
    expect(colors.warning).toBeDefined();
    expect(colors.info).toBeDefined();
  });

  it("returns valid hex colors", async () => {
    const { getColors } = await import("tui/theme.js");
    const colors = getColors();
    const hexRegex = /^#[0-9a-fA-F]{6}$/;

    expect(colors.text).toMatch(hexRegex);
    expect(colors.accent).toMatch(hexRegex);
  });
});
