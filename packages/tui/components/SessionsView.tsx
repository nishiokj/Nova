/**
 * SessionsView - A well-designed session picker for /sessions command.
 *
 * Features:
 * - Responsive card layout that adapts to terminal width
 * - Color-coded status indicators
 * - Truncated message previews
 * - Relative timestamps
 * - Keyboard navigation (handled by parent)
 */

import { Box, Text } from "ink";
import { getColors } from "../theme.js";
import type { SessionEntry } from "../types.js";
import { Divider } from "./Divider.js";

interface SessionsViewProps {
  sessions: SessionEntry[];
  cursor: number;
  currentSessionKey: string | null;
  width: number;
  height: number;
}

/**
 * Format timestamp as relative time (e.g., "2h ago", "3d ago")
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;

  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 604800)}w`;
}

/**
 * Extract directory name from path
 */
function getProjectName(workingDir: string | null): string {
  if (!workingDir) return "unknown";
  const parts = workingDir.split("/");
  return parts[parts.length - 1] || "root";
}

/**
 * Truncate text to fit width with ellipsis
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

export function SessionsView({
  sessions,
  cursor,
  currentSessionKey,
  width,
  height,
}: SessionsViewProps) {
  const colors = getColors();

  // Calculate layout dimensions
  const contentWidth = Math.max(40, width - 4); // 2px padding each side
  const cardHeight = 3; // Each session card is 3 lines
  const headerHeight = 4; // Title + instructions + divider + spacer
  const footerHeight = 2; // Divider + hint
  const availableHeight = height - headerHeight - footerHeight;
  const visibleCards = Math.max(1, Math.floor(availableHeight / (cardHeight + 1))); // +1 for spacing

  // Calculate visible window (scroll if needed)
  let startIdx = 0;
  if (cursor >= visibleCards) {
    startIdx = cursor - visibleCards + 1;
  }
  const visibleSessions = sessions.slice(startIdx, startIdx + visibleCards);

  // Column widths (responsive)
  const statusWidth = 10;
  const timeWidth = 6;
  const projectMinWidth = 12;
  const previewMinWidth = 20;
  const availableForContent = contentWidth - statusWidth - timeWidth - 6; // 6 for spacing
  const projectWidth = Math.min(Math.max(projectMinWidth, Math.floor(availableForContent * 0.3)), 24);
  const previewWidth = Math.max(previewMinWidth, availableForContent - projectWidth);

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color={colors.accent}>Sessions</Text>
        <Text color={colors.muted}>No recoverable sessions found.</Text>
        <Text color={colors.muted}>Press Esc to return.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Header */}
      <Text bold color={colors.accent}>Sessions</Text>
      <Text color={colors.muted}>↑↓ navigate  Enter select  Esc cancel</Text>
      <Divider width={contentWidth} />

      {/* Session list */}
      <Box flexDirection="column" height={availableHeight}>
        {visibleSessions.map((session, visualIdx) => {
          const actualIdx = startIdx + visualIdx;
          const isSelected = actualIdx === cursor;
          const isCurrent = session.sessionKey === currentSessionKey;

          const project = getProjectName(session.workingDir);
          const time = formatRelativeTime(session.lastAccessedAt);
          const preview = session.lastUserMessagePreview || "(no messages)";
          const statusIcon = session.status === "active" ? "●" : "○";
          const statusColor = session.status === "active" ? colors.success : colors.muted;

          // Selection indicator
          const pointer = isSelected ? "▸" : " ";
          const pointerColor = isSelected ? colors.accent : colors.muted;

          // Current session marker
          const currentMarker = isCurrent ? " ★" : "";

          return (
            <Box
              key={session.sessionKey}
              flexDirection="column"
              marginBottom={1}
            >
              {/* Main row: pointer | status | project | time */}
              <Box>
                <Text color={pointerColor}>{pointer} </Text>
                <Text color={statusColor}>{statusIcon} </Text>
                <Text
                  color={isSelected ? colors.text : colors.muted}
                  bold={isSelected}
                >
                  {truncate(project, projectWidth)}
                </Text>
                <Text color={colors.accent}>{currentMarker}</Text>
                <Text color={colors.muted}>
                  {" ".repeat(Math.max(1, projectWidth - project.length - currentMarker.length + 2))}
                </Text>
                <Text color={colors.muted}>{time.padStart(timeWidth)}</Text>
              </Box>
              {/* Preview row: indented message preview */}
              <Box paddingLeft={3}>
                <Text color={colors.muted} dimColor={!isSelected}>
                  {truncate(preview, previewWidth)}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Footer */}
      <Divider width={contentWidth} />
      <Box>
        <Text color={colors.muted}>
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
          {startIdx > 0 || startIdx + visibleCards < sessions.length
            ? ` (${cursor + 1}/${sessions.length})`
            : ""}
        </Text>
        <Text color={colors.muted}> │ </Text>
        <Text color={colors.success}>● active</Text>
        <Text color={colors.muted}> │ </Text>
        <Text color={colors.muted}>○ inactive</Text>
      </Box>
    </Box>
  );
}
