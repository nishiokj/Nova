/**
 * Streaming JSON response extractor.
 *
 * Incrementally parses JSON as it streams and extracts the `response` field
 * in real-time, enabling streaming for structured output agents.
 */

/**
 * State for tracking position within the JSON stream.
 */
type ExtractorState =
  | 'searching'      // Looking for "response": "
  | 'in_string'      // Inside the response string value
  | 'done';          // Found end of response string

/**
 * Extracts the `response` field from streaming JSON in real-time.
 *
 * Usage:
 * ```typescript
 * const extractor = new StreamingJsonExtractor();
 * onChunk((chunk) => {
 *   const newContent = extractor.addChunk(chunk);
 *   if (newContent) emit(newContent);
 * });
 * ```
 */
export class StreamingJsonExtractor {
  private buffer = '';
  private state: ExtractorState = 'searching';
  private extractedContent = '';
  private emittedLength = 0;

  /**
   * Add a chunk and return any new response content.
   * Returns null if no new content is available yet.
   */
  addChunk(chunk: string): string | null {
    this.buffer += chunk;

    if (this.state === 'done') {
      return null;
    }

    if (this.state === 'searching') {
      // Look for "response" followed by : and opening "
      // Handle variations: "response": " or "response" : " or "response":"
      const pattern = /"response"\s*:\s*"/;
      const match = pattern.exec(this.buffer);
      if (match?.index !== undefined) {
        this.state = 'in_string';
        // Start parsing from after the opening quote
        const startPos = match.index + match[0].length;
        this.parseStringContent(startPos);
      }
    } else {
      // state === 'in_string': continue parsing from where we left off
      this.parseStringContent(0);
    }

    // Return new content if we have any
    if (this.extractedContent.length > this.emittedLength) {
      const newContent = this.extractedContent.slice(this.emittedLength);
      this.emittedLength = this.extractedContent.length;
      return newContent;
    }

    return null;
  }

  /**
   * Parse string content starting from the given position in the buffer.
   * Handles JSON escape sequences and detects the end of the string.
   */
  private parseStringContent(startPos: number): void {
    let i = startPos;
    let escaped = false;

    while (i < this.buffer.length) {
      const ch = this.buffer[i];

      if (escaped) {
        // Handle escape sequences
        const unescaped = this.unescapeChar(ch, i);
        if (unescaped !== null) {
          this.extractedContent += unescaped.char;
          i += unescaped.consumed;
        } else {
          // Incomplete escape sequence (e.g., \u at end of buffer)
          // Trim buffer to before the escape and wait for more data
          this.buffer = this.buffer.slice(i - 1);
          return;
        }
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        escaped = true;
        i++;
        continue;
      }

      if (ch === '"') {
        // End of string
        this.state = 'done';
        this.buffer = this.buffer.slice(i + 1);
        return;
      }

      // Regular character
      this.extractedContent += ch;
      i++;
    }

    // Reached end of buffer, trim processed content
    if (escaped) {
      // Incomplete escape at end - keep the backslash for next chunk
      this.buffer = '\\';
    } else {
      this.buffer = '';
    }
  }

  /**
   * Unescape a JSON escape sequence character.
   * Returns the unescaped character and how many additional chars were consumed,
   * or null if the sequence is incomplete.
   */
  private unescapeChar(ch: string, pos: number): { char: string; consumed: number } | null {
    switch (ch) {
      case '"': return { char: '"', consumed: 1 };
      case '\\': return { char: '\\', consumed: 1 };
      case '/': return { char: '/', consumed: 1 };
      case 'b': return { char: '\b', consumed: 1 };
      case 'f': return { char: '\f', consumed: 1 };
      case 'n': return { char: '\n', consumed: 1 };
      case 'r': return { char: '\r', consumed: 1 };
      case 't': return { char: '\t', consumed: 1 };
      case 'u': {
        // Unicode escape: \uXXXX
        const hex = this.buffer.slice(pos + 1, pos + 5);
        if (hex.length < 4) {
          // Incomplete unicode escape
          return null;
        }
        const codePoint = parseInt(hex, 16);
        if (isNaN(codePoint)) {
          // Invalid unicode, output as-is
          return { char: `\\u${hex}`, consumed: 5 };
        }
        return { char: String.fromCharCode(codePoint), consumed: 5 };
      }
      default:
        // Unknown escape, pass through
        return { char: ch, consumed: 1 };
    }
  }

  /**
   * Get the full extracted content so far.
   */
  getContent(): string {
    return this.extractedContent;
  }

  /**
   * Check if the response field has been fully extracted.
   */
  isDone(): boolean {
    return this.state === 'done';
  }

  /**
   * Reset the extractor for reuse.
   */
  reset(): void {
    this.buffer = '';
    this.state = 'searching';
    this.extractedContent = '';
    this.emittedLength = 0;
  }
}

/**
 * Create a streaming response extractor.
 * Convenience function for one-off usage.
 */
export function createStreamingJsonExtractor(): StreamingJsonExtractor {
  return new StreamingJsonExtractor();
}
