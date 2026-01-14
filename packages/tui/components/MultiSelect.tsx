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
  const selectedCount = selected.length;

  const colors = getColors();
  const accentColor = colors.accent;
  const selectedColor = colors.success;
  const textColor = colors.text;
  const dimColor = colors.muted;

  return (
    <Box flexDirection="column" marginY={1}>
      {options.map((opt, i) => {
        const isCursor = i === cursor;
        const isSelected = selected.includes(i);

        const marker = isCursor ? ">" : " ";
        const checkbox = isSelected ? "[x]" : "[ ]";

        return (
          <Box key={opt.id}>
            <Text color={isCursor ? accentColor : dimColor} bold={isCursor}>
              {marker} {checkbox}{" "}
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

      {selectedCount > 0 && (
        <Box marginTop={1}>
          <Text color={selectedColor}>{selectedCount} selected</Text>
        </Box>
      )}
    </Box>
  );
}
