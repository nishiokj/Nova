/**
 * UsageView - Session usage and analytics view.
 *
 * Features:
 * - List mode: Shows session list with token summaries
 * - Detail mode: Shows expanded session with LLM calls/tools
 * - Analytics mode: Shows aggregated metrics by day and provider
 * - Keyboard navigation
 */

import { Box, Text, useInput } from "ink";
import { getColors } from "../theme.js";
import type { UsageSessionSummary, UsageDayStats, UsageProviderStats } from "../types.js";
import { Divider } from "./Divider.js";

interface UsageViewProps {
  sessions: UsageSessionSummary[];
  cursor: number;
  viewMode: "list" | "detail" | "analytics";
  dayStats: UsageDayStats[];
  providerStats: UsageProviderStats[];
  loading: boolean;
  width: number;
  height: number;
  onMoveCursor: (delta: number) => void;
  onSetViewMode: (mode: "list" | "detail" | "analytics") => void;
  onRefresh: () => void;
  onClose: () => void;
}

/**
 * Format relative time (e.g., "2h", "3d")
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
 * Format token count (e.g., "1.2M", "45K", "890")
 */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}

/**
 * Format duration in human readable form
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remainingM = m % 60;
  return remainingM > 0 ? `${h}h ${remainingM}m` : `${h}h`;
}

/**
 * Truncate text to fit width with ellipsis
 */
function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

export function UsageView({
  sessions,
  cursor,
  viewMode,
  dayStats,
  providerStats,
  loading,
  width,
  height,
  onMoveCursor,
  onSetViewMode,
  onRefresh,
  onClose,
}: UsageViewProps) {
  const colors = getColors();
  const contentWidth = Math.max(1, width - 4);

  // Handle input
  useInput((input, key) => {
    if (key.escape) {
      if (viewMode === "detail") {
        onSetViewMode("list");
      } else {
        onClose();
      }
      return;
    }

    if (key.tab) {
      // Toggle between list and analytics
      if (viewMode === "list") {
        onSetViewMode("analytics");
      } else if (viewMode === "analytics") {
        onSetViewMode("list");
      } else if (viewMode === "detail") {
        onSetViewMode("analytics");
      }
      return;
    }

    if (viewMode === "list") {
      if (key.upArrow) {
        onMoveCursor(-1);
        return;
      }
      if (key.downArrow) {
        onMoveCursor(1);
        return;
      }
      if (key.return) {
        onSetViewMode("detail");
        return;
      }
    }

    if (input === "r") {
      onRefresh();
      return;
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color={colors.accent}>Usage</Text>
        <Text color={colors.muted}>Loading usage data...</Text>
      </Box>
    );
  }

  if (viewMode === "analytics") {
    return (
      <AnalyticsView
        dayStats={dayStats}
        providerStats={providerStats}
        width={contentWidth}
        height={height}
        colors={colors}
      />
    );
  }

  if (viewMode === "detail") {
    const selected = sessions[cursor];
    if (!selected) {
      return (
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text bold color={colors.accent}>Usage - Detail</Text>
          <Text color={colors.muted}>No session selected.</Text>
          <Text color={colors.muted}>Press Esc to return.</Text>
        </Box>
      );
    }
    return (
      <DetailView
        session={selected}
        width={contentWidth}
        colors={colors}
      />
    );
  }

  // List view
  return (
    <ListView
      sessions={sessions}
      cursor={cursor}
      width={contentWidth}
      height={height}
      colors={colors}
    />
  );
}

// ============================================
// List View
// ============================================

interface ListViewProps {
  sessions: UsageSessionSummary[];
  cursor: number;
  width: number;
  height: number;
  colors: ReturnType<typeof getColors>;
}

function ListView({ sessions, cursor, width, height, colors }: ListViewProps) {
  const headerHeight = 4;
  const footerHeight = 2;
  const cardHeight = 2;
  const availableHeight = height - headerHeight - footerHeight;
  const visibleCards = Math.max(1, Math.floor(availableHeight / (cardHeight + 1)));

  // Calculate visible window
  let startIdx = 0;
  if (cursor >= visibleCards) {
    startIdx = cursor - visibleCards + 1;
  }
  const visibleSessions = sessions.slice(startIdx, startIdx + visibleCards);

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color={colors.accent}>Usage</Text>
        <Text color={colors.muted}>No sessions found.</Text>
        <Text color={colors.muted}>Press Esc to return.</Text>
      </Box>
    );
  }

  // Compute totals
  const totalInput = sessions.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOutput = sessions.reduce((sum, s) => sum + s.outputTokens, 0);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Header */}
      <Box>
        <Text bold color={colors.accent}>Usage</Text>
        <Text color={colors.muted}> </Text>
        <Text color={colors.muted}>[Tab: Analytics]</Text>
      </Box>
      <Text color={colors.muted}>\u2191\u2193 navigate  Enter details  Tab analytics  r refresh  Esc close</Text>
      <Divider width={width} />

      {/* Session list */}
      <Box flexDirection="column" height={availableHeight}>
        {visibleSessions.map((session, visualIdx) => {
          const actualIdx = startIdx + visualIdx;
          const isSelected = actualIdx === cursor;

          const statusIcon = session.status === "active" ? "\u25CF" : session.status === "idle" ? "\u25CB" : "\u25CB";
          const statusColor = session.status === "active" ? colors.success : colors.muted;
          const pointer = isSelected ? "\u25B8" : " ";
          const pointerColor = isSelected ? colors.accent : colors.muted;

          const time = formatRelativeTime(session.lastAccessedAt);
          const tokens = `${formatTokens(session.inputTokens)}/${formatTokens(session.outputTokens)}`;
          const reqs = `${session.requestCount} reqs`;

          // Layout: pointer | status | project | time | reqs | tokens
          return (
            <Box key={session.sessionKey} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={pointerColor}>{pointer} </Text>
                <Text color={statusColor}>{statusIcon} </Text>
                <Text color={isSelected ? colors.text : colors.muted} bold={isSelected}>
                  {truncate(session.projectName, 16)}
                </Text>
                <Text color={colors.muted}>{" ".repeat(Math.max(1, 18 - session.projectName.length))}</Text>
                <Text color={colors.muted}>{session.status.padEnd(7)}</Text>
                <Text color={colors.muted}> {time.padStart(4)} </Text>
                <Text color={colors.muted}> {reqs.padStart(8)} </Text>
                <Text color={isSelected ? colors.accent : colors.muted}> {tokens} tokens</Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Footer */}
      <Divider width={width} />
      <Box>
        <Text color={colors.muted}>
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
          {startIdx > 0 || startIdx + visibleCards < sessions.length
            ? ` (${cursor + 1}/${sessions.length})`
            : ""}
        </Text>
        <Text color={colors.muted}> | </Text>
        <Text color={colors.accent}>Total: {formatTokens(totalInput)}/{formatTokens(totalOutput)} tokens</Text>
      </Box>
    </Box>
  );
}

// ============================================
// Detail View
// ============================================

interface DetailViewProps {
  session: UsageSessionSummary;
  width: number;
  colors: ReturnType<typeof getColors>;
}

function DetailView({ session, width, colors }: DetailViewProps) {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        <Text bold color={colors.accent}>Usage - {session.projectName}</Text>
        <Text color={colors.muted}> [Tab: Analytics]</Text>
      </Box>
      <Divider width={width} />

      {/* Session info */}
      <Box flexDirection="column" marginY={1}>
        <Text color={colors.text}>Session: <Text color={colors.muted}>{truncate(session.sessionKey, 40)}</Text></Text>
        <Text color={colors.text}>Status: <Text color={session.status === "active" ? colors.success : colors.muted}>{session.status}</Text></Text>
        <Text color={colors.text}>Duration: <Text color={colors.muted}>{formatDuration(session.durationMs)}</Text></Text>
        <Text color={colors.text}>Working Dir: <Text color={colors.path}>{truncate(session.workingDir ?? "unknown", width - 16)}</Text></Text>
      </Box>

      <Divider width={width} />

      {/* Token metrics */}
      <Box flexDirection="column" marginY={1}>
        <Text bold color={colors.text}>Token Usage</Text>
        <Box marginTop={1}>
          <Box flexDirection="column" width={20}>
            <Text color={colors.muted}>Input Tokens</Text>
            <Text bold color={colors.accent}>{formatTokens(session.inputTokens)}</Text>
          </Box>
          <Box flexDirection="column" width={20}>
            <Text color={colors.muted}>Output Tokens</Text>
            <Text bold color={colors.accent}>{formatTokens(session.outputTokens)}</Text>
          </Box>
          <Box flexDirection="column" width={20}>
            <Text color={colors.muted}>Total</Text>
            <Text bold color={colors.accent}>{formatTokens(session.inputTokens + session.outputTokens)}</Text>
          </Box>
        </Box>
      </Box>

      <Divider width={width} />

      {/* Activity metrics */}
      <Box flexDirection="column" marginY={1}>
        <Text bold color={colors.text}>Activity</Text>
        <Box marginTop={1}>
          <Box flexDirection="column" width={20}>
            <Text color={colors.muted}>Requests</Text>
            <Text bold color={colors.text}>{session.requestCount}</Text>
          </Box>
          <Box flexDirection="column" width={20}>
            <Text color={colors.muted}>LLM Calls</Text>
            <Text bold color={colors.text}>{session.llmCallCount}</Text>
          </Box>
          <Box flexDirection="column" width={20}>
            <Text color={colors.muted}>Tool Calls</Text>
            <Text bold color={colors.text}>{session.toolCallCount}</Text>
          </Box>
        </Box>
      </Box>

      <Divider width={width} />
      <Text color={colors.muted}>Esc back  Tab analytics</Text>
    </Box>
  );
}

// ============================================
// Analytics View
// ============================================

interface AnalyticsViewProps {
  dayStats: UsageDayStats[];
  providerStats: UsageProviderStats[];
  width: number;
  height: number;
  colors: ReturnType<typeof getColors>;
}

function AnalyticsView({ dayStats, providerStats, width, colors }: AnalyticsViewProps) {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        <Text bold color={colors.accent}>Usage - Analytics</Text>
        <Text color={colors.muted}> [Tab: Sessions]</Text>
      </Box>
      <Text color={colors.muted}>r refresh  Esc close</Text>
      <Divider width={width} />

      {/* Daily stats table */}
      <Box flexDirection="column" marginY={1}>
        <Text bold color={colors.text}>Daily Usage</Text>
        <Box marginTop={1}>
          <Text color={colors.muted}>{"Date".padEnd(10)}</Text>
          <Text color={colors.muted}>{"In".padStart(8)}</Text>
          <Text color={colors.muted}>{"Out".padStart(8)}</Text>
          <Text color={colors.muted}>{"Reqs".padStart(6)}</Text>
          <Text color={colors.muted}>{"Calls".padStart(6)}</Text>
        </Box>
        {dayStats.length === 0 ? (
          <Text color={colors.muted}>No data available</Text>
        ) : (
          dayStats.slice(0, 7).map((day) => (
            <Box key={day.date}>
              <Text color={colors.text}>{day.date.padEnd(10)}</Text>
              <Text color={colors.accent}>{formatTokens(day.inputTokens).padStart(8)}</Text>
              <Text color={colors.accent}>{formatTokens(day.outputTokens).padStart(8)}</Text>
              <Text color={colors.muted}>{String(day.requestCount).padStart(6)}</Text>
              <Text color={colors.muted}>{String(day.llmCallCount).padStart(6)}</Text>
            </Box>
          ))
        )}
      </Box>

      <Divider width={width} />

      {/* Provider stats table */}
      <Box flexDirection="column" marginY={1}>
        <Text bold color={colors.text}>By Provider (Input Tokens)</Text>
        <Box marginTop={1}>
          <Text color={colors.muted}>{"Provider".padEnd(14)}</Text>
          <Text color={colors.muted}>{"Today".padStart(10)}</Text>
          <Text color={colors.muted}>{"Week".padStart(10)}</Text>
          <Text color={colors.muted}>{"Month".padStart(10)}</Text>
        </Box>
        {providerStats.length === 0 ? (
          <Text color={colors.muted}>No data available</Text>
        ) : (
          providerStats.map((prov) => (
            <Box key={prov.provider}>
              <Text color={colors.text}>{prov.provider.padEnd(14)}</Text>
              <Text color={colors.accent}>{formatTokens(prov.today).padStart(10)}</Text>
              <Text color={colors.accent}>{formatTokens(prov.week).padStart(10)}</Text>
              <Text color={colors.accent}>{formatTokens(prov.month).padStart(10)}</Text>
            </Box>
          ))
        )}
      </Box>

      <Divider width={width} />
      <Text color={colors.muted}>Tab sessions  Esc close</Text>
    </Box>
  );
}
