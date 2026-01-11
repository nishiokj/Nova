# Context Window Isolation

Agents read from global context, write to their own local context, return it. Orchestrator decides what to merge.

## Architecture

- **Orchestrator** owns global context, passes it by reference (read-only to agents)
- **Agents** create fresh local context, work on it, return it in `AgentResult.localContext`
- **Sub-agents** see only global context (parent's local work is invisible)
- **Merge** via `context.addAgentResultContext(result)` - single point of control

## API Contract

### ContextWindow

```typescript
// Mutation
addMessage(role, content): void
addFunctionCall(callId, name, args): void
addFunctionCallOutput(callId, output, isError?, durationMs?): void
addReasoning(content): void
addFileContent(path, content, language?): string
appendItem(item): void
addAgentResultContext(result): void  // Merge agent result

// Compaction
compact(options): CompactResult
ejectFileContentByPath(path): EjectResult
ejectFileContentById(id): EjectResult

// Query
isNearFull(threshold?): boolean  // Uses content estimation
estimateTokenUsage(): number     // ~4 chars/token heuristic

// LLM Integration
getItemsForLLM(): Array<Record<string, unknown>>
getItemsForAnthropic(): Array<Record<string, unknown>>

// Persistence
serialize(): ContextWindowSnapshot
static deserialize(snapshot): ContextWindow
```

### AgentRunParams

```typescript
interface AgentRunParams {
  globalContext: ContextWindow;  // Read-only reference
  workItem: WorkItem;
}
```

### AgentResult

```typescript
interface AgentResult {
  success: boolean;
  response: string;
  localContext: ContextWindow;  // Agent's execution context
  // ... other fields
}
```

## Behavior

| Aspect | Implementation |
|--------|----------------|
| Global context | Read-only reference passed to agent |
| Local context | Fresh ContextWindow per agent run |
| Sub-agent visibility | Global only (Option A) |
| Merge strategy | `addAgentResultContext()` - ejects stale files, merges filesRead, merges tool calls, adds response |
| Auto-compact | Triggers at 80% estimated capacity |
| Token estimation | ~4 chars per token heuristic |

## Events

- `agent_bounds_hit` - Emitted when agent hits tool call or duration limits
- `tool_call` - Tool execution lifecycle
- `llm_call` - LLM request/response
