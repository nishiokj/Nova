# Context Window Refactor - Surgical Plan

## Design Principle: Match the Responses API Input Model

The OpenAI Responses API `input` field is an **array of heterogeneous items**, NOT just messages:

```typescript
// From OpenAI Responses API spec
input: [
  { type: 'message', role: 'user', content: [...] },
  { type: 'function_call', call_id: '...', name: '...', arguments: '...' },
  { type: 'function_call_output', call_id: '...', output: '...' },
  { type: 'reasoning', content: '...' },
  // etc.
]
```

**Our ContextWindow.items IS the input array.** We canonicalize around item types.

---

## Canonical Item Types

```typescript
// types/context.ts - THE canonical types

/** Item types that can exist in a context window */
export type ContextItemType =
  | 'message'              // User/assistant/system messages
  | 'function_call'        // Tool invocation by model
  | 'function_call_output' // Result of tool execution
  | 'reasoning'            // Chain of thought (from reasoning models)
  | 'file_content';        // File loaded into context

/** Message item - user, assistant, system, or developer message */
export interface MessageItem {
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ContentBlock[];
  timestamp?: number;
}

/** Function call item - model wants to call a tool */
export interface FunctionCallItem {
  type: 'function_call';
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  timestamp?: number;
}

/** Function call output - result from tool execution */
export interface FunctionCallOutputItem {
  type: 'function_call_output';
  callId: string;
  output: string;
  isError?: boolean;
  durationMs?: number;
  timestamp?: number;
}

/** Reasoning item - chain of thought from reasoning models */
export interface ReasoningItem {
  type: 'reasoning';
  content: string;
  timestamp?: number;
}

/** File content item - file loaded into context */
export interface FileContentItem {
  type: 'file_content';
  path: string;
  content: string;
  language?: string;
  timestamp?: number;
}

/** Union of all context item types */
export type ContextItem =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem
  | FileContentItem;
```

---

## Target Architecture: ContextWindow Class

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ContextWindow                               │
│  Location: types/context.ts (NEW - replaces wizard/context.ts)      │
├─────────────────────────────────────────────────────────────────────┤
│  IDENTITY                                                           │
│  ├─ sessionKey: string                                              │
│  └─ maxTokens: number                                               │
├─────────────────────────────────────────────────────────────────────┤
│  STATE (single-writer: Harness owns, passes to Agent)               │
│  ├─ items: ContextItem[]       // THE source of truth               │
│  ├─ readFiles: Set<string>     // Derived from file_content items   │
│  ├─ metrics: ContextWindowMetrics                                   │
│  └─ version: number            // Increments on mutation            │
├─────────────────────────────────────────────────────────────────────┤
│  MUTATION METHODS                                                   │
│  ├─ addMessage(role, content): void                                 │
│  ├─ addFunctionCall(callId, name, args): void                       │
│  ├─ addFunctionCallOutput(callId, output, isError?): void           │
│  ├─ addReasoning(content): void                                     │
│  ├─ addFileContent(path, content, language?): void                  │
│  └─ updateMetrics(promptTokens, completionTokens): void             │
├─────────────────────────────────────────────────────────────────────┤
│  QUERY METHODS                                                      │
│  ├─ getItems(): readonly ContextItem[]                              │
│  ├─ getItemsForLLM(): Array<Record<string,unknown>>  // API format  │
│  ├─ hasReadFile(path): boolean                                      │
│  ├─ getMetrics(): ContextWindowMetrics                              │
│  └─ getItemsByType<T>(type): T[]                                    │
├─────────────────────────────────────────────────────────────────────┤
│  PERSISTENCE                                                        │
│  ├─ serialize(): ContextWindowSnapshot                              │
│  ├─ static deserialize(snapshot): ContextWindow                     │
│  └─ toTelemetry(): ContextWindowTelemetry                           │
└─────────────────────────────────────────────────────────────────────┘
```

### Persistence Flow

```
Session Start (Harness.run):
┌─────────────────────────────────────────────────────────────────────┐
│  1. Check GraphD for existing session                               │
│  2. If exists: contextGet(sessionKey) → ContextWindow.deserialize() │
│  3. If new: new ContextWindow(sessionKey, goal, maxTokens)          │
│  4. Pass ContextWindow to Agent.run()                               │
└─────────────────────────────────────────────────────────────────────┘

During Execution:
┌─────────────────────────────────────────────────────────────────────┐
│  Worker calls context.addMessage() / context.addToolResult()        │
│  Worker calls context.markFileRead() after successful reads         │
│  Worker calls context.updateMetrics() after LLM responses           │
│  → All mutations tracked, metrics updated automatically             │
└─────────────────────────────────────────────────────────────────────┘

Request End (Harness.run finally):
┌─────────────────────────────────────────────────────────────────────┐
│  1. contextSave(sessionKey, context.serialize())                    │
│  2. Snapshot includes: messages, readFiles, metrics                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Surgical Changes

### File: `types/context.ts` (NEW - creates the class)

This is the ONLY new file. It replaces `wizard/context.ts`.

```typescript
// types/context.ts
import type { Message, ContentBlock, ToolResultContentBlock } from './llm.js';
import type { ContextWindowMetrics } from './session.js';

export interface ContextWindowSnapshot {
  sessionKey: string;
  goal: string;
  maxTokens: number;
  messages: Message[];
  readFiles: string[];
  metrics: ContextWindowMetrics;
  version: number;
}

export class ContextWindow {
  readonly sessionKey: string;
  readonly goal: string;
  readonly maxTokens: number;

  private _messages: Message[] = [];
  private _readFiles = new Set<string>();
  private _metrics: ContextWindowMetrics;
  private _version = 0;

  constructor(sessionKey: string, goal: string, maxTokens = 200_000) { ... }

  // Mutation methods
  addMessage(msg: Message, estimatedTokens?: number): void { ... }
  addToolResult(callId: string, result: string, isError = false): void { ... }
  markFileRead(path: string): void { ... }
  updateMetrics(promptTokens: number, completionTokens: number): void { ... }

  // Query methods
  get messages(): readonly Message[] { return this._messages; }
  get readFiles(): ReadonlySet<string> { return this._readFiles; }
  get metrics(): Readonly<ContextWindowMetrics> { return this._metrics; }
  get version(): number { return this._version; }
  hasReadFile(path: string): boolean { return this._readFiles.has(path); }
  getMessagesForLLM(): Message[] { ... }

  // Persistence
  serialize(): ContextWindowSnapshot { ... }
  static deserialize(snapshot: ContextWindowSnapshot): ContextWindow { ... }

  // Telemetry
  toTelemetry(): ContextWindowTelemetry { ... }
}
```

### File: `wizard/context.ts` (DELETE most, keep buildSystemMessage)

**KEEP:**
- `buildSystemMessage()` - needed by Worker

**DELETE:**
- `ContextDelta` interface
- `createContextDelta()`
- `addDeltaMessage()`
- `mergeMessages()`
- `ContextWindow` interface
- `createContextWindow()`
- `buildFilesMessage()`
- `getContextMessages()`

### File: `wizard/worker.ts` (MODIFY)

**Changes:**
```typescript
// BEFORE
import { createContextDelta, addDeltaMessage, mergeMessages } from './context.js';
const delta = createContextDelta();
addDeltaMessage(delta, { role: 'assistant', content: ... });
const messages = mergeMessages(baseContext.messages, delta);

// AFTER
// Worker receives ContextWindow, mutates it directly
context.addMessage({ role: 'assistant', content: ... });
const messages = context.getMessagesForLLM();
```

### File: `wizard/wizard.ts` (MODIFY)

**Changes:**
- Receives `ContextWindow` instead of `Partial<ContextWindow>`
- Passes same instance to Worker (single source of truth)
- No more `createContextWindow()` per step

### File: `agent/agent.ts` (MODIFY)

**DELETE:**
```typescript
export interface SessionContext {
  messages: Array<Record<string, unknown>>;
  readFiles: Set<string>;
}
```

**Changes:**
- Receives `ContextWindow` from Harness
- Passes to Wizard directly

### File: `harness/harness.ts` (MODIFY)

**DELETE:**
```typescript
private sessionStates = new Map<string, SessionContext>();
private getSessionState(sessionKey: string): SessionContext { ... }
```

**ADD:**
```typescript
private async getOrCreateContext(sessionKey: string, goal: string): Promise<ContextWindow> {
  // Try to load from GraphD
  if (this.graphd && this.graphdStarted) {
    const result = this.graphd.contextGet(sessionKey);
    if (result.snapshot?.context) {
      return ContextWindow.deserialize(result.snapshot.context);
    }
  }
  // Create new
  return new ContextWindow(sessionKey, goal, this.config.agent.maxContextTokens ?? 200_000);
}

private persistContext(context: ContextWindow): void {
  if (this.graphd && this.graphdStarted) {
    this.graphd.contextSave(context.sessionKey, context.serialize());
  }
}
```

### File: `types/index.ts` (MODIFY)

**ADD:**
```typescript
export { ContextWindow, type ContextWindowSnapshot, type ContextWindowTelemetry } from './context.js';
```

### File: `src/agent-ts/index.ts` (MODIFY)

**DELETE these re-exports:**
```typescript
export {
  type ContextDelta as WizardContextDelta,
  createContextDelta as createWizardContextDelta,
  addDeltaMessage,
  mergeMessages,
  createContextWindow,
  buildFilesMessage,
  getContextMessages,
} from './wizard/index.js';
```

**KEEP:**
```typescript
export { buildSystemMessage } from './wizard/index.js';
export { ContextWindow, type ContextWindowSnapshot } from './types/index.js';
```

---

## Telemetry Event

New event type for dashboard visibility:

```typescript
// types/events.ts - ADD
export interface ContextWindowTelemetryData {
  sessionKey: string;
  goal: string;
  messageCount: number;
  readFilesCount: number;
  contextTokens: number;
  outputTokens: number;
  maxTokens: number;
  percentageUsed: number;
  version: number;
  // For inspection
  recentMessages?: Array<{ role: string; preview: string; tokenEstimate: number }>;
  readFilesList?: string[];
}
```

Emitted:
1. On context creation/hydration
2. After each message added
3. After metrics update (LLM response received)

---

## Execution Order

1. **Create `types/context.ts`** - The new ContextWindow class
2. **Update `types/index.ts`** - Export new class
3. **Update `types/events.ts`** - Add telemetry event type
4. **Gut `wizard/context.ts`** - Keep only `buildSystemMessage`
5. **Update `wizard/worker.ts`** - Use ContextWindow methods
6. **Update `wizard/wizard.ts`** - Pass ContextWindow through
7. **Update `agent/agent.ts`** - Remove SessionContext, use ContextWindow
8. **Update `harness/harness.ts`** - Add persistence/hydration
9. **Update `src/agent-ts/index.ts`** - Clean up exports
10. **Delete dead code** - Remove unused functions from wizard/index.ts

---

## What Gets Deleted

| File | Deleted Code |
|------|-------------|
| `wizard/context.ts` | ~100 lines (keep ~25 for buildSystemMessage) |
| `agent/agent.ts` | `SessionContext` interface (~5 lines) |
| `harness/harness.ts` | `sessionStates` Map, `getSessionState()` (~15 lines) |
| `src/agent-ts/index.ts` | 8 re-exports |
| `wizard/index.ts` | 6 re-exports |

**Net change estimate:** ~200 lines added (ContextWindow class + telemetry), ~150 lines deleted = +50 lines

---

## Dashboard Integration

The `context_window_telemetry` event enables:

1. **Token gauge** - contextTokens / maxTokens percentage
2. **Message list** - Expandable view of messages with role icons
3. **Read files list** - Files loaded into context
4. **Version tracking** - How many updates this session

Schema already supports this via `context_snapshots` table - dashboard can query directly for historical views.
