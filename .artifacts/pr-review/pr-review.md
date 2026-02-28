<!-- nova-pr-review -->
## Entity Graph PR Review

Compared `ca77d8cd...f2b839b6` with max depth `2`.

Summary: 40 entities changed; 12 direct and 0 transitive dependents affected; 20 warnings.

### Counts
- Changed entities: 40
- Blast radius (direct): 12
- Blast radius (transitive): 0
- Risk signals: 42 (critical 0, warning 20)
- Contract impact gaps: 0
- Dead code candidates: 29

### Top Risks
| Score | Entity | File | Key factor |
|---:|---|---|---|
| 61 | `EntityGraph.entitiesAtLines` | `packages/plugins/entity-graph/src/index.ts` | directly signature changed |
| 61 | `EntityGraph.entityBlastRadius` | `packages/plugins/entity-graph/src/index.ts` | directly signature changed |
| 61 | `EntityGraph.graphStats` | `packages/plugins/entity-graph/src/index.ts` | directly signature changed |
| 61 | `EntityGraph.reviewDiff` | `packages/plugins/entity-graph/src/index.ts` | directly signature changed |
| 61 | `EntityGraph.unusedExports` | `packages/plugins/entity-graph/src/index.ts` | directly signature changed |
| 60 | `BlastRadiusEntry` | `packages/plugins/entity-graph/src/queries.ts` | directly signature changed |
| 50 | `entitiesAtLines` | `packages/plugins/entity-graph/src/queries.ts` | directly signature changed |
| 50 | `entityBlastRadius` | `packages/plugins/entity-graph/src/queries.ts` | directly signature changed |
| 48 | `classifyChanges` | `packages/plugins/entity-graph/src/pr-review/classifier.ts` | directly entity added |
| 48 | `parseDiff` | `packages/plugins/entity-graph/src/pr-review/diff.ts` | directly entity added |
| 48 | `reviewDiff` | `packages/plugins/entity-graph/src/pr-review/review.ts` | directly entity added |
| 48 | `scoreRisks` | `packages/plugins/entity-graph/src/pr-review/scorer.ts` | directly entity added |

### Changed Entities
- `body_changed` `EntityGraph` in `packages/plugins/entity-graph/src/index.ts`
- `signature_changed` `EntityGraph.unusedExports` in `packages/plugins/entity-graph/src/index.ts`
- `signature_changed` `EntityGraph.entitiesAtLines` in `packages/plugins/entity-graph/src/index.ts`
- `signature_changed` `EntityGraph.entityBlastRadius` in `packages/plugins/entity-graph/src/index.ts`
- `signature_changed` `EntityGraph.graphStats` in `packages/plugins/entity-graph/src/index.ts`
- `signature_changed` `EntityGraph.reviewDiff` in `packages/plugins/entity-graph/src/index.ts`
- `entity_added` `classifyChanges` in `packages/plugins/entity-graph/src/pr-review/classifier.ts`
- `entity_added` `syntheticFileEntity` in `packages/plugins/entity-graph/src/pr-review/classifier.ts`
- `entity_added` `inferChangeKind` in `packages/plugins/entity-graph/src/pr-review/classifier.ts`
- `entity_added` `parseDiff` in `packages/plugins/entity-graph/src/pr-review/diff.ts`
- `entity_added` `parseFileDiff` in `packages/plugins/entity-graph/src/pr-review/diff.ts`
- `entity_added` `parseHunkHeader` in `packages/plugins/entity-graph/src/pr-review/diff.ts`
- `entity_added` `packages/plugins/entity-graph/src/pr-review/index.ts` in `packages/plugins/entity-graph/src/pr-review/index.ts`
- `entity_added` `reviewDiff` in `packages/plugins/entity-graph/src/pr-review/review.ts`
- `entity_added` `dedupeBlastEntries` in `packages/plugins/entity-graph/src/pr-review/review.ts`
- `entity_added` `dedupeEntitiesById` in `packages/plugins/entity-graph/src/pr-review/review.ts`
- `entity_added` `buildSummary` in `packages/plugins/entity-graph/src/pr-review/review.ts`
- `entity_added` `computeImpactGaps` in `packages/plugins/entity-graph/src/pr-review/review.ts`
- `entity_added` `scoreRisks` in `packages/plugins/entity-graph/src/pr-review/scorer.ts`
- `entity_added` `seedSeverityByEntity` in `packages/plugins/entity-graph/src/pr-review/scorer.ts`
- ...and 20 more

### Dead Code Candidates
- `EntityGraph` in `packages/plugins/entity-graph/src/index.ts`
- `EntityGraph.constructor` in `packages/plugins/entity-graph/src/index.ts`
- `EntityGraph.initialize` in `packages/plugins/entity-graph/src/index.ts`
- `EntityGraph.waitForScan` in `packages/plugins/entity-graph/src/index.ts`
- `EntityGraph.getHooks` in `packages/plugins/entity-graph/src/index.ts`
- `EntityGraph.reparse` in `packages/plugins/entity-graph/src/index.ts`
- `classifyChanges` in `packages/plugins/entity-graph/src/pr-review/classifier.ts`
- `parseDiff` in `packages/plugins/entity-graph/src/pr-review/diff.ts`
- `reviewDiff` in `packages/plugins/entity-graph/src/pr-review/review.ts`
- `scoreRisks` in `packages/plugins/entity-graph/src/pr-review/scorer.ts`
- `FileChange` in `packages/plugins/entity-graph/src/pr-review/types.ts`
- `Hunk` in `packages/plugins/entity-graph/src/pr-review/types.ts`
- `ChangeKind` in `packages/plugins/entity-graph/src/pr-review/types.ts`
- `EntityChange` in `packages/plugins/entity-graph/src/pr-review/types.ts`
- `RiskSignal` in `packages/plugins/entity-graph/src/pr-review/types.ts`
- `ImpactGap` in `packages/plugins/entity-graph/src/pr-review/types.ts`
- `PRReview` in `packages/plugins/entity-graph/src/pr-review/types.ts`
- `entitiesInFile` in `packages/plugins/entity-graph/src/queries.ts`
- `entityById` in `packages/plugins/entity-graph/src/queries.ts`
- `importersOfFile` in `packages/plugins/entity-graph/src/queries.ts`
- ...and 9 more