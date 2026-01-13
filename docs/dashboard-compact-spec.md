# Compact Dashboard Implementation Spec

## Overview

A lightweight, dense dashboard variant for viewing agent sessions. Designed for minimal bundle size and maximum information density.

## Architecture

### Separate App
Location: `apps/dashboard-compact/`

Rationale:
- Fundamentally different UI paradigm (tables vs nested cards)
- Independent bundle optimization
- Shared types/API imported from existing dashboard via aliases

### Shared Code
Import from `apps/dashboard/src/` via Vite aliases:
- `domain/models.ts` - Types
- `lib/api.ts` - GraphD client
- `lib/mappers.ts` - Data transformation
- `lib/time.ts` - Duration formatting

---

## Data Layer Changes

### 1. SessionInsights Extension

**File:** `apps/dashboard/src/domain/models.ts`

Add to `SessionInsights` type:
```typescript
export type SessionInsights = {
  // ... existing fields
  totalInputTokens: number;   // Sum of all request prompt tokens
  totalOutputTokens: number;  // Sum of all request completion tokens
};
```

Update `computeSessionInsights()`:
```typescript
// Add after avgQuality computation
let totalInputTokens = 0;
let totalOutputTokens = 0;
for (const r of s.requests) {
  for (const call of r.llmCalls) {
    totalInputTokens += call.promptTokens;
    totalOutputTokens += call.completionTokens;
  }
}

return {
  // ... existing return fields
  totalInputTokens,
  totalOutputTokens,
};
```

### 2. Session Description

**File:** `apps/dashboard/src/lib/mappers.ts`

In `mapGraphDSession()`, extract description from first request:
```typescript
// After requests are parsed
const description = meta.description
  ?? (requests[0]?.userInput?.slice(0, 80) || undefined);

const partialSession = {
  // ... existing fields
  meta: {
    // ... existing meta
    description,
  },
};
```

---

## App Structure

```
apps/dashboard-compact/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── compact.css
    ├── hooks/
    │   └── useSessions.ts
    └── components/
        ├── SessionTable.tsx
        ├── SessionRow.tsx
        └── TurnTable.tsx
```

---

## Component Specs

### SessionTable

Main landing view - table of all sessions.

**Columns:**
| Column | Width | Content |
|--------|-------|---------|
| Status | 24px | Colored dot (active/idle/ended/error) |
| ID | 80px | First 8 chars of session key |
| Description | flex | First request's userInput (truncated) |
| Reqs | 48px | Request count |
| In Tok | 72px | Total input tokens (formatted) |
| Out Tok | 72px | Total output tokens (formatted) |
| Duration | 64px | Session duration |

**Behavior:**
- Click row to expand inline detail (request list)
- Hover highlight on rows
- Sort by most recent first

**Code:**
```tsx
interface SessionTableProps {
  sessions: Session[];
  loading: boolean;
}

function SessionTable({ sessions, loading }: SessionTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <table className="w-full">
      <thead>
        <tr className="text-left text-muted border-b border-border">
          <th className="py-1 px-2 w-6"></th>
          <th className="py-1 px-2">ID</th>
          <th className="py-1 px-2">Description</th>
          <th className="py-1 px-2 text-right">Reqs</th>
          <th className="py-1 px-2 text-right">In Tok</th>
          <th className="py-1 px-2 text-right">Out Tok</th>
          <th className="py-1 px-2 text-right">Duration</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map(session => (
          <SessionRow
            key={session.id}
            session={session}
            expanded={expandedId === session.id}
            onToggle={() => setExpandedId(
              expandedId === session.id ? null : session.id
            )}
          />
        ))}
      </tbody>
    </table>
  );
}
```

### SessionRow

Individual session row with expandable detail.

**Code:**
```tsx
interface SessionRowProps {
  session: Session;
  expanded: boolean;
  onToggle: () => void;
}

function SessionRow({ session, expanded, onToggle }: SessionRowProps) {
  const { insights, meta } = session;
  const shortId = session.id.slice(0, 8);
  const description = meta.description || session.requests[0]?.userInput || '-';

  return (
    <>
      <tr
        onClick={onToggle}
        className="hover:bg-hover cursor-pointer border-b border-border"
      >
        <td className="py-1 px-2">
          <StatusDot status={session.state} />
        </td>
        <td className="py-1 px-2 font-mono text-xs">{shortId}</td>
        <td className="py-1 px-2 truncate max-w-xs">{description}</td>
        <td className="py-1 px-2 text-right tabular-nums">{insights.requestCount}</td>
        <td className="py-1 px-2 text-right tabular-nums text-cyan">
          {formatTokens(insights.totalInputTokens)}
        </td>
        <td className="py-1 px-2 text-right tabular-nums text-green">
          {formatTokens(insights.totalOutputTokens)}
        </td>
        <td className="py-1 px-2 text-right tabular-nums">
          {formatDuration(insights.durationMs)}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="p-0">
            <div className="bg-elevated border-b border-border p-2">
              {session.requests.map((req, i) => (
                <RequestDetail key={req.id} request={req} index={i} />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
```

### TurnTable

Dense grid showing LLM calls with tool counts per turn.

**Fixed Tool Columns:**
Based on registered tools in the system:
- `Read`
- `Write`
- `Edit`
- `Bash`
- `Grep`
- `Glob`
- `Task`
- `WebFetch`
- `WebSearch`
- `TodoWrite`
- `AskUserQuestion`
- `NotebookEdit`

**Table Structure:**
| # | Agent | Model | Read | Write | Edit | Bash | Grep | Glob | Task | ... | In | Out | Latency |
|---|-------|-------|------|-------|------|------|------|------|------|-----|-----|-----|---------|

**Data Computation:**
```typescript
const TOOL_COLUMNS = [
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
  'Task', 'WebFetch', 'WebSearch', 'TodoWrite',
  'AskUserQuestion', 'NotebookEdit'
] as const;

interface TurnRow {
  turnIndex: number;
  llmCall: LLMCall;
  toolCounts: Record<string, number>;
}

function computeTurns(llmCalls: LLMCall[], toolCalls: ToolCall[]): TurnRow[] {
  // Merge and sort by timestamp
  type Event =
    | { type: 'llm'; data: LLMCall; ts: number }
    | { type: 'tool'; data: ToolCall; ts: number };

  const events: Event[] = [
    ...llmCalls.map(c => ({
      type: 'llm' as const,
      data: c,
      ts: new Date(c.timestamp).getTime()
    })),
    ...toolCalls.map(c => ({
      type: 'tool' as const,
      data: c,
      ts: new Date(c.timestamp).getTime()
    })),
  ].sort((a, b) => a.ts - b.ts);

  const turns: TurnRow[] = [];
  let current: TurnRow | null = null;

  for (const event of events) {
    if (event.type === 'llm') {
      if (current) turns.push(current);
      current = {
        turnIndex: turns.length,
        llmCall: event.data,
        toolCounts: Object.fromEntries(TOOL_COLUMNS.map(t => [t, 0])),
      };
    } else if (current) {
      const name = event.data.toolName;
      if (name in current.toolCounts) {
        current.toolCounts[name]++;
      }
    }
  }
  if (current) turns.push(current);

  return turns;
}
```

**Component:**
```tsx
interface TurnTableProps {
  llmCalls: LLMCall[];
  toolCalls: ToolCall[];
}

function TurnTable({ llmCalls, toolCalls }: TurnTableProps) {
  const turns = useMemo(
    () => computeTurns(llmCalls, toolCalls),
    [llmCalls, toolCalls]
  );

  // Determine which tool columns have any usage
  const usedTools = useMemo(() => {
    const used = new Set<string>();
    for (const turn of turns) {
      for (const [tool, count] of Object.entries(turn.toolCounts)) {
        if (count > 0) used.add(tool);
      }
    }
    return TOOL_COLUMNS.filter(t => used.has(t));
  }, [turns]);

  return (
    <table className="w-full text-xs font-mono">
      <thead className="text-left text-muted border-b border-border">
        <tr>
          <th className="py-1 px-1">#</th>
          <th className="py-1 px-1">Agent</th>
          <th className="py-1 px-1">Model</th>
          {usedTools.map(tool => (
            <th key={tool} className="py-1 px-1 text-center">{tool}</th>
          ))}
          <th className="py-1 px-1 text-right">In</th>
          <th className="py-1 px-1 text-right">Out</th>
          <th className="py-1 px-1 text-right">Latency</th>
        </tr>
      </thead>
      <tbody>
        {turns.map(turn => (
          <tr key={turn.llmCall.id} className="border-b border-border">
            <td className="py-1 px-1 text-muted">{turn.turnIndex + 1}</td>
            <td className="py-1 px-1">{turn.llmCall.agentType}</td>
            <td className="py-1 px-1 text-muted">{turn.llmCall.model}</td>
            {usedTools.map(tool => (
              <td key={tool} className="py-1 px-1 text-center">
                {turn.toolCounts[tool] || '-'}
              </td>
            ))}
            <td className="py-1 px-1 text-right text-cyan">
              {turn.llmCall.promptTokens.toLocaleString()}
            </td>
            <td className="py-1 px-1 text-right text-green">
              {turn.llmCall.completionTokens.toLocaleString()}
            </td>
            <td className="py-1 px-1 text-right">
              {formatDuration(turn.llmCall.durationMs)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

---

## Styling

### CSS Variables
```css
:root {
  --bg: #09090b;
  --bg-hover: #18181b;
  --bg-elevated: #0f0f11;
  --border: #27272a;
  --text: #fafafa;
  --muted: #71717a;
  --cyan: #22d3ee;
  --green: #4ade80;
  --red: #f87171;
  --yellow: #facc15;
}
```

### Base Styles
```css
body {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  background: var(--bg);
  color: var(--text);
  margin: 0;
}

table {
  border-collapse: collapse;
  width: 100%;
}

th, td {
  padding: 4px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

tr:hover {
  background: var(--bg-hover);
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

.text-muted { color: var(--muted); }
.text-cyan { color: var(--cyan); }
.text-green { color: var(--green); }
.text-red { color: var(--red); }
```

---

## Build Configuration

### package.json
```json
{
  "name": "dashboard-compact",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.1.1",
    "typescript": "~5.9.3",
    "vite": "^7.2.4"
  }
}
```

### vite.config.ts
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../dashboard/src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9444',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "paths": {
      "@shared/*": ["../dashboard/src/*"]
    }
  },
  "include": ["src"]
}
```

---

## Token Formatting Helper

```typescript
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
```

---

## Bundle Size Target

- Total gzipped: <50KB
- React + ReactDOM: ~45KB gzipped (unavoidable)
- App code: <5KB gzipped

Strategies:
- No Tailwind (pure CSS)
- System font stack
- No animations
- Single chunk bundle
- Tree-shake unused code

---

## Verification Steps

1. `cd apps/dashboard-compact && npm install && npm run build`
2. Check `dist/` size: `gzip -c dist/assets/*.js | wc -c`
3. Start GraphD: `npm run graphd` (from root)
4. Preview: `npm run preview`
5. Test:
   - Sessions load in table
   - Click row expands to show requests
   - Click request shows TurnTable
   - Token totals match sum of request tokens
   - Tool counts accurate per turn
