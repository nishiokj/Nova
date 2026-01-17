# Robust Compaction & Context Engineering Engine
## Implementation Plan from First Principles

**Status**: Planning Phase
**Version**: 1.0
**Date**: 2026-01-16

---

## Executive Summary

Our current compaction implementation is **mechanical, not intelligent**. It removes context items based purely on age, count, and path deduplication—without any understanding of semantic relevance, task criticality, or exploration history. This leads to:

1. **Wasted tokens** on irrelevant context
2. **Re-exploration loops** when critical information was prematurely ejected
3. **Cache misses** from wholesale context rewrites
4. **Naive-naive failures** where the agent loses essential state silently

This plan synthesizes three existing specification documents into a concrete, phased implementation roadmap grounded in first principles of distillation, representation optimization, and epistemic engineering.

---

## First Principles

### 1. **Epistemic Relevance Over Token Count**
> **Principle**: Not all tokens are epistemically equal. Some carry actionable knowledge; others are redundant scaffolding.

**Implication**: Compaction should maximize **information density**, not minimize token count. We want the highest ratio of "knowledge that enables action" to total tokens.

### 2. **Negative Constraints Encode More Efficiently**
> **Principle**: "What not to do" is more compact than "what to do."

**Example**:
- *Original*: "We tried implementing OAuth, but it conflicted with the existing session system. The session manager expects JWT tokens, not OAuth tokens. We can't change the session manager because it's used by the billing service." (~80 tokens)
- *Distilled*: "**Constraint**: Must use JWT tokens (OAuth conflicts with billing session system)." (~15 tokens)
- **Savings**: 81% reduction while preserving 100% of the constraint

### 3. **Chronological Salience**
> **Principle**: Older messages primarily encode "what was done" (negative constraints). Newer messages encode "what to do next" (positive constraints).

**Implication**: 
- Recent turns (0-3): Keep verbatim (action directives)
- Medium turns (3-10): Summarize to key decisions
- Old turns (>10): Extract to negative constraint list

### 4. **Exploration Cache Avoidance**
> **Principle**: If the agent has already explored something, don't let it re-explore.

**Implementation**: Track exploration signatures `(toolName, argsHash, timestamp)` and add hints like:
```
[EXPLORATION CACHE]
- Searched for "auth" in src/ → Found src/auth/login.ts (see artifacts)
- Searched for "OAuth" → Not found (confirmed)
```

### 5. **Crucial File Protection**
> **Principle**: Files that are task-critical must never be ejected unless explicitly invalidated.

**Detection criteria**:
- File contains the primary implementation target
- Frequently referenced (>3 references in last 10 turns)
- Has high-relevance artifacts (relevance > 0.8)
- Imported by other crucial files

---

## Current Architecture Analysis

### Context Item Types
```
ContextItem =
  | MessageItem              // User/assistant/system messages
  | FunctionCallItem         // Tool invocation by model
  | FunctionCallOutputItem   // Result from tool execution
  | ReasoningItem            // Chain of thought
  | FileContentItem          // File loaded into context
  | ArtifactItem             // Semantic code distillation
```

### Current Compaction Logic (`context-window.ts:402-517`)
```typescript
compact(options: CompactOptions): CompactResult {
  // 1. Age-based removal (remove files older than threshold)
  // 2. Count-based LRU eviction (keep N most recent files)
  // 3. Path deduplication (keep newest per path)
  // 4. Output truncation (truncate long tool outputs)
}
```

**Limitations**:
- No semantic awareness
- No task relevance scoring
- No artifact relationships
- No crucial file protection
- No exploration cache hints
- No negative constraint extraction

### Trigger Points
1. **Orchestrator** (`orchestrator.ts:290-305`):
   - Triggers when `context.metrics.percentageUsed >= 0.70`
   - Uses hysteresis: won't compact again until below 0.7
   - Options: `{ deduplicateByPath: true, maxFileContentCount: 20, truncateOutputsTo: 5000 }`

2. **Agent** (`agent.ts:176`):
   - Triggers when `localContext.isNearFull()` (threshold 0.8)
   - Options: `{ deduplicateByPath: true, truncateOutputsTo: 4000 }`

---

## Proposed Architecture

### Phase 1: Foundation (Observability Layer)

**Goal**: Capture data needed for intelligent decisions

**New Types**:
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

interface CompactionTelemetry {
  triggerReason: string;
  tokensBefore: number;
  tokensAfter: number;
  compressionRatio: number;
  crucialFilesProtected: number;
  constraintsExtracted: number;
  explorationHintsAdded: number;
  cacheMissCost: number;
  expectedPaybackTurns: number;
}
```

**New Methods on `ContextWindow`**:
```typescript
/**
 * Analyze context for smart compaction without modifying state.
 */
analyzeForCompaction(options: CompactOptions): CompactionAnalysis;

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
```

**Metrics to Track**:
| Metric | Definition | Target |
|--------|------------|--------|
| **Cache Hit Rate** | % of turns served from KV cache | >70% |
| **Effective Compaction Ratio** | `tokens_before / tokens_after` | 3-6× |
| **Constraint Preservation Rate** | % of user constraints retained | >95% |
| **Exploration Cache Hit Rate** | % of redundant explorations prevented | >80% |
| **Crucial File Retention Rate** | % of crucial files still available | 100% |
| **Regret Rate** | % of compactions requiring re-exploration | <15% |
| **Naive-Naive Incidents** | Count per 100 turns | <1 |

---

### Phase 2: Semantic Importance Scoring

**Goal**: Replace mechanical removal with intelligent scoring

**New Interface**:
```typescript
interface ItemScorer {
  /**
   * Score a single context item.
   * Returns a value between 0 (low priority) and 1 (high priority).
   */
  scoreItem(item: ContextItem, context: ScoringContext): number;

  /**
   * Score multiple items efficiently.
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

**Default Implementation**:
```typescript
class DefaultItemScorer implements ItemScorer {
  scoreItem(item: ContextItem, context: ScoringContext): number {
    const scores = {
      recency: this.scoreRecency(item, context),
      interaction: this.scoreInteraction(item, context),
      artifact: this.scoreArtifact(item, context),
      task: this.scoreTask(item, context),
    };

    return (
      context.weights.recency * scores.recency +
      context.weights.interaction * scores.interaction +
      context.weights.artifact * scores.artifact +
      context.weights.task * scores.task
    );
  }

  private scoreRecency(item: ContextItem, context: ScoringContext): number {
    const age = Date.now() - item.timestamp;
    return Math.max(0, 1 - age / context.maxAgeMs);
  }

  private scoreInteraction(item: ContextItem, context: ScoringContext): number {
    // How recently was this item referenced in tool calls?
    // Implementation: scan recent function_call items for references
    return 0; // TODO: implement
  }

  private scoreArtifact(item: ContextItem, context: ScoringContext): number {
    // Does this file have artifacts still in context?
    if (item.type !== 'file_content') return 0;
    // Count artifacts from this file
    return 0; // TODO: implement
  }

  private scoreTask(item: ContextItem, context: ScoringContext): number {
    // Is this item semantically relevant to the current objective?
    // Implementation: lightweight relevance classifier
    return 0; // TODO: implement
  }
}
```

**Extended `CompactOptions`**:
```typescript
export interface CompactOptions {
  // Existing options...
  maxFileContentAgeMs?: number;
  maxFileContentCount?: number;
  deduplicateByPath?: boolean;
  truncateOutputsTo?: number;

  // NEW: Smart compaction options
  enableSmartCompaction?: boolean;
  scorer?: ItemScorer;
  scoringContext?: Partial<ScoringContext>;
  preserveArtifactFiles?: boolean;
  preserveRecentItems?: number;
  protectCrucialFiles?: boolean;
  negativeConstraintExtraction?: boolean;
  explorationHintGeneration?: boolean;
  actionLogTurns?: number;
  recentMessageCount?: number;
}
```

---

### Phase 3: Epistemic Distillation

**Goal**: Distill context to high-signal knowledge

**Distilled Context Structure**:
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

**Distillation Pipeline**:
```typescript
function distillContext(
  original: ContextWindow,
  analysis: CompactionAnalysis,
  options: CompactOptions
): DistilledContext {
  return {
    negativeConstraints: original.extractNegativeConstraints(),
    crucialFiles: Array.from(analysis.crucialFiles).map(path => ({
      path,
      artifactCount: original.getArtifactsByPath(path).length,
      lineCount: original.getItemsByType<FileContentItem>('file_content')
        .find(f => f.path === path)?.content.split('\n').length ?? 0,
    })),
    highRelevanceArtifacts: original.getArtifacts()
      .filter(a => a.relevance > 0.7)
      .map(a => a.payload),
    explorationHints: original.buildExplorationHints(),
    actionLogSummary: summarizeActionLog(original, options.actionLogTurns ?? 15),
    recentMessages: original.getRecentItems(options.recentMessageCount ?? 3)
      .filter(i => i.type === 'message') as MessageItem[],
  };
}
```

**Context Reconstruction**:
```typescript
function reconstructContext(
  original: ContextWindow,
  distilled: DistilledContext,
  analysis: CompactionAnalysis
): ContextItem[] {
  const items: ContextItem[] = [];

  // 1. System message (always first)
  items.push(original.items[0]);

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
      content: `[CRUCIAL FILES]\n${distilled.crucialFiles.map(f => 
        `- ${f.path} (${f.lineCount} lines, ${f.artifactCount} artifacts)`
      ).join('\n')}`,
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
      content: `[ACTION LOG - Last ${options.actionLogTurns ?? 15} turns]\n${distilled.actionLogSummary}`,
      timestamp: Date.now(),
    });
  }

  // 7. Recent messages (verbatim)
  items.push(...distilled.recentMessages);

  return items;
}
```

---

### Phase 4: Cache-Aware Decision Engine

**Goal**: Balance cache economics with token savings

**Expected Value Heuristic**:
```typescript
interface CompactionDecision {
  action: 'compact' | 'wait' | 'light_prune';
  rationale: string;
  confidence: number;
  expectedTokensSaved: number;
  expectedCacheMissCost: number;
  expectedPaybackTurns: number;
}

class CompactionDecisionEngine {
  decide(context: ContextWindow, config: OrchestratorConfig): CompactionDecision {
    const C = context.estimateTokenUsage();
    const fullness = C / context.maxTokens;
    const D = this.estimateCompactionDivisor(context);
    const Q = this.estimateTokenDelta(context);
    const M = this.estimateRemainingTurns(context);
    const L = this.calculateLossSlope(fullness);

    // Expected value of compaction
    const cacheMissCost = C * (1 - 1 / D);
    const futureSavings = Q * M * this.cacheHitConfidence;
    const headroomGain = L * (1 - fullness);
    const penaltyNaive = this.estimateNaivePenalty(context);

    const EV = -cacheMissCost + futureSavings + headroomGain - penaltyNaive;

    // Safety thresholds
    if (fullness > 0.95) {
      return {
        action: 'compact',
        rationale: 'Context >95% full - emergency compaction',
        confidence: 0.9,
        expectedTokensSaved: C * (1 - 1 / D),
        expectedCacheMissCost: cacheMissCost,
        expectedPaybackTurns: D,
      };
    }

    if (fullness > 0.80 && EV > 0) {
      return {
        action: 'compact',
        rationale: `Context >80% full, EV=${EV.toFixed(0)} > 0`,
        confidence: Math.min(0.9, EV / C),
        expectedTokensSaved: C * (1 - 1 / D),
        expectedCacheMissCost: cacheMissCost,
        expectedPaybackTurns: D,
      };
    }

    return {
      action: 'wait',
      rationale: `EV=${EV.toFixed(0)} <= 0, fullness=${(fullness * 100).toFixed(0)}%`,
      confidence: 0.8,
      expectedTokensSaved: 0,
      expectedCacheMissCost: 0,
      expectedPaybackTurns: 0,
    };
  }

  private estimateCompactionDivisor(context: ContextWindow): number {
    // Historical compression ratio, default 4
    return 4;
  }

  private estimateTokenDelta(context: ContextWindow): number {
    // Token difference between cached and uncached turns
    return 5000; // TODO: measure from telemetry
  }

  private estimateRemainingTurns(context: ContextWindow): number {
    // Estimate how many more turns will be needed
    return 10; // TODO: implement based on work queue
  }

  private calculateLossSlope(fullness: number): number {
    // Exponential loss curve: quality degrades faster beyond 70%
    if (fullness < 0.7) return 0;
    return Math.pow(fullness - 0.7, 2) * 10000; // Scaling factor
  }

  private estimateNaivePenalty(context: ContextWindow): number {
    // Penalty for naive-naive and naive-aware failures
    return 1000; // TODO: implement based on incident history
  }

  private cacheHitConfidence = 0.8;
}
```

---

### Phase 5: Adaptive Optimization

**Goal**: Continuously learn optimal aggressiveness

**Multi-Armed Bandit Approach**:
```typescript
class AdaptiveCompactionPolicy {
  private arms: Map<string, { pulls: number; rewards: number }>;

  selectArm(contextState: string): string {
    // Use epsilon-greedy or UCB to select compaction strategy
    return 'moderate'; // TODO: implement
  }

  updateReward(arm: string, reward: number): void {
    // Update bandit statistics
    // TODO: implement
  }
}
```

---

## Implementation Roadmap

### Week 1: Foundation (Low Risk)

**Tasks**:
1. [ ] Extend `CompactOptions` with smart compaction flags
2. [ ] Add `CompactionAnalysis` and `CompactionTelemetry` types to `types/src/context.ts`
3. [ ] Implement `analyzeForCompaction()` method in `context-window.ts`
4. [ ] Implement `extractNegativeConstraints()` method
5. [ ] Implement `identifyCrucialFiles()` method
6. [ ] Implement `buildExplorationHints()` method
7. [ ] Add telemetry hooks in `Orchestrator` and `Agent`
8. [ ] Write unit tests for analysis logic

**Deliverables**:
- Extended type definitions
- Analysis methods without side effects
- Telemetry collection infrastructure
- Test coverage for new methods

**Success Criteria**:
- All analysis methods return correct results
- Telemetry is captured on every compaction
- No regressions in existing functionality

---

### Week 2: Semantic Scoring (Medium Risk)

**Tasks**:
1. [ ] Create `ItemScorer` interface in new file `packages/context/src/scorer.ts`
2. [ ] Implement `DefaultItemScorer` with multi-dimensional scoring
3. [ ] Implement recency scoring
4. [ ] Implement interaction scoring (track recent references)
5. [ ] Implement artifact relevance scoring
6. [ ] Implement task relevance scoring (lightweight classifier)
7. [ ] Add integration tests with realistic scenarios
8. [ ] Add performance benchmarks

**Deliverables**:
- `ItemScorer` interface and `DefaultItemScorer` implementation
- Configurable scoring weights
- Test coverage for all scoring dimensions
- Performance benchmarks (target: <100ms for 100 items)

**Success Criteria**:
- Scoring produces consistent, deterministic results
- Scoring is performant (<100ms for typical context sizes)
- Test coverage demonstrates task-aware prioritization

---

### Week 3: Smart Distillation (Medium Risk)

**Tasks**:
1. [ ] Implement `distillContext()` function
2. [ ] Implement `summarizeActionLog()` function
3. [ ] Implement `reconstructContext()` function
4. [ ] Add `compactSmart()` method to `ContextWindow`
5. [ ] Integrate with existing `compact()` method (preserve backward compatibility)
6. [ ] Add integration tests for end-to-end compaction
7. [ ] Add E2E tests with realistic workloads

**Deliverables**:
- Complete distillation pipeline
- Smart compaction method
- Integration test suite
- E2E test scenarios

**Success Criteria**:
- Compacted context preserves >95% of constraints
- Compaction ratio achieves 3-6× token reduction
- No regressions in task completion rate

---

### Week 4: Decision Engine (High Risk)

**Tasks**:
1. [ ] Implement `CompactionDecisionEngine` class
2. [ ] Implement cache miss cost estimation
3. [ ] Implement token delta estimation
4. [ ] Implement remaining turns estimation
5. [ ] Implement loss slope calculation
6. [ ] Implement naive penalty estimation
7. [ ] Integrate with `Orchestrator` compaction triggers
8. [ ] Add safety thresholds and cooldown logic
9. [ ] Add rollback/snapshotting for safety
10. [ ] Write comprehensive tests

**Deliverables**:
- Complete decision engine
- Integration with orchestrator
- Safety mechanisms (rollback, cooldown)
- Comprehensive test coverage

**Success Criteria**:
- Decision engine makes sound compaction decisions
- Cache hit rate improves by >20%
- No increase in naive-naive incidents

---

### Week 5: Rollout & Optimization (Low Risk)

**Tasks**:
1. [ ] Add feature flags for gradual rollout
2. [ ] Implement monitoring dashboard
3. [ ] Add alerting for key metrics
4. [ ] Tune thresholds based on initial data
5. [ ] Document best practices
6. [ ] Create migration guide
7. [ ] Train team on new system

**Deliverables**:
- Feature flag infrastructure
- Monitoring and alerting
- Documentation
- Training materials

**Success Criteria**:
- Gradual rollout completes without incidents
- Metrics meet targets (>70% cache hit rate, <15% regret rate)
- Team is trained and documentation is complete

---

## Testing Strategy

### Unit Tests
- Each scoring dimension tested independently
- Analysis methods tested with synthetic data
- Edge cases (empty context, single item, etc.)

### Integration Tests
- End-to-end compaction with realistic context
- Interaction with orchestrator and agent
- Telemetry capture verification

### E2E Tests
- Real workloads (e.g., implementing a feature, debugging an issue)
- Measure actual token savings and task success rate
- Compare with baseline (mechanical compaction)

### Regression Tests
- Ensure existing functionality is preserved
- Test backward compatibility when smart compaction is disabled

---

## Performance Considerations

### Scoring Performance
- Target: <100ms for 100 items
- Use efficient data structures (Maps for lookups)
- Cache expensive operations (e.g., task relevance classification)

### Compaction Performance
- Target: <500ms for typical compaction
- Batch operations where possible
- Avoid unnecessary string operations

### Memory Overhead
- Limit analysis data structures to <10MB
- Use streaming for large contexts
- Clean up temporary data promptly

---

## Backward Compatibility

### Phase 1-2: No Breaking Changes
- New methods are additive
- Existing `compact()` method unchanged
- Smart compaction is opt-in via `enableSmartCompaction` flag

### Phase 3-4: Gradual Migration
- Default to mechanical compaction
- Gradually enable smart compaction with feature flags
- Monitor metrics and regressions

### Phase 5: Full Rollout
- Once metrics are validated, make smart compaction default
- Keep mechanical compaction as fallback option

---

## Open Questions

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

## Appendix: Existing Specifications

This plan synthesizes three existing specification documents:

1. **`docs/compaction-strategy-spec.md`** - Game-theoretic approach with cache-aware decisions
2. **`docs/compaction-strategy-embellishment.md`** - Semantic importance scoring system
3. **`docs/compaction-strategy-epistemology-spec.md`** - Epistemology-based distillation principles

These documents provide detailed technical specifications that this implementation plan operationalizes.

---

**Next Steps**:
1. Review and approve this plan
2. Assign ownership for each phase
3. Set up tracking for tasks and milestones
4. Begin Week 1 implementation