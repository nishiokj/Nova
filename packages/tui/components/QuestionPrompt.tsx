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
  queueInfo?: { current: number; total: number };
}

export function QuestionPrompt({
  question,
  cursor,
  selection,
  inputText,
  width,
  queueInfo,
}: QuestionPromptProps): JSX.Element {
  const colors = getColors();
  const contentWidth = Math.max(30, width - 6);

  // Progress indicator
  const showProgress = queueInfo && queueInfo.total > 1;
  const progressText = showProgress ? `  [${queueInfo.current}/${queueInfo.total}]` : "";

  // Text wrapping helper
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

  const questionLines = wrapText(question.question, contentWidth);
  const contextLines = question.context ? wrapText(question.context, contentWidth) : [];

  // Render options for selection questions
  const renderOptions = () => {
    if (!question.options || question.options.length === 0) return null;

    const isMulti = question.type === "multi_select";

    return question.options.map((opt, i) => {
      const isCursor = i === cursor;
      const isSelected = selection.includes(i);
      const pointer = isCursor ? ">" : " ";
      const checkbox = isMulti ? (isSelected ? "[x]" : "[ ]") : (isCursor ? "(*)" : "( )");
      const label = `${pointer} ${checkbox} ${opt.label}`;

      return (
        <Box key={opt.id} flexDirection="column">
          <Text color={isCursor ? colors.accent : colors.muted}>
            {"   "}{label}
          </Text>
          {opt.description && (
            <Text color={colors.muted}>{"       "}{opt.description}</Text>
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

    return (
      <Box marginLeft={3}>
        <Text color={colors.muted}>{">"} </Text>
        {showPlaceholder ? (
          <>
            <Text color={colors.muted} dimColor>{placeholder}</Text>
            <Text backgroundColor={colors.accent}>{" "}</Text>
          </>
        ) : (
          <>
            <Text color={colors.text}>{displayValue}</Text>
            <Text backgroundColor={colors.accent}>{" "}</Text>
          </>
        )}
      </Box>
    );
  };

  const isTextInput = question.type === "fill_in_blank" || question.type === "free_text";

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
        {questionLines.map((line, i) => (
          <Text key={`q-${i}`} color={colors.text} bold>{"  "}{line}</Text>
        ))}
      </Box>

      {/* Context */}
      {contextLines.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {contextLines.map((line, i) => (
            <Text key={`c-${i}`} color={colors.muted}>{"  "}{line}</Text>
          ))}
        </Box>
      )}

      {/* Input area */}
      <Box flexDirection="column" marginY={1}>
        {isTextInput ? renderTextInput() : renderOptions()}
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
