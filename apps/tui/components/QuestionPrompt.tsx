import { Box, Text } from "ink";
import type { AgentQuestion, QuestionType } from "../types.js";
import { getColors } from "../theme.js";
import { SingleSelect } from "./SingleSelect.js";
import { MultiSelect } from "./MultiSelect.js";
import { TextInputField } from "./TextInputField.js";
import { wrapText, padText } from "../utils/textWrap.js";

interface QuestionPromptProps {
  question: AgentQuestion;
  cursor: number;
  selection: number[];
  inputText: string;
  width: number;
}

function getQuestionTypeLabel(type: QuestionType): { label: string; icon: string } {
  switch (type) {
    case "multiple_choice":
      return { label: "Choose one", icon: "○" };
    case "yes_no":
      return { label: "Yes / No", icon: "◐" };
    case "multi_select":
      return { label: "Select multiple", icon: "☰" };
    case "fill_in_blank":
      return { label: "Type answer", icon: "▸" };
    case "free_text":
      return { label: "Free response", icon: "▸" };
    default:
      return { label: "Question", icon: "?" };
  }
}

export function QuestionPrompt({
  question,
  cursor,
  selection,
  inputText,
  width,
}: QuestionPromptProps): JSX.Element {
  // Fixed width box for consistent alignment
  const boxWidth = Math.min(70, width - 4);
  const innerWidth = boxWidth - 4; // 2 for borders, 2 for padding

  const questionLines = wrapText(question.question, innerWidth);
  const contextLines = question.context ? wrapText(question.context, innerWidth) : [];
  const typeInfo = getQuestionTypeLabel(question.type);

  // Simple box characters
  const TOP_LEFT = "┌";
  const TOP_RIGHT = "┐";
  const BOT_LEFT = "└";
  const BOT_RIGHT = "┘";
  const HORIZ = "─";
  const VERT = "│";
  const TEE_LEFT = "├";
  const TEE_RIGHT = "┤";

  // Build fixed-width strings
  const headerLabel = " ? Agent Question ";
  const headerPadding = boxWidth - 2 - headerLabel.length;
  const topBorder = TOP_LEFT + HORIZ.repeat(2) + headerLabel + HORIZ.repeat(headerPadding) + TOP_RIGHT;
  const bottomBorder = BOT_LEFT + HORIZ.repeat(boxWidth - 2) + BOT_RIGHT;
  const emptyLine = VERT + " ".repeat(boxWidth - 2) + VERT;

  // Type label separator
  const typeLabel = ` ${typeInfo.icon} ${typeInfo.label} `;
  const sepPadLeft = Math.floor((boxWidth - 2 - typeLabel.length) / 2);
  const sepPadRight = boxWidth - 2 - typeLabel.length - sepPadLeft;
  const separator = TEE_LEFT + HORIZ.repeat(sepPadLeft) + typeLabel + HORIZ.repeat(sepPadRight) + TEE_RIGHT;

  // Render a content line with fixed width
  const renderLine = (text: string) => {
    const padded = padText(text, innerWidth, "left");
    return VERT + " " + padded + " " + VERT;
  };

  const renderQuestionBody = () => {
    switch (question.type) {
      case "multiple_choice":
      case "yes_no":
        return (
          <SingleSelect
            options={question.options || []}
            cursor={cursor}
            selected={selection[0]}
            width={innerWidth}
          />
        );

      case "multi_select":
        return (
          <MultiSelect
            options={question.options || []}
            cursor={cursor}
            selected={selection}
            width={innerWidth}
          />
        );

      case "fill_in_blank":
      case "free_text":
        return (
          <TextInputField
            value={inputText}
            placeholder={question.placeholder || "Type your answer..."}
            width={innerWidth}
            multiline={question.type === "free_text"}
          />
        );

      default:
        return null;
    }
  };

  // Use theme colors
  const colors = getColors();
  const borderColor = colors.border;
  const textColor = colors.agent;
  const dimColor = colors.muted;

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Top border */}
      <Text color={borderColor} bold>
        {topBorder}
      </Text>

      {/* Question text */}
      {questionLines.map((line, i) => (
        <Text key={`q-${i}`}>
          <Text color={borderColor}>{VERT}</Text>
          <Text color={textColor} bold={i === 0}>
            {" " + padText(line, innerWidth, "left") + " "}
          </Text>
          <Text color={borderColor}>{VERT}</Text>
        </Text>
      ))}

      {/* Context (if any) - dimmed */}
      {contextLines.length > 0 && (
        <>
          <Text color={borderColor}>{emptyLine}</Text>
          {contextLines.map((line, i) => (
            <Text key={`c-${i}`}>
              <Text color={borderColor}>{VERT}</Text>
              <Text color={dimColor}>
                {" " + padText(line, innerWidth, "left") + " "}
              </Text>
              <Text color={borderColor}>{VERT}</Text>
            </Text>
          ))}
        </>
      )}

      {/* Separator with type badge */}
      <Text color={borderColor}>{separator}</Text>

      {/* Input area - outside the strict box for flexibility */}
      <Box paddingLeft={1}>
        {renderQuestionBody()}
      </Box>

      {/* Bottom border */}
      <Text color={borderColor}>{bottomBorder}</Text>

      {/* Controls hint */}
      <Box marginTop={1} paddingLeft={1}>
        <Text color={dimColor}>
          {"  "}
          <Text color={colors.success}>Enter</Text>
          {" submit  "}
          <Text color={colors.error}>Esc</Text>
          {" cancel"}
        </Text>
      </Box>
    </Box>
  );
}
