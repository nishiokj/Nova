import { Box, Text } from "ink";
import type { Role, BoxStyle } from "../types.js";
import { BOX_CHARS } from "../types.js";
import { wrapText, padText } from "../utils/textWrap.js";

interface MessageBoxProps {
  role: Role;
  text: string;
  meta?: string;
  width: number;
  compact?: boolean;
  timestamp?: number;
}

interface RoleConfig {
  style: BoxStyle;
  alignment: "left" | "right";
  maxWidth: number;
  color: string;
  labelColor?: string;
}

function getRoleConfig(role: Role): RoleConfig {
  switch (role) {
    case "user":
      return {
        style: "rounded",
        alignment: "right",
        maxWidth: 60,
        color: "green",
        labelColor: "greenBright",
      };
    case "agent":
      return {
        style: "sharp",
        alignment: "left",
        maxWidth: 70,
        color: "cyan",
        labelColor: "cyanBright",
      };
    case "system":
      return {
        style: "minimal",
        alignment: "left",
        maxWidth: 50,
        color: "yellow",
      };
    case "status":
      return {
        style: "minimal",
        alignment: "left",
        maxWidth: 50,
        color: "magenta",
      };
    default:
      return {
        style: "minimal",
        alignment: "left",
        maxWidth: 60,
        color: "white",
      };
  }
}

function getRoleLabel(role: Role): string {
  switch (role) {
    case "user":
      return "You";
    case "agent":
      return "Agent";
    case "system":
      return "System";
    case "status":
      return "Status";
    default:
      return "Message";
  }
}

export function MessageBox({
  role,
  text,
  meta,
  width,
  compact = false,
}: MessageBoxProps): JSX.Element {
  const config = getRoleConfig(role);
  const chars = BOX_CHARS[config.style];

  // Calculate content width: min of maxWidth and available width
  // Leave space for box borders (2 chars) and some margin
  const availableWidth = Math.max(20, width - 4);
  const contentWidth = Math.min(config.maxWidth, availableWidth);
  const innerWidth = contentWidth - 2; // Account for side borders and padding

  // Wrap text to fit inside the box
  const lines = wrapText(text, innerWidth - 2); // -2 for padding inside box

  // Build the box
  const label = getRoleLabel(role);
  const labelText = ` ${label} `;

  // Top border with label
  const topFill = contentWidth - labelText.length - 2; // -2 for corners
  const topLeftFill = Math.max(0, Math.floor(topFill / 4));
  const topRightFill = Math.max(0, topFill - topLeftFill);
  const topBorder =
    chars.tl + chars.h.repeat(topLeftFill) + labelText + chars.h.repeat(topRightFill) + chars.tr;

  // Bottom border
  const bottomBorder = chars.bl + chars.h.repeat(contentWidth - 2) + chars.br;

  // Determine alignment justification
  const justifyContent = config.alignment === "right" ? "flex-end" : "flex-start";

  return (
    <Box
      flexDirection="column"
      alignItems={config.alignment === "right" ? "flex-end" : "flex-start"}
      marginBottom={compact ? 0 : 1}
      width={width}
    >
      <Box flexDirection="column">
        {/* Top border with label */}
        <Text color={config.labelColor || config.color} bold>
          {config.alignment === "right"
            ? " ".repeat(Math.max(0, width - contentWidth)) + topBorder
            : topBorder}
        </Text>

        {/* Content lines */}
        {lines.map((line, i) => {
          const paddedLine = padText(line, innerWidth - 2, "left");
          const lineContent = `${chars.v} ${paddedLine} ${chars.v}`;
          return (
            <Text key={i} color={config.color}>
              {config.alignment === "right"
                ? " ".repeat(Math.max(0, width - contentWidth)) + lineContent
                : lineContent}
            </Text>
          );
        })}

        {/* Bottom border */}
        <Text color={config.color}>
          {config.alignment === "right"
            ? " ".repeat(Math.max(0, width - contentWidth)) + bottomBorder
            : bottomBorder}
        </Text>

        {/* Metadata line (if present and not compact) */}
        {meta && !compact && (
          <Text dimColor>
            {config.alignment === "right"
              ? " ".repeat(Math.max(0, width - meta.length)) + meta
              : meta}
          </Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * Compact inline message without box (for status/system in compact mode)
 */
export function InlineMessage({
  role,
  text,
  width,
}: {
  role: Role;
  text: string;
  width: number;
}): JSX.Element {
  const config = getRoleConfig(role);
  const label = getRoleLabel(role);
  const prefix = `${label}: `;
  const lines = wrapText(text, width - prefix.length);

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={config.color}>
          {i === 0 ? prefix : " ".repeat(prefix.length)}
          {line}
        </Text>
      ))}
    </Box>
  );
}
