import { Box, Text } from "ink";
import { getColors } from "../theme.js";

interface TextInputFieldProps {
  value: string;
  placeholder?: string;
  width: number;
  multiline?: boolean;
  label?: string;
}

export function TextInputField({
  value,
  placeholder,
  width,
  multiline = false,
  label,
}: TextInputFieldProps): JSX.Element {
  const displayValue = value || "";
  const showPlaceholder = displayValue.length === 0 && placeholder;

  const colors = getColors();
  const promptColor = colors.user;
  const textColor = colors.agent;
  const placeholderColor = colors.muted;
  const cursorColor = colors.user;

  // For multiline with actual newlines
  if (multiline && displayValue.includes("\n")) {
    const lines = displayValue.split("\n");

    return (
      <Box flexDirection="column" marginY={1}>
        {label && (
          <Text color={placeholderColor} bold>
            {label}
          </Text>
        )}

        {lines.map((line, i) => {
          const isLastLine = i === lines.length - 1;
          return (
            <Box key={i}>
              <Text color={promptColor}>{i === 0 ? "▸ " : "  "}</Text>
              <Text color={textColor}>{line}</Text>
              {isLastLine && <Text backgroundColor={cursorColor}> </Text>}
            </Box>
          );
        })}
      </Box>
    );
  }

  // Single line input - cursor immediately after text
  return (
    <Box flexDirection="column" marginY={1}>
      {label && (
        <Box marginBottom={1}>
          <Text color={placeholderColor} bold>
            {label}
          </Text>
        </Box>
      )}

      {/* Input line with cursor right after content */}
      <Box>
        <Text color={promptColor} bold>{"▸ "}</Text>
        {showPlaceholder ? (
          <>
            <Text color={placeholderColor}>{placeholder}</Text>
            <Text backgroundColor={cursorColor}> </Text>
          </>
        ) : (
          <>
            <Text color={textColor}>{displayValue}</Text>
            <Text backgroundColor={cursorColor}> </Text>
          </>
        )}
      </Box>
    </Box>
  );
}
