# PATCH SPEC: Eliminate O(n) Hot Path Operations in ContextWindow

## Problem Statement

Every `addMessage()`, `addArtifact()`, and `updateMetrics()` call triggers O(n) array scans.
At 1000+ items, this becomes measurable latency on every LLM turn.

## Design Principles

- `_items` stays as array (source of truth, cache-friendly iteration)
- Add secondary indices for O(1) hot path operations
- Indices are derived state - rebuilt after destructive operations (compact, eject)
- Ejection/compact continue to scan the array directly (not hot path, cache-friendly)

## New Internal Indices

```typescript
// Incremental counts - eliminates filter().length patterns
private _countsByType: Map<ContextItemType, number> = new Map();

// Artifact dedupe index - path -> (name:line -> artifact)
// Eliminates O(n) scan in orchestrator's artifact_discovered handler
private _artifactsByPath: Map<string, Map<string, ArtifactItem>> = new Map();

// File content index - path -> Set<id>
// Enables O(1) check for "any remaining items for this path?"
private _fileContentByPath: Map<string, Set<string>> = new Map();
```

## Method Changes

### `addMessage(role, content)`
**Before:** `this._items.filter(i => i.type === 'message').length`
**After:** `this._countsByType.set('message', (this._countsByType.get('message') ?? 0) + 1)`

### `addFunctionCall()`, `addFunctionCallOutput()`, `addReasoning()`
**Add:** Increment `_countsByType` for respective type.

### `addFileContent(path, content, language)`
**Add:**
```typescript
const pathSet = this._fileContentByPath.get(path) ?? new Set();
pathSet.add(id);
this._fileContentByPath.set(path, pathSet);
this._countsByType.set('file_content', (this._countsByType.get('file_content') ?? 0) + 1);
```

### `addArtifact(artifact)` - CHANGES BEHAVIOR
**Before:** Always adds, returns id. Dedupe happens externally in orchestrator.
**After:** Returns existing id if duplicate, only adds if new.

```typescript
addArtifact(artifact): string {
  const compositeKey = `${artifact.name}:${artifact.line ?? 0}`;
  const pathMap = this._artifactsByPath.get(artifact.sourcePath);

  if (pathMap?.has(compositeKey)) {
    return pathMap.get(compositeKey)!.id; // Already exists - O(1)
  }

  // New artifact - add to items and indices
  const id = `art_${this.sessionKey.slice(0, 4)}_${++this._artifactCounter}`;
  const full: ArtifactItem = { type: 'artifact', id, ...artifact, timestamp: Date.now() };

  this._items.push(full);

  const newPathMap = pathMap ?? new Map();
  newPathMap.set(compositeKey, full);
  this._artifactsByPath.set(artifact.sourcePath, newPathMap);

  this._countsByType.set('artifact', (this._countsByType.get('artifact') ?? 0) + 1);
  this._version++;
  this._onArtifactAdded?.(full);

  return id;
}
```

### `getArtifacts()`
**Before:** `this._items.filter(...)`
**After:** Flatten `_artifactsByPath` values (still O(artifacts) but only when called, not on add)

### `getArtifactsByPath(sourcePath)`
**Before:** `this.getArtifacts().filter(a => a.sourcePath === sourcePath)`
**After:** `Array.from(this._artifactsByPath.get(sourcePath)?.values() ?? [])` - O(1) lookup

### `getArtifactsByKind(kind)`
Keep as filter over `getArtifacts()` - not on hot path, rarely called.

### `updateMetrics(promptTokens, completionTokens)`
**Before:** `this._items.filter(i => i.type === 'message').length`
**After:** `this._countsByType.get('message') ?? 0`

### `ejectFileContentByPath(path)`
**Before:** Filter + rebuild `_items`, check if any remaining via filter
**After:**
```typescript
const ids = this._fileContentByPath.get(path);
if (!ids?.size) return { ejectedCount: 0, ejectedIds: [], pathsRemoved: [] };

// Remove from _items (still O(n) but ejection is NOT hot path)
this._items = this._items.filter(item =>
  !(item.type === 'file_content' && ids.has(item.id))
);

// Update indices - O(1)
this._countsByType.set('file_content',
  (this._countsByType.get('file_content') ?? 0) - ids.size);
this._fileContentByPath.delete(path);
this._readFiles.delete(path);
```

### `ejectFileContentById(id)`
Similar pattern - lookup path from item, update indices.

### `compact(options)`
**After compaction:** Rebuild all indices from `_items`.
This is acceptable - compact is infrequent and already O(n).

```typescript
private rebuildIndices(): void {
  this._countsByType.clear();
  this._artifactsByPath.clear();
  this._fileContentByPath.clear();

  for (const item of this._items) {
    this._countsByType.set(item.type, (this._countsByType.get(item.type) ?? 0) + 1);

    if (item.type === 'artifact') {
      const key = `${item.name}:${item.line ?? 0}`;
      const pathMap = this._artifactsByPath.get(item.sourcePath) ?? new Map();
      pathMap.set(key, item);
      this._artifactsByPath.set(item.sourcePath, pathMap);
    }

    if (item.type === 'file_content') {
      const pathSet = this._fileContentByPath.get(item.path) ?? new Set();
      pathSet.add(item.id);
      this._fileContentByPath.set(item.path, pathSet);
    }
  }
}
```

### `serialize()` / `deserialize()`
Indices are NOT serialized. Call `rebuildIndices()` after deserialize.

```typescript
static deserialize(snapshot: ContextWindowSnapshot): ContextWindow {
  const context = new ContextWindow(snapshot.sessionKey, snapshot.maxTokens);
  context._items = [...snapshot.items];
  context._metrics = { ...snapshot.metrics };
  context._version = snapshot.version;
  context._readFiles = new Set(snapshot.readFiles);
  context._fileContentCounter = snapshot.fileContentCounter ?? 0;
  context.rebuildIndices(); // NEW
  return context;
}
```

### `toTelemetry()`
**Before:** Builds `itemsByType` via iteration
**After:** Clone `_countsByType` into object form

## Orchestrator Changes

### `execute()` artifact_discovered handler (lines 183-201)
**DELETE the dedupe logic entirely.** `addArtifact()` now handles it.

```typescript
// BEFORE
const existing = context.getArtifactsByPath(data.artifact.sourcePath);
const isDuplicate = existing.some(e =>
  e.name === data.artifact.name && e.line === data.artifact.line
);
if (!isDuplicate) {
  context.addArtifact({...});
}

// AFTER
context.addArtifact({...}); // Dedupe is internal, returns existing id if dup
```

## Complexity Summary

| Operation | Before | After |
|-----------|--------|-------|
| `addMessage()` | O(n) | O(1) |
| `addArtifact()` | O(1) + O(n) external | O(1) |
| `updateMetrics()` | O(n) | O(1) |
| `getArtifactsByPath()` | O(n) | O(1) |
| `ejectFileContentByPath()` | O(n) | O(n) - unchanged, not hot path |
| `compact()` | O(n) | O(n) + rebuild - unchanged, not hot path |
| `deserialize()` | O(1) | O(n) rebuild - acceptable, rare |

## Test Cases to Add

1. `addArtifact` returns same id for duplicate (same path + name + line)
2. `addArtifact` returns new id for same path, different name
3. `getArtifactsByPath` returns correct artifacts after adds
4. `ejectFileContentByPath` correctly updates `_countsByType`
5. `compact` + subsequent adds work correctly (indices rebuilt)
6. `deserialize` + subsequent `getArtifactsByPath` works (indices rebuilt)
7. `_onArtifactAdded` callback only fires for new artifacts, not duplicates

## Files Modified

- `packages/context/src/context-window.ts` - main changes
- `packages/orchestrator/src/orchestrator.ts` - delete dedupe logic in artifact_discovered handler
