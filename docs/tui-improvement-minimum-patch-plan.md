# TUI Improvement — Minimum Patch Plan (Color + Diff Preview)

This repo (`apps/harness-daemon`) is **not the TUI**; it’s the harness/daemon that feeds the TUI via `BridgeEvent`s.
Today the harness emits only these event types (see `apps/harness-daemon/src/harness/types.ts`):

- `ready`
- `status`
- `progress`
- `stream`
- `response`
- `user_prompt`
- `error`

The minimum-change strategy is to **add small, backwards-compatible fields/events** that the TUI can use for coloring and (optionally) diff preview.

---

## 1) Slightly better coloring (high impact, minimal surface)

### Patch 1A — Add structured `level` / `kind` fields
Right now `progress.data.message` and `status.data.message` are just strings, which makes TUI coloring brittle (regex on message text).

**Change:** extend event data types with optional machine-readable fields:

- `level?: 'info' | 'success' | 'warning' | 'error'`
- `kind?: 'work' | 'tool' | 'planning' | 'system'`

**Where to patch:**
- `apps/harness-daemon/src/harness/types.ts`
  - `ProgressEventData` → add optional `level`, `kind` (and consider `duration_ms`)
  - `StatusEventData` → add optional `level`, `kind`
  - (optional) `ErrorEventData` → add optional `code?: string`
- `apps/harness-daemon/src/harness/event_translator.ts`
  - Populate these fields in each translated event.

**Suggested mapping (cheap, effective):**
- `runtime_script_created` → `status(level='info', kind='planning')`
- `workitem_started` → `progress(level='info', kind='work')`
- `workitem_completed` → `progress(level='success', kind='work')`
- `workitem_failed` → `progress(level='error', kind='work')`
- `workitem_skipped` → `progress(level='warning', kind='work')`
- `tool_call starting` → `progress(level='info', kind='tool', tool_name=toolName)`
- `tool_call completed success=true` → `progress(level='success', kind='tool')`
- `tool_call completed success=false` → `progress(level='error', kind='tool')`

**TUI change:**
- Color by `level` and/or `kind` when present.
- Fall back to existing message parsing when absent (backwards compatible).

### Patch 1B — Don’t rely on unicode “✓/✗” as the only signal
The harness currently bakes `✓`/`✗` into the tool completion message.

**Change:** keep the message, but send `level='success'|'error'` and a dedicated duration field (e.g. `duration_ms`).

**Net effect:** TUI can show success green, failures red, and durations dim, without parsing text.

---

## 2) Diff render preview (MVP + upgrade path)

There are two viable approaches; start with the minimal one.

### Option A (most minimal): put a unified diff in `response.metadata`
**No new event type required.**

**Payload to attach:**
- `response.data.metadata.patch?: { format: 'unified', text: string }`
- optionally: `response.data.metadata.files?: string[]`

**Minimal diff generation approach:**
- If the agent response already contains fenced diff blocks (e.g. ```diff), extract them in the harness and attach as `metadata.patch`.

**TUI UX:**
- If `metadata.patch` exists: show “Press `d` to view diff” and open a diff panel.

### Option B (better UX): add a dedicated `diff` BridgeEvent
If you want a live-updating diff panel as tools edit files, add a new event type.

**Change:**
- Extend `BridgeEventType` with `'diff'`
- Add a `DiffEventData` payload:
  - `request_id: string`
  - `title?: string` (e.g. filename)
  - `unified_diff: string`
  - `is_final?: boolean`

**Emission strategy:**
- Emit a `diff` event when a file changes (ideally on successful `Edit`/`Write` tool completion).
- Compute unified diff old vs new (debounce if needed).

---

## 3) Small UX wins that cost almost nothing

### Patch 3A — Forward “dropped” events as lightweight status/progress
`event_translator.ts` currently drops:
- `llm_call`
- `goal_achieved` / `goal_not_achieved`

**Minimum improvement:**
- Forward `goal_achieved` → `status(level='success', kind='system')`
- Forward `goal_not_achieved` → `status(level='error', kind='system')`
- Optionally forward `llm_call` → `progress(level='info', kind='system', message='LLM call: provider/model…')` (short text only)

This makes runs feel more alive without changing the core TUI.

### Patch 3B — Standardize status transitions: `sending` → `streaming` → `idle`
You already have `status.state: 'idle'|'sending'|'streaming'|'error'`.

**Change:**
- Set `streaming` when the first `stream` chunk is emitted.
- Return to `idle` after `response`.

---

## Recommended implementation order (smallest patches first)

1. **Add `level/kind` optional fields** to `ProgressEventData`/`StatusEventData` and populate them in `translateAgentEvent`.
2. **Forward goal terminal events** (`goal_achieved`, `goal_not_achieved`) as `status`.
3. **Diff MVP:** attach extracted diff blocks to `response.metadata.patch`.
4. Upgrade to **`diff` BridgeEvent** only if you want live diff preview.

---

## Decision point (affects diff approach)
Choose one:

- **A — End-of-run diff only** (simpler): `response.metadata.patch`
- **B — Live diff updates** (richer): new `diff` event + diff generation on tool edits
