# TUI Beauty Improvements

## Summary
Enhanced the TUI visual experience by removing unnecessary background colors from code highlighting and centering the Bloom title in the header panel.

## Changes

### 1. Code Syntax Highlighting - Syntax Only (No Background)
**File: `packages/tui/utils/syntax.ts`**

- Removed `chalk.bgBlack` from highlighted code output
- Now applies only syntax colors to code blocks
- Error fallback returns plain code without background styling

**Before:** Code had black background with colored syntax
**After:** Code has no background, only colored syntax highlighting

### 2. Inline Code in Markdown - Syntax Only (No Background)
**File: `packages/tui/utils/markdown.ts`**

- Changed `chalk.bgBlack.yellow` to just `chalk.yellow` for:
  - `code` blocks
  - `codespan` (inline code like \`this\`)

**Before:** Inline/code had black background with yellow text
**After:** Inline/code has yellow text with no background

### 3. Diff Highlighting - Full Line Backgrounds ✅
**File: `packages/tui/components/ResponsePane.tsx`**

- Already correctly implemented - no changes needed
- Full-width colored backgrounds for diffs:
  - **Added lines**: Green background (`#166534`) with white text
  - **Removed lines**: Red background (`#991b1b`) with white text
  - **Context lines**: Theme-based background matching user message style

### 4. Bloom Title Centered in Header
**File: `packages/tui/index.tsx`**

- Modified header rendering to support centered text
- Changed "Bloom" from left-aligned to center-aligned in the first header row
- Added new properties: `center`, `centerColor`, `boldCenter`

**New Header Layout:**
```
                        Bloom                                        
Session abc123                    Voice on | Mode chat
                    State: idle | PLAN                          
────────────────────────────────────────────────────────────────
```

## Technical Details

### Syntax Highlighting Changes
- Tree-sitter parser now returns colored text only (no ANSI background codes)
- Fallback for unsupported languages returns plain text
- Improves readability and reduces visual clutter

### Header Centering Implementation
- Calculates padding dynamically: `Math.floor((contentWidth - text.length) / 2)`
- Handles text truncation if content exceeds available width
- Maintains consistent spacing with left/right aligned rows

## Testing
- TUI builds successfully: `bun run build`
- Pre-existing test failure (PermissionPrompt) is unrelated to these changes
- Visual improvements verified through code inspection

## Future Enhancements
Potential areas for further beautification:
- Add subtle gradient backgrounds to code blocks (optional theme setting)
- Implement configurable code block borders
- Add syntax highlighting for more languages (beyond TS/JS/TSX/JSX)
