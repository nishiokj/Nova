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
  width,
}: SingleSelectProps): JSX.Element {
  const colors = getColors();
  const accentColor = colors.user;
  const selectedColor = colors.success;
  const textColor = colors.agent;
  const dimColor = colors.muted;

  return (
    <Box flexDirection="column" marginY={1}>
      {options.map((opt, i) => {
        const isCursor = i === cursor;
        const isSelected = i === selected;

        // Visual indicators
        const radio = isSelected ? "●" : "○";
        const pointer = isCursor ? "▸" : " ";

        return (
          <Box key={opt.id}>
            {/* Pointer */}
            <Text color={isCursor ? accentColor : undefined} bold>
              {pointer}{" "}
            </Text>

            {/* Radio */}
            <Text color={isSelected ? selectedColor : dimColor}>
              {radio}{" "}
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
    </Box>
  );
}
