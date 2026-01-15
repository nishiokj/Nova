# TUI Improvement Implementation Plan

**Goal:** Modernize the terminal UI so sessions feel readable and informative. The plan below maps each UX concern to concrete engineering work, grouped from quick wins to advanced upgrades.

## Repository Context
- **packages/tui/index.tsx** – App component, event handlers (`handleProgress`, `handleResponse`, etc.), rendering pipeline.
- **packages/tui/store.ts** – Central state + `buildHistoryLines()` used to render history text.
- **packages/tui/theme.ts** – Theme catalog; currently under-used for hierarchy cues.
- **packages/harness-daemon/src/harness/event_translator.ts** – Emits BridgeEvents; enrich here for smarter UI rendering.
- **docs/tui-improvement-minimum-patch-plan.md** – Prior work describing `level`/`kind` metadata and diff event ideas.

---
## Phase 1 – Quick Wins (≈ 0.5–1 day)
Focus: remove noise, add lightweight feedback, reuse existing color tokens.

### 1. Filter low-value system chatter
**Problem:** “Indexing files for autocomplete…” and similar boilerplate consume vertical space.

**Changes**
- `packages/tui/index.tsx`: wrap initial autocomplete status messages with a `showSystemMessage` guard.
- `packages/tui/store.ts`: add helper `addSystemMessage(message: string, opts?: { muted?: boolean })` that skips duplicates or suppressed phrases.

```ts
// index.tsx
const shouldSurfaceSystemMessage = (text: string) => !/Indexing files/i.test(text);
...
if (shouldSurfaceSystemMessage(msg)) {
  store.addMessage('system', msg);
}
```

**Dependencies:** none.

**Effort:** S.

### 2. One-line tool call summaries
**Problem:** Tool outputs stream entire logs; we only need status + key args.

**Changes**
- `packages/tui/index.tsx > handleProgress`: collapse tool payloads before dispatching to the store (truncate to 1 line, append ✔/✖ or the `level` color).
- `packages/tui/store.ts`: track `progressLevel`/`progressKind` (already present) and expose `getProgressBadge()` for renderer.

```ts
const summarize = (text: string, max = 80) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
...
const statusIcon = level === 'success' ? '✔' : level === 'error' ? '✖' : '•';
store.setProgress(`${statusIcon} ${toolName ?? ''} ${summarize(message)}`.trim(), level, kind);
```

**Renderer hook** (`index.tsx` around line ~1460): replace `statusLine` with
`const statusLine = store.progressSummary() ?? snapshot.statusMessage;` and colorize via `levelColor(snapshot.progressLevel)`.

**Dependencies:** relies on optional `level/kind` fields already emitted from harness.

**Effort:** S.

### 3. Surface intermediate agent updates in history
**Problem:** Users do not see “thinking” updates (e.g., “reading foo.ts”). Progress bar disappears once completed.

**Changes**
- `packages/tui/index.tsx`: when `data.kind` is `planning` or `thinking`, call `store.addMessage('status', ...)` instead of transient progress.
- `packages/tui/store.ts`: extend `addMessage` to de-duplicate consecutive identical status lines (avoid spam) and tag them with timestamps.

```ts
if ((data.kind === 'planning' || data.kind === 'thinking') && data.message) {
  store.addMessage('status', data.message, undefined, data.request_id);
  return;
}
```

**Dependencies:** requires harness to send `kind: 'planning' | 'thinking'` (per minimum patch plan).

**Effort:** S.

### 4. Basic syntax color cues (expand existing parser)
**Problem:** Text wall lacks hierarchy despite available theme tokens.

**Changes**
- `packages/tui/index.tsx > syntaxPatterns`: add more targeted regexes (list bullets, diff +/- prefixes, timestamps) and reuse `colors.header/bold/path/code` to create visual anchors.
- Highlight role prefixes (`You:`, `Agent:`) by wrapping them in `<Text color={colors.accent} bold>` before passing to `StyledLine`.

**Effort:** S-M.

---
## Phase 2 – Medium Complexity (≈ 1–2 days)
Focus: structural layout improvements and richer formatting.

### 5. Message framing & visual hierarchy
**Problem:** Chat history is a flat list; no separation between turns or metadata (tools, durations, diffs).

**Changes**
- `packages/tui/store.ts > buildHistoryLines`: emit metadata about block start/end so renderer can draw boxes.
- `packages/tui/index.tsx`: replace plain `<Text>` history rows with a `MessageBlock` component that:
  - Draws borders using `BOX_CHARS` (already defined in `types.ts`).
  - Gives user blocks a different background (`colors.userBg`).
  - Shows a top line with role, timestamp, duration badges.
- Add `components/MessageBlock.tsx` to keep App lean.

```tsx
// MessageBlock.tsx
export function MessageBlock({ entry }: { entry: MessageEntry }) {
  const colors = getColors();
  return (
    <Box borderStyle="round" borderColor={roleColor(entry.role)}>
      <Text color={colors.accent} bold>{roleLabel(entry.role)}</Text>
      <StyledLine text={entry.text} baseColor={colors.text} />
    </Box>
  );
}
```

**Dependencies:** Phase 1 de-duplication (less noise) keeps framing tight.

**Effort:** M.

### 6. Markdown-aware rendering
**Problem:** Current regex approach strips formatting inconsistently and double-renders fences.

**Changes**
- Introduce a lightweight markdown tokenizer (e.g., `marked` or `micromark` in `packages/tui` – keep bundler impact in mind) or extend existing regex pipeline to tag block types.
- `packages/tui/index.tsx`: detect fenced code blocks and render via a `CodeBlock` component with indentation + `colors.code` background.
- Use `colors.header/bold/italic` for headings and emphasis, and indent lists for hierarchy.

**Effort:** M.

### 7. Status/system panel polish
**Problem:** Status bar is just text; we can leverage theme colors for clarity.

**Changes**
- In `index.tsx`, render the status line inside a fixed-width bar (e.g., `[STATE] message (duration)`), using `levelColor` for background and `colors.border` for separators.
- Allow toggling compact/full status with `/status compact` (add command parser entry in `packages/tui/commands.ts`).

**Dependencies:** uses `Store.progressLevel` from Phase 1.

**Effort:** M.

---
## Phase 3 – Advanced Enhancements (≈ 2–3 days)
Focus: diff visualization + deeper agent telemetry.

### 8. Diff rendering capability
**Problem:** Users can’t inspect changes inside the TUI.

**Approach A – End-of-run diffs (simpler)**
- `packages/harness-daemon/src/harness/event_translator.ts`: when final agent response contains ```diff blocks or when edit tools run, attach `metadata.patch = { format: 'unified', text }` to the `response` event (per minimum patch plan).
- `packages/tui/index.tsx`: detect `response.metadata.patch` and store in `Store` (new `setDiff(requestId, patch)` API).
- Add `components/DiffPanel.tsx` (use `diff` or `ansi-diff` packages or manual parsing) and show it either below the history or in a toggleable split view (`press d`).

**Approach B – Live diffs (optional upgrade)**
- Extend `BridgeEventType` with `'diff'` (both harness types + TUI `types.ts`). Emit after each edit tool completes (`Edit`, `Write`).
- `App.handleBridgeEvent`: route `diff` events to Store for streaming display.

**Dependencies:** finalize event schema in `packages/tui/types.ts` & harness `types.ts` together.

**Effort:** M-L depending on approach.

### 9. Structured intermediate updates (“Agent is reading X”)
**Problem:** Need explicit “reading/analysis” breadcrumbs beyond text heuristics.

**Changes**
- Harness (`event_translator.ts`): forward `agent_progress` with `kind: 'planning'` and attach a `detail` payload like `{ action: 'read_file', target: 'src/foo.ts' }`.
- `packages/tui/store.ts`: add `planningFeed: Array<{ text: string; timestamp: number }>`.
- `packages/tui/index.tsx`: render a narrow sidebar or inline italic line whenever `kind === 'planning'` to show “📖 reading src/foo.ts (reason: debug z)”.

**Effort:** M.

### 10. Tool output drill-down (optional advanced)
**Problem:** After truncation, users might still need raw output.

**Changes**
- Extend `Store` to keep full output per request (capped, e.g., 200 lines) and expose `/details <requestId>` command.
- Add `components/ToolOutputModal.tsx` that opens when user presses `o` on a message block, showing truncated log with scroll + `colors.code` styling.

**Dependencies:** builds on Phase 1 truncation + Phase 2 message framing for selection focus.

**Effort:** M.

---
## Dependencies & Ordering Summary
1. **Phase 1** must land first to reduce noise and ensure `level/kind` metadata is honored (foundation for later coloring).
2. **Phase 2** assumes cleaner history + status metadata to render richer blocks without overwhelming the user.
3. **Phase 3** requires new harness metadata (`metadata.patch`, optional `diff` events, richer `agent_progress` payloads). Coordinate schema changes between `packages/tui/types.ts` and `packages/harness-daemon/src/harness/types.ts`.

---
## Effort Table
| Phase | Scope | Est. Effort |
|-------|-------|-------------|
| Phase 1 | Message filtering, tool summary, lightweight syntax cues | 0.5–1 day |
| Phase 2 | Message framing, markdown-aware rendering, status bar polish | 1–2 days |
| Phase 3 | Diff viewer, structured planning feed, optional tool log modal | 2–3 days |

---
## Validation Checklist (for future implementation)
- Run `bun run tui` locally and confirm filtered system messages + colored progress badges.
- Add snapshot tests for `buildHistoryLines()` to ensure block metadata is stable.
- Unit-test diff parsing (feed sample unified diff strings, assert panel rendering colors + +/- markers).
- Ensure harness schema changes remain backward compatible by keeping fields optional and gating new UI on their presence.
