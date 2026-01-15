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

  const renderInput = () => {
    switch (question.type) {
      case "multiple_choice":
      case "yes_no":
      case "plan_mode_exit":
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

  const showProgress = queueInfo && queueInfo.total > 1;

  return (
    <Box flexDirection="column">
      {showProgress && (
        <Text color={colors.muted}>Question {queueInfo.current} of {queueInfo.total}</Text>
      )}
      <Text color={colors.accent}>{question.question}</Text>
      {question.context && <Text color={colors.muted}>{question.context}</Text>}
      {renderInput()}
      <Text color={colors.muted}>
        enter submit | esc cancel
      </Text>
    </Box>
  );
}
