# Smart Compaction Strategy: Epistemology-Based Context Distillation

## Executive Summary

This specification defines a **smart compaction algorithm** grounded in epistemology—the theory of knowledge—to maximize the information density of context tokens. The core insight: **not all tokens are epistemically equal**. Some carry actionable knowledge; others are redundant scaffolding that can be distilled.

The algorithm operates on three first principles:

1. **Epistemic Relevance**: Keep what the agent needs to *know* to execute the task
2. **Actionability**: Preserve what enables *action*; discard what's merely *descriptive*
3. **Chronological Salience**: Older messages primarily encode "what was done" (negative constraints); newer messages encode "what to do next" (positive constraints)

---

## Part 1: Epistemology of Task Execution Context

### The Agent's Epistemic Requirements

When executing a task, an agent needs four types of knowledge:

| Epistemic Category | What It Provides | Compaction Strategy |
|--------------------|------------------|---------------------|
| **Structural** | What exists? (files, functions, classes) | Artifacts > File content > Descriptions |
| **Relational** | What connects? (dependencies, call graphs) | Artifacts with `calls[]`, `import` artifacts |
| **Behavioral** | What happens? (side effects, mutations) | Artifacts with `modifies[]`, recent tool outputs |
| **Contractual** | What's promised? (invariants, constraints) | Q&A decisions, error patterns, gotchas |

### The Epistemic Hierarchy of Context Items

```
Highest Signal (Never Remove)
├── Active Goal/Objective (system prompt)
├── Recent Q&A Resolutions (user preferences)
├── Artifacts with high `relevance` score
├── Recent tool outputs (last 3-5 turns)

Medium Signal (Distill, Don't Remove)
├── Older artifacts (moderate relevance)
├── File content for active files
├── Tool outputs 5-15 turns ago (summarize)

Low Signal (Remove First)
├── Stale file content (not recently referenced)
├── Duplicated file versions
├── Tool outputs >15 turns ago (truncate heavily)
├── Exploratory tool results (failed searches)

No Signal (Always Remove)
├── Duplicate tool calls (same args, same output)
├── Stale Q&A (resolved, no longer relevant)
└── Failed attempts (unless they encode constraints)
```

---

## Part 2: First Principles for Distillation

### Principle 1: Actionability Over Descriptiveness

**Rule**: If a token doesn't enable action, it's epistemically redundant.

**Implementation**:
- **Keep**: "Function `foo()` at `src/auth.ts:42` checks user permissions"
- **Distill**: "File `src/auth.ts` contains authentication logic" → "Auth: `src/auth.ts`"
- **Remove**: "The file is 500 lines long and has 15 functions"

**Why**: The agent only needs to *find* `foo()` when needed, not *know* everything about the file upfront.

---

### Principle 2: Negative Constraints Encode More Efficiently

**Rule**: "What not to do" is more compact than "what to do."

**Implementation**:
- **Original**: "We tried implementing OAuth, but it conflicted with the existing session system. The session manager expects JWT tokens, not OAuth tokens. We can't change the session manager because it's used by the billing service."
- **Distilled**: "**Constraint**: Must use JWT tokens (OAuth conflicts with billing session system)."
- **Token Savings**: ~80% reduction

**Why**: Negative constraints are high-signal, low-token knowledge that prevents wasted exploration.

---

### Principle 3: Chronological Decay with Salience Preservation

**Rule**: Older messages primarily encode "actions not to repeat" (negative constraints). Newer messages encode "actions to take" (positive constraints).

**Implementation**:

| Message Age | Primary Epistemic Value | Treatment |
|-------------|------------------------|-----------|
| 0-3 turns | Action directives | Keep verbatim |
| 3-10 turns | Progress updates | Summarize to key decisions |
| 10-20 turns | Constraints discovered | Extract to negative constraint list |
| >20 turns | Historical context | Remove unless salient |

**Salience Detection**:
- A message is **salient** if it:
  - Contains a user preference/decision
  - Defines a constraint or invariant
  - Explains why an approach failed
  - References a file still in context

---

### Principle 4: Exploration Cache Avoidance

**Rule**: If the agent has already explored something, don't let it re-explore.

**Implementation**:
- Track **exploration signatures**: `(toolName, argsHash, timestamp)`
- When compacting, check if an exploration signature is still relevant:
  - **Relevant if**: Target file is in context, or artifact references exist
  - **Irrelevant if**: File ejected, no artifacts, no recent references
- Add **exploration hints** to compacted context:
  ```
  [EXPLORATION CACHE]
  - Searched for "auth" in `src/` → Found `src/auth/login.ts` (see artifacts)
  - Searched for "OAuth" → Not found (confirmed)
  ```
- **Token savings**: Prevents duplicate "Read file, search for pattern, not found" loops

---

### Principle 5: Crucial File Protection

**Rule**: Files that are task-critical must never be ejected unless explicitly invalidated.

**Implementation**:
- **Crucial file detection**:
  - File contains the primary implementation target
  - File is frequently referenced in recent tool calls (>3 references in last 10 turns)
  - File has high-relevance artifacts (relevance > 0.8)
  - File is imported by other crucial files

- **Protection mechanism**:
  ```typescript
  interface CompactOptions {
    // ... existing options
    protectCrucialFiles?: boolean;  // Never remove crucial files
    crucialFileThreshold?: {
      referenceCount?: number;      // Default: 3
      artifactRelevance?: number;   // Default: 0.8
      recencyMs?: number;           // Default: 600000 (10 min)
    };
  }
  ```

- **Fallback**: If a crucial file must be removed (e.g., due to extreme pressure), replace with a **pointer artifact**:
  ```
  [file] src/auth/login.ts
  → Crucial file ejected. Reload with Read({path: "src/auth/login.ts"})
  ```

---

## Part 3: Signal Maximization Techniques

### Technique 1: Terminology Density

**Goal**: Use the most information-dense terminology possible.

**Examples**:

| Low Density | High Density | Signal Increase |
|-------------|--------------|-----------------|
| "The function that handles user login" | `login()` | 3× |
| "We need to make sure that the user is authenticated before they can access the dashboard" | "Require auth for dashboard access" | 2.5× |
| "The agent tried to read the file but it didn't exist" | "File not found" | 3× |

**Implementation Pattern**:
```typescript
// Instead of:
"The agent called the Read tool with the path 'src/auth/login.ts' and received the file contents..."

// Use:
"Read: src/auth/login.ts (245 lines)"
```

---

### Technique 2: Structured Constraint Encoding

**Goal**: Encode constraints in a parseable, queryable format.

**Format**:
```
[CONSTRAINTS]
- Must use JWT tokens (OAuth conflicts with billing)
- Cannot modify session.ts (shared with billing service)
- Must preserve backward compatibility with v1 API
- Max response time: 200ms
```

**Benefits**:
- High token efficiency (one line per constraint)
- Queryable by agent ("What are my constraints?")
- Preserves user intent verbatim

---

### Technique 3: Artifact-First File Representation

**Goal**: Replace file content with artifacts when possible.

**Heuristic**:
- If file has >5 artifacts representing >70% of functions, replace content with artifacts
- If file is <200 lines, keep content (artifact overhead > benefit)
- If file is >1000 lines, always replace with artifacts

**Implementation**:
```typescript
interface FileContentItem {
  // ... existing fields
  representation?: 'full' | 'artifacts' | 'summary';
  artifacts?: ArtifactPayload[];  // Pre-extracted
  summary?: string;               // One-line description
}
```

---

### Technique 4: Action Log Distillation

**Goal**: Summarize completed actions into "what was done" and "what not to do."

**Format**:
```
[ACTION LOG - Last 10 turns]
Turn 1: Explored src/auth/ → Found login.ts, session.ts
Turn 2: Read login.ts → Extracted 3 artifacts
Turn 3: Attempted OAuth → Failed (conflict with session.ts)
Turn 4-6: Implemented JWT auth → Success
Turn 7-9: Added tests → 5 tests passing

[WHAT NOT TO REPEAT]
- Don't use OAuth (conflicts with session.ts)
- Don't modify session.ts (billing dependency)
- Don't add new auth endpoints (use existing ones)
```

**Token Savings**: Reduces 10 turns of tool calls (~5000 tokens) to ~200 tokens.

---

## Part 4: Packaging the Distilled Context

### The Compacted Context Structure

```
┌─────────────────────────────────────────────────────────────┐
│ SYSTEM PROMPT (Goal + Objective + Constraints)             │
├─────────────────────────────────────────────────────────────┤
│ NEGATIVE CONSTRAINTS (What not to do)                       │
│ - Must use JWT tokens                                        │
│ - Cannot modify session.ts                                   │
├─────────────────────────────────────────────────────────────┤
│ CRUCIAL FILES (Never ejected)                               │
│ - src/auth/login.ts (245 lines, 12 artifacts)               │
│ - src/auth/jwt.ts (180 lines, 8 artifacts)                  │
├─────────────────────────────────────────────────────────────┤
│ ARTIFACTS (High relevance)                                  │
│ [fn] src/auth/login.ts:42 login()                           │
│ → modifies: this._session, calls: jwt.validate               │
├─────────────────────────────────────────────────────────────┤
│ EXPLORATION CACHE (What was already searched)               │
│ - Searched "auth" in src/ → Found login.ts                   │
│ - Searched "OAuth" → Not found (confirmed)                   │
├─────────────────────────────────────────────────────────────┤
│ ACTION LOG (What was done, what not to repeat)              │
│ Turn 1-3: Explored auth → Found login.ts, jwt.ts            │
│ Turn 4-6: Implemented JWT auth → Success                     │
│ Don't repeat: OAuth attempt, session.ts modification         │
├─────────────────────────────────────────────────────────────┤
│ RECENT MESSAGES (Last 3 turns, verbatim)                    │
│ User: "Add logout functionality"                             │
│ Assistant: "I'll add logout to jwt.ts..."                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 5: Algorithm Implementation

### Phase 1: Analysis (Before Compaction)

```typescript
interface CompactionAnalysis {
  crucialFiles: Set<string>;
  constraints: string[];
  explorationSignatures: ExplorationSignature[];
  artifactRelevance: Map<string, number>;
  messageSalience: Map<number, number>;  // index → salience score
}

interface ExplorationSignature {
  toolName: string;
  argsHash: string;
  timestamp: number;
  targetPath?: string;
  result?: 'found' | 'not_found' | 'failed';
}
```

**Analysis Steps**:
1. **Identify crucial files** (reference count, artifact relevance, recency)
2. **Extract constraints** from recent messages (user decisions, error patterns)
3. **Build exploration cache** from function_call items
4. **Score artifacts** by relevance (see `compaction-strategy-embellishment.md`)
5. **Score messages** by salience (recency, constraint density, user intent)

---

### Phase 2: Distillation (During Compaction)

```typescript
interface DistilledContext {
  negativeConstraints: string[];
  crucialFiles: Array<{ path: string; artifactCount: number; lineCount: number }>;
  highRelevanceArtifacts: ArtifactPayload[];
  explorationHints: string[];
  actionLogSummary: string;
  recentMessages: MessageItem[];
}
```

**Distillation Steps**:
1. **Extract negative constraints** from messages with salience > 0.7
2. **Replace crucial files** with artifact representations where beneficial
3. **Build exploration hints** from relevant exploration signatures
4. **Summarize action log** (last 10-15 turns) into "what was done" + "what not to repeat"
5. **Keep recent messages** verbatim (last 3 turns)

---

### Phase 3: Reconstruction (After Compaction)

```typescript
function reconstructContext(
  original: ContextWindow,
  distilled: DistilledContext,
  analysis: CompactionAnalysis
): ContextItem[] {
  const items: ContextItem[] = [];

  // 1. System message (always first)
  items.push(original.items[0]);  // Assuming system message is first

  // 2. Negative constraints block
  if (distilled.negativeConstraints.length > 0) {
    items.push({
      type: 'message',
      role: 'system',
      content: `[NEGATIVE CONSTRAINTS]\n${distilled.negativeConstraints.map(c => `- ${c}`).join('\n')}`,
      timestamp: Date.now(),
    });
  }

  // 3. Crucial files block
  if (distilled.crucialFiles.length > 0) {
    items.push({
      type: 'message',
      role: 'system',
      content: `[CRUCIAL FILES]\n${distilled.crucialFiles.map(f => `- ${f.path} (${f.lineCount} lines, ${f.artifactCount} artifacts)`).join('\n')}`,
      timestamp: Date.now(),
    });
  }

  // 4. High-relevance artifacts
  items.push({
    type: 'message',
    role: 'user',
    content: `[HIGH-RELEVANCE ARTIFACTS]\n${distilled.highRelevanceArtifacts.map(formatArtifactForLLM).join('\n---\n')}`,
    timestamp: Date.now(),
  });

  // 5. Exploration hints
  if (distilled.explorationHints.length > 0) {
    items.push({
      type: 'message',
      role: 'system',
      content: `[EXPLORATION CACHE]\n${distilled.explorationHints.join('\n')}`,
      timestamp: Date.now(),
    });
  }

  // 6. Action log summary
  if (distilled.actionLogSummary) {
    items.push({
      type: 'message',
      role: 'system',
      content: `[ACTION LOG - Last ${actionLogTurns} turns]\n${distilled.actionLogSummary}`,
      timestamp: Date.now(),
    });
  }

  // 7. Recent messages (verbatim)
  items.push(...distilled.recentMessages);

  return items;
}
```

---

## Part 6: Integration with Existing System

### Extending `CompactOptions`

```typescript
export interface CompactOptions {
  // ... existing options
  maxFileContentAgeMs?: number;
  maxFileContentCount?: number;
  deduplicateByPath?: boolean;
  truncateOutputsTo?: number;

  // NEW: Smart compaction options
  enableSmartCompaction?: boolean;
  protectCrucialFiles?: boolean;
  crucialFileThreshold?: {
    referenceCount?: number;
    artifactRelevance?: number;
    recencyMs?: number;
  };
  negativeConstraintExtraction?: boolean;
  explorationHintGeneration?: boolean;
  actionLogTurns?: number;  // How many turns to summarize
  recentMessageCount?: number;  // How many messages to keep verbatim
}
```

### New ContextWindow Methods

```typescript
class ContextWindow {
  // ... existing methods

  /**
   * Analyze context for smart compaction.
   * Returns analysis without modifying state.
   */
  analyzeForCompaction(options: CompactOptions = {}): CompactionAnalysis;

  /**
   * Compact using smart distillation strategy.
   */
  compactSmart(options: CompactOptions = {}): CompactResult;

  /**
   * Extract negative constraints from messages.
   */
  extractNegativeConstraints(): string[];

  /**
   * Identify crucial files based on usage patterns.
   */
  identifyCrucialFiles(threshold?: CrucialFileThreshold): Set<string>;

  /**
   * Build exploration hints from tool history.
   */
  buildExplorationHints(): string[];
}
```

---

## Part 7: Evaluation Metrics

### Epistemic Quality Metrics

| Metric | Definition | Target |
|--------|------------|--------|
| **Constraint Preservation Rate** | % of user constraints retained after compaction | >95% |
| **Exploration Cache Hit Rate** | % of redundant explorations prevented | >80% |
| **Crucial File Retention Rate** | % of crucial files still available | 100% |
| **Artifact Relevance Retention** | Avg relevance of retained artifacts | >0.7 |
| **Negative Constraint Density** | Constraints per 1000 tokens after compaction | >5 |

### Token Efficiency Metrics

| Metric | Definition | Target |
|--------|------------|--------|
| **Compression Ratio** | `tokens_before / tokens_after` | 3-6× |
| **Signal Density** | Actionable tokens / total tokens | >0.6 |
| **Regret Rate** | % of compactions requiring re-exploration | <15% |
| **Cache Miss Penalty** | Tokens paid per forced cache miss | <C/2 |

### User Experience Metrics

| Metric | Definition | Target |
|--------|------------|--------|
| **Latency Overhead** | Additional latency from compaction | <200ms |
| **Quality Preservation** | Task success rate with/without compaction | >90% |
| **Context Coherence** | Human-rated coherence of compacted context | >0.8 |

---

## Part 8: Implementation Roadmap

### Phase 1: Foundation (Week 1)
- [ ] Extend `CompactOptions` with smart compaction flags
- [ ] Implement `analyzeForCompaction()` method
- [ ] Add `CompactionAnalysis` types
- [ ] Write unit tests for analysis logic

### Phase 2: Distillation (Week 2)
- [ ] Implement `extractNegativeConstraints()`
- [ ] Implement `identifyCrucialFiles()`
- [ ] Implement `buildExplorationHints()`
- [ ] Implement `reconstructContext()`
- [ ] Add integration tests

### Phase 3: Smart Compact (Week 2-3)
- [ ] Implement `compactSmart()` with full pipeline
- [ ] Integrate with agent/orchestrator compaction triggers
- [ ] Add telemetry for epistemic quality metrics
- [ ] Benchmark token efficiency

### Phase 4: Optimization (Week 3-4)
- [ ] Tune thresholds based on production data
- [ ] Add caching for expensive operations
- [ ] Implement adaptive compression ratio
- [ ] Add A/B testing framework

### Phase 5: Rollout (Week 4+)
- [ ] Gradual rollout with feature flags
- [ ] Monitor metrics and regressions
- [ ] Iterate based on feedback
- [ ] Document best practices

---

## Part 9: Examples

### Example 1: Simple Task Compaction

**Before Compaction** (15,000 tokens):
```
System: "Implement OAuth login..."
User: "Can you add OAuth?"
Assistant: "I'll explore the codebase..."
[10 turns of Read, Grep, function calls]
User: "Wait, we use JWT, not OAuth."
Assistant: "Got it, I'll use JWT..."
[5 turns of JWT implementation]
```

**After Smart Compaction** (2,500 tokens):
```
System: "Implement JWT login for the dashboard..."

[NEGATIVE CONSTRAINTS]
- Must use JWT tokens (user explicitly requested, not OAuth)
- Cannot use OAuth (user correction)

[CRUCIAL FILES]
- src/auth/login.ts (245 lines, 12 artifacts)
- src/auth/jwt.ts (180 lines, 8 artifacts)

[EXPLORATION CACHE]
- Searched for "OAuth" → User corrected to JWT
- Searched for "JWT" → Found jwt.ts

[ACTION LOG - Last 15 turns]
Turn 1-10: Explored auth system → Found login.ts, jwt.ts
Turn 11-15: Implemented JWT login → Success
Don't repeat: OAuth exploration (user corrected)

[RECENT MESSAGES]
User: "Wait, we use JWT, not OAuth."
Assistant: "Got it, I'll use JWT instead..."
```

**Token Savings**: 83% reduction, 100% constraint preservation.

---

### Example 2: Complex Task with Crucial File Protection

**Scenario**: Agent is debugging a race condition in `src/auth/session.ts`

**Analysis**:
- `session.ts` has 15 references in last 10 turns → **Crucial**
- User stated: "Don't modify session.ts, it's shared with billing" → **Constraint**
- Previous attempts at `session.ts` modification failed → **Negative constraint**

**Compaction Result**:
- `session.ts` kept in context (crucial file protection)
- Constraint preserved: "Cannot modify session.ts (billing dependency)"
- Exploration hint: "Tried modifying session.ts → Failed (billing conflict)"
- Other files ejected or distilled

---

## Part 10: Open Questions

1. **How to measure epistemic quality automatically?**
   - Can we use embedding similarity between original and compacted context?
   - Can we measure constraint preservation via semantic matching?

2. **What's the optimal action log length?**
   - 10 turns? 15 turns? Should it be dynamic based on task complexity?

3. **How to handle cross-session context?**
   - Should negative constraints persist across sessions?
   - Should exploration hints have a TTL?

4. **Can we learn from user corrections?**
   - If user says "You already searched for that," can we improve exploration hints?
   - If user says "Why did you remove that file?", can we adjust crucial file detection?

5. **How to balance compression vs. regret?**
   - Aggressive compaction saves tokens but increases re-exploration
   - Conservative compaction wastes tokens but preserves context
   - Can we use reinforcement learning to find the optimal tradeoff?

---

## Appendix A: References

1. **Epistemology**: Gettier, "Is Justified True Belief Knowledge?"
2. **Information Theory**: Shannon, "A Mathematical Theory of Communication"
3. **Cognitive Science**: Miller, "The Magical Number Seven, Plus or Minus Two"
4. **Existing Specs**:
   - `docs/compaction-strategy-spec.md` (Game-theoretic approach)
   - `docs/compaction-strategy-embellishment.md` (Semantic importance scoring)
   - `docs/compaction_game_theoretic_strategy.md` (Decision models)

---

**Document Version**: 1.0
**Last Updated**: 2026-01-16
**Status**: Planning Complete - Ready for Implementation