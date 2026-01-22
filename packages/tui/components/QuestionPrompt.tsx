import { Box, Text } from "ink";
import type { AgentQuestion } from "../types.js";
import { getColors } from "../theme.js";

/**
 * QuestionPrompt - A clean, minimal modal for user input prompts.
 *
 * Renders complete lines to avoid ANSI/rendering issues from
 * piecing together multiple Text components per line.
 */

interface QuestionPromptProps {
  question: AgentQuestion;
  cursor: number;
  selection: number[];
  inputText: string;
  width: number;
  height?: number; // Optional height constraint for modal
  queueInfo?: { current: number; total: number };
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

export function QuestionPrompt({
  question,
  cursor,
  selection,
  inputText,
  width,
  height,
  queueInfo,
}: QuestionPromptProps): JSX.Element {
  const colors = getColors();
  const contentWidth = Math.max(30, width - 6);
  const maxHeight = height || 20; // Default max height if not specified

  // Progress indicator
  const showProgress = queueInfo && queueInfo.total > 1;
  const progressText = showProgress ? `  [${queueInfo.current}/${queueInfo.total}]` : "";

  // Text wrapping helper - uses display width to account for wide characters
  const wrapText = (text: string, maxWidth: number): string[] => {
    if (!text) return [""];
    const words = text.split(" ");
    const lines: string[] = [];
    let currentLine = "";
    for (const word of words) {
      const wordWidth = getDisplayWidth(word);
      const currentWidth = getDisplayWidth(currentLine);
      const spaceWidth = currentLine.length > 0 ? 1 : 0; // Space width is always 1

      if (currentWidth + spaceWidth + wordWidth <= maxWidth) {
        currentLine += (currentLine ? " " : "") + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.length > 0 ? lines : [""];
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

  const questionLines = wrapText(question.question, contentWidth);
  const contextLines = question.context ? wrapText(question.context, contentWidth) : [];

  // Render options for selection questions
  const renderOptions = () => {
    if (!question.options || question.options.length === 0) return null;

    const isMulti = question.type === "multi_select";

    // Calculate available width for option labels (subtract fixed elements)
    // Fixed elements: cursorArrow(1) + space(1) + num(3) + space(1) + checkbox(3) + space(1) = 10
    const labelMaxWidth = Math.max(10, contentWidth - 10);

    return question.options.map((opt, i) => {
      const isCursor = i === cursor;
      const isSelected = selection.includes(i);

      // Enhanced visual indicators
      const cursorArrow = isCursor ? "▸" : " ";
      const cursorBox = isCursor ? "[" : " ";
      const cursorBoxEnd = isCursor ? "]" : " ";
      const checkbox = isMulti
        ? (isSelected ? "✓" : " ")
        : (isSelected ? "●" : "○");

      // Numbered options for keyboard navigation clarity
      const num = (i + 1).toString().padStart(2, " ");

      // Truncate label to fit available width - 3 for "..."
      const truncatedLabel = truncateText(opt.label, labelMaxWidth - 3);

      // Truncate description to fit content width with 6 spaces of indentation - 3 for "..."
      const descriptionMaxWidth = Math.max(10, contentWidth - 6);
      const truncatedDescription = opt.description
        ? truncateText(opt.description, descriptionMaxWidth - 3)
        : "";

      return (
        <Box key={opt.id} flexDirection="column" marginBottom={isCursor ? 0 : 0}>
          {/* Main option row with enhanced styling */}
          <Box>
            <Text color={isCursor ? colors.accent : colors.muted}>
              {cursorArrow}
            </Text>
            <Text color={isCursor ? colors.info : colors.muted}>
              {" "}{num}.{" "}
            </Text>
            <Text color={isCursor ? colors.accent : colors.muted} bold={isCursor}>
              {cursorBox}{checkbox}{cursorBoxEnd}
            </Text>
            <Text
              color={isCursor ? colors.text : (isSelected ? colors.success : colors.muted)}
              bold={isCursor || isSelected}
            >
              {" "}{truncatedLabel}
            </Text>
          </Box>
          {/* Description with better indentation */}
          {truncatedDescription && (
            <Text color={isCursor ? colors.text : colors.muted} dimColor={!isCursor}>
              {"      "}{truncatedDescription}
            </Text>
          )}
        </Box>
      );
    });
  };

  // Render text input for free text questions
  const renderTextInput = () => {
    const displayValue = inputText || "";
    const placeholder = question.placeholder || "Type your answer...";
    const showPlaceholder = displayValue.length === 0;

    // Calculate input box width
    const boxWidth = Math.max(40, contentWidth - 10);

    // Truncate placeholder to fit - account for cursor width (2 for █ in visual, 1 space)
    const inputAvailableWidth = boxWidth - 3; // -3 for "..." and space
    const truncatedPlaceholder = truncateText(placeholder, inputAvailableWidth);

    // Truncate input value if too long
    const truncatedValue = truncateText(displayValue, inputAvailableWidth);

    return (
      <Box flexDirection="column" marginTop={1}>
        {/* Input box with visual frame */}
        <Box>
          <Text color={colors.accent} bold>▸</Text>
          <Text color={colors.border}>{"┌─"}</Text>
          <Text color={colors.border}>{"─".repeat(boxWidth)}</Text>
        </Box>
        <Box>
          <Text color={colors.accent} bold>{" "}</Text>
          <Text color={colors.border}>{"│ "}</Text>
          {showPlaceholder ? (
            <Text color={colors.muted} italic dimColor>
              {truncatedPlaceholder}
              <Text backgroundColor={colors.accent}>█</Text>
            </Text>
          ) : (
            <Text color={colors.text}>
              {truncatedValue}
              <Text backgroundColor={colors.accent}>█</Text>
            </Text>
          )}
        </Box>
        <Box>
          <Text color={colors.accent} bold>{" "}</Text>
          <Text color={colors.border}>{"└─"}</Text>
          <Text color={colors.border}>{"─".repeat(boxWidth)}</Text>
        </Box>
      </Box>
    );
  };

  const isTextInput = question.type === "fill_in_blank" || question.type === "free_text";

  // Calculate estimated height of each section
  const headerHeight = 2; // header + divider
  const questionHeight = questionLines.length;
  const contextHeight = contextLines.length;
  const actionsHeight = 2; // actions + divider

  // Calculate available height for content
  const maxContentHeight = Math.max(
    5, // minimum for content
    maxHeight - headerHeight - actionsHeight - contextHeight
  );

  // Truncate options if too many for available space
  const maxOptions = isTextInput
    ? 0
    : Math.max(
        1,
        Math.min(
          question.options?.length || 0,
          Math.floor((maxContentHeight - questionHeight - contextHeight) / 2)
        )
      );

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color={colors.warning} bold>? </Text>
        <Text color={colors.text} bold>Input Required</Text>
        <Text color={colors.muted}>{progressText}</Text>
      </Box>

      {/* Divider */}
      <Text color={colors.border}>{"-".repeat(Math.min(40, width - 4))}</Text>

      {/* Question */}
      <Box flexDirection="column" marginY={1}>
        {questionLines.slice(0, maxContentHeight).map((line, i) => (
          <Text key={`q-${i}`} color={colors.text} bold>{"  "}{line}</Text>
        ))}
      </Box>

      {/* Context */}
      {contextLines.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {contextLines.slice(0, Math.max(1, maxContentHeight - questionHeight)).map((line, i) => (
            <Text key={`c-${i}`} color={colors.muted}>{"  "}{line}</Text>
          ))}
        </Box>
      )}

      {/* Input area */}
      <Box flexDirection="column" marginY={1}>
        {isTextInput ? renderTextInput() : renderOptions().slice(0, maxOptions)}
      </Box>

      {/* Divider */}
      <Text color={colors.border}>{"-".repeat(Math.min(40, width - 4))}</Text>

      {/* Actions */}
      <Box marginTop={1}>
        <Text color={colors.muted}>  </Text>
        <Text color={colors.success}>[Enter]</Text>
        <Text color={colors.muted}> Submit   </Text>
        <Text color={colors.error}>[Esc]</Text>
        <Text color={colors.muted}> Cancel</Text>
        {question.type === "multi_select" && (
          <>
            <Text color={colors.muted}>   </Text>
            <Text color={colors.info}>[Space]</Text>
            <Text color={colors.muted}> Toggle</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
