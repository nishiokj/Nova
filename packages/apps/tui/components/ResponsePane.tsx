/**
 * ResponsePane - Full-pane response renderer.
 *
 * Renders diff output and other long responses as a dedicated full-pane view.
 * When active, this replaces the normal scrolling log view:
 * - No system/agent prefixes
 * - No timestamps
 * - Full-width row coloring for diffs
 * - Proper file grouping with visual boundaries
 */

import { Box, Text } from "ink";
import type { ResponseContent, ResponseLine } from "../types.js";
import { getColors } from "../theme.js";

// Diff colors - uses theme for header and context, text-only highlighting for add/remove
const getDiffColors = () => {
  const theme = getColors();
  return {
    header: { fg: theme.diffHeader },
    added: { fg: "#4ade80" },
    removed: { fg: "#f87171" },
    context: { fg: theme.text },
    separator: { fg: theme.muted },
    text: { fg: theme.text },
  };
};

interface ResponsePaneProps {
  content: ResponseContent;
  width: number;
  height: number;
}

/**
 * Renders a response pane with full-width colored rows.
 * Each line is padded to fill the entire width.
 */
export function ResponsePane({ content, width, height }: ResponsePaneProps): JSX.Element {
  const lines = content.lines;
  const visibleLines = lines.slice(0, height);
  const colors = getDiffColors();

  return (
    <Box flexDirection="column" width={width} height={height}>
      {visibleLines.map((line, i) => (
        <ResponseLineRow key={i} line={line} width={width} />
      ))}
      {/* Fill remaining space */}
      {Array.from({ length: Math.max(0, height - visibleLines.length) }).map((_, i) => (
        <Text key={`empty-${i}`}>
          {" ".repeat(width)}
        </Text>
      ))}
    </Box>
  );
}

interface ResponseLineRowProps {
  line: ResponseLine;
  width: number;
}

/**
 * Renders a single response line with full-width background color.
 */
function ResponseLineRow({ line, width }: ResponseLineRowProps): JSX.Element {
  const colors = getLineColors(line.type);

  // Pad text to full width for consistent background
  const paddedText = line.text.padEnd(width, " ").slice(0, width);

  return (
    <Text color={colors.fg}>
      {paddedText}
    </Text>
  );
}

function getLineColors(type: ResponseLine["type"]): { fg: string } {
  const colors = getDiffColors();
  switch (type) {
    case "header":
      return colors.header;
    case "added":
      return colors.added;
    case "removed":
      return colors.removed;
    case "context":
      return colors.context;
    case "separator":
      return colors.separator;
    case "text":
    default:
      return colors.text;
  }
}

/**
 * Parse diff text lines into ResponseContent format.
 * This is used when displaying Edit tool results in response mode.
 */
export function parseDiffToResponseContent(diffText: string, filePath?: string): ResponseContent {
  const lines: ResponseLine[] = [];
  const rawLines = diffText.split("\n");

  for (const rawLine of rawLines) {
    // Edit tool header: "✓ Edit /path/to/file.ts  +3 / -2 (123ms)"
    if (rawLine.match(/^[✓✗] Edit /)) {
      lines.push({ text: rawLine, type: "header" });
      continue;
    }

    // Diff lines with line numbers: "   42 + content" or "   42 - content" or "   42   content"
    const diffMatch = rawLine.match(/^(\s*\d+)\s([+-]|\s)\s(.*)$/);
    if (diffMatch) {
      const [, , prefix] = diffMatch;
      if (prefix === "+") {
        lines.push({ text: rawLine, type: "added" });
      } else if (prefix === "-") {
        lines.push({ text: rawLine, type: "removed" });
      } else {
        lines.push({ text: rawLine, type: "context" });
      }
      continue;
    }

    // Default to text
    lines.push({ text: rawLine, type: "text" });
  }

  return {
    type: "diff",
    lines,
    filePath,
  };
}
