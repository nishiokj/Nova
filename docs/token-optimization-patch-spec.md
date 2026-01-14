# Token Optimization Patch Spec

## Overview

This spec addresses critical token waste from redundant discovery when spawning sub-agents. The core issue: sub-agents don't see parent's local context (artifacts, file reads), causing re-discovery of already-known information.

**Target**: 50% token reduction for medium-difficulty tasks requiring discovery + execution.

---

## Fix #2: Batch Artifacts into Single Message

**File**: `packages/agent-core/src/context/context-window.ts`

### Current Behavior (lines 613-620)

```typescript
case 'artifact':
  result.push({
    type: 'message',
    role: 'user',
    content: formatArtifactForLLM(item as ArtifactItem),
  });
```

Each artifact = 1 message. 10 artifacts = 10 separate user messages with role/content overhead.

### Patch

Modify `getItemsForLLM()` to batch artifacts:

```typescript
getItemsForLLM(): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const artifactItems: ArtifactItem[] = [];

  for (const item of this._items) {
    switch (item.type) {
      // ... existing cases for message, function_call, etc ...

      case 'artifact':
        // Collect, don't emit yet
        artifactItems.push(item as ArtifactItem);
        break;
    }
  }

  // Batch all artifacts into single message at the end
  if (artifactItems.length > 0) {
    result.push({
      type: 'message',
      role: 'user',
      content: `[DISCOVERED ARTIFACTS: ${artifactItems.length}]\n${artifactItems.map(formatArtifactForLLM).join('\n---\n')}`,
    });
  }

  return result;
}
```

**Note**: Same change needed in `getItemsForAnthropic()`.

---

## Fix #3: Truncate Tool Outputs at Storage

**File**: `packages/agent-core/src/agent/agent.ts`

### Location

`handleToolResult` closure in `processToolCalls` (lines 582-655)

### Current (lines 616-623)

```typescript
localContext.appendItem({
  type: 'function_call_output',
  callId: call.id,
  output: toolResult.output ?? '',
  isError: !toolResult.isSuccess,
  durationMs: toolDurationMs,
  timestamp: Date.now(),
});
```

### Patch

```typescript
const MAX_TOOL_OUTPUT_LENGTH = 8000;

// In handleToolResult:
const rawOutput = toolResult.output ?? '';
const truncatedOutput = rawOutput.length > MAX_TOOL_OUTPUT_LENGTH
  ? rawOutput.slice(0, MAX_TOOL_OUTPUT_LENGTH) + `\n... [truncated ${rawOutput.length - MAX_TOOL_OUTPUT_LENGTH} chars]`
  : rawOutput;

localContext.appendItem({
  type: 'function_call_output',
  callId: call.id,
  output: truncatedOutput,
  isError: !toolResult.isSuccess,
  durationMs: toolDurationMs,
  timestamp: Date.now(),
});
```

Consider making `MAX_TOOL_OUTPUT_LENGTH` configurable via agent config or work item bounds.

---

## Fix #4: Bidirectional Context Inheritance (CRITICAL)

This is the most impactful fix. Two directions:

### 4A: Parent → Sub-Agent (sub-agent sees parent's discoveries)

**File**: `packages/agent-core/src/agent/agent.ts`

**Location**: `executeAgentToolCall` (lines 822-993)

#### Current (line 897)

```typescript
const subResult = await agent.run({ globalContext, workItem: subWorkItem, cwd });
```

Sub-agent only sees `globalContext`. Parent's `localContext` (with artifacts, file reads, tool outputs) is invisible.

#### Patch

```typescript
// Before line 897, create merged context for sub-agent
const mergedContextForSubAgent = this.createMergedContext(
  globalContext,
  parentLocalContext,
  {
    includeArtifacts: true,
    includeFileContent: true,
    includeToolHistory: false,  // Don't leak parent's tool calls - they're not relevant
  }
);

const subResult = await agent.run({
  globalContext: mergedContextForSubAgent,
  workItem: subWorkItem,
  cwd
});
```

#### New Method on Agent Class

```typescript
/**
 * Create a merged context view for sub-agent consumption.
 * Combines global context with relevant items from parent's local context.
 */
private createMergedContext(
  globalContext: ContextWindow,
  parentLocalContext: ContextWindow,
  options: {
    includeArtifacts: boolean;
    includeFileContent: boolean;
    includeToolHistory: boolean;
  }
): ContextWindow {
  // Clone global context to avoid mutation
  const merged = ContextWindow.deserialize(globalContext.serialize());

  // Transfer artifacts from parent
  if (options.includeArtifacts) {
    for (const artifact of parentLocalContext.getArtifacts()) {
      merged.addArtifact({
        sourcePath: artifact.sourcePath,
        line: artifact.line,
        kind: artifact.kind,
        name: artifact.name,
        signature: artifact.signature,
        modifies: artifact.modifies,
        calls: artifact.calls,
        insight: artifact.insight,
      });
    }
  }

  // Transfer file content (sub-agent shouldn't re-read what parent already read)
  if (options.includeFileContent) {
    const fileItems = parentLocalContext.getItemsByType<FileContentItem>('file_content');
    for (const fileItem of fileItems) {
      if (!merged.hasReadFile(fileItem.path)) {
        merged.addFileContent(fileItem.path, fileItem.content, fileItem.language);
      }
    }
  }

  // Optionally transfer tool history (usually not needed)
  if (options.includeToolHistory) {
    for (const item of parentLocalContext.items) {
      if (item.type === 'function_call' || item.type === 'function_call_output') {
        merged.appendItem(item);
      }
    }
  }

  return merged;
}
```

### 4B: Sub-Agent → Parent (parent absorbs sub-agent's discoveries)

#### Current Behavior (lines 940-971)

Only artifacts are extracted from `subResult.structuredOutput.artifacts`. But sub-agent may have:
- Read files (stored in `subResult.localContext`)
- Discovered artifacts via tool calls (not in structured output)
- Made observations in tool outputs

#### Current Partial Merge (lines 766-784)

`addAgentResultContext` exists but is NOT called for sub-agent results in `executeAgentToolCall`.

#### Patch

After line 971 in `executeAgentToolCall`, add:

```typescript
// Merge sub-agent's discoveries back into parent's local context
this.mergeSubAgentResults(parentLocalContext, subResult);
```

#### New Method

```typescript
/**
 * Merge sub-agent execution results into parent's local context.
 * Transfers artifacts, file reads, and invalidations.
 */
private mergeSubAgentResults(
  parentLocalContext: ContextWindow,
  subResult: AgentResult
): void {
  // 1. Merge files read (so parent doesn't re-read them)
  for (const path of subResult.filesRead) {
    parentLocalContext.markFileRead(path);
  }

  // 2. Merge invalidated paths (so parent knows what changed)
  // This is already tracked in result.invalidatedPaths at parent level

  // 3. Merge artifacts from sub-agent's local context (not just structured output)
  if (subResult.localContext) {
    const subArtifacts = subResult.localContext.getArtifacts();
    for (const artifact of subArtifacts) {
      // Avoid duplicates by checking sourcePath + name + line
      const existing = parentLocalContext.getArtifactsByPath(artifact.sourcePath);
      const isDuplicate = existing.some(e =>
        e.name === artifact.name && e.line === artifact.line
      );
      if (!isDuplicate) {
        parentLocalContext.addArtifact({
          sourcePath: artifact.sourcePath,
          line: artifact.line,
          kind: artifact.kind,
          name: artifact.name,
          signature: artifact.signature,
          modifies: artifact.modifies,
          calls: artifact.calls,
          insight: artifact.insight,
        });
      }
    }

    // 4. Optionally merge file content (if sub-agent read files parent hasn't)
    const subFileItems = subResult.localContext.getItemsByType<FileContentItem>('file_content');
    for (const fileItem of subFileItems) {
      if (!parentLocalContext.hasReadFile(fileItem.path)) {
        parentLocalContext.addFileContent(fileItem.path, fileItem.content, fileItem.language);
      }
    }
  }
}
```

---

## Required Type Import

Add to `agent.ts` imports:

```typescript
import type { FileContentItem } from '../types/context.js';
```

---

## Summary of Changes

| File | Method | Change |
|------|--------|--------|
| `context-window.ts` | `getItemsForLLM()` | Batch artifacts into single message |
| `context-window.ts` | `getItemsForAnthropic()` | Same batching |
| `agent.ts` | `processToolCalls` → `handleToolResult` | Truncate outputs to 8k chars |
| `agent.ts` | `executeAgentToolCall` | Call `createMergedContext` before sub-agent run |
| `agent.ts` | NEW `createMergedContext` | Build merged view for sub-agent |
| `agent.ts` | `executeAgentToolCall` | Call `mergeSubAgentResults` after sub-agent run |
| `agent.ts` | NEW `mergeSubAgentResults` | Absorb sub-agent discoveries |

---

## Data Flow After Patch

```
Parent Agent (iteration N)
├── localContext: [artifacts A,B] [fileContent X,Y]
│
├── Spawns Explorer sub-agent
│   ├── INPUT: globalContext + parent's artifacts + parent's files
│   ├── Sub-agent sees A,B,X,Y - doesn't re-discover
│   ├── Sub-agent discovers C,D, reads file Z
│   └── OUTPUT: subResult with localContext containing C,D,Z
│
├── mergeSubAgentResults()
│   └── localContext now: [artifacts A,B,C,D] [fileContent X,Y,Z]
│
└── Parent continues with enriched context
```

This eliminates the "repeat discovery" problem entirely. Sub-agents inherit and contribute to a shared knowledge base within the request lifecycle.

---

## Impact Estimate

| Fix | Token Savings |
|-----|---------------|
| #2 Batch artifacts | ~50 tokens per artifact |
| #3 Truncate tool outputs | 1000-5000 per verbose tool call |
| #4 Context inheritance | **2000-10000 per sub-agent call** |

**Combined impact**: 30-50% reduction for tasks involving sub-agent spawning.
