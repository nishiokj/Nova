# Root Cause Analysis: Agent System Issues

## Problem 1: Tool Call Repetition

### Per-iteration repetition
LLM emits the same tool call twice in a single response.

**Current mitigation**: `toolRepeatState` in agent.ts:156-160, 642-663 terminates after 2 identical consecutive calls.

**Root cause**: Prompt is too long/repetitive. LLM doesn't attend to "Do not repeat" instruction buried in context-window.ts:112.

### Cross-iteration repetition
LLM repeats tool calls across iterations.

**Mechanism**: In `buildMessages()` (agent.ts:491-532), function_calls WITHOUT matching outputs are DROPPED (line 524). If an orphaned function_call exists (output lost or mismatched callId), the LLM doesn't see it was made → repeats it.

**Root cause**: call_id matching relies on consistency between `addAssistantMessage()` (line 554) and `handleToolResult()` (line 635). The filtering logic (line 524) is defensive—if ANY edge case causes mismatch, the LLM will repeat.

---

## Problem 2: Low Tool Call Efficacy

**Symptoms**: Tool calls don't succeed, leading to unnecessary turns.

**Root cause**:
- STANDARD_PROMPT was ~140 lines of dense, contradictory instructions
- "Cast a wide net" vs "minimize tokens" at odds with each other
- LLM can't attend to all instructions equally → picks wrong strategy

**Status**: Addressed by prompt compaction (137 → 53 lines) with explicit trade-off framing.

---

## Problem 3: Explorer Not Adding Useful Artifacts

Three sub-issues:

### A. Artifact positioning (context-window.ts:622-629)
```typescript
// Batch all artifacts into single message at the END
if (artifactItems.length > 0) {
  result.push({
    type: 'message',
    role: 'user',
    content: `[DISCOVERED ARTIFACTS: ${artifactItems.length}]\n...`,
  });
}
```
Artifacts added to END of context, not near the conversation where they'd be useful. By the time LLM sees them, they're far from the tool call that needed them.

### B. Double-adding artifacts (agent.ts:1073-1110)
- First added from `subResult.structuredOutput?.artifacts` (line 1095)
- Then again via `mergeSubAgentResults()` (line 1110) which reads `subResult.localContext?.getArtifacts()`
- Duplicates waste tokens

### C. Artifact density too low
- Explorer prompt says to extract "modifies[], calls[], insight" but doesn't enforce it
- Empty fields are common → downstream agent doesn't trust artifacts → re-reads files

---

## Problem 4: Explorer Calling Itself Recursively

**Symptom**: Explorer spawns sub-explorers before accomplishing original task.

**Root cause**: If explorer has access to itself as a tool (check harness_config.json), it may:
1. Spawn sub-explorer to find files
2. Sub-explorer spawns another sub-explorer
3. Original task never completes

**Fix**: Remove any sub-agent tools from explorer's config. Explorer is pure discovery—Read/Glob/Grep only.

---

## Problem 5: CWD Pathing

**Symptom**: CWD is set to where harness is launched, not where user's project is.

**Root cause**: `config.tools.workingDir` is set at harness startup time (harness.ts:283-292):
```typescript
const workingDir = config.tools.workingDir;
this.toolRegistry = new ToolRegistry({...}, workingDir);
```

This comes from `loadConfig()` which resolves relative to where the harness process starts, NOT where the user's project is.

The per-request `workingDir` parameter exists (harness.ts:444) but:
1. TUI may not be passing it correctly
2. Tool registry has its own workingDir set at construction time

**Fix needed**:
- Remove `workingDir` from ToolRegistry constructor
- Pass `cwd` on every `toolRegistry.execute()` call (already done, but verify)
- Remove `this.toolRegistry.getWorkingDir()` call in agent.ts:460—it's using stale data

---

## Fix Priority

| Problem | Impact | Effort | Status |
|---------|--------|--------|--------|
| 2. Prompt bloat | High | Low | ✅ Done |
| 5. CWD pathing | High | Medium | Pending |
| 3. Artifact positioning | Medium | Medium | Pending |
| 1. Tool repetition | Medium | Low | Partial (detection exists) |
| 4. Explorer recursion | Low | Low | Verify config |
