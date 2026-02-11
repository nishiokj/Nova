import { Box, Text } from "ink";
import type { QuestionOption } from "../types.js";
import { getColors } from "../theme.js";

interface MultiSelectProps {
  options: QuestionOption[];
  cursor: number;
  selected: number[];
  width: number;
}

export function MultiSelect({
  options,
  cursor,
  selected,
}: MultiSelectProps): JSX.Element {
  const colors = getColors();

  return (
    <Box flexDirection="column" marginY={1}>
      {options.map((opt, i) => {
        const isCursor = i === cursor;
        const isSelected = selected.includes(i);
        const checkbox = isSelected ? "[x]" : "[ ]";

        return (
          <Box key={opt.id}>
            <Text color={isCursor ? colors.accent : colors.muted}>
              {isCursor ? "> " : "  "}
              {checkbox}{" "}
            </Text>
            <Text color={isCursor ? colors.text : isSelected ? colors.success : colors.muted}>
              {opt.label}
            </Text>
            {opt.description && (
              <Text color={colors.muted}> - {opt.description}</Text>
            )}
          </Box>
        );
      })}
      <Text color={colors.muted}>space toggle</Text>
    </Box>
  );
}
