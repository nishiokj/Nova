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
  selected,
}: SingleSelectProps): JSX.Element {
  const colors = getColors();
  const accentColor = colors.accent;
  const selectedColor = colors.success;
  const textColor = colors.text;
  const dimColor = colors.muted;

  return (
    <Box flexDirection="column" marginY={1}>
      {options.map((opt, i) => {
        const isCursor = i === cursor;
        const isSelected = i === selected;

        const marker = isCursor ? ">" : " ";
        const radio = isSelected ? "(*)" : "( )";

        return (
          <Box key={opt.id}>
            <Text color={isCursor ? accentColor : dimColor} bold={isCursor}>
              {marker} {radio}{" "}
            </Text>
            <Text
              color={isCursor ? accentColor : isSelected ? selectedColor : textColor}
              bold={isCursor || isSelected}
            >
              {opt.label}
            </Text>
            {opt.description && (
              <Text color={dimColor}> - {opt.description}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
