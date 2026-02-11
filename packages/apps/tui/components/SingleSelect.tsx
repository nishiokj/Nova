import { Box, Text } from "ink";
import type { QuestionOption } from "../types.js";
import { getColors } from "../theme.js";

interface SingleSelectProps {
  options: QuestionOption[];
  cursor: number;
  selected: number | undefined;
  width: number;
}

export function SingleSelect({
  options,
  cursor,
}: SingleSelectProps): JSX.Element {
  const colors = getColors();

  return (
    <Box flexDirection="column" marginY={1}>
      {options.map((opt, i) => {
        const isCursor = i === cursor;
        return (
          <Box key={opt.id}>
            <Text color={isCursor ? colors.accent : colors.muted}>
              {isCursor ? "> " : "  "}
            </Text>
            <Text color={isCursor ? colors.text : colors.muted}>
              {opt.label}
            </Text>
            {opt.description && (
              <Text color={colors.muted}> - {opt.description}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
