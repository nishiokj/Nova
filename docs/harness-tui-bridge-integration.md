# Ralph Prompt: Iterative TUI Improvement

## Objective
Systematically improve the Terminal UI (TUI) by implementing the TUI Improvement Implementation Plan in phases, ensuring each iteration is tested, validated, and builds incrementally on the previous work.

---

## Context Overview

### Current State
- **packages/tui/bridge_client.ts**: TCP JSONL client managing connections to harness bridge
  - Connection state machine: disconnected/connecting/connected/reconnecting
  - Event validation at boundary (`validateBridgeEvent`)
  - Auth commands, provider management, session handling
  - Run tracking via `activeRuns` Set with requestId
  - Auto-reconnect with exponential backoff (max 5 attempts, 30s cap)

- **packages/tui/index.tsx**: Main app component (target for improvements)
  - Event handlers: `handleProgress`, `handleResponse`, etc.
  - Rendering pipeline with `StyledLine` component
  - Status bar rendering

- **packages/tui/store.ts**: Central state management
  - `buildHistoryLines()` for rendering
  - Message tracking with type system
  - Progress tracking

- **packages/tui/theme.ts**: Theme catalog (under-utilized for hierarchy)

- **packages/harness-daemon/src/harness/event_translator.ts**: Emits BridgeEvents (source for metadata)

### Implementation Plan Reference
See `docs/tui-improvement-implementation-plan.md` for full details:
- **Phase 1** (0.5–1 day): Filter noise, tool summaries, intermediate updates, syntax cues
- **Phase 2** (1–2 days): Message framing, markdown rendering, status polish
- **Phase 3** (2–3 days): Diff viewer, planning feed, tool output drill-down

---

## Ralph's Working Style

1. **Iterative & Incremental**: Work through phases in order. Complete and validate Phase 1 before starting Phase 2.

2. **Test-First Approach**: Before making changes, understand the current behavior. After changes, verify:
   - Run `bun run tui` locally
   - Confirm UI renders correctly
   - Check event flow through bridge client

3. **Minimal Changes**: Make the smallest change that achieves the stated goal. Don't refactor unrelated code.

4. **Schema Coordination**: When changing event schemas (Phase 3), update both:
   - `packages/tui/types.ts`
   - `packages/harness-daemon/src/harness/types.ts`

5. **Backward Compatibility**: Keep new fields optional. Gate UI enhancements on presence of metadata.

---

## Phase 1: Quick Wins (Start Here)

### Task 1.1: Filter Low-Value System Chatter
**File**: `packages/tui/index.tsx`

**Goal**: Prevent boilerplate messages like "Indexing files for autocomplete..." from cluttering the history.

**Actions**:
1. Read `packages/tui/index.tsx` to find where system messages are added to the store
2. Create a helper `shouldSurfaceSystemMessage(text: string): boolean` with regex suppression
3. Wrap calls to `store.addMessage('system', ...)` with this guard
4. Test by running TUI and confirming filtered messages don't appear

**Example Pattern**:
```typescript
const shouldSurfaceSystemMessage = (text: string) => 
  !/Indexing files|Preparing workspace/i.test(text);
```

### Task 1.2: One-Line Tool Call Summaries
**Files**: `packages/tui/index.tsx` (handleProgress), `packages/tui/store.ts`

**Goal**: Collapse tool output to single line with status icon.

**Actions**:
1. Locate `handleProgress` in `index.tsx`
2. Add `summarize(text, max = 80)` helper
3. Add status icon logic: `level === 'success' ? '✔' : level === 'error' ? '✖' : '•'`
4. Update store to track `progressLevel`/`progressKind`
5. Modify renderer to use `store.progressSummary()` with `levelColor(snapshot.progressLevel)`
6. Verify tool calls show as colored badges with truncated text

### Task 1.3: Surface Intermediate Agent Updates
**Files**: `packages/tui/index.tsx`, `packages/tui/store.ts`

**Goal**: Make planning/thinking updates visible in history instead of disappearing.

**Actions**:
1. Find where progress events are handled
2. When `data.kind === 'planning' | 'thinking'`, call `store.addMessage('status', ...)`
3. Extend `addMessage` in store to de-duplicate consecutive identical status lines
4. Add timestamp tagging
5. Test with a planning scenario to confirm status lines appear

### Task 1.4: Basic Syntax Color Cues
**File**: `packages/tui/index.tsx`

**Goal**: Use existing theme tokens to create visual hierarchy.

**Actions**:
1. Locate `syntaxPatterns` in `index.tsx`
2. Add regexes for: list bullets (`^[-*]`), diff prefixes (`^[-+]`), timestamps
3. Apply `colors.header`, `colors.bold`, `colors.path`, `colors.code` appropriately
4. Highlight role prefixes (`You:`, `Agent:`) with `colors.accent` + bold
5. Verify improved visual hierarchy in rendered output

---

## Phase 2: Medium Complexity (After Phase 1 Validated)

### Task 2.1: Message Framing & Visual Hierarchy
**Files**: `packages/tui/store.ts`, `packages/tui/index.tsx` (new component)

**Goal**: Draw boxed message blocks with role headers.

**Actions**:
1. Modify `buildHistoryLines()` in store to emit block metadata
2. Create `packages/tui/components/MessageBlock.tsx`:
   - Use `BOX_CHARS` for borders
   - Different background for user blocks (`colors.userBg`)
   - Header with role, timestamp, duration badges
3. Replace plain `<Text>` rows in App with `MessageBlock`
4. Test border rendering and color scheme

### Task 2.2: Markdown-Aware Rendering
**Files**: `packages/tui/index.tsx` (new component), `packages/tui/components/CodeBlock.tsx`

**Goal**: Properly render fenced code blocks and markdown structure.

**Actions**:
1. Evaluate adding `marked` or `micromark` (consider bundler impact)
2. Detect fenced code blocks (```lang) in `StyledLine` pipeline
3. Create `CodeBlock` component with indentation + `colors.code` background
4. Apply theme colors for headings (`colors.header`), bold, italic
5. Indent lists for hierarchy
6. Test code block rendering and markdown formatting

### Task 2.3: Status Bar Polish
**Files**: `packages/tui/index.tsx`, `packages/tui/commands.ts`

**Goal**: Enhance status bar with colors and toggle commands.

**Actions**:
1. Render status line as fixed-width bar: `[STATE] message (duration)`
2. Use `levelColor` for background, `colors.border` for separators
3. Add `/status compact` command in `commands.ts`
4. Implement toggle logic in App component
5. Verify compact/full mode switching

---

## Phase 3: Advanced Enhancements (After Phase 2 Validated)

### Task 3.1: Diff Rendering Capability
**Files**: `packages/harness-daemon/src/harness/event_translator.ts`, `packages/tui/types.ts`, `packages/tui/components/DiffPanel.tsx`

**Goal**: Show code changes in TUI.

**Approach A (Simpler)**: End-of-run diffs
1. Modify `event_translator.ts` to attach `metadata.patch = { format: 'unified', text }` to response events
2. Detect `response.metadata.patch` in App and store via `store.setDiff(requestId, patch)`
3. Create `DiffPanel.tsx` using `diff` or `ansi-diff` package
4. Show diff below history or with `press d` toggle
5. Test with unified diff input

**Approach B (Optional)**: Live diffs
1. Add `'diff'` to `BridgeEventType` in both TUI and harness types
2. Emit diff events after edit tools complete
3. Route `diff` events to Store for streaming

### Task 3.2: Structured Intermediate Updates
**Files**: `packages/harness-daemon/src/harness/event_translator.ts`, `packages/tui/store.ts`, `packages/tui/index.tsx`

**Goal**: Show breadcrumbs like "📖 reading src/foo.ts (reason: debug z)"

**Actions**:
1. Modify `event_translator.ts` to emit `agent_progress` with `kind: 'planning'` and detail payload
2. Add `planningFeed: Array<{ text: string; timestamp: number }>` to store
3. Render sidebar or inline italic line for `kind === 'planning'` events
4. Test with file read operations

### Task 3.3: Tool Output Drill-Down (Optional)
**Files**: `packages/tui/store.ts`, `packages/tui/components/ToolOutputModal.tsx`, `packages/tui/commands.ts`

**Goal**: Allow viewing full tool logs.

**Actions**:
1. Extend Store to keep full output per request (capped at 200 lines)
2. Add `/details <requestId>` command
3. Create `ToolOutputModal.tsx` with scroll + `colors.code` styling
4. Bind `o` key to open modal on message block
5. Test modal opening and log display

---

## Validation Checklist (Complete Each Phase Before Moving On)

- [ ] Run `bun run tui` and confirm visual changes work
- [ ] Check bridge client connection/reconnect still functions
- [ ] Verify event flow through `validateBridgeEvent` still works
- [ ] Add snapshot tests for `buildHistoryLines()` if schema changed
- [ ] For Phase 3: Unit-test diff parsing with sample unified diffs
- [ ] Ensure harness schema changes are backward compatible

---

## Troubleshooting Guide

**If TUI won't start after changes**:
- Check `packages/tui/index.tsx` for syntax errors
- Verify `packages/tui/bridge_client.ts` wasn't accidentally modified
- Run `bun run build:tui` to catch build errors

**If events aren't reaching handlers**:
- Verify `validateBridgeEvent` isn't rejecting valid events
- Check `activeRuns` Set logic in bridge client
- Confirm event type is in `VALID_EVENT_TYPES`

**If colors don't apply**:
- Ensure theme tokens exist in `packages/tui/theme.ts`
- Check color usage in components matches token names
- Verify terminal supports 256 colors

**If reconnect behavior breaks**:
- Don't modify reconnection logic in `bridge_client.ts`
- Test network disconnect/reconnect cycle

---

## Output Format

For each completed task, Ralph should report:

```
## [Phase X.Y]: [Task Title]

**Status**: ✅ Complete | ⚠️ Partial | ❌ Blocked

**Files Modified**:
- `packages/tui/[file].tsx` (lines N-M)
- [other files]

**Changes Made**:
- [Brief description of what was changed]

**Testing Results**:
- [What was tested and observed]

**Next Steps**:
- [What to do next, or dependencies on other tasks]

**Issues/Questions**:
- [Any problems encountered or clarifications needed]
```

---

## Getting Started

Begin with **Task 1.1** in Phase 1. Work sequentially through the tasks. Validate each task before proceeding to the next. Report progress using the output format above.

If you encounter blockers or need clarification on any task, pause and ask for guidance before proceeding.

Good luck! 🚀
