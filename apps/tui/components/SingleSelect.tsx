import { Box, Text } from "ink";
import type { QuestionOption } from "../types.js";

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
  return (
    <Box flexDirection="column" marginY={1}>
      {options.map((opt, i) => {
        const isCursor = i === cursor;
        const isSelected = i === selected;
        const indicator = isSelected ? "●" : "○";
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
