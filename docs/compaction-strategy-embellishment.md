# Compaction Strategy Embellishment: Semantic Importance Scoring

## Overview

This document proposes an intelligent embellishment to the ContextWindow compaction algorithm that introduces **semantic importance scoring** while respecting the system's invariants and separations of concern.

## Current State Analysis

### Existing Compaction Strategy

The `ContextWindow.compact()` method currently supports:

1. **Age-based removal**: Removes `file_content` items older than `maxFileContentAgeMs`
2. **Count-based removal (LRU)**: Removes oldest `file_content` items when exceeding `maxFileContentCount`
3. **Deduplication by path**: Keeps only the newest `file_content` per path
4. **Output truncation**: Truncates long `function_call_output` to `truncateOutputsTo` characters

### Limitations

The current strategy is purely **mechanical**—it removes items based on age and quantity without considering:
- Semantic relevance to the current task
- Interaction patterns (e.g., files referenced in recent tool calls)
- Artifact relationships (files that generated artifacts still in context)
- Critical items that should never be removed

**Note:** The current data model does not track file access or tool reference timestamps. Any scoring based on those signals requires new state to be recorded.

## Proposed Enhancement: Semantic Importance Scoring

### Core Principle

> **Compaction should be intelligent, not mechanical.** Items should be scored based on multiple signals, and the lowest-scored items should be removed first.

### Multi-Dimensional Scoring System

Each `file_content` item receives a **composite score** (0-1) based on four dimensions:

#### 1. Recency Score (`score_recency`)

How recently was this file added or accessed?

```
score_recency = clamp(1 - (age / maxAge), 0, 1)
```

Where `age` is time since last access, and `maxAge` is a configurable maximum (e.g., 1 hour).

**Required state:** a `lastAccessedAt` timestamp per file item (or a separate access log).

**Example**: A file added 5 minutes ago with `maxAge=1h` → `score_recency ≈ 0.92`

#### 2. Interaction Score (`score_interaction`)

How recently was this file referenced in tool calls or messages?

```
score_interaction = clamp(1 - (timeSinceReference / referenceWindow), 0, 1)
```

Where `referenceWindow` is the time window for considering references (e.g., 30 minutes).

**Required state:** a record of the most recent tool/message reference per file path.

**Example**: A file mentioned in a tool call 2 minutes ago with `referenceWindow=30m` → `score_interaction ≈ 0.93`

#### 3. Artifact Relevance Score (`score_artifact`)

Does this file have artifacts still in context?

```
score_artifact = artifactCount > 0 ? clamp(artifactCount / maxArtifacts, 0, 1) : 0
```

Where `artifactCount` is the number of artifacts from this file in context, and `maxArtifacts` is a scaling factor (e.g., 5).

**Example**: A file with 3 artifacts in context with `maxArtifacts=5` → `score_artifact = 0.6`

#### 4. Task Relevance Score (`score_task`)

Is this file semantically relevant to the current objective?

**Implementation**: This requires a lightweight relevance classifier that evaluates:
- Path similarity to paths mentioned in the current objective
- Content keywords matching objective terms
- Explicit task annotations (e.g., "priority: high")

**Guardrail:** keep it deterministic and fast. Avoid non-deterministic LLM calls in the hot path.

```
score_task = classifier.relevance(file, currentObjective)
```

**Example**: A file `src/auth/login.ts` when objective is "implement OAuth login" → `score_task ≈ 0.85`

### Composite Score

```
score_composite = (
  weight_recency * score_recency +
  weight_interaction * score_interaction +
  weight_artifact * score_artifact +
  weight_task * score_task
)
```

Default weights: `weight_recency=0.3`, `weight_interaction=0.3`, `weight_artifact=0.2`, `weight_task=0.2`

## Implementation Design

### Separation of Concerns

The enhancement respects the system's architecture by introducing three distinct components:

#### 1. `ItemScorer` (New Interface)

```typescript
interface ItemScorer {
  /**
   * Score a single context item.
   * Returns a value between 0 (low priority) and 1 (high priority).
   */
  scoreItem(item: ContextItem, context: ScoringContext): number;

  /**
   * Score multiple items efficiently.
   * Returns a map of item indices to scores.
   */
  scoreItems(items: ContextItem[], context: ScoringContext): Map<number, number>;
}

interface ScoringContext {
  currentObjective?: string;
  currentGoal?: string;
  referenceWindowMs: number;
  maxAgeMs: number;
  maxArtifacts: number;
  weights: {
    recency: number;
    interaction: number;
    artifact: number;
    task: number;
  };
}
```

#### 2. `DefaultItemScorer` (New Implementation)

A concrete implementation of `ItemScorer` that uses the multi-dimensional scoring system described above.

**Key features:**
- Efficient batch scoring (avoids redundant calculations)
- Caches expensive operations (e.g., task relevance classification)
- Extensible for custom scoring strategies

#### 3. Enhanced `CompactOptions` (Extension)

```typescript
interface CompactOptions {
  // Existing options...
  maxFileContentAgeMs?: number;
  maxFileContentCount?: number;
  deduplicateByPath?: boolean;
  truncateOutputsTo?: number;

  // New options...
  scorer?: ItemScorer;                    // Custom scorer (defaults to DefaultItemScorer)
  scoringContext?: Partial<ScoringContext>; // Override scoring parameters
  preserveArtifactFiles?: boolean;        // Never remove files with artifacts in context
  preserveRecentItems?: number;           // Never remove N most recent items
}
```

### Algorithm Changes

The `compact()` method is enhanced with a new compaction phase:

```typescript
compact(options: CompactOptions = {}): CompactResult {
  // Existing age-based, count-based, and deduplication logic...

  // NEW: Semantic importance scoring phase (only if still over limit)
  const scorer = options.scorer ?? new DefaultItemScorer();
  const scoringContext = buildScoringContext(options);

  // Score only file_content items
  const fileItems = this._items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type === 'file_content');

  const scores = scorer.scoreItems(
    fileItems.map(({ item }) => item),
    scoringContext
  );

  // Sort by score (ascending), remove lowest-scored first
  const scored = fileItems
    .map(({ item, index }, scoredIndex) => ({
      item,
      index,
      score: scores.get(scoredIndex) ?? 0,
    }));

  // Apply preservation rules
  const sorted = scored
    .filter(({ item, index }) => {
      // Preserve files with artifacts if enabled
      if (options.preserveArtifactFiles) {
        const hasArtifacts = this._items.some(
          a => a.type === 'artifact' && a.sourcePath === (item as FileContentItem).path
        );
        if (hasArtifacts) return false;
      }

      // Preserve N most recent items
      if (options.preserveRecentItems) {
        const sortedByTime = [...scored].sort((a, b) => b.item.timestamp - a.item.timestamp);
        const isRecent = sortedByTime.slice(0, options.preserveRecentItems)
          .some(recent => recent.index === index);
        if (isRecent) return false;
      }

      return true;
    })
    .sort((a, b) => a.score - b.score);

  // Remove lowest-scored items until under limit
  const targetCount = options.maxFileContentCount ?? Infinity;
  while (sorted.length > targetCount) {
    const { index } = sorted.shift()!;
    toRemove.add(index);
    // ... update metrics
  }

  // ... rest of existing logic
}
```

## Invariants Preserved

### 1. Version System

The `_version` counter is still incremented on every mutation. The scoring phase does not introduce additional mutations beyond the existing removal logic.

### 2. `_readFiles` Consistency

The `_readFiles` set is still updated correctly when file_content items are removed. The scoring logic only influences **which** items are removed, not **how** the removal is tracked.

### 3. Item Ordering

The relative ordering of items (`_items` array) is preserved. The scoring phase selects items for removal based on indices, but does not reorder items.

### 4. Idempotency

Calling `compact()` multiple times with the same options produces the same result. The scoring function is deterministic.

## Benefits

### 1. Task-Aware Compaction

Files relevant to the current objective are prioritized, reducing the likelihood of compacting away critical information.

### 2. Artifact-Aware Compaction

Files that generated artifacts still in context are less likely to be removed, preserving the semantic link between code and its discovered structure.

### 3. Interaction-Aware Compaction

Files recently referenced in tool calls or messages are given higher priority, reflecting the model's current focus.

### 4. Configurable Intelligence

The scoring system is fully configurable:
- Custom scorers can be injected for domain-specific logic
- Weights can be tuned per application
- Individual dimensions can be disabled (e.g., set `weight_task = 0` to disable task relevance)

### 5. Backward Compatibility

The enhancement is **fully backward compatible**:
- Existing `compact()` calls work unchanged (scoring is opt-in)
- Default behavior is preserved when no scorer is provided
- New options have sensible defaults

## Migration Path

### Phase 1: Foundation (Low Risk)

1. Add `ItemScorer` interface and `DefaultItemScorer` implementation
2. Add new `CompactOptions` fields with default values that disable scoring
3. Add unit tests for the scoring logic

### Phase 2: Integration (Medium Risk)

1. Enable scoring in `compact()` when `scorer` is provided
2. Add integration tests with realistic scenarios
3. Add telemetry to track scoring effectiveness

### Phase 3: Optimization (Low Risk)

1. Tune default weights based on production data
2. Add caching for expensive operations (e.g., task relevance)
3. Add performance benchmarks

### Phase 4: Rollout (Low Risk)

1. Gradually enable scoring in production environments
2. Monitor metrics (compaction rate, cache miss rate, token efficiency)
3. Iterate on weights based on observed behavior

## Future Enhancements

### 1. Artifact Compaction

Extend scoring to `artifact` items, allowing intelligent removal of old artifacts that are no longer relevant.

### 2. Message Compaction

Apply scoring to `message` items, enabling intelligent summarization or removal of old conversation turns.

### 3. Predictive Compaction

Use machine learning to predict which items will be needed in the next turn, proactively preserving them.

### 4. Distributed Scoring

For large-scale deployments, delegate scoring to a separate service to reduce main thread overhead.

## Conclusion

The proposed semantic importance scoring system enhances the ContextWindow's compaction strategy while respecting the system's invariants and separations of concern. It introduces intelligence without breaking existing functionality, provides configurability for diverse use cases, and offers a clear migration path for gradual adoption.

By moving from mechanical to intelligent compaction, we can:
- Reduce token waste on irrelevant context
- Improve cache hit rates for file content
- Maintain better semantic coherence in long conversations
- Provide fine-grained control over context management

---

**Document Version**: 1.0
**Last Updated**: 2026-01-16
**Author**: System Architecture Team
