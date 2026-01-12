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
  width,
}: MultiSelectProps): JSX.Element {
  const selectedCount = selected.length;

  const colors = getColors();
  const accentColor = colors.user;
  const selectedColor = colors.success;
  const textColor = colors.agent;
  const dimColor = colors.muted;

  return (
    <Box flexDirection="column" marginY={1}>
      {options.map((opt, i) => {
        const isCursor = i === cursor;
        const isSelected = selected.includes(i);

        // Visual indicators
        const checkbox = isSelected ? "☑" : "☐";
        const pointer = isCursor ? "▸" : " ";

        return (
          <Box key={opt.id}>
            {/* Pointer */}
            <Text color={isCursor ? accentColor : undefined} bold>
              {pointer}{" "}
            </Text>

            {/* Checkbox */}
            <Text color={isSelected ? selectedColor : dimColor}>
              {checkbox}{" "}
            </Text>

            {/* Label */}
            <Text
              color={isCursor ? accentColor : isSelected ? selectedColor : textColor}
              bold={isCursor || isSelected}
            >
              {opt.label}
            </Text>

            {/* Description */}
            {opt.description && (
              <Text color={dimColor}>
                {"  → "}
                {opt.description}
              </Text>
            )}
          </Box>
        );
      })}

      {/* Selection count */}
      {selectedCount > 0 && (
        <Box marginTop={1}>
          <Text color={selectedColor}>
            {"  ✓ "}{selectedCount} selected
          </Text>
        </Box>
      )}
    </Box>
  );
}
