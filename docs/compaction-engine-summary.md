# Compaction Engine Plan Summary

## Problem Statement

Our current compaction implementation is **mechanical, not intelligent**. It removes context items based purely on:
- Age (remove items older than threshold)
- Count (LRU eviction)
- Path deduplication (keep newest per path)
- Output truncation

This leads to:
1. **Wasted tokens** on irrelevant context
2. **Re-exploration loops** when critical information was prematurely ejected
3. **Cache misses** from wholesale context rewrites
4. **Silent failures** (naive-naive) where agent loses essential state

## First Principles

1. **Epistemic Relevance** - Not all tokens are equal. Maximize information density.
2. **Negative Constraints** - "What not to do" is more compact than "what to do."
3. **Chronological Salience** - Old messages = negative constraints, new messages = actions.
4. **Exploration Cache** - Don't let agent re-explore what it already searched.
5. **Crucial File Protection** - Never eject task-critical files.

## Implementation Phases (5 Weeks)

### Week 1: Foundation (Observability)
- Add `CompactionAnalysis` and `CompactionTelemetry` types
- Implement analysis methods: `analyzeForCompaction()`, `extractNegativeConstraints()`, `identifyCrucialFiles()`, `buildExplorationHints()`
- Add telemetry hooks in Orchestrator and Agent

### Week 2: Semantic Scoring
- Create `ItemScorer` interface and `DefaultItemScorer` implementation
- Implement multi-dimensional scoring: recency, interaction, artifact relevance, task relevance
- Add performance benchmarks (target: <100ms for 100 items)

### Week 3: Smart Distillation
- Implement `distillContext()` and `reconstructContext()` functions
- Add `compactSmart()` method to ContextWindow
- Integrate with existing `compact()` (backward compatible)

### Week 4: Decision Engine
- Implement `CompactionDecisionEngine` with expected value heuristic
- Cache-aware decisions: balance token savings vs. cache miss costs
- Add safety thresholds, cooldown, and rollback

### Week 5: Rollout & Optimization
- Feature flags for gradual rollout
- Monitoring dashboard and alerting
- Tune thresholds based on production data

## Key Metrics

| Metric | Target |
|--------|--------|
| Cache Hit Rate | >70% |
| Compaction Ratio | 3-6× |
| Constraint Preservation | >95% |
| Exploration Cache Hit Rate | >80% |
| Crucial File Retention | 100% |
| Regret Rate | <15% |

## Architecture

```
ContextWindow
├── Phase 1: Analysis
│   ├── analyzeForCompaction()
│   ├── extractNegativeConstraints()
│   ├── identifyCrucialFiles()
│   └── buildExplorationHints()
│
├── Phase 2: Scoring
│   ├── ItemScorer interface
│   └── DefaultItemScorer (recency, interaction, artifact, task)
│
├── Phase 3: Distillation
│   ├── distillContext()
│   ├── reconstructContext()
│   └── compactSmart()
│
└── Phase 4: Decision Engine
    └── CompactionDecisionEngine (EV heuristic)
```

## Next Steps

1. **Review and approve** the full implementation plan
2. **Assign ownership** for each phase
3. **Set up tracking** for tasks and milestones
4. **Begin Week 1** implementation

## Files to Create/Modify

**New Files:**
- `packages/context/src/scorer.ts` - ItemScorer interface and DefaultItemScorer
- `packages/context/src/distillation.ts` - Distillation functions
- `packages/context/src/decision-engine.ts` - CompactionDecisionEngine

**Modified Files:**
- `packages/types/src/context.ts` - Add new types (CompactionAnalysis, etc.)
- `packages/context/src/context-window.ts` - Add analysis and smart compaction methods
- `packages/orchestrator/src/orchestrator.ts` - Integrate decision engine
- `packages/agent/src/agent.ts` - Use smart compaction when available

## Documentation

See `docs/compaction-engine-implementation-plan.md` for the complete 750-line specification including:
- Detailed first principles
- Full type definitions
- Algorithm pseudocode
- Testing strategy
- Performance considerations
- Backward compatibility plan
- Open questions and research areas