/**
 * Diff rendering utilities for the TUI.
 *
 * Computes line-level diffs and renders them with text-only coloring
 * (red for deletions, green for additions) while preserving syntax highlighting.
 */

import React from "react";
import { Text, Box } from "ink";
import { diffLines, type Change } from "diff";

export interface DiffLine {
  type: "added" | "removed" | "context";
  content: string;
  lineNumber?: { old?: number; new?: number };
}

export interface DiffResult {
  lines: DiffLine[];
  stats: { added: number; removed: number; context: number };
}

/**
 * Compute a line-level diff between old and new strings.
 * Returns structured diff lines with type annotations.
 */
export function computeDiff(oldStr: string, newStr: string, contextLines = 3): DiffResult {
  const changes = diffLines(oldStr, newStr);
  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let stats = { added: 0, removed: 0, context: 0 };

  for (const change of changes) {
    const changeLines = change.value.split("\n");
    // Remove trailing empty string from split if value ends with newline
    if (changeLines[changeLines.length - 1] === "") {
      changeLines.pop();
    }

    for (const content of changeLines) {
      if (change.added) {
        lines.push({
          type: "added",
          content,
          lineNumber: { new: newLine++ },
        });
        stats.added++;
      } else if (change.removed) {
        lines.push({
          type: "removed",
          content,
          lineNumber: { old: oldLine++ },
        });
        stats.removed++;
      } else {
        lines.push({
          type: "context",
          content,
          lineNumber: { old: oldLine++, new: newLine++ },
        });
        stats.context++;
      }
    }
  }

  // Apply context limiting - only show contextLines around changes
  if (contextLines > 0 && lines.length > contextLines * 2 + 1) {
    const filtered: DiffLine[] = [];
    let lastChangeIndex = -Infinity;

    // First pass: find indices of all changes
    const changeIndices = lines
      .map((line, i) => (line.type !== "context" ? i : -1))
      .filter((i) => i >= 0);

    if (changeIndices.length === 0) {
      // No changes, return empty
      return { lines: [], stats: { added: 0, removed: 0, context: 0 } };
    }

    // Second pass: include lines within context range of any change
    for (let i = 0; i < lines.length; i++) {
      const nearChange = changeIndices.some(
        (ci) => Math.abs(i - ci) <= contextLines
      );
      if (nearChange) {
        // Check if we need to add a separator (skipped lines indicator)
        if (filtered.length > 0 && i > lastChangeIndex + 1) {
          const lastFiltered = filtered[filtered.length - 1];
          if (lastFiltered && lastFiltered.type === "context") {
            // Check if there's a gap
            const gap = i - lastChangeIndex - 1;
            if (gap > 0) {
              filtered.push({
                type: "context",
                content: `... ${gap} lines hidden ...`,
                lineNumber: {},
              });
            }
          }
        }
        filtered.push(lines[i]);
        lastChangeIndex = i;
      }
    }

    return { lines: filtered, stats };
  }

  return { lines, stats };
}

interface DiffBlockProps {
  oldStr: string;
  newStr: string;
  filePath?: string;
  width?: number;
  contextLines?: number;
}

/** Colors for diff rendering - text-only highlighting (no background) */
const DIFF_COLORS = {
  added: { fg: "#4ade80" },      // Light green text
  removed: { fg: "#f87171" },    // Light red text
  context: { fg: "#9ca3af" },    // Gray text
  lineNum: "#6b7280",            // Gray for line numbers
  header: "#60a5fa",             // Blue for file path
  stats: { added: "#4ade80", removed: "#f87171" },
};

/**
 * Render a diff block with text-only coloring.
 * Integrates with the TUI's visual style.
 */
export function DiffBlock({ oldStr, newStr, filePath, width = 80, contextLines = 3 }: DiffBlockProps): JSX.Element {
  const { lines, stats } = computeDiff(oldStr, newStr, contextLines);

  if (lines.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={DIFF_COLORS.context.fg} dimColor>No changes</Text>
      </Box>
    );
  }

  const lineNumWidth = 4;
  const contentWidth = width - lineNumWidth - 3; // -3 for prefix and padding

  return (
    <Box flexDirection="column">
      {/* Header with file path and stats */}
      {filePath && (
        <Text>
          <Text color={DIFF_COLORS.header} bold>📄 {filePath}</Text>
          <Text color={DIFF_COLORS.context.fg}> </Text>
          <Text color={DIFF_COLORS.stats.added}>+{stats.added}</Text>
          <Text color={DIFF_COLORS.context.fg}> / </Text>
          <Text color={DIFF_COLORS.stats.removed}>-{stats.removed}</Text>
        </Text>
      )}

      {/* Diff lines */}
      <Box flexDirection="column" marginTop={filePath ? 1 : 0}>
        {lines.map((line, i) => {
          const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          const lineNum = line.type === "added"
            ? String(line.lineNumber?.new ?? "").padStart(lineNumWidth, " ")
            : String(line.lineNumber?.old ?? "").padStart(lineNumWidth, " ");

          // Truncate content to fit width
          const displayContent = line.content.length > contentWidth
            ? line.content.slice(0, contentWidth - 1) + "…"
            : line.content;

          const colors = DIFF_COLORS[line.type];

          return (
            <Text key={i}>
              <Text color={DIFF_COLORS.lineNum}>{lineNum}</Text>
              <Text color={colors.fg}> {prefix} </Text>
              <Text color={colors.fg}>{displayContent}</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

/**
 * Format diff as plain text lines for embedding in message history.
 * Returns an array of strings that can be joined and displayed.
 *
 * Output format:
 * - File header: "/path/to/file.ts  +3 / -2"
 * - Added lines: "   42 + content"
 * - Removed lines: "   42 - content"
 * - Context lines: "   42   content"
 *
 * When width is provided, lines are padded with spaces to enable full-width
 * background coloring in the TUI.
 */
export function formatDiffAsText(
  oldStr: string,
  newStr: string,
  filePath?: string,
  contextLines = 3,
  width?: number
): string[] {
  const { lines, stats } = computeDiff(oldStr, newStr, contextLines);
  const output: string[] = [];

  if (lines.length === 0) {
    return ["  (no changes)"];
  }

  // Helper to pad line to full width (for full-width background coloring)
  const padLine = (line: string): string => {
    if (!width) return line;
    // Pad to width, but don't exceed (truncate if needed)
    if (line.length >= width) {
      return line.slice(0, width);
    }
    return line.padEnd(width, " ");
  };

  // File header - just the path and stats, no brackets
  if (filePath) {
    output.push(padLine(`${filePath}  +${stats.added} / -${stats.removed}`));
  }

  // Diff lines with line numbers
  const lineNumWidth = 4;
  for (const line of lines) {
    const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
    const lineNum = line.type === "added"
      ? String(line.lineNumber?.new ?? "").padStart(lineNumWidth, " ")
      : String(line.lineNumber?.old ?? "").padStart(lineNumWidth, " ");
    output.push(padLine(`${lineNum} ${prefix} ${line.content}`));
  }

  // No end marker - spacing handled by message layout

  return output;
}

export interface ToolCallDisplay {
  toolName: string;
  args: Record<string, unknown>;
  phase: "starting" | "completed";
  success?: boolean;
  durationMs?: number;
  // For Edit tool specifically
  diff?: {
    filePath: string;
    oldStr: string;
    newStr: string;
  };
}

/**
 * Format a tool call for display in the TUI.
 * Returns formatted lines suitable for the message history.
 *
 * @param call - The tool call to format
 * @param width - Optional terminal width for full-width diff padding
 */
export function formatToolCall(call: ToolCallDisplay, width?: number): string[] {
  const output: string[] = [];
  const status = call.phase === "starting"
    ? "⏳"
    : call.success ? "✓" : "✗";
  const duration = call.durationMs ? ` (${call.durationMs}ms)` : "";

  // Tool header
  output.push(`${status} ${call.toolName}${duration}`);

  // For Edit tool with diff data, show the diff
  if (call.diff && call.toolName === "Edit") {
    const diffLines = formatDiffAsText(call.diff.oldStr, call.diff.newStr, call.diff.filePath, 3, width);
    output.push(...diffLines.map(l => `  ${l}`));
  } else if (call.phase === "starting") {
    // Show relevant args for other tools
    const relevantArgs = formatRelevantArgs(call.toolName, call.args);
    if (relevantArgs) {
      output.push(`  ${relevantArgs}`);
    }
  }

  return output;
}

/**
 * Extract and format the most relevant arguments for a tool call.
 */
function formatRelevantArgs(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case "Read":
      return args.path ? `path: ${args.path}` : null;
    case "Write":
      return args.path ? `path: ${args.path}` : null;
    case "Bash":
      return args.command ? `$ ${String(args.command).slice(0, 60)}${String(args.command).length > 60 ? "…" : ""}` : null;
    case "Glob":
      return args.pattern ? `pattern: ${args.pattern}` : null;
    case "Grep":
      return args.pattern ? `pattern: ${args.pattern}` : null;
    case "Edit":
      return args.path ? `path: ${args.path}` : null;
    default:
      // For unknown tools, show first string arg
      for (const [key, val] of Object.entries(args)) {
        if (typeof val === "string" && val.length < 80) {
          return `${key}: ${val}`;
        }
      }
      return null;
  }
}
