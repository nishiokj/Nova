import { Box, Text } from "ink";
import type { AgentQuestion } from "../types.js";
import { getColors } from "../theme.js";
import { SingleSelect } from "./SingleSelect.js";
import { MultiSelect } from "./MultiSelect.js";
import { TextInputField } from "./TextInputField.js";

interface QuestionPromptProps {
  question: AgentQuestion;
  cursor: number;
  selection: number[];
  inputText: string;
  width: number;
}

export function QuestionPrompt({
  question,
  cursor,
  selection,
  inputText,
  width,
}: QuestionPromptProps): JSX.Element {
  const colors = getColors();
  const questionColor = colors.info;
  const dimColor = colors.muted;

  const renderQuestionBody = () => {
    switch (question.type) {
      case "multiple_choice":
      case "yes_no":
        return (
          <SingleSelect
            options={question.options || []}
            cursor={cursor}
            selected={selection[0]}
            width={width}
          />
        );

      case "multi_select":
        return (
          <MultiSelect
            options={question.options || []}
            cursor={cursor}
            selected={selection}
            width={width}
          />
        );

      case "fill_in_blank":
      case "free_text":
        return (
          <TextInputField
            value={inputText}
            placeholder={question.placeholder || "Type your answer..."}
            width={width}
            multiline={question.type === "free_text"}
          />
        );

      default:
        return null;
    }
  };

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Question text */}
      <Text color={questionColor} bold>
        {question.question}
      </Text>

      {/* Context if provided */}
      {question.context && (
        <Text color={dimColor}>{question.context}</Text>
      )}

      {/* Input area */}
      {renderQuestionBody()}

      {/* Controls hint */}
      <Box marginTop={1}>
        <Text color={dimColor}>
          <Text color={colors.success}>Enter</Text>
          {" submit  "}
          <Text color={colors.error}>Esc</Text>
          {" cancel"}
        </Text>
      </Box>
    </Box>
  );
}
