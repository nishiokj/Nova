# TUI Scroll/Viewport Fix Attempt

## Date: 2026-01-20

## Problem Description

The TUI has a broken scrolling/viewport system with the following symptoms:

1. **Scrolling direction is inverted**: Scrolling down (mouse wheel toward user) reveals content "below" the last line of content (blank space), which should not exist
2. **Blank space visible**: There's a visible blank box/area around halfway down the screen that only disappears when scrolling to the top of content
3. **Cannot access older content**: Scrolling up (mouse wheel away from user) is blocked because the system tries to "push the bottom line beneath the input line"
4. **Viewport not properly constrained**: The viewport allows viewing beyond the actual content bounds

## Architecture Understanding

### Scroll Model (from `store.ts`)
- `scrollOffset = 0` means "at the bottom" (newest content visible)
- `scrollOffset > 0` means scrolled UP (older content visible)
- `maxScroll = totalHistoryLines - historyHeight`
- `scrollBy(delta, maxScroll)` clamps offset to `[0, maxScroll]`

### Input Mapping (from `index.tsx` and `useMouse.ts`)
- Mouse wheel UP (away from user) → `onScrollUp` → `scrollBy(+SCROLL_AMOUNT)` → increases offset → should show older content
- Mouse wheel DOWN (toward user) → `onScrollDown` → `scrollBy(-SCROLL_AMOUNT)` → decreases offset → should show newer content
- PageUp/Shift+Up → positive delta → older content
- PageDown/Shift+Down → negative delta → newer content

### Original Rendering Approach
The original code rendered ALL historyLines and used CSS-like margin tricks:

```tsx
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
    marginBottom={scrollMargin}  // scrollMargin = scrollOffset
  >
    {historyLines.map((line, index) => { ... })}
  </Box>
</Box>
```

**Theory**: `justifyContent="flex-end"` pins content to bottom, `marginBottom` pushes it up, `overflow="hidden"` clips the overflow.

**Reality**: This doesn't work in Ink's Yoga layout engine the way it would in CSS.

## Fix Attempt #1: Array Slicing

### Rationale
Instead of relying on margin/overflow tricks that don't work in Yoga, slice the array to only render the visible portion.

### Changes Made

1. **Added visible line calculation** (`index.tsx` ~line 2664):
```tsx
const totalLines = historyLines.length;
const visibleEndIndex = totalLines - scrollOffset;
const visibleStartIndex = Math.max(0, visibleEndIndex - historyHeight);
const visibleHistoryLines = historyLines.slice(visibleStartIndex, visibleEndIndex);
```

2. **Simplified Box structure** (`index.tsx` ~line 2867):
```tsx
<Box flexDirection="column" height={historyHeight}>
  {visibleHistoryLines.map((line, index) => { ... })}
</Box>
```

Removed: `overflow="hidden"`, `justifyContent="flex-end"`, nested Box with `marginBottom`

### Result
**Did not fix the problem.** There is still a visible blank box around halfway down the screen that only disappears when scrolling to the top of the content.

## Hypotheses for Why It Still Doesn't Work

1. **historyHeight calculation issue**: The `historyHeight` might be larger than the actual number of lines being rendered, creating empty space in the Box

2. **Line height mismatch**: Ink might be calculating line heights differently than expected, causing the Box to reserve more vertical space than needed

3. **historyLines contains blank entries**: The `buildHistoryLines` function in `store.ts` adds separator lines (spaces) between messages - these might be contributing to the blank space issue

4. **Flex layout behavior**: Even with slicing, the `height={historyHeight}` on the Box might be creating a fixed-height container that's larger than the content

5. **The problem is elsewhere**: The blank box might not be from the history pane at all - could be from another component in the layout

## Files Involved

- `packages/tui/index.tsx` - Main TUI component, rendering logic
- `packages/tui/store.ts` - State management, scroll methods, `buildHistoryLines` function
- `packages/tui/useMouse.ts` - Mouse wheel event handling
- `packages/tui/constants.ts` - `SCROLL_AMOUNT = 3`

## Key Functions to Investigate

1. `buildHistoryLines()` in `store.ts` (lines 1855-1957) - builds the line array, adds separators
2. `historyHeight` calculation in `index.tsx` (line 2599-2602)
3. The relationship between `historyHeight` and actual rendered content

## Next Steps to Try

1. **Debug the dimensions**: Add logging to see `historyHeight`, `totalLines`, `visibleHistoryLines.length` at runtime

2. **Check for empty Box space**: Try adding `flexGrow={0}` and `flexShrink={0}` to prevent the history Box from expanding beyond content

3. **Investigate separator lines**: The `buildHistoryLines` function adds 1-3 blank separator lines after each message - check if these are causing issues

4. **Check if height should be dynamic**: Maybe `height={historyHeight}` should be `height={Math.min(historyHeight, visibleHistoryLines.length)}` or removed entirely

5. **Verify Ink's Box behavior**: Test with a minimal reproduction to understand how Ink handles `height` on a Box with fewer children than the height allows

## User's Suggestion

> "I think we should instead have the input bar and content a part of one single page, where scrolling just moves the viewport on that page."

This suggests treating the entire layout as a single scrollable document rather than having separate fixed regions. This would be a more significant architectural change.
