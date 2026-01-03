import { Box, Text } from "ink";
import type { QuestionOption } from "../types.js";

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
  return (
    <Box flexDirection="column" marginY={1}>
      {options.map((opt, i) => {
        const isCursor = i === cursor;
        const isSelected = selected.includes(i);
        const indicator = isSelected ? "☑" : "☐";
        const prefix = isCursor ? "> " : "  ";

        return (
          <Box key={opt.id} flexDirection="row">
            <Text color={isCursor ? "cyan" : undefined} bold={isCursor}>
              {prefix}
              {indicator} {opt.label}
            </Text>
            {opt.description && (
              <Text dimColor> - {opt.description}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
