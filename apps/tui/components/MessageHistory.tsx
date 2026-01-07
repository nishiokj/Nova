import { Box, Text } from "ink";
import type { MessageEntry } from "../types.js";
import { MessageBox, InlineMessage } from "./MessageBox.js";
import { wrapText } from "../utils/textWrap.js";

interface MessageHistoryProps {
  messages: MessageEntry[];
  streamingText: string;
  streamingRequestId: string | null;
  width: number;
  height: number;
  scrollOffset: number;
  compact: boolean;
}

interface RenderedLine {
  key: string;
  element: JSX.Element;
  height: number; // Number of terminal lines this element takes
}

/**
 * Estimates the height of a message box in terminal lines.
 */
function estimateMessageHeight(
  text: string,
  role: string,
  width: number,
  compact: boolean,
  hasMeta: boolean
): number {
  const maxWidth = role === "user" ? 60 : role === "agent" ? 70 : 50;
  const contentWidth = Math.min(maxWidth, width - 4);
  const innerWidth = contentWidth - 4; // Account for borders and padding
  const lines = wrapText(text, innerWidth);

  // Box has: top border (1) + content lines + bottom border (1) + margin (0 or 1)
  let height = 2 + lines.length;
  if (!compact) height += 1; // Bottom margin
  if (hasMeta && !compact) height += 1; // Meta line

  return height;
}

export function MessageHistory({
  messages,
  streamingText,
  streamingRequestId,
  width,
  height,
  scrollOffset,
  compact,
}: MessageHistoryProps): JSX.Element {
  // Build list of rendered messages with height estimates
  const renderedMessages: RenderedLine[] = [];

  for (const msg of messages) {
    const msgHeight = estimateMessageHeight(msg.text, msg.role, width, compact, !!msg.meta);

    // For system and status in compact mode, use inline style
    const useInline = compact && (msg.role === "system" || msg.role === "status");

    if (useInline) {
      renderedMessages.push({
        key: msg.id,
        element: <InlineMessage role={msg.role} text={msg.text} width={width} />,
        height: Math.ceil((msg.text.length + 10) / (width - 10)) || 1,
      });
    } else {
      renderedMessages.push({
        key: msg.id,
        element: (
          <MessageBox
            role={msg.role}
            text={msg.text}
            meta={msg.meta}
            width={width}
            compact={compact}
          />
        ),
        height: msgHeight,
      });
    }
  }

  // Add streaming message if present
  if (streamingText && streamingRequestId) {
    const streamHeight = estimateMessageHeight(streamingText + "|", "agent", width, compact, false);
    renderedMessages.push({
      key: `streaming-${streamingRequestId}`,
      element: (
        <MessageBox
          role="agent"
          text={streamingText + "|"}
          width={width}
          compact={compact}
        />
      ),
      height: streamHeight,
    });
  }

  // Calculate total height and visible window
  let totalHeight = 0;
  for (const rm of renderedMessages) {
    totalHeight += rm.height;
  }

  // Determine which messages to show based on scroll offset
  // scrollOffset = 0 means we're at the bottom (newest messages visible)
  // scrollOffset > 0 means we've scrolled up

  // Calculate visible range from the end
  const endLineIndex = Math.max(0, totalHeight - scrollOffset);
  const startLineIndex = Math.max(0, endLineIndex - height);

  // Find which messages are visible
  let currentLine = 0;
  const visibleMessages: JSX.Element[] = [];

  for (const rm of renderedMessages) {
    const msgStart = currentLine;
    const msgEnd = currentLine + rm.height;

    // Check if this message is in the visible range
    if (msgEnd > startLineIndex && msgStart < endLineIndex) {
      visibleMessages.push(
        <Box key={rm.key} flexDirection="column">
          {rm.element}
        </Box>
      );
    }

    currentLine += rm.height;
  }

  // If no messages, show empty state
  if (visibleMessages.length === 0 && messages.length === 0) {
    return (
      <Box flexDirection="column" height={height} justifyContent="center" alignItems="center">
        <Text dimColor>No messages yet. Type something to get started.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {visibleMessages}
    </Box>
  );
}

/**
 * Simple line-based history for fallback or when precise scrolling is needed.
 */
export function LineBasedHistory({
  lines,
  height,
  scrollOffset,
}: {
  lines: Array<{ text: string; color?: string }>;
  height: number;
  scrollOffset: number;
}): JSX.Element {
  const endIndex = Math.max(0, lines.length - scrollOffset);
  const startIndex = Math.max(0, endIndex - height);
  const visibleLines = lines.slice(startIndex, endIndex);

  return (
    <Box flexDirection="column" height={height}>
      {visibleLines.map((line, i) => (
        <Text key={startIndex + i} color={line.color as any}>
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
