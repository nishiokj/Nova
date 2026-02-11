// Resource limit for input buffer to prevent memory exhaustion
const MAX_INPUT_LENGTH = 100 * 1024; // 100KB

export interface InputLayout {
  lines: string[];
  lineStartIndices: number[];
  lineLengths: number[];
  cursorLine: number;
  cursorCol: number;
}

export class InputBuffer {
  private buffer: string[] = [];
  private cursor = 0;

  getRawBuffer(): string[] {
    return [...this.buffer];
  }

  getText(): string {
    return this.buffer.join("");
  }

  getCursor(): number {
    return this.cursor;
  }

  setText(text: string): void {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.buffer = normalized.split("");
    this.cursor = this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
    this.cursor = 0;
  }

  insertText(text: string): void {
    if (!text) {
      return;
    }
    // Enforce input limit - silently reject if full
    if (this.buffer.length >= MAX_INPUT_LENGTH) {
      return;
    }
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Truncate to fit within limit
    const available = MAX_INPUT_LENGTH - this.buffer.length;
    const chars = normalized.slice(0, available).split("");
    this.buffer.splice(this.cursor, 0, ...chars);
    this.cursor += chars.length;
  }

  backspace(): boolean {
    if (this.cursor <= 0) {
      return false;
    }
    this.buffer.splice(this.cursor - 1, 1);
    this.cursor -= 1;
    return true;
  }

  deleteForward(): boolean {
    if (this.cursor >= this.buffer.length) {
      return false;
    }
    this.buffer.splice(this.cursor, 1);
    return true;
  }

  moveCursor(delta: number): boolean {
    const next = Math.max(0, Math.min(this.cursor + delta, this.buffer.length));
    if (next === this.cursor) {
      return false;
    }
    this.cursor = next;
    return true;
  }

  moveCursorTo(position: number): boolean {
    const next = Math.max(0, Math.min(position, this.buffer.length));
    if (next === this.cursor) {
      return false;
    }
    this.cursor = next;
    return true;
  }

  deleteWordBack(): boolean {
    if (this.cursor === 0) {
      return false;
    }

    let index = this.cursor;
    while (index > 0 && isWhitespace(this.buffer[index - 1])) {
      index -= 1;
    }
    while (index > 0 && !isWhitespace(this.buffer[index - 1])) {
      index -= 1;
    }

    if (index === this.cursor) {
      return false;
    }

    this.buffer.splice(index, this.cursor - index);
    this.cursor = index;
    return true;
  }

  replaceRange(start: number, end: number, text: string): void {
    const safeStart = Math.max(0, Math.min(start, this.buffer.length));
    const safeEnd = Math.max(safeStart, Math.min(end, this.buffer.length));
    this.buffer.splice(safeStart, safeEnd - safeStart, ...text.split(""));
    this.cursor = safeStart + text.length;
  }

  moveCursorUp(width: number, prompt: string): boolean {
    const layout = computeInputLayout(this.buffer, this.cursor, width, prompt);
    if (layout.cursorLine === 0) {
      return false;
    }

    const targetLine = layout.cursorLine - 1;
    const targetStart = layout.lineStartIndices[targetLine];
    const targetLength = layout.lineLengths[targetLine];
    const targetCol = Math.min(layout.cursorCol, targetLength);
    this.cursor = targetStart + targetCol;
    return true;
  }

  moveCursorDown(width: number, prompt: string): boolean {
    const layout = computeInputLayout(this.buffer, this.cursor, width, prompt);
    if (layout.cursorLine >= layout.lines.length - 1) {
      return false;
    }

    const targetLine = layout.cursorLine + 1;
    const targetStart = layout.lineStartIndices[targetLine];
    const targetLength = layout.lineLengths[targetLine];
    const targetCol = Math.min(layout.cursorCol, targetLength);
    this.cursor = targetStart + targetCol;
    return true;
  }

  /**
   * Efficiently insert a large block of text at the cursor position.
   * Optimized for pasting: uses array concatenation for large texts.
   * Preserves all whitespace and indentation.
   */
  insertBulkText(text: string): void {
    if (!text) return;

    // Enforce input limit
    const available = MAX_INPUT_LENGTH - this.buffer.length;
    if (available <= 0) return;

    // Normalize line endings but preserve all other whitespace
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Truncate to fit within limit
    const truncated = normalized.slice(0, available);

    // For large pastes (>1000 chars), use array concatenation
    // which is more efficient than splice for large insertions
    if (truncated.length > 1000) {
      const before = this.buffer.slice(0, this.cursor);
      const after = this.buffer.slice(this.cursor);
      const chars = truncated.split("");
      this.buffer = [...before, ...chars, ...after];
      this.cursor += chars.length;
    } else {
      // Small paste - use existing method
      const chars = truncated.split("");
      this.buffer.splice(this.cursor, 0, ...chars);
      this.cursor += chars.length;
    }
  }

  /**
   * Replace entire buffer content efficiently.
   * Used for very large pastes where incremental update is too slow.
   */
  replaceBulk(text: string, cursorAtEnd = true): void {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.buffer = normalized.split("");
    this.cursor = cursorAtEnd ? this.buffer.length : 0;
  }

  /**
   * Get buffer length without joining to string.
   */
  getLength(): number {
    return this.buffer.length;
  }
}

export function computeInputLayout(
  buffer: string[],
  cursor: number,
  width: number,
  prompt: string,
): InputLayout {
  const lines: string[] = [];
  const lineStartIndices: number[] = [];
  const lineLengths: number[] = [];
  const positions: Array<{ line: number; col: number }> = [];

  let line = 0;
  let col = 0;
  let current = "";
  let lineStart = 0;

  const safeWidth = Math.max(1, width);
  const lineWidth = Math.max(1, safeWidth - prompt.length);
  let maxWidth = lineWidth;

  for (let i = 0; i < buffer.length; i += 1) {
    positions[i] = { line, col };
    const ch = buffer[i];

    if (ch === "\n") {
      lines.push(current);
      lineStartIndices.push(lineStart);
      lineLengths.push(current.length);
      current = "";
      line += 1;
      col = 0;
      lineStart = i + 1;
      maxWidth = lineWidth;
      continue;
    }

    if (col >= maxWidth) {
      lines.push(current);
      lineStartIndices.push(lineStart);
      lineLengths.push(current.length);
      current = "";
      line += 1;
      col = 0;
      lineStart = i;
      maxWidth = lineWidth;
    }

    current += ch;
    col += 1;
  }

  positions[buffer.length] = { line, col };
  lines.push(current);
  lineStartIndices.push(lineStart);
  lineLengths.push(current.length);

  const cursorPos = positions[Math.min(cursor, buffer.length)] ?? { line: 0, col: 0 };

  return {
    lines,
    lineStartIndices,
    lineLengths,
    cursorLine: cursorPos.line,
    cursorCol: cursorPos.col,
  };
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}
