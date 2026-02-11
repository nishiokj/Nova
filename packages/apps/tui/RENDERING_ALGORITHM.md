# TUI Rendering Algorithm

This document describes the complete algorithm for how messages are stored, transformed, and rendered in the terminal UI.

---

## Table of Contents

1. [Data Structures](#1-data-structures)
2. [Screen Layout](#2-screen-layout)
3. [Dimension Calculations](#3-dimension-calculations)
4. [Message Addition Flow](#4-message-addition-flow)
5. [History Lines Construction](#5-history-lines-construction)
6. [Viewing Port Calculation](#6-viewing-port-calculation)
7. [Bottom-Aligned Padding](#7-bottom-aligned-padding)
8. [Scrolling Mechanics](#8-scrolling-mechanics)
9. [Rendering Pipeline](#9-rendering-pipeline)
10. [Syntax Highlighting](#10-syntax-highlighting)
11. [Complete Example](#11-complete-example)

---

## 1. Data Structures

### MessageEntry (Source of Truth)

Stored in `Store.history[]`. This is the canonical message data.

```typescript
interface MessageEntry {
  id: string;           // Unique: "{timestamp}_{randomHex}" e.g. "1737500000_abc123"
  role: Role;           // "user" | "agent" | "system" | "status" | "reasoning"
  text: string;         // Raw message content (may contain newlines, markdown)
  timestamp: number;    // Unix timestamp (milliseconds)
  meta?: string;        // Optional metadata: "Duration: 1234ms\nTools: Read, Edit"
  requestId?: string;   // Links streaming updates to final message
}
```

### HistoryLine (Computed for Display)

Generated from MessageEntry array. Each message becomes multiple lines after text wrapping.

```typescript
interface HistoryLine {
  id: string;            // "{messageId}:{lineIndex}" e.g. "1737500000_abc123:0"
  text: string;          // Single line of wrapped text
  role?: Role;           // Inherited from parent MessageEntry
  requestId?: string;    // For correlating streaming updates
  isBlockStart?: boolean; // True for first line of a message block
  isBlockEnd?: boolean;   // True for last line before separator
}
```

### Relationship

```
1 MessageEntry  →  N HistoryLines

Example:
  MessageEntry { text: "Hello world, this is a long message..." }

  Becomes (at 40-char width):
    HistoryLine { id: "msg:0", text: "Hello world, this is a long", isBlockStart: true }
    HistoryLine { id: "msg:1", text: "message...", isBlockEnd: true }
    HistoryLine { id: "msg:2", text: " " }  // separator
```

---

## 2. Screen Layout

The terminal is divided into fixed regions stacked vertically:

```
┌─────────────────────────────────────────────────────────────┐
│  TOP_PADDING (1 line)                                       │
├─────────────────────────────────────────────────────────────┤
│  HEADER SECTION (5 lines fixed):                            │
│    Line 0: "Bloom" (application title)                      │
│    Line 1: Session key | State | Voice | Plan mode          │
│    Line 2: Status: {spinner} {statusMessage}                │
│    Line 3: Progress/scroll info | New messages indicator    │
│    Line 4: ─────────────────── (separator line)             │
├─────────────────────────────────────────────────────────────┤
│  HISTORY VIEWPORT (dynamic height):                         │
│    - Shows slice of historyLines[]                          │
│    - Scrollable when content exceeds viewport               │
│    - Minimum height: 3 lines                                │
├─────────────────────────────────────────────────────────────┤
│  INPUT BOX (dynamic height):                                │
│    Line: ─────────────────── (top border)                   │
│    Lines: > {input text with cursor} (1-6 lines)            │
│    Line: ─────────────────── (bottom border)                │
│    Line: model (Esc+M) | reasoning (Esc+T)                  │
├─────────────────────────────────────────────────────────────┤
│  AUTOCOMPLETE (conditional):                                │
│    Line: ─────────────────── (border)                       │
│    Lines: suggestions (if active)                           │
├─────────────────────────────────────────────────────────────┤
│  BOTTOM_PADDING (1 line)                                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Dimension Calculations

### Terminal Dimensions

```typescript
// Raw terminal size (from process.stdout or Ink's useStdout)
const rawWidth = process.stdout.columns;   // e.g., 120
const rawHeight = process.stdout.rows;     // e.g., 30

// Clamped to minimums
const width = Math.max(MIN_TERMINAL_WIDTH, rawWidth);    // min 40
const height = Math.max(MIN_TERMINAL_HEIGHT, rawHeight); // min 10

// Content width (usable space after horizontal padding)
const contentWidth = width - (HORIZONTAL_PADDING * 2);   // e.g., 120 - 4 = 116
```

### History Viewport Height

```typescript
// Header is always 5 lines
const headerLines = 5;

// Input box height varies with input length
const inputLineCount = Math.min(DEFAULT_MAX_INPUT_LINES, actualInputLines); // max 6
const inputBoxHeight = 1 + inputLineCount + 1 + 1;  // top border + lines + bottom border + model row

// Autocomplete height (0 if not active)
const autocompleteHeight = autocompleteActive
  ? suggestionCount + 1   // suggestions + border
  : 0;

// History viewport gets remaining space
const historyHeight = Math.max(
  3,  // minimum 3 lines
  height
    - headerLines           // 5
    - inputBoxHeight        // 4-9
    - autocompleteHeight    // 0 or N
    - TOP_PADDING           // 1
    - BOTTOM_PADDING        // 1
);
```

### Example Calculation (80x24 terminal)

```
Terminal:        80 columns × 24 rows
Content width:   80 - 4 = 76 characters
Header:          5 lines
Input box:       4 lines (single line input)
Autocomplete:    0 lines (not active)
Padding:         2 lines (top + bottom)

History height:  24 - 5 - 4 - 0 - 1 - 1 = 13 lines
```

---

## 4. Message Addition Flow

### A. User Submits Message

```typescript
// 1. User presses Enter
handleSubmit() {
  const text = store.getSnapshot().inputText;

  // 2. Add to local history immediately (optimistic)
  store.addMessage("user", text);

  // 3. Clear input
  store.clearInput();

  // 4. Send to backend
  const requestId = `ink_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  sendCommand("send_text", { text, client_request_id: requestId });

  // 5. Update state
  store.setState("sending");
}
```

### B. Agent Response (Streaming)

```typescript
// 1. First chunk arrives
handleStream({ request_id, chunk, is_reasoning, is_final }) {
  if (is_reasoning) {
    // Reasoning content (extended thinking)
    if (reasoningRequestId !== request_id) {
      store.setReasoning(request_id, chunk);  // Start new reasoning
    } else {
      store.appendReasoning(chunk);           // Append to existing
    }
    return;
  }

  // 2. Regular response streaming
  if (streamingRequestId !== request_id) {
    store.setStreaming(request_id, chunk);    // Start new stream
  } else {
    store.appendStreaming(chunk);             // Append (throttled at 16ms)
  }

  // 3. Final chunk - commit to history
  if (is_final) {
    const finalText = store.getSnapshot().streamingText;
    store.addMessage("agent", finalText, undefined, request_id);
    store.finalizeStreaming();
    store.setState("idle");
  }
}
```

### C. System Messages

```typescript
// Direct addition for errors, status updates, command responses
store.addMessage("system", "No API keys configured. Run /providers to set up.");
```

### D. Store.addMessage() Implementation

```typescript
addMessage(role: Role, text: string, meta?: string, requestId?: string): void {
  const id = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  const entry: MessageEntry = {
    id,
    role,
    text,
    timestamp: Date.now(),
    meta,
    requestId,
  };

  this.history.push(entry);
  this.historyVersion++;        // Invalidates cache
  this.pruneHistory();          // Keep under MAX_HISTORY (500)

  if (this.scrollOffset > 0) {
    this.newMessages = true;    // Show "new messages" indicator
  }

  this.emit();                  // Trigger React re-render
}
```

---

## 5. History Lines Construction

### buildHistoryLines() Algorithm

Location: `store.ts:1855`

```typescript
function buildHistoryLines(
  history: MessageEntry[],
  streamingText: string,
  reasoningText: string,
  width: number,
): HistoryLine[] {
  const lines: HistoryLine[] = [];
  const safeWidth = Math.max(20, width);

  // ─── Process each message ───
  for (const entry of history) {
    // 1. Wrap message text to fit width
    const wrapped = wrapText(entry.text || "", safeWidth);
    const entryLinePrefix = entry.id;
    let lineIndex = 0;
    const blockStartIndex = lines.length;

    // 2. Add wrapped content lines
    wrapped.forEach((line, index) => {
      lines.push({
        id: `${entryLinePrefix}:${lineIndex}`,
        text: line,
        role: entry.role,
        requestId: entry.requestId,
        isBlockStart: index === 0,
      });
      lineIndex += 1;
    });

    // 3. Add metadata lines (if present)
    if (entry.meta) {
      const metaLines = wrapText(entry.meta, safeWidth);
      metaLines.forEach((line) => {
        lines.push({
          id: `${entryLinePrefix}:${lineIndex}`,
          text: line,
          role: entry.role,
          requestId: entry.requestId,
        });
        lineIndex += 1;
      });
    }

    // 4. Mark last content line
    if (lines.length > blockStartIndex) {
      lines[lines.length - 1].isBlockEnd = true;
    }

    // 5. Add separator line (visual breathing room)
    const separatorCount = 1;
    for (let i = 0; i < separatorCount; i++) {
      lines.push({
        id: `${entryLinePrefix}:${lineIndex + i}`,
        text: " ",
        role: undefined,
        requestId: entry.requestId,
      });
    }
  }

  // ─── Add reasoning content (if streaming) ───
  if (reasoningText) {
    lines.push({
      id: "reasoning:header",
      text: "💭 Thinking...",
      role: "reasoning",
      isBlockStart: true,
    });

    const wrapped = wrapText(reasoningText, safeWidth);
    wrapped.forEach((line, index) => {
      lines.push({
        id: `reasoning:${index}`,
        text: line,
        role: "reasoning",
      });
    });

    if (lines.length > 0 && lines[lines.length - 1].role === "reasoning") {
      lines[lines.length - 1].isBlockEnd = true;
    }

    lines.push({ id: "reasoning:sep", text: " ", role: undefined });
  }

  // ─── Add streaming content (if active) ───
  if (streamingText) {
    const wrapped = wrapText(streamingText, safeWidth);
    wrapped.forEach((line, index) => {
      lines.push({
        id: `stream:${index}`,
        text: line,
        role: "agent",
        isBlockStart: index === 0,
      });
    });

    if (lines.length > 0 && lines[lines.length - 1].role === "agent") {
      lines[lines.length - 1].isBlockEnd = true;
    }
  }

  return lines;
}
```

### Text Wrapping Algorithm

```typescript
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];

  // 1. Normalize markdown spacing (headers, code blocks, etc.)
  const normalized = normalizeMarkdownSpacing(text);

  // 2. Split on explicit newlines
  const rawLines = normalized.split("\n");

  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }

    // 3. Word-aware wrapping
    if (rawLine.length <= width) {
      lines.push(rawLine);
    } else {
      // Split at word boundaries, hard-wrap long words
      const wrapped = wrapLineByWords(rawLine, width);
      lines.push(...wrapped);
    }
  }

  return lines;
}
```

### Caching

Results are cached by `{width, historyVersion}`:

```typescript
getHistoryLines(width: number, streamCursor: string): HistoryLine[] {
  const cacheKey = { width, version: this.historyVersion };

  if (this.historyCache?.width === width &&
      this.historyCache?.version === this.historyVersion) {
    return this.historyCache.lines;  // Cache hit
  }

  // Cache miss - rebuild
  const lines = buildHistoryLines(
    this.history.slice(this.historyStart),
    this.streamingText + streamCursor,
    this.reasoningText,
    width
  );

  this.historyCache = { width, version: this.historyVersion, lines };
  return lines;
}
```

Cache is invalidated when:
- Any message is added/updated (`historyVersion++`)
- Terminal is resized (`store.invalidateHistoryCache()`)
- Streaming text changes

---

## 6. Viewing Port Calculation

### Coordinate System

The coordinate system is **array-index based**, not screen coordinates:

```
historyLines[] array:
  Index 0     → Oldest message line (top of full history)
  Index N-1   → Newest content line (bottom of full history)

scrollOffset:
  0   → "At bottom" - viewing the newest content
  N   → "N lines up from bottom" - scrolled up
```

### Slicing Algorithm

```typescript
// Total lines in history
const totalLines = historyLines.length;  // e.g., 100

// Maximum scroll position (can't scroll past oldest content)
const maxScroll = Math.max(0, totalLines - historyHeight);
// e.g., max(0, 100 - 13) = 87

// Clamp current scroll to valid range
const scrollOffset = Math.min(snapshot.scrollOffset, maxScroll);

// Calculate visible slice indices
const visibleEndIndex = totalLines - scrollOffset;
const visibleStartIndex = Math.max(0, visibleEndIndex - historyHeight);

// Extract visible portion
const visibleHistoryLines = historyLines.slice(visibleStartIndex, visibleEndIndex);
```

### Example: 100 Lines, 13-Line Viewport

| scrollOffset | visibleStartIndex | visibleEndIndex | Lines Shown | Description |
|--------------|-------------------|-----------------|-------------|-------------|
| 0 | 87 | 100 | 87-99 | At bottom (newest) |
| 10 | 77 | 90 | 77-89 | Scrolled up 10 lines |
| 50 | 37 | 50 | 37-49 | Middle of history |
| 87 | 0 | 13 | 0-12 | At top (oldest) |

### Visual Representation

```
historyLines[] array (100 lines total):
┌────────────────────────────────────────┐
│ Index 0:  "Welcome to Bloom"           │  ← Oldest (top of history)
│ Index 1:  " "                          │
│ Index 2:  "User: hello"                │
│ ...                                    │
│ Index 86: " "                          │
├────────────────────────────────────────┤  ← visibleStartIndex=87 when scrollOffset=0
│ Index 87: "Agent: Here's the..."       │  ┐
│ Index 88: "answer to your..."          │  │
│ Index 89: "question about..."          │  │
│ Index 90: " "                          │  │
│ Index 91: " "                          │  │ VIEWING PORT
│ Index 92: " "                          │  │ (13 lines)
│ Index 93: "User: thanks"               │  │
│ Index 94: " "                          │  │
│ Index 95: " "                          │  │
│ Index 96: " "                          │  │
│ Index 97: "Agent: You're welcome"      │  │
│ Index 98: " "                          │  │
│ Index 99: " "                          │  ┘ ← visibleEndIndex=100
└────────────────────────────────────────┘
```

---

## 7. Bottom-Aligned Padding

### The Problem

When content is less than viewport height, the slice algorithm produces fewer lines than the viewport can display. Without padding, content renders at the **top** of the viewport with empty space below (due to flexbox `flex-start` default).

```
Content: 5 lines, Viewport: 13 lines

Without padding (content at top):
┌─────────────────────────────────────┐
│ Welcome to Bloom                    │  ← Content at top
│                                     │
│ User: hello                         │
│                                     │
│                                     │
│                                     │  ← 8 empty lines
│                                     │
│                                     │
│                                     │
│                                     │
│                                     │
│                                     │
│                                     │
├─────────────────────────────────────┤
│ > _                                 │  ← Input box (gap above)
```

### The Solution: Pre-Padding

Pad the array with empty lines at the **beginning** so content appears at the bottom:

```typescript
// After slicing
const sliced = historyLines.slice(visibleStartIndex, visibleEndIndex);

// Calculate needed padding
// Use space character (not empty string) so Ink renders with actual height
const padding = Math.max(0, historyHeight - sliced.length);

// Build padded array
const visibleHistoryLines = [
  // Padding lines at TOP of viewport (pushes content to bottom)
  ...Array(padding).fill(null).map((_, i) => ({
    id: `pad:${i}`,
    text: " ",  // Space character ensures Ink renders with height
    role: undefined as Role | undefined,
  })),
  // Actual content at BOTTOM of viewport
  ...sliced,
];
```

### Result

```
Content: 5 lines, Viewport: 13 lines, Padding: 8 lines

With padding (content at bottom):
┌─────────────────────────────────────┐
│                                     │  ← Padding line 0
│                                     │  ← Padding line 1
│                                     │  ← Padding line 2
│                                     │  ← Padding line 3
│                                     │  ← Padding line 4
│                                     │  ← Padding line 5
│                                     │  ← Padding line 6
│                                     │  ← Padding line 7
│ Welcome to Bloom                    │  ← Content starts here
│                                     │
│ User: hello                         │
│                                     │
│                                     │
├─────────────────────────────────────┤
│ > _                                 │  ← Input box (content adjacent)
```

### Padding Behavior as Content Grows

| Content Lines | Viewport | Padding | Result |
|---------------|----------|---------|--------|
| 5 | 13 | 8 | Content at bottom, 8 empty lines above |
| 10 | 13 | 3 | Content at bottom, 3 empty lines above |
| 13 | 13 | 0 | Viewport exactly filled |
| 100 | 13 | 0 | Scrollable, no padding needed |

---

## 8. Scrolling Mechanics

### Scroll State

```typescript
// In Store
private scrollOffset = 0;  // 0 = at bottom, N = N lines up

// Exposed in snapshot
scrollOffset: number;
newMessages: boolean;  // True if scrolled up and new content arrived
```

### Scroll Actions

```typescript
// Mouse wheel (3 lines per tick)
scrollBy(delta: number, maxScroll: number): void {
  const next = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
  if (next !== this.scrollOffset) {
    this.scrollOffset = next;
    if (next === 0) {
      this.newMessages = false;  // Reached bottom, clear indicator
    }
    this.emit();
  }
}

// Jump to bottom
scrollToBottom(): void {
  this.scrollOffset = 0;
  this.newMessages = false;
  this.emit();
}

// Jump to top
scrollToTop(maxScroll: number): void {
  this.scrollOffset = maxScroll;
  this.emit();
}
```

### Input Bindings

| Input | Action |
|-------|--------|
| Mouse wheel up | `scrollBy(+3, maxScroll)` |
| Mouse wheel down | `scrollBy(-3, maxScroll)` |
| Page Up | `scrollBy(+historyHeight, maxScroll)` |
| Page Down | `scrollBy(-historyHeight, maxScroll)` |
| Ctrl+Home | `scrollToTop(maxScroll)` |
| Ctrl+End | `scrollToBottom()` |

### New Messages Indicator

When user is scrolled up and new content arrives:

```typescript
addMessage(role, text, ...) {
  // ... add message ...

  if (this.scrollOffset > 0) {
    this.newMessages = true;  // Show indicator in header
  }
}
```

Header shows: `↓ New messages` when `newMessages === true`

---

## 9. Rendering Pipeline

### Complete Flow

```typescript
// 1. Get current state
const snapshot = store.getSnapshot();

// 2. Compute streaming cursor (animated)
const streamCursor = snapshot.state === "streaming"
  ? STREAM_CURSOR_FRAMES[statusTick % 2]  // "|" or " "
  : "";

// 3. Build history lines (cached)
let historyLines = store.getHistoryLines(contentWidth, streamCursor);

// 4. Apply visual spacing (markdown-aware)
if (snapshot.uiMode === "chat") {
  historyLines = applyVisualSpacing(historyLines);
}

// 5. Calculate viewport
const totalLines = historyLines.length;
const maxScroll = Math.max(0, totalLines - historyHeight);
const scrollOffset = Math.min(snapshot.scrollOffset, maxScroll);

// 6. Slice visible portion
const visibleEndIndex = totalLines - scrollOffset;
const visibleStartIndex = Math.max(0, visibleEndIndex - historyHeight);
const sliced = historyLines.slice(visibleStartIndex, visibleEndIndex);

// 7. Apply bottom-alignment padding
const padding = Math.max(0, historyHeight - sliced.length);
const visibleHistoryLines = [
  ...Array(padding).fill(null).map((_, i) => ({
    id: `pad:${i}`,
    text: "",
    role: undefined,
  })),
  ...sliced,
];

// 8. Render
return (
  <Box flexDirection="column" height={historyHeight}>
    {visibleHistoryLines.map((line, index) => {
      const isUserLine = line.role === "user";
      const bgColor = isUserLine ? colors.userBg : undefined;
      const paddedText = isUserLine ? ` ${line.text} ` : line.text;

      return (
        <Text key={line.id ?? `hist-${index}`} backgroundColor={bgColor}>
          <StyledLine text={paddedText} baseColor={roleColor(line.role)} />
        </Text>
      );
    })}
  </Box>
);
```

### Role-Based Styling

```typescript
function roleColor(role?: Role): string | undefined {
  switch (role) {
    case "user":
    case "agent":
    case "system":
    case "status":
      return colors.text;      // Standard text color
    case "reasoning":
      return colors.muted;     // Dimmed for thinking content
    default:
      return undefined;        // Padding lines
  }
}
```

User messages also receive `backgroundColor: colors.userBg` for visual distinction.

---

## 10. Syntax Highlighting

### Pattern Matching

`parseTextSegments()` (now in `formatting.ts`) uses a two-stage approach:

1. Line-level recognition for block elements (diff headers, diff hunks, headers, blockquotes, lists, tables, HRs).
2. Inline parsing for markdown spans (code, bold, italic, strike, links), followed by plain-text token highlighting (URLs, paths, durations, calls).

This avoids regex-overlap bugs and keeps output width-stable.

### Segment Building (Simplified)

```typescript
function parseTextSegments(text: string, baseColor?: string): ParsedSegment[] {
  const block = parseBlockLine(text);
  if (block) return padSegments(block.segments);

  const inline = parseInlineMarkdown(text, baseColor);
  const highlighted = inline.flatMap(seg =>
    seg.kind === "plain" ? highlightPlainText(seg.text) : [seg]
  );
  return padSegments(highlighted);
}
```

### Caching

Results cached (LRU, 200 entries max) by `{baseColor}::{text}`.

---

## 11. Complete Example

### Scenario

- Terminal: 80 columns × 24 rows
- 3 messages in history
- User is at bottom (scrollOffset = 0)

### Step-by-Step

**1. Dimension Calculation**

```
width = 80, height = 24
contentWidth = 80 - 4 = 76
headerLines = 5
inputBoxHeight = 4 (single line input)
autocompleteHeight = 0
historyHeight = 24 - 5 - 4 - 0 - 1 - 1 = 13
```

**2. History Array (3 messages)**

```typescript
history = [
  { id: "msg0", role: "system", text: "Welcome to Bloom" },
  { id: "msg1", role: "user", text: "Hello, can you help me?" },
  { id: "msg2", role: "agent", text: "Of course! What do you need help with?" },
]
```

**3. Build History Lines**

```typescript
historyLines = [
  { id: "msg0:0", text: "Welcome to Bloom", role: "system", isBlockStart: true, isBlockEnd: true },
  { id: "msg0:1", text: " ", role: undefined },  // 1 separator

  { id: "msg1:0", text: "Hello, can you help me?", role: "user", isBlockStart: true, isBlockEnd: true },
  { id: "msg1:1", text: " ", role: undefined },  // 1 separator

  { id: "msg2:0", text: "Of course! What do you need help with?", role: "agent", isBlockStart: true, isBlockEnd: true },
  { id: "msg2:1", text: " ", role: undefined },  // 1 separator
]
// Total: 6 lines
```

**4. Viewport Calculation**

```typescript
totalLines = 6
maxScroll = max(0, 6 - 13) = 0  // Can't scroll (content < viewport)
scrollOffset = min(0, 0) = 0

visibleEndIndex = 6 - 0 = 6
visibleStartIndex = max(0, 6 - 13) = 0
sliced = historyLines.slice(0, 6)  // All 6 lines
```

**5. Apply Padding**

```typescript
padding = max(0, 13 - 6) = 7

visibleHistoryLines = [
  { id: "pad:0", text: " ", role: undefined },
  { id: "pad:1", text: " ", role: undefined },
  { id: "pad:2", text: " ", role: undefined },
  { id: "pad:3", text: " ", role: undefined },
  { id: "pad:4", text: " ", role: undefined },
  { id: "pad:5", text: " ", role: undefined },
  { id: "pad:6", text: " ", role: undefined },
  { id: "msg0:0", text: "Welcome to Bloom", role: "system" },
  { id: "msg0:1", text: " ", role: undefined },
  { id: "msg1:0", text: "Hello, can you help me?", role: "user" },
  { id: "msg1:1", text: " ", role: undefined },
  { id: "msg2:0", text: "Of course! What do you need help with?", role: "agent" },
  { id: "msg2:1", text: " ", role: undefined },
]
// Total: 13 lines (matches historyHeight)
```

**6. Final Render**

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ TOP_PADDING                                                                    │
├────────────────────────────────────────────────────────────────────────────────┤
│ Bloom                                                                          │
│ Session: abc123 | idle | Voice: off                                            │
│ Status: Ready                                                                  │
│                                                                                │
│ ──────────────────────────────────────────────────────────────────────────── │
├────────────────────────────────────────────────────────────────────────────────┤
│                                                                    │ pad:0     │
│                                                                    │ pad:1     │
│                                                                    │ pad:2     │
│                                                                    │ pad:3     │
│                                                                    │ pad:4     │
│                                                                    │ pad:5     │
│                                                                    │ pad:6     │
│ Welcome to Bloom                                                   │ msg0:0    │
│                                                                    │ msg0:1    │
│  Hello, can you help me?                                           │ msg1:0    │ ← user bg
│                                                                    │ msg1:1    │
│ Of course! What do you need help with?                             │ msg2:0    │
│                                                                    │ msg2:1    │
├────────────────────────────────────────────────────────────────────────────────┤
│ ──────────────────────────────────────────────────────────────────────────── │
│ > _                                                                            │
│ ──────────────────────────────────────────────────────────────────────────── │
│ model (Esc+M) | reasoning (Esc+T)                                              │
├────────────────────────────────────────────────────────────────────────────────┤
│ BOTTOM_PADDING                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Constants Reference

| Constant | Value | Description |
|----------|-------|-------------|
| `HORIZONTAL_PADDING` | 2 | Characters on each side of content |
| `TOP_PADDING` | 1 | Lines above header |
| `BOTTOM_PADDING` | 1 | Lines below input |
| `MIN_TERMINAL_WIDTH` | 40 | Minimum supported width |
| `MIN_TERMINAL_HEIGHT` | 10 | Minimum supported height |
| `DEFAULT_MAX_INPUT_LINES` | 6 | Max visible input lines before scroll |
| `SCROLL_AMOUNT` | 3 | Lines per mouse wheel tick |
| `DEFAULT_MAX_HISTORY` | 500 | Max MessageEntry count |
| `MAX_STREAMING_BYTES` | 5MB | Cap on streaming text buffer |
| `MAX_INPUT_LENGTH` | 100KB | Cap on input buffer |
