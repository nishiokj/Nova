# Entity Graph Panel — Implementation Spec

## Overview

The Packet panel in plain (non-async, non-document) chat mode becomes a **live entity graph visualizer**. As the agent works, the panel renders an interactive subgraph of the entities being touched and their structural relationships, sourced entirely from the `entity_graph` Postgres schema.

No model overhead. The agent writes code naturally, mentions entities by name in its output. We extract those mentions, resolve them against GraphD, expand their edges, and render the subgraph.

---

## Architecture

```
Assistant messages
       │
       ▼
┌──────────────┐     ┌────────────────────┐     ┌─────────────────┐
│  Extraction  │────▶│  GraphD Resolution │────▶│  Subgraph API   │
│  (regex/     │     │  (entity_graph.    │     │  /cockpit/       │
│   heuristic) │     │   entities + edges)│     │   entity-graph/  │
└──────────────┘     └────────────────────┘     │   subgraph       │
                                                 └────────┬────────┘
                                                          │
                                                          ▼
                                                 ┌─────────────────┐
                                                 │  Frontend Graph  │
                                                 │  (D3 force /    │
                                                 │   dagre toggle)  │
                                                 └─────────────────┘
```

---

## 1. Entity Mention Extraction

### Location
`packages/harness-daemon/src/harness/entity_extraction.ts` (new file)

### Input
Array of assistant message strings from the session event stream.

### Extraction Rules

**Backtick identifiers** — highest signal:
```
`TokenValidator`  `validateScope`  `authMiddleware.ts`  `IValidator`
```
Regex: `` /`([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\.tsx?|\.jsx?|\.py)?)`/g ``

**Dotted references** — class.method patterns in prose:
```
"TokenValidator.validate()"  "auth.hashToken"
```
Regex: `/\b([A-Z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*)\b/g`

**File paths** — relative paths in prose or backticks:
```
src/middleware/auth.ts  packages/harness/src/routes.ts
```
Regex: `/(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|py))\b/g`

### Output

```typescript
interface ExtractedMention {
  raw: string;           // original text matched
  kind: 'identifier' | 'dotted' | 'filepath';
  name: string;          // extracted entity name (e.g., "TokenValidator")
  filepath?: string;     // if a filepath was co-located in the same message
  messageIndex: number;  // which message it appeared in (for recency)
}
```

### Deduplication

Maintain a `Map<string, ExtractedMention>` keyed on normalized name. Later mentions update `messageIndex` (recency) but don't create duplicates.

---

## 2. GraphD Resolution

### Location
`packages/harness-daemon/src/harness/entity_resolution.ts` (new file)

### Resolution Strategy

For each `ExtractedMention`, query `entity_graph.entities`:

**Pass 1 — Exact name match:**
```sql
SELECT * FROM entity_graph.entities
WHERE name = $1
ORDER BY
  CASE WHEN filepath = $2 THEN 0 ELSE 1 END,
  kind ASC
LIMIT 5
```
If `filepath` context exists from the same message, prefer entities in that file. Cap at 5 to avoid fan-out on common names like `index` or `config`.

**Pass 2 — Dotted reference split:**
For `TokenValidator.validate`, split on `.` and look for an `owns` edge:
```sql
SELECT owned.* FROM entity_graph.entities owned
JOIN entity_graph.owns o ON o.owned_id = owned.id
JOIN entity_graph.entities owner ON o.owner_id = owner.id
WHERE owner.name = $1 AND owned.name = $2
```

**Pass 3 — Filepath match:**
For filepath mentions, resolve directly:
```sql
SELECT * FROM entity_graph.entities WHERE filepath = $1
```
This returns all entities in that file — they all become part of the subgraph.

### Output

```typescript
interface ResolvedEntity {
  entityId: string;
  kind: EntityKind;
  name: string;
  filepath: string;
  startLine: number | null;
  endLine: number | null;
  exported: boolean;
  async: boolean;
  recency: number;  // messageIndex from extraction (higher = more recent)
}
```

---

## 3. Subgraph Expansion

### Location
Same file as resolution, or inline in the route handler.

### Expansion Query

Given a set of resolved entity IDs, fetch all edges where **both endpoints** are in the resolved set OR one endpoint is in the resolved set and the other is within 1 hop:

```sql
WITH seed AS (
  SELECT unnest($1::text[]) AS id
),
-- 1-hop neighbors
neighbors AS (
  SELECT DISTINCT target_id AS id FROM (
    SELECT imported_id AS target_id FROM entity_graph.imports WHERE importer_id IN (SELECT id FROM seed)
    UNION ALL
    SELECT importer_id FROM entity_graph.imports WHERE imported_id IN (SELECT id FROM seed)
    UNION ALL
    SELECT callee_id FROM entity_graph.calls WHERE caller_id IN (SELECT id FROM seed)
    UNION ALL
    SELECT caller_id FROM entity_graph.calls WHERE callee_id IN (SELECT id FROM seed)
    UNION ALL
    SELECT used_id FROM entity_graph.uses WHERE user_id IN (SELECT id FROM seed)
    UNION ALL
    SELECT user_id FROM entity_graph.uses WHERE used_id IN (SELECT id FROM seed)
    UNION ALL
    SELECT owned_id FROM entity_graph.owns WHERE owner_id IN (SELECT id FROM seed)
    UNION ALL
    SELECT owner_id FROM entity_graph.owns WHERE owned_id IN (SELECT id FROM seed)
    UNION ALL
    SELECT parent_id FROM entity_graph.extends WHERE child_id IN (SELECT id FROM seed)
    UNION ALL
    SELECT child_id FROM entity_graph.extends WHERE parent_id IN (SELECT id FROM seed)
    UNION ALL
    SELECT interface_id FROM entity_graph.implements WHERE implementor_id IN (SELECT id FROM seed)
    UNION ALL
    SELECT implementor_id FROM entity_graph.implements WHERE interface_id IN (SELECT id FROM seed)
  ) all_neighbors
),
-- Combined node set
all_ids AS (
  SELECT id FROM seed UNION SELECT id FROM neighbors
)
SELECT * FROM entity_graph.entities WHERE id IN (SELECT id FROM all_ids)
```

Then fetch all edges between nodes in `all_ids`:

```sql
SELECT 'imports' AS type, importer_id AS source_id, imported_id AS target_id, symbol AS meta
FROM entity_graph.imports
WHERE importer_id IN (SELECT id FROM all_ids) AND imported_id IN (SELECT id FROM all_ids)
UNION ALL
SELECT 'calls', caller_id, callee_id, site_line::text
FROM entity_graph.calls
WHERE caller_id IN (SELECT id FROM all_ids) AND callee_id IN (SELECT id FROM all_ids)
UNION ALL
SELECT 'uses', user_id, used_id, NULL
FROM entity_graph.uses
WHERE user_id IN (SELECT id FROM all_ids) AND used_id IN (SELECT id FROM all_ids)
UNION ALL
SELECT 'owns', owner_id, owned_id, NULL
FROM entity_graph.owns
WHERE owner_id IN (SELECT id FROM all_ids) AND owned_id IN (SELECT id FROM all_ids)
UNION ALL
SELECT 'extends', child_id, parent_id, NULL
FROM entity_graph.extends
WHERE child_id IN (SELECT id FROM all_ids) AND parent_id IN (SELECT id FROM all_ids)
UNION ALL
SELECT 'implements', implementor_id, interface_id, NULL
FROM entity_graph.implements
WHERE implementor_id IN (SELECT id FROM all_ids) AND interface_id IN (SELECT id FROM all_ids)
```

### Blast Radius Overlay

If the session has modified files (from diffstat/events), run the existing `blastRadius()` query on each modified filepath. Mark affected entity IDs in the response so the frontend can color them.

### Unused Export Detection

Run `unusedExports()` scoped to filepaths in the subgraph. Return those entity IDs so the frontend can ghost them.

---

## 4. Cockpit API Route

### Endpoint

```
POST /cockpit/entity-graph/subgraph
```

### Request Body

```typescript
{
  sessionKey: string;
  // Optional overrides (normally derived from session events):
  additionalFilepaths?: string[];
  maxHops?: number;  // default 1
}
```

The route handler:
1. Loads session events from GraphD
2. Extracts entity mentions from assistant messages (§1)
3. Also collects filepaths from tool events (Read/Write/Edit targets)
4. Resolves mentions against entity_graph (§2)
5. Expands to subgraph (§3)
6. Computes blast radius for modified files
7. Computes unused exports within the subgraph

### Response

```typescript
{
  nodes: Array<{
    id: string;
    kind: EntityKind;
    name: string;
    filepath: string;
    startLine: number | null;
    endLine: number | null;
    exported: boolean;
    async: boolean;
    // Overlay flags:
    mentioned: boolean;       // directly mentioned by agent
    modified: boolean;        // in a file the agent wrote to
    blastRadius: boolean;     // affected by a modified file
    unusedExport: boolean;    // exported but unreferenced
    recency: number;          // 0-1 normalized, 1 = most recent mention
  }>;
  edges: Array<{
    type: EdgeType;
    sourceId: string;
    targetId: string;
    meta?: string;
  }>;
  stats: {
    mentionedEntities: number;
    resolvedEntities: number;
    totalNodes: number;
    totalEdges: number;
    blastRadiusFiles: number;
    unusedExports: number;
  };
}
```

---

## 5. Frontend — Graph Component

### Location
`packages/dashboard-control/src/components/center/tabs/EntityGraphView.tsx` (new file)

### Library
**D3 force-simulation** for the default layout. No additional npm dependency — d3-force is lightweight and already compatible with React via refs. If dagre toggle is added later, use `dagre` (small, no transitive deps).

### Integration Point

In `PacketTab.tsx`, when no active packet exists and the session is in plain chat mode:

```tsx
if (!activePacket && focusData?.header?.sessionKey) {
  return <EntityGraphView sessionKey={focusData.header.sessionKey} />;
}
```

### Component Behavior

1. **On mount / session change**: `POST /cockpit/entity-graph/subgraph` with the session key.
2. **On new events**: Re-fetch when session events update (debounced 2s — entity graph doesn't change faster than the agent edits files).
3. **Render**: D3 force-directed graph in an SVG container.

### Visual Language

| Entity Kind | Shape     | Color              |
|-------------|-----------|-------------------|
| file        | rectangle | `--text-muted`     |
| class       | rectangle | `--accent-cyan`    |
| function    | ellipse   | `--running`        |
| method      | ellipse   | `--running` (lighter) |
| interface   | diamond   | `--warning`        |
| type        | diamond   | `--warning` (lighter) |
| enum        | hexagon   | `--text-secondary` |

| Edge Type   | Stroke    | Style              |
|-------------|-----------|-------------------|
| imports     | gray      | dashed             |
| calls       | green     | solid, arrow       |
| uses        | blue      | dotted             |
| owns        | none      | invisible (use grouping) |
| extends     | orange    | solid, open arrow  |
| implements  | purple    | solid, open arrow  |

### Overlay Rendering

- **`mentioned`** nodes: full opacity, slightly larger
- **`modified`** nodes: pulsing border animation (agent touched this file)
- **`blastRadius`** nodes: warm tint (orange glow at 20% opacity), intensity by hop distance
- **`unusedExport`** nodes: ghosted (40% opacity, dashed border)
- **`recency`** mapped to opacity: `0.4 + 0.6 * recency` — old mentions fade

### Ownership Grouping

`owns` edges don't render as visible lines. Instead, owned entities are positioned near their owner via a compound node / convex hull group. A class and its methods form a visual cluster with a faint background rect. This reduces edge clutter while preserving structural hierarchy.

### Interactions

| Action | Behavior |
|--------|----------|
| Hover node | Tooltip: `kind · name · filepath:startLine` |
| Click node | If modified → switch to Diff tab focused on that file. Else → open file in editor. |
| Hover edge | Tooltip: edge type + meta (symbol for imports, site_line for calls) |
| Scroll | Zoom in/out on the graph |
| Drag node | Pin it; double-click to unpin |
| Click background | Reset zoom/pan to fit all nodes |

### Empty State

If the subgraph returns 0 nodes (entity graph not populated, or session hasn't touched any recognized files):

```
No entity graph available

The entity graph builds as the agent reads and modifies source files.
```

### Header Bar

Compact stats bar above the graph:

```
Entity Graph · 23 nodes · 31 edges · 3 files modified · 2 blast radius hits
```

With a layout toggle: `[Force] [Hierarchy]` — switches between force-directed and dagre.

---

## 6. Rolling Mention Set

### Concept

Don't just extract from the latest message. Maintain a **session-scoped rolling mention set** that accumulates across all turns. This set is the union of:

- Entity names mentioned in any assistant message this session
- Filepaths from any tool call (Read, Write, Edit, Glob targets)

The `recency` field tracks when each entity was last mentioned (normalized to 0-1 across the session timeline). This drives the opacity fade — the graph shows the full explored territory with recent work highlighted.

### Implementation

The extraction + resolution runs over the full event stream on each request. This is acceptable because:
- Assistant messages are already loaded for the event drawer
- Extraction is pure string work (microseconds)
- Resolution is indexed queries (milliseconds)
- The event stream for a single session is small (tens to low hundreds of messages)

No caching needed in v1. If perf becomes an issue, cache the mention set in memory on the route handler, keyed by `sessionKey + eventCount`.

---

## 7. File Manifest

| File | Change |
|------|--------|
| `packages/harness-daemon/src/harness/entity_extraction.ts` | **New** — extraction regexes + types |
| `packages/harness-daemon/src/harness/entity_resolution.ts` | **New** — GraphD resolution + subgraph expansion |
| `packages/harness-daemon/src/harness/routes/cockpit.ts` | **Edit** — add `/entity-graph/subgraph` route |
| `packages/dashboard-control/src/components/center/tabs/EntityGraphView.tsx` | **New** — D3 graph component |
| `packages/dashboard-control/src/components/center/tabs/PacketTab.tsx` | **Edit** — fallback to EntityGraphView when no packet |
| `packages/dashboard-control/src/hooks/use-cockpit-store.ts` | **Edit** — add subgraph fetch + state |

---

## 8. Sequencing

1. **Entity extraction** — pure functions, unit-testable in isolation
2. **Entity resolution** — needs Postgres, but queries are straightforward
3. **Subgraph route** — wires extraction + resolution together, returns JSON
4. **Frontend graph component** — D3 force layout with the visual language above
5. **PacketTab integration** — swap in the graph when no packet exists
6. **Overlay features** — blast radius, unused exports, recency fade (can ship incrementally)

Steps 1-3 are backend-only. Step 4 can develop in parallel with a mock JSON fixture. Step 5 is a one-line conditional. Step 6 is polish.
