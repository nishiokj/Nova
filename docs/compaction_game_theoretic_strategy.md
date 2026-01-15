# Optimal Compaction Strategy: Game Theoretic Approach

## Executive Summary

This document outlines a game-theoretic framework for making optimal context compaction decisions under uncertainty. The problem is framed as a sequential decision-making problem where at each turn we must decide whether to compact the context, balancing the immediate cost of compaction against the long-term benefit of reduced token usage.

---

## Problem Formalization

### Core Tradeoff

**Compaction Cost vs. Cached Tokens Benefit**

- **Compaction Cost**: Uncached summarization tokens added to context
- **Cached Benefit**: Reusing cached turn logs instead of summarization in future turns

At each decision point, we face a tradeoff:
- **Don't compact**: Continue paying full token cost for all historical context
- **Compact**: Pay summary generation cost now, but reduce future costs by using cached logs

### Key Variables

| Variable | Definition | Typical Range | Impact |
|----------|------------|---------------|--------|
| **Q** | Cost difference between cached and uncached tokens per turn | 100-500 tokens/turn | Higher Q favors earlier compaction |
| **D** | Division factor (how much we reduce context size when compacting) | 2-10x | Higher D reduces per-turn cost but increases summary generation cost |
| **K** | Fraction of remaining context that will be cached after compaction | 0.0-0.2 (summarization) | Lower K means more aggressive summarization |
| **M** | Number of remaining turns (future horizon) | 1-100 (estimated) | Higher M amortizes compaction cost better |

### Notation

- **C**: Current context size (tokens)
- **S**: Summary generation cost (tokens) - typically proportional to C/D
- **R**: Cached turns remaining after compaction = K × C
- **U**: Uncached summary tokens = C/D - R
- **T**: Turns elapsed so far
- **N**: Total expected turns (T + M)

---

## Decision Model

### Immediate Compaction Decision

At turn `t`, with `M` remaining turns, should we compact?

**Expected Value of Compacting Now:**

```
EV_compact = -S + Σ_{i=1 to M} [Q × min(i, R/turn_size)] - (C/D × i × cost_per_token)
```

Where:
- `-S`: Immediate summary generation cost
- `Q × min(i, R/turn_size)`: Benefit from cached turns (diminishes as cache is consumed)
- `C/D × i × cost_per_token`: Cost of uncached summary tokens per future turn

**Expected Value of Not Compacting:**

```
EV_no_compact = Σ_{i=1 to M} [C × cost_per_token × decay_factor^i]
```

Where `decay_factor` captures diminishing relevance of older context.

**Decision Rule:**

```
Compact if: EV_compact > EV_no_compact
```

### Simplified Heuristic

For practical implementation, use a threshold-based rule:

```
Compact if:
  (C × Q × M × P_cache_exhaustion) > (S × cost_multiplier)
```

Where:
- `P_cache_exhaustion`: Probability cache will be consumed before session ends
- `cost_multiplier`: Risk aversion factor (typically 1.2-1.5)

---

## Uncertainty Handling

### Unknown M (Remaining Turns)

**Problem**: We don't know how many turns remain in the conversation.

**Approaches:**

1. **Conservative Estimate** (Default):
   - Assume `M = current_turn_count` (conversation is halfway done)
   - Use `M = max(3, current_turn_count)` for early turns

2. **Adaptive Estimation**:
   - Track conversation length distribution in similar sessions
   - Use `M = E[remaining | current_turn, domain, user]`
   - Update estimate as conversation progresses

3. **Uncertainty Penalty**:
   - Apply penalty factor to EV_compact when M confidence is low
   - `EV_compact_adjusted = EV_compact × (confidence_score - uncertainty_penalty)`

### Unknown D (Effective Division)

**Problem**: We don't know exactly how much the summary will reduce context size.

**Approaches:**

1. **Empirical Calibration**:
   - Measure actual `D` across past compactions
   - Use distribution: `D ~ N(μ_D, σ_D)`
   - Use `D = μ_D - σ_D` (conservative) for decision

2. **Model-Based Estimation**:
   - Use LLM token count estimator on summary draft
   - `D_estimated = C / estimated_summary_tokens`

3. **Safety Margin**:
   - Assume worst-case `D = 2` (summary is half of original)
   - Only compact if decision holds with `D = 2`

### Unknown K (Cache Hit Rate)

**Problem**: We don't know how much cached content will be relevant.

**Approaches:**

1. **Cache Relevance Prediction**:
   - Track which cached turns get referenced in subsequent turns
   - Use embedding similarity: `relevance_score = cos_sim(summary_embedding, turn_embedding)`
   - `K_effective = K × avg_relevance_score`

2. **Conservative Assumption**:
   - For summarization-based compaction, assume `K ≈ 0.05` (5% of context remains directly relevant)

---

## Optimal Strategy

### Strategy 1: Threshold-Based (Simple)

```typescript
function shouldCompact(
  currentContextTokens: number,
  turnsElapsed: number,
  estimatedRemainingTurns: number,
  cacheCostDiff: number, // Q
): boolean {
  // Conservative estimate for M
  const M = Math.max(3, estimatedRemainingTurns);
  
  // Expected benefit from caching
  const expectedBenefit = cacheCostDiff * M * 0.5; // 0.5 = avg cache hit rate
  
  // Summary generation cost (estimated)
  const summaryCost = currentContextTokens / 8; // Assume 8x compression
  
  // Risk multiplier (avoids premature compaction)
  const riskMultiplier = 1.3;
  
  return expectedBenefit > summaryCost * riskMultiplier;
}
```

### Strategy 2: Expected Value (More Sophisticated)

```typescript
interface CompactionDecision {
  shouldCompact: boolean;
  confidence: number; // 0-1
  reasoning: string;
}

function makeCompactionDecision(
  context: ContextWindow,
  turnsElapsed: number,
  historical: TurnHistory,
): CompactionDecision {
  const C = context.estimateTokenUsage();
  const Q = getCacheCostDiff(historical);
  const M_estimate = estimateRemainingTurns(historical);
  const D_estimate = estimateDivisionFactor(historical);
  const K_estimate = 0.05; // Conservative for summarization
  
  // Calculate EV_compact
  const S = C / D_estimate; // Summary cost
  const R = C * K_estimate; // Cached tokens
  const cacheBenefit = Q * Math.min(M_estimate, R / 100); // Assume 100 tokens/turn avg
  
  const EV_compact = -S + cacheBenefit;
  
  // Calculate EV_no_compact
  const decayFactor = 0.9; // Older context less relevant
  let EV_no_compact = 0;
  for (let i = 1; i <= M_estimate; i++) {
    EV_no_compact += C * Math.pow(decayFactor, i);
  }
  
  // Apply uncertainty penalty
  const uncertainty = calculateUncertainty(M_estimate, D_estimate);
  const EV_compact_adjusted = EV_compact * (1 - uncertainty * 0.3);
  
  const shouldCompact = EV_compact_adjusted > EV_no_compact;
  const confidence = calculateConfidence(M_estimate, D_estimate, historical);
  
  return {
    shouldCompact,
    confidence,
    reasoning: `EV_compact=${EV_compact_adjusted.toFixed(0)}, EV_no_compact=${EV_no_compact.toFixed(0)}, M=${M_estimate}, D=${D_estimate.toFixed(1)}`,
  };
}

function getCacheCostDiff(history: TurnHistory): number {
  // Average tokens saved per turn when using cached context
  const cachedTurns = history.turns.filter(t => t.usedCache);
  const uncachedTurns = history.turns.filter(t => !t.usedCache);
  
  if (cachedTurns.length === 0 || uncachedTurns.length === 0) return 200; // Default
  
  const avgCached = cachedTurns.reduce((sum, t) => sum + t.tokens, 0) / cachedTurns.length;
  const avgUncached = uncachedTurns.reduce((sum, t) => sum + t.tokens, 0) / uncachedTurns.length;
  
  return avgUncached - avgCached;
}

function estimateRemainingTurns(history: TurnHistory): number {
  // Use historical distribution for similar sessions
  const similarSessions = history.getSimilarSessions();
  if (similarSessions.length < 3) return Math.max(5, history.turns.length);
  
  const avgLength = similarSessions.reduce((sum, s) => sum + s.totalTurns, 0) / similarSessions.length;
  return Math.max(5, avgLength - history.turns.length);
}

function estimateDivisionFactor(history: TurnHistory): number {
  // Historical compression ratio from past compactions
  const pastCompactions = history.getPastCompactions();
  if (pastCompactions.length === 0) return 4; // Default assumption
  
  const avgRatio = pastCompactions.reduce((sum, c) => sum + c.compressionRatio, 0) / pastCompactions.length;
  return avgRatio;
}
```

### Strategy 3: Multi-Armed Bandit (Adaptive)

Treat different compaction strategies as "arms" and use exploration-exploitation:

```typescript
class CompactionBandit {
  private arms: Map<string, { pulls: number; reward: number[] }> = new Map();
  
  // Strategies: "aggressive", "moderate", "conservative", "none"
  private strategies = [
    { name: "none", threshold: Infinity },
    { name: "conservative", threshold: 150000 },
    { name: "moderate", threshold: 100000 },
    { name: "aggressive", threshold: 70000 },
  ];
  
  selectStrategy(contextTokens: number): string {
    // Upper Confidence Bound (UCB1)
    let bestArm = "none";
    let bestUCB = -Infinity;
    
    for (const strategy of this.strategies) {
      if (contextTokens < strategy.threshold) {
        const stats = this.arms.get(strategy.name) || { pulls: 0, reward: [] };
        const ucb = this.calculateUCB(stats);
        if (ucb > bestUCB) {
          bestUCB = ucb;
          bestArm = strategy.name;
        }
      }
    }
    
    return bestArm;
  }
  
  updateReward(strategy: string, reward: number): void {
    const stats = this.arms.get(strategy) || { pulls: 0, reward: [] };
    stats.pulls++;
    stats.reward.push(reward);
    this.arms.set(strategy, stats);
  }
  
  private calculateUCB(stats: { pulls: number; reward: number[] }): number {
    if (stats.pulls === 0) return Infinity;
    
    const avgReward = stats.reward.reduce((a, b) => a + b, 0) / stats.reward.length;
    const totalPulls = Array.from(this.arms.values()).reduce((sum, s) => sum + s.pulls, 0);
    const exploration = Math.sqrt(2 * Math.log(totalPulls) / stats.pulls);
    
    return avgReward + exploration;
  }
}
```

---

## Implementation Architecture

### Components

```
┌─────────────────────────────────────────────────────────────────┐
│                    CompactionDecisionEngine                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Estimator   │  │  Estimator   │  │  Estimator           │  │
│  │  Module      │  │  Module      │  │  Module              │  │
│  │              │  │              │  │                      │  │
│  │ • M (turns)  │  │ • D (ratio)  │  │ • Q (cache diff)     │  │
│  │ • confidence │  │ • confidence │  │ • history based      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│           │                  │                    │             │
│           └──────────────────┼────────────────────┘             │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Decision Model                                            │ │
│  │  • Threshold-based (fallback)                              │ │
│  │  • Expected value (primary)                                │ │
│  │  • Bandit (adaptive)                                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Action Selector                                           │ │
│  │  • compact() or defer()                                    │ │
│  │  • confidence threshold check                              │ │
│  │  • safety overrides                                        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Integration with ContextWindow

```typescript
class ContextWindow {
  // ... existing code ...
  
  private compactionEngine: CompactionDecisionEngine;
  private turnHistory: TurnHistory;
  
  /**
   * Check if compaction is recommended at this point.
   * Called automatically before adding new content.
   */
  shouldCompactNow(): { shouldCompact: boolean; reason: string } {
    const decision = this.compactionEngine.makeDecision({
      currentTokens: this.estimateTokenUsage(),
      turnCount: this._metrics.messageCount / 2, // Approximate
      history: this.turnHistory,
    });
    
    return {
      shouldCompact: decision.shouldCompact,
      reason: decision.reasoning,
    };
  }
  
  /**
   * Compact with optimal parameters based on game theory.
   */
  compactOptimal(): CompactResult {
    const decision = this.compactionEngine.makeDecision({
      currentTokens: this.estimateTokenUsage(),
      turnCount: this._metrics.messageCount / 2,
      history: this.turnHistory,
    });
    
    if (!decision.shouldCompact) {
      return {
        itemsRemoved: 0,
        fileContentRemoved: 0,
        outputsTruncated: 0,
        bytesRecovered: 0,
      };
    }
    
    // Determine optimal D based on decision
    const D = decision.parameters?.divisionFactor || 4;
    const targetSize = Math.ceil(this.estimateTokenUsage() / D);
    
    return this.compact({
      maxFileContentAgeMs: this.calculateOptimalAgeThreshold(),
      maxFileContentCount: this.calculateOptimalFileCount(),
      truncateOutputsTo: this.calculateOptimalOutputTruncation(),
    });
  }
  
  private calculateOptimalAgeThreshold(): number {
    // Older files less likely to be relevant
    const turnCount = this._metrics.messageCount / 2;
    return turnCount * 60000; // 1 minute per turn
  }
  
  private calculateOptimalFileCount(): number | undefined {
    // Keep recent files that are likely to be referenced
    const recentTurns = 5;
    return recentTurns * 3; // Assume 3 files per turn
  }
  
  private calculateOptimalOutputTruncation(): number | undefined {
    //truncate outputs that are likely tool results
    return 500;
  }
}
```

### Turn History Tracking

```typescript
interface TurnHistory {
  turns: TurnRecord[];
  compactions: CompactionRecord[];
}

interface TurnRecord {
  turnIndex: number;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  usedCache: boolean;
  cacheHitTokens?: number;
  filesRead: string[];
}

interface CompactionRecord {
  turnIndex: number;
  contextSizeBefore: number;
  contextSizeAfter: number;
  divisionFactor: number;
  summaryTokens: number;
  cachedTokens: number;
  reward: number; // Net benefit observed
}

class TurnHistoryTracker {
  private history: TurnHistory = { turns: [], compactions: [] };
  
  recordTurn(record: Omit<TurnRecord, 'turnIndex'>): void {
    this.history.turns.push({
      turnIndex: this.history.turns.length,
      ...record,
    });
  }
  
  recordCompaction(record: Omit<CompactionRecord, 'turnIndex'>): void {
    this.history.compactions.push({
      turnIndex: this.history.turns.length,
      ...record,
    });
  }
  
  getAverageTurnLength(): number {
    return this.history.turns.length;
  }
  
  getCacheCostDiff(): number {
    const cached = this.history.turns.filter(t => t.usedCache);
    const uncached = this.history.turns.filter(t => !t.usedCache);
    
    if (cached.length === 0 || uncached.length === 0) return 200;
    
    const avgCached = cached.reduce((s, t) => s + t.inputTokens, 0) / cached.length;
    const avgUncached = uncached.reduce((s, t) => s + t.inputTokens, 0) / uncached.length;
    
    return avgUncached - avgCached;
  }
  
  getPastCompactions(): CompactionRecord[] {
    return this.history.compactions;
  }
}
```

---

## Practical Recommendations

### Phase 1: Conservative Baseline (Immediate)

1. **Implement threshold-based compaction**:
   - Compact when context > 100,000 tokens AND turns > 10
   - Use simple logic: `shouldCompact = tokens > 100_000 && turns > 10`
   
2. **Track basic metrics**:
   - Turn count per session
   - Context size before/after compaction
   - Cache hit rate (if using KV cache)

3. **Add safety limits**:
   - Never compact if turns < 5 (insufficient history)
   - Never compact more than once per 5 turns
   - Never compact if estimated M < 3

### Phase 2: Expected Value Model (Short-term)

1. **Implement estimator modules**:
   - `estimateRemainingTurns()` based on historical distribution
   - `estimateDivisionFactor()` from past compactions
   - `calculateCacheCostDiff()` from token usage

2. **Add confidence scoring**:
   - Low confidence (< 0.5) → defer to threshold-based
   - Medium confidence (0.5-0.7) → use with safety margin
   - High confidence (> 0.7) → trust the decision

3. **Implement decision logging**:
   - Log all decisions with parameters
   - Track actual vs. expected outcomes
   - Use for model refinement

### Phase 3: Adaptive Learning (Long-term)

1. **Implement bandit strategy**:
   - Start with uniform exploration
   - Gradually shift to exploitation
   - A/B test different strategies

2. **Add session clustering**:
   - Group sessions by domain, user, task type
   - Learn optimal parameters per cluster
   - Personalize compaction thresholds

3. **Implement continuous improvement**:
   - Weekly analysis of compaction decisions
   - Retrain estimators with new data
   - A/B test new decision models

---

## Edge Cases and Failures

### When NOT to Compact

| Condition | Reason | Action |
|-----------|--------|--------|
| Turns < 5 | Insufficient history for meaningful summary | Defer |
| Estimated M < 3 | Compaction cost won't amortize | Defer |
| High uncertainty (> 0.7) | Decision too unreliable | Use conservative threshold |
| Recent file writes | Context likely needed soon | Defer |
| Low Q (< 50) | Cache benefit too small | Defer |

### Failure Modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Over-compaction | Context quality degradation detected | Restore from snapshot, recompact with higher K |
| Under-compaction | Context exceeds maxTokens | Emergency compaction with D=2 |
| Poor estimate | Actual M deviates > 50% from estimate | Adjust confidence score, re-estimate |
| Cache miss | Cached content not referenced | Reduce K for future compactions |

---

## Evaluation Metrics

### Decision Quality

- **Precision**: Fraction of compactions that were beneficial (reward > 0)
- **Recall**: Fraction of beneficial opportunities captured
- **Regret**: Difference from optimal decisions in hindsight

### Cost Impact

- **Token Savings**: `(tokens_without_compaction - tokens_with_compaction) / tokens_without_compaction`
- **Summary Overhead**: `summary_tokens / total_tokens`
- **Net Savings**: `token_savings - summary_overhead`

### User Experience

- **Latency Impact**: Additional latency from summary generation
- **Quality Impact**: Task success rate with/without compaction
- **Context Relevance**: Fraction of cached content actually used

---

## Open Questions

1. **What's the minimum viable Q?** At what cache benefit does compaction make sense?
2. **How to measure cache hit rate?** Without KV cache visibility, how do we estimate K?
3. **Should we compact proactively or reactively?** Wait for pressure or anticipate it?
4. **How to handle multi-agent sessions?** Different agents may have different optimal strategies.
5. **What's the role of user signals?** Can we detect user frustration with long contexts?

---

## References

1. **Multi-Armed Bandits**: Sutton & Barto, "Reinforcement Learning: An Introduction"
2. **Sequential Decision Making**: Puterman, "Markov Decision Processes"
3. **Context Window Optimization**: Various LLM caching strategies (Anthropic, OpenAI)
4. **Game Theory in Systems**: Kleinberg & Oren, "Strategic Reasoning in Systems"

