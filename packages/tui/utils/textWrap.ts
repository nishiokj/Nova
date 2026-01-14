/**
 * Text wrapping utilities for terminal UI rendering.
 */

/**
 * Wraps text to fit within a specified width, respecting word boundaries where possible.
 * Falls back to hard wrapping for very long words.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];

  const lines: string[] = [];
  const safeWidth = Math.max(1, width);

  // Handle explicit newlines first
  const rawLines = text.split("\n");

  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }

    // Try word-aware wrapping first
    const wrapped = wrapLineByWords(rawLine, safeWidth);
    lines.push(...wrapped);
  }

  return lines;
}

/**
 * Wraps a single line of text, trying to break at word boundaries.
 */
function wrapLineByWords(line: string, width: number): string[] {
  if (line.length <= width) {
    return [line];
  }

  const lines: string[] = [];
  const words = line.split(/(\s+)/); // Split but keep whitespace
  let currentLine = "";

  for (const word of words) {
    // If word itself is too long, hard-wrap it
    if (word.length > width) {
      if (currentLine) {
        lines.push(currentLine);
        currentLine = "";
      }
      // Hard wrap the long word
      for (let i = 0; i < word.length; i += width) {
        const chunk = word.slice(i, i + width);
        if (i + width < word.length) {
          lines.push(chunk);
        } else {
          currentLine = chunk;
        }
      }
      continue;
    }

    // Check if adding word would exceed width
    if (currentLine.length + word.length > width) {
      if (currentLine.trimEnd()) {
        lines.push(currentLine.trimEnd());
      }
      currentLine = word.trimStart();
    } else {
      currentLine += word;
    }
  }

  if (currentLine.trimEnd()) {
    lines.push(currentLine.trimEnd());
  }

  return lines.length > 0 ? lines : [""];
}

/**
 * Hard wraps text at exactly the specified width, preserving all whitespace.
 * Use this for code blocks where preserving exact formatting is important.
 */
export function hardWrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];

  const lines: string[] = [];
  const safeWidth = Math.max(1, width);

  const rawLines = text.split("\n");

  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }

    let start = 0;
    while (start < rawLine.length) {
      const chunk = rawLine.slice(start, start + safeWidth);
      lines.push(chunk);
      start += safeWidth;
    }
  }

  return lines;
}

/**
 * Truncates text to fit within a width, adding ellipsis if needed.
 */
export function truncateText(text: string, width: number, ellipsis = "..."): string {
  if (text.length <= width) return text;
  if (width <= ellipsis.length) return text.slice(0, width);
  return text.slice(0, width - ellipsis.length) + ellipsis;
}

/**
 * Pads text to a specified width, aligning left, right, or center.
 */
export function padText(
  text: string,
  width: number,
  align: "left" | "right" | "center" = "left"
): string {
  if (text.length >= width) return text.slice(0, width);

  const padding = width - text.length;

  switch (align) {
    case "right":
      return " ".repeat(padding) + text;
    case "center":
      const leftPad = Math.floor(padding / 2);
      const rightPad = padding - leftPad;
      return " ".repeat(leftPad) + text + " ".repeat(rightPad);
    default:
      return text + " ".repeat(padding);
  }
}

/**
 * Gets the visual width of a string, accounting for wide characters.
 * This is a simplified version - for full Unicode support, consider using
 * a library like string-width.
 */
export function getStringWidth(str: string): number {
  // For now, just return length. Could be enhanced for CJK characters.
  return str.length;
}
