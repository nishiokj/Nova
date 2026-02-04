# Memory Injection / Entity Graph System: Implementation Spec v2.1

**Status**: Draft (revised)
**Foundation**: `packages/entity-graph` (TreeSitter), `packages/agent-memory` (Postgres)
**Principles**: Auditability, Observability, Trackability, Excellence, Safety

---

## Executive Summary

Elevate memory injection from "RAG returning preferences" to a **decision-support evidence pipeline** that:

1. **Uses entity-graph tables as the code structure backbone** (no parallel AST parsing)
2. **Extends agent-memory** with runtime + config + test evidence that soft-links to code entities
3. **Prioritizes discriminators** (facts that rule out wrong approaches) over pure similarity
4. **Packs context with coverage constraints** and explicit safety/redaction
5. **Is fully observable and backwards compatible** with the current injector contract

Key revisions vs v2:
- Retrieval runs inside **agent-memory daemon** (SQL + entity_graph tables), not inside the agent
- **Compatibility layer** for existing `MemoryInjector` interface
- **Redaction/safety rules** to avoid leaking secrets into prompts
- **Structured joins** for test/config/runtime tables (no ID-as-text queries)
- **Complete observability** with end-to-end latency and coverage metrics

---

## Part 1: Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          AGENT RUNTIME                              │
│   ┌──────────────────────┐     ┌─────────────────────────────┐     │
│   │ Agent (buildIteration│     │ memory-injector (client)    │     │
│   │ request)             │────▶│ - v1: /preferences|decisions│     │
│   └──────────────────────┘     │ - v2: /evidence/retrieve    │     │
│                                └───────────────┬─────────────┘     │
└────────────────────────────────────────────────┼────────────────────┘
                                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     AGENT-MEMORY DAEMON                             │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ Evidence Retrieval Engine                                       │ │
│  │ - discriminator-first retrieval                                │ │
│  │ - hybrid search (lexical + semantic + graph)                    │ │
│  │ - safety/redaction                                              │ │
│  └───────────────┬────────────────────────────────────────────────┘ │
└──────────────────┼──────────────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         STORAGE LAYER                               │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐ │
│  │     entity_graph (code)     │  │    agent-memory (behavior)   │ │
│  │  • entities/edges           │  │  • config_facts              │ │
│  │  • calls/imports/etc        │  │  • runtime_facts             │ │
│  │                             │  │  • test_specs                │ │
│  └─────────────────────────────┘  │  • coding_preferences        │ │
│                                   │  • coding_decisions          │ │
│                                   └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**Key integration shift**: the agent does *not* need an in-process `EntityGraph`. The retrieval engine runs in the agent-memory daemon and queries `entity_graph` tables via SQL (or uses shared query helpers).

---

## Part 2: Compatibility Contract (v1 + v2)

We must preserve the existing injector contract while enabling v2.

### 2.1 Current v1 Contract (unchanged)

```typescript
export interface InjectParams {
  query: string
  maxTokens: number
}

export interface MemoryInjector {
  inject(params: InjectParams): Promise<string | null>
}
```

### 2.2 New v2 Contract (additive)

```typescript
export interface InjectParamsV2 {
  task: {
    objective: string
    recentMessages: string[]
    touchedFiles?: string[]
    iteration: number
    sessionId: string
    workItemId?: string
  }
  budget: {
    maxTokens: number
    maxItems?: number
    minCoverage?: Partial<Record<EvidenceCategory, number>>
  }
  options?: {
    forceV1Fallback?: boolean
    trace?: boolean
  }
}

export interface InjectResultV2 {
  content: string
  atoms: AnyEvidenceAtom[]
  metrics: {
    totalTokens: number
    attentionTax: number
    coverage: Record<string, number>
    discriminatorsIncluded: number
    latencyMs: number
  }
}

export interface MemoryInjectorV2 {
  injectV2(params: InjectParamsV2): Promise<InjectResultV2 | null>
}
```

### 2.3 Backwards-compatible usage in `Agent`

- If injector implements `injectV2`, use it.
- Otherwise fall back to v1 `inject`.
- Emit `memory_injected` hook with versioned metadata (see Observability).

---

## Part 3: Schema Extensions (agent-memory)

### 3.1 `config_facts` (with redaction)

```sql
-- Migration: 022_evidence_atoms.sql (revised)

CREATE TABLE IF NOT EXISTS config_facts (
  id TEXT PRIMARY KEY,  -- ULID

  -- Identity
  key_path TEXT NOT NULL,
  config_type TEXT NOT NULL CHECK (config_type IN ('env_var', 'feature_flag', 'build_config', 'runtime_config')),

  -- Value + redaction
  value_type TEXT CHECK (value_type IN ('string', 'number', 'boolean', 'object', 'array')),
  default_value JSONB,
  current_value JSONB,   -- MAY BE NULL if sensitive; never injected raw
  redacted_value JSONB,  -- always safe for injection
  value_hash TEXT,       -- sha256 of canonical value for change detection
  is_sensitive BOOLEAN NOT NULL DEFAULT false,
  redaction_reason TEXT,
  description TEXT,

  -- Source location
  source_file TEXT,
  source_line INTEGER,

  -- References to entity-graph
  affects_entity_ids TEXT[],

  -- Provenance
  discovered_at TIMESTAMPTZ DEFAULT now(),
  last_observed_at TIMESTAMPTZ DEFAULT now(),
  discovery_method TEXT,  -- 'static_analysis' | 'runtime_observation' | 'manual'

  -- Search
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(key_path, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED
);

CREATE INDEX idx_config_facts_key_path ON config_facts(key_path);
CREATE INDEX idx_config_facts_type ON config_facts(config_type);
CREATE INDEX idx_config_facts_search ON config_facts USING GIN(search_vector);
CREATE INDEX idx_config_facts_affects ON config_facts USING GIN(affects_entity_ids);
CREATE INDEX idx_config_facts_sensitive ON config_facts(is_sensitive);
```

### 3.2 `runtime_facts` (embedding dimension aligned with config)

```sql
CREATE TABLE IF NOT EXISTS runtime_facts (
  id TEXT PRIMARY KEY,

  fact_type TEXT NOT NULL CHECK (fact_type IN ('error', 'exception', 'performance', 'log_pattern', 'behavior')),

  -- Content (stored raw + optional sanitized copy)
  message TEXT,
  sanitized_message TEXT,
  stack_frames JSONB,  -- [{ file, line, function, context }]
  context JSONB,

  -- Related entities
  related_entity_ids TEXT[],

  -- Occurrence tracking
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence_count INTEGER NOT NULL DEFAULT 1,

  -- Provenance
  session_id TEXT,
  commit_hash TEXT,

  -- Search
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(message, ''))
  ) STORED,
  embedding VECTOR(${EMBEDDING_DIM})  -- must match AGENT_MEMORY_EMBEDDING_DIM
);

CREATE INDEX idx_runtime_facts_type ON runtime_facts(fact_type);
CREATE INDEX idx_runtime_facts_last_seen ON runtime_facts(last_seen_at DESC);
CREATE INDEX idx_runtime_facts_search ON runtime_facts USING GIN(search_vector);
CREATE INDEX idx_runtime_facts_related ON runtime_facts USING GIN(related_entity_ids);
CREATE INDEX idx_runtime_facts_embedding ON runtime_facts USING hnsw(embedding vector_cosine_ops);
```

### 3.3 `test_specs` (unchanged structure, structured joins)

```sql
CREATE TABLE IF NOT EXISTS test_specs (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,  -- entity_graph.entities.id of the test function
  test_name TEXT NOT NULL,
  test_suite TEXT,
  description TEXT,
  assertions JSONB,
  fixtures JSONB,
  tests_entity_ids TEXT[],

  last_result TEXT CHECK (last_result IN ('pass', 'fail', 'skip', 'flaky')),
  last_run_at TIMESTAMPTZ,
  pass_rate REAL,
  flakiness_score REAL,

  extracted_at TIMESTAMPTZ DEFAULT now(),
  commit_hash TEXT,

  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(test_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED
);

CREATE INDEX idx_test_specs_entity ON test_specs(entity_id);
CREATE INDEX idx_test_specs_tests ON test_specs USING GIN(tests_entity_ids);
CREATE INDEX idx_test_specs_result ON test_specs(last_result);
CREATE INDEX idx_test_specs_search ON test_specs USING GIN(search_vector);
```

### 3.4 `evidence_retrieval_log` (complete observability)

```sql
CREATE TABLE IF NOT EXISTS evidence_retrieval_log (
  id TEXT PRIMARY KEY,

  -- Correlation
  session_id TEXT NOT NULL,
  work_item_id TEXT,
  request_id TEXT,
  injector_version TEXT, -- 'v1' | 'v2'

  -- Request
  request_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_objective TEXT,
  query_text TEXT,
  budget JSONB,  -- { maxTokens, maxItems, minCoverage }

  -- Response
  retrieved_count INTEGER,
  packed_count INTEGER,
  total_tokens INTEGER,
  attention_tax REAL,
  coverage JSONB,
  discriminators_count INTEGER,

  -- Performance
  retrieval_latency_ms INTEGER,
  packing_latency_ms INTEGER,
  total_latency_ms INTEGER,

  -- Outcome
  status TEXT DEFAULT 'ok',  -- 'ok' | 'partial' | 'error'
  error_code TEXT,
  error_message TEXT,

  -- Audit trail
  retrieved_ids TEXT[],
  packed_ids TEXT[],
  rejection_reasons JSONB
);

CREATE INDEX idx_evidence_log_session ON evidence_retrieval_log(session_id);
CREATE INDEX idx_evidence_log_time ON evidence_retrieval_log(request_at DESC);
CREATE INDEX idx_evidence_log_status ON evidence_retrieval_log(status);
```

---

## Part 4: Evidence Atom Type System (with safety)

```typescript
export type EvidenceCategory =
  | 'code_entity'
  | 'config_fact'
  | 'runtime_fact'
  | 'test_spec'
  | 'preference'
  | 'decision'

export interface EvidenceAtom<T = unknown> {
  id: string
  category: EvidenceCategory

  provenance: {
    source: string        // 'entity-graph' | 'agent-memory' | 'runtime'
    sourceTable: string
    version: string
    filepath?: string
    lineRange?: [number, number]
    confidence: number
  }

  data: T
  displayText: string  // always sanitized, safe to inject

  safety: {
    isSensitive: boolean
    redacted: boolean
    redactionReason?: string
  }

  retrieval: {
    score: number
    matchType: 'lexical' | 'semantic' | 'structural' | 'graph'
    isDiscriminator: boolean
    novelty: number
    retrievedAt: number
  }

  cost: {
    tokens: number
    attentionTax: number
  }
}
```

**Safety rule**: `displayText` must never contain raw secrets or untrusted prompt-like content. All config and runtime facts must be redacted/sanitized before formatting.

---

## Part 5: Discriminator-First Retrieval (revised)

### 5.1 Core Algorithm (runs in agent-memory daemon)

Key changes:
- Retrieval uses **SQL + entity_graph tables** (no in-process `EntityGraph` requirement in agent).
- Discriminator queries are **structured joins** (array containment), not ID-as-text search.

```typescript
export interface RetrievalRequest {
  task: {
    objective: string
    recentMessages: string[]
    touchedFiles?: string[]
    iteration: number
    sessionId: string
    workItemId?: string
  }
  budget: {
    maxTokens: number
    maxItems: number
    minCoverage: Partial<Record<EvidenceCategory, number>>
  }
}

export interface RetrievalResult {
  atoms: AnyEvidenceAtom[]
  metrics: {
    totalCandidates: number
    totalTokens: number
    attentionTax: number
    coverage: Record<EvidenceCategory, number>
    discriminatorsFound: number
    latencyMs: number
  }
  audit: {
    retrievedIds: string[]
    packedIds: string[]
    rejectionReasons: Record<string, string>
  }
}

// Outline
// 1) infer approaches from touched files + keywords
// 2) generate discriminator intents with entity IDs
// 3) hybrid retrieval (entity_graph + lexical + semantic + structured joins)
// 4) score with discriminator bonus + novelty
// 5) pack with coverage constraints
```

### 5.2 Structured discriminator queries (examples)

```sql
-- Tests covering a target entity
SELECT * FROM test_specs
WHERE tests_entity_ids @> ARRAY[$1] OR entity_id = $1
ORDER BY last_run_at DESC NULLS LAST
LIMIT 5;

-- Config facts affecting a target entity
SELECT * FROM config_facts
WHERE affects_entity_ids @> ARRAY[$1]
ORDER BY last_observed_at DESC
LIMIT 5;

-- Runtime facts related to a target entity
SELECT * FROM runtime_facts
WHERE related_entity_ids @> ARRAY[$1]
ORDER BY last_seen_at DESC
LIMIT 5;
```

### 5.3 Safety + redaction rules

- Config facts: if `is_sensitive = true`, **never** inject `current_value`; use `redacted_value`.
- Runtime facts: sanitize message + stack frames (strip secrets, tokens, URLs with credentials).
- Do not inject raw multi-line log blobs; format as compact bullet entries.

---

## Part 6: Integration Points (revised)

### 6.1 Agent-Memory Daemon

Add a new HTTP route:
- `POST /evidence/retrieve` => runs retrieval engine and returns `InjectResultV2`
- The daemon already has SQL + access to `entity_graph` tables; no agent-side EntityGraph dependency.

### 6.2 Memory Injector (client)

Add a v2 client that calls `/evidence/retrieve`:

```typescript
// packages/memory-injector/src/enhanced-injector.ts
export function createEnhancedMemoryInjector(config: MemoryInjectorConfig): MemoryInjectorV2
```

Fallback behavior:
- If `/evidence/retrieve` is unavailable or errors, fall back to v1 `inject`.
- Record fallback in `memory_injected` metrics.

### 6.3 Agent Integration (buildIterationRequest)

Use v2 when available:

```typescript
const injector = this.memoryInjector
if (injector?.injectV2) {
  const result = await injector.injectV2({...})
  memoryContent = result?.content ?? null
  // Emit memory_injected with version + metrics
} else if (injector?.inject) {
  memoryContent = await injector.inject({ query, maxTokens })
  // Emit memory_injected v1
}
```

---

## Part 7: Observability & Metrics

### 7.1 Hook payload (agent)

Extend `memory_injected` event payload (additive fields):

```typescript
{
  type: 'memory_injected',
  query: string,
  resultPreview?: string,
  itemCount: number,
  success: boolean,
  iteration: number,
  version?: 'v1' | 'v2',
  latencyMs?: number,
  coverage?: Record<string, number>,
  discriminatorsIncluded?: number,
  totalTokens?: number,
  fallbackToV1?: boolean,
}
```

### 7.2 Retrieval log (daemon)

All retrievals should emit `evidence_retrieval_log` with:
- end-to-end latency
- coverage + discriminator counts
- budget + outcome (ok/partial/error)

### 7.3 Improvement measurement

- **A/B flag** in the injector (`v1` vs `v2`) keyed by `sessionId` or `workItemId`.
- Compare: first-turn success, average turns per task, tool calls per task, time-to-complete, user corrections.
- Run offline regression suite in `bench/` for repeatable comparisons.

---

## Part 8: Derivation Scripts (revised)

### 8.1 Config Fact Extractor (redaction-first)

Rules:
- `.env*` values are **always sensitive**; store `redacted_value` + `value_hash`.
- Config objects in code: mark as sensitive only if key name matches secret patterns.
- Never inject `current_value` if sensitive; always inject `redacted_value`.

### 8.2 Test Spec Extractor

- Use `entity_graph` tables to map tests to code entities.
- Prefer `tests_entity_ids` joins over keyword search.

### 8.3 Runtime Facts

- Collect from watcher logs / error hooks.
- Sanitize before storage or at retrieval time.

---

## Part 9: Rollout Plan (revised)

**Phase 0 (Compatibility)**
- Add `MemoryInjectorV2` interface + adapter in memory-injector.
- Add `/evidence/retrieve` endpoint in agent-memory (behind flag).
- Extend `memory_injected` hook payload (additive).

**Phase 1 (Schema)**
- Add `config_facts`, `runtime_facts`, `test_specs`, `evidence_retrieval_log`.
- Ensure embedding dimension matches `AGENT_MEMORY_EMBEDDING_DIM`.

**Phase 2 (Population)**
- Implement config/test/runtime derivation scripts with redaction.
- Run initial population.

**Phase 3 (Retrieval)**
- Implement discriminator-first retrieval in agent-memory daemon.
- Add unit tests for structured joins and redaction.

**Phase 4 (Integration + A/B)**
- Enable v2 injector for a subset of sessions.
- Compare metrics vs v1 and adjust weights/coverage.

---

## Appendix: Open Questions (updated)

1. **Embedding model**: keep existing embeddings or switch to local model? (Must match `AGENT_MEMORY_EMBEDDING_DIM`)
2. **Discriminator effectiveness**: what concrete signals prove they prevent wrong paths?
3. **Graph freshness**: how to invalidate evidence when entity_graph updates?
4. **Redaction policy**: what patterns count as sensitive? (env key names, JWTs, secrets, tokens)
5. **Scope**: keep retrieval within monorepo or include external deps?
