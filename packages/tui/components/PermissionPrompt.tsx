import { Box, Text } from "ink";
import type { PermissionRequestData } from "../types.js";
import { getColors } from "../theme.js";

/**
 * PermissionPrompt - Modal for tool permission requests.
 *
 * Displays permission requests for Bash, Write, and Edit tools.
 * Users can Allow (one-time), Always Allow (persistent), or Deny.
 */

interface PermissionPromptProps {
  request: PermissionRequestData;
  cursor: number;
  width: number;
  height?: number; // Optional height constraint for modal
}

/**
 * Calculate the actual display width of a string in terminal columns.
 * Handles ANSI escape codes (strips them) and wide Unicode characters
 * (CJK, emojis, etc.) that occupy 2 columns instead of 1.
 */
function getDisplayWidth(text: string): number {
  // ANSI escape code pattern: \x1b[...m or \033[...m
  const ansiPattern = /\x1b\[.*?m|\033\[.*?m/g;
  const withoutAnsi = text.replace(ansiPattern, "");

  let width = 0;
  for (let i = 0; i < withoutAnsi.length; i++) {
    const code = withoutAnsi.codePointAt(i)!;

    // Wide characters (CJK, emojis, etc.) - ranges based on East Asian Width
    // Fullwidth (F), Wide (W), and some Ambiguous (A) characters
    const isWide = (
      (code >= 0x1100 && code <= 0x115F) || // Hangul Jamo
      (code >= 0x2329 && code <= 0x232A) || // Left/Right angle brackets
      (code >= 0x2E80 && code <= 0x303E) || // CJK radicals, symbols, punctuation
      (code >= 0x3040 && code <= 0xA4CF) || // Hiragana, Katakana, Hangul, CJK Unified Ideographs
      (code >= 0xAC00 && code <= 0xD7A3) || // Hangul Syllables
      (code >= 0xF900 && code <= 0xFAFF) || // CJK Compatibility Ideographs
      (code >= 0xFE10 && code <= 0xFE19) || // Vertical forms
      (code >= 0xFE30 && code <= 0xFE6F) || // CJK compatibility forms, small forms
      (code >= 0xFF00 && code <= 0xFF60) || // Fullwidth ASCII variants
      (code >= 0xFFE0 && code <= 0xFFE6) || // Fullwidth symbols
      (code >= 0x1F300 && code <= 0x1F5FF) || // Misc symbols and pictographs
      (code >= 0x1F600 && code <= 0x1F64F) || // Emoticons
      (code >= 0x1F680 && code <= 0x1F6FF) || // Transport and map symbols
      (code >= 0x1F900 && code <= 0x1F9FF) || // Supplemental symbols and pictographs
      (code >= 0x20000 && code <= 0x2FFFD) || // CJK extensions A-D
      (code >= 0x30000 && code <= 0x3FFFD) || // CJK extensions E-F
      (code === 0x23F0) || // Alarm clock (emoji)
      (code === 0x23F3) || // Hourglass with flowing sand (emoji)
      (code >= 0x25A0 && code <= 0x25FF) || // Geometric shapes (some are wide)
      (code >= 0x2600 && code <= 0x26FF) || // Misc symbols (some are wide)
      (code >= 0x2700 && code <= 0x27BF) || // Dingbats
      (code >= 0x2B50 && code <= 0x2BFF)    // Stars and symbols
    );

    width += isWide ? 2 : 1;

    // Skip surrogate pair second half (for emojis)
    if (code >= 0xD800 && code <= 0xDBFF) {
      i++;
    }
  }

  return width;
}

export function PermissionPrompt({
  request,
  cursor,
  width,
  height,
}: PermissionPromptProps): JSX.Element {
  const colors = getColors();
  const contentWidth = Math.max(30, width - 6);
  const maxHeight = height || 15; // Default max height if not specified

  // Tool icon based on type
  const getToolIcon = () => {
    switch (request.tool) {
      case "Bash": return "$";
      case "Write": return "+";
      case "Edit": return "~";
      default: return "?";
    }
  };

  // Tool color based on type
  const getToolColor = () => {
    switch (request.tool) {
      case "Bash": return colors.warning;
      case "Write": return colors.success;
      case "Edit": return colors.info;
      default: return colors.text;
    }
  };

  // Truncate text to fit within maxWidth, adding "..." if truncated
  // Reserves 3 chars for "..." at the end if text is too long
  const truncateText = (text: string, maxWidth: number): string => {
    if (!text) return "";
    if (getDisplayWidth(text) <= maxWidth) return text;

    const ellipsis = "...";
    const ellipsisWidth = getDisplayWidth(ellipsis);
    const availableWidth = maxWidth - ellipsisWidth;

    if (availableWidth <= 0) return ellipsis.slice(0, maxWidth);

    let result = "";
    let currentWidth = 0;

    for (let i = 0; i < text.length; i++) {
      const code = text.codePointAt(i)!;
      const isWide = (
        (code >= 0x1100 && code <= 0x115F) ||
        (code >= 0x2329 && code <= 0x232A) ||
        (code >= 0x2E80 && code <= 0x303E) ||
        (code >= 0x3040 && code <= 0xA4CF) ||
        (code >= 0xAC00 && code <= 0xD7A3) ||
        (code >= 0xF900 && code <= 0xFAFF) ||
        (code >= 0xFE10 && code <= 0xFE19) ||
        (code >= 0xFE30 && code <= 0xFE6F) ||
        (code >= 0xFF00 && code <= 0xFF60) ||
        (code >= 0xFFE0 && code <= 0xFFE6) ||
        (code >= 0x1F300 && code <= 0x1F5FF) ||
        (code >= 0x1F600 && code <= 0x1F64F) ||
        (code >= 0x1F680 && code <= 0x1F6FF) ||
        (code >= 0x1F900 && code <= 0x1F9FF) ||
        (code >= 0x20000 && code <= 0x2FFFD) ||
        (code >= 0x30000 && code <= 0x3FFFD) ||
        (code === 0x23F0) ||
        (code === 0x23F3) ||
        (code >= 0x25A0 && code <= 0x25FF) ||
        (code >= 0x2600 && code <= 0x26FF) ||
        (code >= 0x2700 && code <= 0x27BF) ||
        (code >= 0x2B50 && code <= 0x2BFF)
      );

      const charWidth = isWide ? 2 : 1;

      if (currentWidth + charWidth > availableWidth) {
        break;
      }

      result += text[i];
      currentWidth += charWidth;

      // Skip surrogate pair second half
      if (code >= 0xD800 && code <= 0xDBFF) {
        i++;
        result += text[i];
      }
    }

    return result + ellipsis;
  };

  const options = [
    { id: "allow", label: "Allow", description: "Allow this specific action (this session)" },
    { id: "always_allow", label: "Always Allow", description: `Add "${request.suggested_pattern}" to allowed patterns` },
    { id: "deny", label: "Deny", description: "Block this action" },
  ];

  // Calculate estimated height of each section
  const headerHeight = 2; // header + divider
  const toolInfoHeight = 2; // tool + target rows
  const descriptionHeight = 1;
  const patternHeight = 1;
  const actionsHeight = 2; // actions + divider

  // Calculate available height for options
  const maxOptionsHeight = Math.max(
    3, // minimum for options
    maxHeight - headerHeight - toolInfoHeight - descriptionHeight - patternHeight - actionsHeight
  );

  // Truncate description using display width - 3 for "..."
  const maxDescLength = Math.max(20, contentWidth - 20);
  const truncatedDescription = truncateText(request.description, maxDescLength - 3);

  // Truncate target using display width - 3 for "..."
  const targetMaxWidth = contentWidth - 12;
  const truncatedTarget = truncateText(request.target, targetMaxWidth - 3);

  // Truncate suggested pattern if needed - 3 for "..."
  const patternMaxWidth = contentWidth - 10;
  const truncatedPattern = truncateText(request.suggested_pattern, patternMaxWidth - 3);

  // Calculate max width for option descriptions
  const optionDescMaxWidth = Math.max(10, contentWidth - 7); // -7 for indentation

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color={colors.warning} bold>! </Text>
        <Text color={colors.text} bold>Permission Required</Text>
      </Box>

      {/* Divider */}
      <Text color={colors.border}>{"-".repeat(Math.min(50, width - 4))}</Text>

      {/* Tool and Target */}
      <Box flexDirection="column" marginY={1}>
        <Box>
          <Text color={colors.muted}>{"  "}Tool:   </Text>
          <Text color={getToolColor()} bold>{getToolIcon()} {request.tool}</Text>
        </Box>
        <Box marginTop={0}>
          <Text color={colors.muted}>{"  "}Target: </Text>
          <Text color={colors.text}>{truncatedTarget}</Text>
        </Box>
      </Box>

      {/* Description */}
      <Box marginBottom={1}>
        <Text color={colors.muted}>{"  "}{truncatedDescription}</Text>
      </Box>

      {/* Suggested Pattern for Always Allow */}
      <Box marginBottom={1}>
        <Text color={colors.muted}>{"  "}Pattern: </Text>
        <Text color={colors.accent}>{truncatedPattern}</Text>
      </Box>

      {/* Divider */}
      <Text color={colors.border}>{"-".repeat(Math.min(50, width - 4))}</Text>

      {/* Options */}
      <Box flexDirection="column" marginY={1}>
        {options.slice(0, Math.max(1, Math.min(options.length, maxOptionsHeight))).map((opt, i) => {
          const isCursor = i === cursor;
          const pointer = isCursor ? ">" : " ";
          const radio = isCursor ? "(*)" : "( )";

          // Color based on option type
          let optionColor = colors.text;
          if (opt.id === "allow") optionColor = colors.success;
          else if (opt.id === "always_allow") optionColor = colors.info;
          else if (opt.id === "deny") optionColor = colors.error;

          // Truncate description using display width - 3 for "..."
          const truncatedOptDesc = truncateText(opt.description, optionDescMaxWidth - 3);

          return (
            <Box key={opt.id} flexDirection="column">
              <Text color={isCursor ? optionColor : colors.muted}>
                {"   "}{pointer} {radio} {opt.label}
              </Text>
              <Text color={colors.muted}>{"       "}{truncatedOptDesc}</Text>
            </Box>
          );
        })}
      </Box>

      {/* Divider */}
      <Text color={colors.border}>{"-".repeat(Math.min(50, width - 4))}</Text>

      {/* Actions */}
      <Box marginTop={1}>
        <Text color={colors.muted}>  </Text>
        <Text color={colors.success}>[Enter]</Text>
        <Text color={colors.muted}> Select   </Text>
        <Text color={colors.info}>[j/k]</Text>
        <Text color={colors.muted}> Navigate</Text>
      </Box>
    </Box>
  );
}
