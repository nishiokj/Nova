import { Box, Text } from "ink";
import { getColors } from "../theme.js";

interface TextInputFieldProps {
  value: string;
  placeholder?: string;
  width: number;
  multiline?: boolean;
}

export function TextInputField({
  value,
  placeholder,
  multiline = false,
}: TextInputFieldProps): JSX.Element {
  const displayValue = value || "";
  const showPlaceholder = displayValue.length === 0 && placeholder;

  const colors = getColors();

  // Multiline with newlines
  if (multiline && displayValue.includes("\n")) {
    const lines = displayValue.split("\n");
    return (
      <Box flexDirection="column" marginY={1}>
        {lines.map((line, i) => {
          const isLastLine = i === lines.length - 1;
          return (
            <Box key={i}>
              <Text color={colors.text}>{line}</Text>
              {isLastLine && <Text backgroundColor={colors.accent}> </Text>}
            </Box>
          );
        })}
      </Box>
    );
  }

  // Single line input
  return (
    <Box marginY={1}>
      {showPlaceholder ? (
        <>
          <Text color={colors.muted}>{placeholder}</Text>
          <Text backgroundColor={colors.accent}> </Text>
        </>
      ) : (
        <>
          <Text color={colors.text}>{displayValue}</Text>
          <Text backgroundColor={colors.accent}> </Text>
        </>
      )}
    </Box>
  );
}
