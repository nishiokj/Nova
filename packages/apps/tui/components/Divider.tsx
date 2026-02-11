/**
 * Divider - Themed horizontal line component for TUI
 *
 * Use this instead of manual "─".repeat() patterns.
 * For full bordered boxes, use Ink's native borderStyle prop.
 */

import { Text } from "ink";
import { getColors } from "../theme.js";

interface DividerProps {
  width: number;
  label?: string;
  char?: string;
}

export function Divider({ width, label, char = "─" }: DividerProps): JSX.Element {
  const colors = getColors();

  if (label) {
    const labelWithPadding = ` ${label} `;
    const remaining = Math.max(0, width - labelWithPadding.length);
    const left = Math.floor(remaining / 2);
    return (
      <Text color={colors.border}>
        {char.repeat(left)}{labelWithPadding}{char.repeat(remaining - left)}
      </Text>
    );
  }

  return <Text color={colors.border}>{char.repeat(width)}</Text>;
}
