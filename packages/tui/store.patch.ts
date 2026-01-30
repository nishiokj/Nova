// This is a patch file to apply the syntax highlighting integration

/**
 * Split markdown text into separate HistoryLines for block elements.
 * This handles headers, code blocks, lists, blockquotes that should be
 * separate rows in the terminal.
 *
 * Code blocks are syntax-highlighted using Tree-sitter for supported languages.
 *
 * This function strips block-level markdown markers (###, - for lists, etc.)
 * but keeps the text content. Inline markdown (bold, italic, code) is preserved
 * for later processing by parseMarkdownToSegments.
 *
 * @param text - The markdown text to split
 * @param role - The role to assign to each line
 * @param requestId - Optional request ID
 * @param baseId - Base ID for the lines
 * @returns Array of HistoryLine objects
 */
function splitMarkdownIntoLines(
  text: string,
  role?: Role,
  requestId?: string,
  baseId?: string,
): HistoryLine[] {
  const lines: HistoryLine[] = [];

  // First, normalize line endings and convert to array
  let normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");

  let inCodeBlock = false;
  let codeBlockLines: string[] = [];
  let codeBlockLang: string | undefined = undefined;
  let lineIndex = 0;

  for (let rawLine of rawLines) {
    // Check for code fence start/end
    if (/^```/.test(rawLine.trim())) {
      if (!inCodeBlock) {
        // Starting a code block
        inCodeBlock = true;
        codeBlockLines = [];
        // Extract language from ```lang
        const langMatch = rawLine.trim().match(/^```(\w*)/);
        codeBlockLang = langMatch ? langMatch[1] : undefined;
      } else {
        // Ending a code block
        inCodeBlock = false;
        const codeContent = codeBlockLines.join("\n");

        // Apply syntax highlighting
        const highlighted = highlightCode(codeContent, codeBlockLang);

        // If highlighting was applied (contains ANSI codes), split into lines
        // Otherwise fall back to original behavior
        if (highlighted && highlighted !== codeContent) {
          const highlightedLines = highlighted.split("\n");
          for (const hlLine of highlightedLines) {
            const lineId = baseId ? `${baseId}:${lineIndex}` : `line:${lineIndex}`;
            lines.push({
              id: lineId,
              text: hlLine,
              role,
              requestId,
            });
            lineIndex++;
          }
        } else {
          // No highlighting applied, just output code as regular lines
          for (let codeLine of codeBlockLines) {
            const lineId = baseId ? `${baseId}:${lineIndex}` : `line:${lineIndex}`;
            lines.push({
              id: lineId,
              text: codeLine,
              role,
              requestId,
            });
            lineIndex++;
          }
        }

        codeBlockLines = [];
        codeBlockLang = undefined;
      }
      continue; // Skip fence lines
    }

    if (inCodeBlock) {
      // Collect code block content
      codeBlockLines.push(rawLine);
      continue;
    }

    // Strip block-level markdown markers
    // Headers: "### Header" -> "Header"
    rawLine = rawLine.replace(/^#{1,6}\s+/, "");

    // Lists: "- item" or "* item" or "1. item" -> "item"
    rawLine = rawLine.replace(/^[-*+]\s+/, "");
    rawLine = rawLine.replace(/^\d+\.\s+/, "");

    // Blockquotes: "> quote" -> "quote"
    rawLine = rawLine.replace(/^>\s+/, "");

    // Horizontal rules: ---, ***, ___ - skip
    if (/^[-*_]{3,}\s*$/.test(rawLine)) {
      continue;
    }

    const lineId = baseId ? `${baseId}:${lineIndex}` : `line:${lineIndex}`;

    lines.push({
      id: lineId,
      text: rawLine,
      role,
      requestId,
    });

    lineIndex++;
  }

  // Handle unclosed code block (shouldn't happen but be defensive)
  if (inCodeBlock && codeBlockLines.length > 0) {
    const codeContent = codeBlockLines.join("\n");
    const highlighted = highlightCode(codeContent, codeBlockLang);
    const outputLines = (highlighted && highlighted !== codeContent)
      ? highlighted.split("\n")
      : codeBlockLines;
    for (let outputLine of outputLines) {
      const lineId = baseId ? `${baseId}:${lineIndex}` : `line:${lineIndex}`;
      lines.push({
        id: lineId,
        text: outputLine,
        role,
        requestId,
      });
      lineIndex++;
    }
  }

  return lines;
}
