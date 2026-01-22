# Patch Spec: Ink-Native Scroll Implementation

## Overview

Replace array-slicing scroll with Ink's native pattern: render all content in a clipped container and use CSS margins to shift the viewport.

**Root Cause of Current Bug**: The current implementation uses array slicing + synthetic padding lines to simulate scrolling. Ink doesn't strictly enforce Box height without `overflow="hidden"`, so the padding lines may not render correctly, causing a floating gap that moves with scroll.

**Solution**: Use `overflow="hidden"` to enforce viewport boundaries, `justifyContent="flex-end"` to anchor content to bottom, and `marginBottom` to shift content upward for scrolling.

---

## Architecture Comparison

### Current (Broken)

```
┌─ Outer Box (height=terminal) ─────────────────┐
│  Headers                                       │
│  ┌─ History Box (height=historyHeight) ──────┐│
│  │  [paddingLines...]  ← synthetic padding    ││
│  │  [slicedLines...]   ← array slice          ││
│  └────────────────────────────────────────────┘│
│  Input Area                                    │
└────────────────────────────────────────────────┘
```

**Why it fails:**
- Ink doesn't enforce `height` without `overflow="hidden"`
- Padding lines (single space) may collapse or render incorrectly
- flex-end was tried WITHOUT overflow=hidden → gap appeared at top instead of bottom
- Fighting Ink's layout model rather than working with it

### New (Fixed)

```
┌─ Outer Box (height=terminal) ─────────────────┐
│  Headers                                       │
│  ┌─ Viewport Box ────────────────────────────┐│
│  │  overflow="hidden"  ← enforces clipping    ││
│  │  justifyContent="flex-end" ← anchors bottom││
│  │  ┌─ Content Box (marginBottom=scroll) ───┐││
│  │  │  [ALL historyLines...]                │││
│  │  │  (rendered bottom-up via flex-end)    │││
│  │  └───────────────────────────────────────┘││
│  └────────────────────────────────────────────┘│
│  Input Area                                    │
└────────────────────────────────────────────────┘
```

**How it works:**
1. `overflow="hidden"` enforces viewport boundaries (critical!)
2. `justifyContent="flex-end"` anchors content to viewport bottom
3. `marginBottom={scrollOffset}` pushes content UP to reveal older messages
4. All content rendered; Ink clips what's outside viewport

**Scroll semantics (unchanged):**
- `scrollOffset = 0` → at bottom, newest content visible, `marginBottom = 0`
- `scrollOffset = maxScroll` → at top, oldest content visible, `marginBottom = maxScroll`

---

## Behavioral Requirements

### Chat Mode (uiMode = "chat")
- **Initial position**: Bottom (scrollOffset = 0)
- **Streaming**: If at bottom, stay at bottom as content grows
- **Scrolled up**: Stay at current offset, show "New messages" indicator

### Skills/Hooks Mode (uiMode = "skills" | "hooks")
- **Initial position**: Top (scrollOffset = maxScroll) — user should see first items
- **Behavior**: Same scroll mechanics, just different starting point

### Empty State (historyLines.length = 0)
- **Visual**: Empty space (no placeholder text)
- **Scroll**: maxScroll = 0, scrollOffset clamped to 0, marginBottom = 0
- **Result**: Empty inner Box at bottom of viewport = blank space

### Terminal Resize
- **Behavior**: Let existing clamping logic handle it
- **If scrollOffset > new maxScroll**: Clamp to maxScroll
- **No special reset logic needed**

---

## Code Changes

### File: `packages/tui/index.tsx`

#### Change 1: Delete Slicing Logic (~lines 2664-2678)

**DELETE this entire block:**
```typescript
// Calculate visible lines: we slice the content and pad top if needed
// scrollOffset = 0 = show most recent (bottom), maxScroll = show oldest (top)
const maxStartIndex = Math.max(0, totalHistoryLines - historyHeight);
const startIndex = Math.max(0, maxStartIndex - scrollOffset);
const slicedLines = historyLines.slice(startIndex, Math.min(startIndex + historyHeight, totalHistoryLines));

// Pad with empty lines at the top if content is shorter than viewport
// This keeps content at the bottom without using flex-end (which causes clipping)
const paddingCount = Math.max(0, historyHeight - slicedLines.length);
const paddingLines: HistoryLine[] = Array.from({ length: paddingCount }, (_, i) => ({
  id: `padding-${i}`,
  text: " ",
  role: undefined,
}));
const visibleHistoryLines = [...paddingLines, ...slicedLines];
```

**REPLACE with:**
```typescript
// marginBottom shifts content UP from bottom to reveal older messages
// overflow="hidden" on parent clips content outside viewport
const scrollMargin = scrollOffset;
```

#### Change 2: Update History Box JSX (~lines 2876-2889)

**REPLACE the history Box:**

```tsx
{!isFullScreenMode && (
  <Box
    flexDirection="column"
    height={historyHeight}
    overflow="hidden"
    justifyContent="flex-end"
  >
    <Box
      flexDirection="column"
      flexShrink={0}
      flexGrow={0}
      marginBottom={scrollMargin}
    >
      {historyLines.map((line, index) => {
        const isUserLine = line.role === "user";
        const bgColor = isUserLine ? colors.userBg : undefined;
        const paddedText = isUserLine ? line.text.padEnd(contentWidth, " ") : line.text;
        return (
          <Text key={line.id ?? `hist-${index}`} backgroundColor={bgColor}>
            <StyledLine text={paddedText} baseColor={roleColor(line.role)} />
          </Text>
        );
      })}
    </Box>
  </Box>
)}
```

**Key properties explained:**
| Property | Purpose |
|----------|---------|
| `overflow="hidden"` | Enforces viewport clipping (critical for fix) |
| `justifyContent="flex-end"` | Anchors content to bottom of viewport |
| `height={historyHeight}` | Sets viewport size |
| `flexShrink={0}` | Prevents inner box from being compressed |
| `flexGrow={0}` | Prevents inner box from expanding |
| `marginBottom={scrollMargin}` | Shifts content UP by scroll amount |

### File: `packages/tui/store.ts`

#### Change 3: Reset Scroll on Mode Change

In the `setUIMode` method, add scroll reset logic:

**FIND the setUIMode method and UPDATE:**

```typescript
setUIMode(mode: UIMode): void {
  const previousMode = this.uiMode;
  this.uiMode = mode;

  // Reset scroll position based on mode type
  // Chat: start at bottom (newest content)
  // Lists (skills/hooks): start at top (first items)
  if (mode !== previousMode) {
    if (mode === "skills" || mode === "hooks") {
      // Will be clamped to maxScroll by the render logic
      // Set to large value; actual maxScroll computed at render time
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
    } else {
      // Chat and other modes: start at bottom
      this.scrollOffset = 0;
    }
    this.newMessages = false;
  }

  this.emit();
}
```

**Note**: Setting `scrollOffset = Number.MAX_SAFE_INTEGER` for list modes works because the existing clamping logic in index.tsx will clamp it to `maxScroll`:
```typescript
useEffect(() => {
  if (snapshot.scrollOffset > maxScroll) {
    store.setScrollOffset(maxScroll);
  }
}, [snapshot.scrollOffset, maxScroll, store]);
```

---

## Variables Summary

### Removed
| Variable | Reason |
|----------|--------|
| `maxStartIndex` | No longer slicing |
| `startIndex` | No longer slicing |
| `slicedLines` | Render all lines instead |
| `paddingCount` | flex-end handles bottom anchoring |
| `paddingLines` | No synthetic padding needed |
| `visibleHistoryLines` | Use `historyLines` directly |

### Added
| Variable | Value | Purpose |
|----------|-------|---------|
| `scrollMargin` | `scrollOffset` | Direct mapping for marginBottom |

### Unchanged
| Variable | Purpose |
|----------|---------|
| `totalHistoryLines` | Count for maxScroll calculation |
| `maxScroll` | Upper bound for scroll offset |
| `scrollOffset` | Current scroll position (clamped) |
| `historyLines` | All wrapped history lines |

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Empty history (0 lines) | Empty viewport, no artifacts |
| Content < viewport | Content at bottom, empty space at top |
| Content = viewport | Content fills viewport exactly |
| Content > viewport | Newest visible, can scroll to older |
| Scroll to top | Oldest content visible |
| Scroll to bottom | Newest content visible, no gap |
| New message while at bottom | Stay at bottom, see new content |
| New message while scrolled up | Stay scrolled, "New messages" indicator |
| Enter skills mode | Jump to top of list |
| Enter hooks mode | Jump to top of list |
| Return to chat mode | Jump to bottom (newest) |
| Terminal resize (shrink) | Clamp scroll if needed |
| Terminal resize (grow) | More content visible, position preserved |
| Rapid streaming | Stay at bottom if at bottom |

---

## Performance

### Current Approach (Simple)
Render all `historyLines` and let `overflow="hidden"` clip. The existing `maxHistory = 500` limit (history entries, not lines) should be acceptable.

### TODO: Buffered Rendering (If Needed)
If performance issues arise with large histories (500 entries could become 2000+ wrapped lines), implement windowed rendering:

```typescript
// Render 3x viewport centered on visible area
const bufferSize = historyHeight * 3;
const visibleEnd = totalHistoryLines - scrollOffset;
const visibleStart = visibleEnd - historyHeight;
const bufferStart = Math.max(0, visibleStart - historyHeight);
const bufferEnd = Math.min(totalHistoryLines, visibleEnd + historyHeight);
const bufferedLines = historyLines.slice(bufferStart, bufferEnd);

// Adjust margin to account for removed lines above
const linesAboveBuffer = bufferStart;
const adjustedMargin = scrollOffset - (totalHistoryLines - bufferEnd);
```

This is NOT implemented in this patch. Add only if profiling shows need.

---

## Testing Checklist

### Core Scroll Behavior
- [ ] Initial load: content anchored to bottom
- [ ] Less content than viewport: content at bottom, empty space at top (no gap at bottom)
- [ ] More content than viewport: newest visible, scrollable
- [ ] Scroll up (toward older): older content revealed at top
- [ ] Scroll down (toward newer): newer content revealed at bottom
- [ ] At bottom (scrollOffset=0): no gap anywhere
- [ ] At top (scrollOffset=maxScroll): oldest content visible at top

### Edge Cases
- [ ] Empty history: blank viewport, no visual artifacts
- [ ] Single line of content: appears at bottom
- [ ] Exactly viewport-height content: fills exactly, no scroll needed
- [ ] Very long single message (many wrapped lines): scrolls correctly

### Mode Transitions
- [ ] Fresh start in chat: at bottom
- [ ] Enter /skills: jumps to top of list
- [ ] Enter /hooks: jumps to top of list
- [ ] Exit skills → chat: jumps to bottom
- [ ] Exit hooks → chat: jumps to bottom

### Dynamic Content
- [ ] New message while at bottom: stays at bottom, sees new content
- [ ] New message while scrolled up: stays scrolled, "New messages" shows
- [ ] Streaming content while at bottom: stays at bottom
- [ ] Streaming content while scrolled: stays scrolled

### Resize
- [ ] Shrink terminal height: content adjusts, scroll clamped if needed
- [ ] Grow terminal height: more content visible
- [ ] Shrink terminal width: lines re-wrap, scroll adjusts

---

## Rollback Plan

If issues arise, revert to the slicing approach by:
1. Restoring the deleted slicing logic (lines 2664-2678)
2. Restoring `visibleHistoryLines` in JSX
3. Removing `overflow="hidden"` and `justifyContent="flex-end"` from Box
4. Reverting `setUIMode` changes in store.ts

The git diff will clearly show all changes for easy revert.
