# Patch Spec: Type Consolidation & Artifact Separation

## Issues

### 1. Type Scattering
- `ContextItem` types in `packages/types/src/context.ts`
- `ContextWindow` class in `packages/context/src/context-window.ts`

**Current state is actually correct** for a monorepo: types in `types/` package, implementations import from there. Both files have a single responsibility. No change needed here.

### 2. Artifact Mixed Concerns
`ArtifactItem` mixes LLM payload fields with system metadata in one flat interface:

```typescript
// Currently mixed together:
interface ArtifactItem {
  type: 'artifact';

  // LLM payload (sent to model)
  sourcePath: string;
  line?: number;
  kind: ArtifactKind;
  name: string;
  signature?: string;
  modifies?: string[];
  calls?: string[];
  insight?: string;

  // System metadata (internal tracking)
  id: string;
  relevance: number;
  discoveredBy: string;
  timestamp: number;
  reduces?: UncertaintyCategory;
}
```

`formatArtifactForLLM()` already strips metadata at runtime, but the type doesn't express this separation.

---

## Patch: Split ArtifactItem into Two Types

**File:** `packages/types/src/context.ts`

```typescript
/** LLM-facing artifact payload - what gets formatted for the model */
export interface ArtifactPayload {
  sourcePath: string;
  line?: number;
  kind: ArtifactKind;
  name: string;
  signature?: string;
  modifies?: string[];
  calls?: string[];
  insight?: string;
}

/** Full artifact item = payload + system fields */
export interface ArtifactItem extends ArtifactPayload {
  type: 'artifact';
  id: string;
  relevance: number;
  discoveredBy: string;
  timestamp: number;
  reduces?: UncertaintyCategory;
}
```

**Downstream:**

- `addArtifact(artifact: ArtifactPayload & { relevance?: number; reduces?: UncertaintyCategory })`
- `formatArtifactForLLM(payload: ArtifactPayload): string`

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/types/src/context.ts` | Add `ArtifactPayload`, refactor `ArtifactItem` to extend it |
| `packages/types/src/index.ts` | Export `ArtifactPayload` |
| `packages/context/src/context-window.ts` | Update `addArtifact()` signature, `formatArtifactForLLM()` param type |

---

## Not Changing

- File organization (types in `types/`, implementation in `context/`) - this is correct
- `formatArtifactForLLM()` logic - already strips metadata
- Event schemas - `artifact_discovered` already sends subset of fields
