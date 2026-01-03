import { Box, Text } from "ink";

interface TextInputFieldProps {
  value: string;
  placeholder?: string;
  width: number;
  multiline?: boolean;
}

export function TextInputField({
  value,
  placeholder,
  width,
  multiline = false,
}: TextInputFieldProps): JSX.Element {
  const displayValue = value || "";
  const showPlaceholder = displayValue.length === 0 && placeholder;

  // For multiline, split by newlines
  if (multiline && displayValue.includes("\n")) {
    const lines = displayValue.split("\n");
    return (
      <Box flexDirection="column" marginY={1}>
        <Text color="cyan">{"> "}</Text>
        {lines.map((line, i) => (
          <Text key={i}>
            {"  "}
            {line}
            {i === lines.length - 1 && <Text inverse> </Text>}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box marginY={1}>
      <Text color="cyan">{"> "}</Text>
      {showPlaceholder ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        <Text>{displayValue}</Text>
      )}
      <Text inverse> </Text>
    </Box>
  );
}
