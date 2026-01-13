# Dashboard Compact Redesign Spec

## Philosophy

Grant power in orchestration. Make it as easy as possible to maneuver through sessions with everything visible at a glance - no collapse/expand needed.

---

## Layout Architecture

### Sidebar (Left)
- **Purpose**: View-only access to historical sessions
- **Content**: Latest ~10 sessions in compact, square list format
- **Display per item**:
  - Session description (truncated)
  - Session ID in finer print
  - Datetime indicator
- **Behavior**: Clicking opens a session summary view (does NOT add to stage)
- **Visual**: Historical sessions only; active sessions live on the stage

### Stage (Center)
- **Purpose**: Live orchestration view of all active sessions
- **Layout**: Horizontal flex-wrap (cards flow left-to-right, wrap to next row)
- **Content**: All sessions with `state === 'active'` auto-appear here
- **Empty state**: "No active sessions" message

---

## Session Card Design (Stage)

### Goals
- Compact, minimalist, almost 0 margin/padding
- No collapse/expand - everything visible
- Full TurnTable columns per LLM step

### Card Structure
```
┌─────────────────────────────────────────────────────────┐
│ [status] Session ID  │  Description  │  Datetime       │
├─────────────────────────────────────────────────────────┤
│ # │ Agent │ Model │ Rd │ Wr │ Ed │ Bsh │ ... │ In │ Out │
│ 1 │ main  │ son.. │  2 │  - │  1 │  -  │     │ 1k │ 500 │
│ 2 │ main  │ son.. │  - │  1 │  - │  2  │     │ 2k │ 1k  │
│ ...                                                     │
└─────────────────────────────────────────────────────────┘
```

### Columns (Full TurnTable)
- Turn number (#)
- Agent type
- Model (shortened)
- Tool counts: Read, Write, Edit, Bash, Grep, Glob, Task, WebFetch, WebSearch, TodoWrite, AskUserQuestion, NotebookEdit
- Input tokens
- Output tokens
- Latency

---

## Live Events Subscription

### Architecture (Mirrors TUI)

**Transport**: TCP socket to Event Bus (NOT WebSocket/SSE)
**Format**: JSONL (JSON Lines)
**Default**: `127.0.0.1:9555` (configurable via `EVENT_BUS_HOST`, `EVENT_BUS_PORT`)

### Key Packages
- `@comms-bus/bus_client.ts` - TCP client for bus connection
- `@comms-bus/bus_types.ts` - Message type definitions

### Subscription Channels
```typescript
// Subscribe to session-level events
`session:{sessionKey}`

// Subscribe to per-request events during execution
`run:{requestId}`
```

### Bus Protocol
```typescript
// Client → Server
{ type: 'subscribe'; channel: string }
{ type: 'unsubscribe'; channel: string }
{ type: 'publish'; channel: string; payload: unknown }

// Server → Client
{ type: 'event'; channel: string; payload: unknown }
{ type: 'error'; message: string; detail?: unknown }
```

### Event Types to Handle
| Event Type | Purpose |
|------------|---------|
| `ready` | Session initialized |
| `status` | State changes (idle, sending, streaming, error) |
| `progress` | Work progress, tool calls |
| `stream` | Token streaming chunks |
| `response` | Final response |
| `error` | Errors |

### Key Event Data Structures

**StatusData**:
```typescript
{
  state?: 'idle' | 'sending' | 'streaming' | 'error'
  message?: string
  level?: 'info' | 'success' | 'warning' | 'error'
  kind?: 'work' | 'tool' | 'planning' | 'system'
}
```

**ProgressData**:
```typescript
{
  request_id?: string
  message?: string
  tool_name?: string
  step_number?: number
  duration_ms?: number
}
```

**StreamData**:
```typescript
{
  request_id: string
  chunk: string
  is_final?: boolean
}
```

### Update Behavior
- No fancy animations (no pulsing, blinking)
- Just update the data in place as events arrive
- Token counts update in real-time
- New LLM calls appear as new rows
- Tool calls update the counts in the current turn

---

## Design Decisions Summary

| Decision | Choice |
|----------|--------|
| Sidebar click behavior | View-only (shows summary, not added to stage) |
| Active sessions on stage | Automatic (no manual action needed) |
| Stage layout | Horizontal flex-wrap |
| Session card columns | Full TurnTable (all tool columns) |
| Live event animations | None - just data updates |
| Historical sessions | Remain in sidebar |
| Active sessions | On stage only (not in sidebar) |
| Empty stage | "No active sessions" message |
| Event subscription | TCP/JSONL via Event Bus (same as TUI) |

---

## Implementation Plan

### Phase 1: Layout Structure
1. Restructure `App.tsx` with sidebar + stage layout
2. Create `Sidebar` component with compact session list
3. Create `Stage` component with flex-wrap container
4. Create `SessionCard` component (compact, no expand)

### Phase 2: Event Subscription
1. Create `useEventBus` hook (TCP client to bus)
2. Subscribe to session channels for active sessions
3. Subscribe to run channels for live request updates
4. Update session state in real-time from events

### Phase 3: Session Card Content
1. Adapt `TurnTable` for inline card use (no nesting)
2. Show all turns as rows within the card
3. Live-update rows as LLM calls complete

### Phase 4: Sidebar Session Summary
1. Create `SessionSummary` modal/panel component
2. Show full session details when sidebar item clicked
3. Include historical request data and stats

---

## File Structure (Proposed)

```
src/
├── App.tsx                    # Main layout (sidebar + stage)
├── components/
│   ├── Sidebar.tsx           # Session list sidebar
│   ├── SidebarItem.tsx       # Compact session preview
│   ├── Stage.tsx             # Active sessions container
│   ├── SessionCard.tsx       # Live session card with turns
│   ├── SessionSummary.tsx    # Full session view (on click)
│   ├── TurnRow.tsx           # Single LLM turn row
│   └── StatusDot.tsx         # (existing)
├── hooks/
│   ├── useSessions.ts        # (existing - for initial load)
│   ├── useEventBus.ts        # NEW - TCP event subscription
│   └── useSessionState.ts    # NEW - merge HTTP + events
└── compact.css               # Updated styles
```
