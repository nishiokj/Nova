import { Box, Text } from "ink";
import type { PermissionRequestData } from "../types.js";
import { getColors } from "../theme.js";

/**
 * PermissionPrompt - Modal for tool permission requests.
 *
 * Displays permission requests for Bash, Write, and Edit tools.
 * Users can Allow (one-time), Always Allow (persistent), or Deny.
 */

interface PermissionPromptProps {
  request: PermissionRequestData;
  cursor: number;
  width: number;
}

export function PermissionPrompt({
  request,
  cursor,
  width,
}: PermissionPromptProps): JSX.Element {
  const colors = getColors();
  const contentWidth = Math.max(30, width - 6);

  // Tool icon based on type
  const getToolIcon = () => {
    switch (request.tool) {
      case "Bash": return "$";
      case "Write": return "+";
      case "Edit": return "~";
      default: return "?";
    }
  };

  // Tool color based on type
  const getToolColor = () => {
    switch (request.tool) {
      case "Bash": return colors.warning;
      case "Write": return colors.success;
      case "Edit": return colors.info;
      default: return colors.text;
    }
  };

  // Truncate target if too long
  const truncateTarget = (target: string, maxLen: number): string => {
    if (target.length <= maxLen) return target;
    return "..." + target.slice(-(maxLen - 3));
  };

  const options = [
    { id: "allow", label: "Allow", description: "Allow this specific action (this session)" },
    { id: "always_allow", label: "Always Allow", description: `Add "${request.suggested_pattern}" to allowed patterns` },
    { id: "deny", label: "Deny", description: "Block this action" },
  ];

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color={colors.warning} bold>! </Text>
        <Text color={colors.text} bold>Permission Required</Text>
      </Box>

      {/* Divider */}
      <Text color={colors.border}>{"-".repeat(Math.min(50, width - 4))}</Text>

      {/* Tool and Target */}
      <Box flexDirection="column" marginY={1}>
        <Box>
          <Text color={colors.muted}>{"  "}Tool:   </Text>
          <Text color={getToolColor()} bold>{getToolIcon()} {request.tool}</Text>
        </Box>
        <Box marginTop={0}>
          <Text color={colors.muted}>{"  "}Target: </Text>
          <Text color={colors.text}>{truncateTarget(request.target, contentWidth - 12)}</Text>
        </Box>
      </Box>

      {/* Description */}
      <Box marginBottom={1}>
        <Text color={colors.muted}>{"  "}{request.description}</Text>
      </Box>

      {/* Suggested Pattern for Always Allow */}
      <Box marginBottom={1}>
        <Text color={colors.muted}>{"  "}Pattern: </Text>
        <Text color={colors.accent}>{request.suggested_pattern}</Text>
      </Box>

      {/* Divider */}
      <Text color={colors.border}>{"-".repeat(Math.min(50, width - 4))}</Text>

      {/* Options */}
      <Box flexDirection="column" marginY={1}>
        {options.map((opt, i) => {
          const isCursor = i === cursor;
          const pointer = isCursor ? ">" : " ";
          const radio = isCursor ? "(*)" : "( )";

          // Color based on option type
          let optionColor = colors.text;
          if (opt.id === "allow") optionColor = colors.success;
          else if (opt.id === "always_allow") optionColor = colors.info;
          else if (opt.id === "deny") optionColor = colors.error;

          return (
            <Box key={opt.id} flexDirection="column">
              <Text color={isCursor ? optionColor : colors.muted}>
                {"   "}{pointer} {radio} {opt.label}
              </Text>
              <Text color={colors.muted}>{"       "}{opt.description}</Text>
            </Box>
          );
        })}
      </Box>

      {/* Divider */}
      <Text color={colors.border}>{"-".repeat(Math.min(50, width - 4))}</Text>

      {/* Actions */}
      <Box marginTop={1}>
        <Text color={colors.muted}>  </Text>
        <Text color={colors.success}>[Enter]</Text>
        <Text color={colors.muted}> Select   </Text>
        <Text color={colors.info}>[j/k]</Text>
        <Text color={colors.muted}> Navigate</Text>
      </Box>
    </Box>
  );
}
