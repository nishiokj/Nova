import { Box, Text } from "ink";
import type { AgentQuestion, QuestionType } from "../types.js";
import { BOX_CHARS } from "../types.js";
import { SingleSelect } from "./SingleSelect.js";
import { MultiSelect } from "./MultiSelect.js";
import { TextInputField } from "./TextInputField.js";
import { wrapText } from "../utils/textWrap.js";

interface QuestionPromptProps {
  question: AgentQuestion;
  cursor: number;
  selection: number[];
  inputText: string;
  width: number;
}

function getHelpText(type: QuestionType): string {
  switch (type) {
    case "multiple_choice":
    case "yes_no":
      return "↑↓ navigate  Enter select  Esc cancel";
    case "multi_select":
      return "↑↓ navigate  Space toggle  Enter confirm  Esc cancel";
    case "fill_in_blank":
    case "free_text":
      return "Type your answer  Enter submit  Esc cancel";
    default:
      return "";
  }
}

export function QuestionPrompt({
  question,
  cursor,
  selection,
  inputText,
  width,
}: QuestionPromptProps): JSX.Element {
  const chars = BOX_CHARS.rounded;
  const contentWidth = Math.min(70, width - 4);
  const innerWidth = contentWidth - 4; // Account for borders and padding

  // Wrap the question text
  const questionLines = wrapText(question.question, innerWidth);
  const contextLines = question.context ? wrapText(question.context, innerWidth) : [];

  // Build the box
  const headerText = " Agent Question ";
  const topFill = contentWidth - headerText.length - 2;
  const topLeftFill = Math.max(0, Math.floor(topFill / 4));
  const topRightFill = Math.max(0, topFill - topLeftFill);
  const topBorder =
    chars.tl + chars.h.repeat(topLeftFill) + headerText + chars.h.repeat(topRightFill) + chars.tr;

  const bottomBorder = chars.bl + chars.h.repeat(contentWidth - 2) + chars.br;
  const emptyLine = chars.v + " ".repeat(contentWidth - 2) + chars.v;

  const helpText = getHelpText(question.type);
  const helpPadded =
    chars.v + " " + helpText.padEnd(contentWidth - 4) + " " + chars.v;

  // Render the appropriate input component based on question type
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

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Top border with header */}
      <Text color="cyanBright" bold>
        {topBorder}
      </Text>

      {/* Empty line for spacing */}
      <Text color="cyan">{emptyLine}</Text>

      {/* Question text */}
      {questionLines.map((line, i) => (
        <Text key={`q-${i}`} color="cyan">
          {chars.v} {line.padEnd(contentWidth - 4)} {chars.v}
        </Text>
      ))}

      {/* Context (if any) */}
      {contextLines.length > 0 && (
        <>
          <Text color="cyan">{emptyLine}</Text>
          {contextLines.map((line, i) => (
            <Text key={`c-${i}`} color="cyan" dimColor>
              {chars.v} {line.padEnd(contentWidth - 4)} {chars.v}
            </Text>
          ))}
        </>
      )}

      {/* Options/Input area */}
      <Box paddingLeft={2} paddingRight={2}>
        {renderQuestionBody()}
      </Box>

      {/* Empty line for spacing */}
      <Text color="cyan">{emptyLine}</Text>

      {/* Help text */}
      <Text color="cyan" dimColor>
        {helpPadded}
      </Text>

      {/* Bottom border */}
      <Text color="cyan">{bottomBorder}</Text>
    </Box>
  );
}
