-- Evidence atoms + retrieval log tables
-- Adds config_facts, runtime_facts, test_specs, evidence_retrieval_log

CREATE TABLE IF NOT EXISTS config_facts (
  id TEXT PRIMARY KEY,

  -- Identity
  key_path TEXT NOT NULL,
  config_type TEXT NOT NULL CHECK (config_type IN ('env_var', 'feature_flag', 'build_config', 'runtime_config')),

  -- Value + redaction
  value_type TEXT CHECK (value_type IN ('string', 'number', 'boolean', 'object', 'array')),
  default_value JSONB,
  current_value JSONB,
  redacted_value JSONB,
  value_hash TEXT,
  is_sensitive BOOLEAN NOT NULL DEFAULT false,
  redaction_reason TEXT,
  description TEXT,

  -- Source location (if defined in code)
  source_file TEXT,
  source_line INTEGER,

  -- References to entity-graph
  affects_entity_ids TEXT[],

  -- Provenance
  discovered_at TIMESTAMPTZ DEFAULT now(),
  last_observed_at TIMESTAMPTZ DEFAULT now(),
  discovery_method TEXT,

  -- Search
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(key_path, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_config_facts_key_path ON config_facts(key_path);
CREATE INDEX IF NOT EXISTS idx_config_facts_type ON config_facts(config_type);
CREATE INDEX IF NOT EXISTS idx_config_facts_search ON config_facts USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_config_facts_affects ON config_facts USING GIN(affects_entity_ids);
CREATE INDEX IF NOT EXISTS idx_config_facts_sensitive ON config_facts(is_sensitive);
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_facts_unique ON config_facts(key_path, source_file);

-- Runtime facts: errors, stack traces, performance observations
CREATE TABLE IF NOT EXISTS runtime_facts (
  id TEXT PRIMARY KEY,

  fact_type TEXT NOT NULL CHECK (fact_type IN ('error', 'exception', 'performance', 'log_pattern', 'behavior')),

  -- Content
  message TEXT,
  sanitized_message TEXT,
  stack_frames JSONB,
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

  -- Search + embedding
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(message, ''))
  ) STORED,
  embedding VECTOR(1536)
);

CREATE INDEX IF NOT EXISTS idx_runtime_facts_type ON runtime_facts(fact_type);
CREATE INDEX IF NOT EXISTS idx_runtime_facts_last_seen ON runtime_facts(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_facts_search ON runtime_facts USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_runtime_facts_related ON runtime_facts USING GIN(related_entity_ids);
CREATE INDEX IF NOT EXISTS idx_runtime_facts_embedding ON runtime_facts USING hnsw(embedding vector_cosine_ops);

-- Test specs: compact behavioral assertions extracted from test files
CREATE TABLE IF NOT EXISTS test_specs (
  id TEXT PRIMARY KEY,

  -- Identity (references entity-graph test file + function)
  entity_id TEXT NOT NULL,
  test_name TEXT NOT NULL,
  test_suite TEXT,

  -- Content
  description TEXT,
  assertions JSONB,
  fixtures JSONB,

  -- What it tests (entity-graph references)
  tests_entity_ids TEXT[],

  -- Status
  last_result TEXT CHECK (last_result IN ('pass', 'fail', 'skip', 'flaky')),
  last_run_at TIMESTAMPTZ,
  pass_rate REAL,
  flakiness_score REAL,

  -- Provenance
  extracted_at TIMESTAMPTZ DEFAULT now(),
  commit_hash TEXT,

  -- Search
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(test_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_test_specs_entity ON test_specs(entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_specs_entity_unique ON test_specs(entity_id);
CREATE INDEX IF NOT EXISTS idx_test_specs_tests ON test_specs USING GIN(tests_entity_ids);
CREATE INDEX IF NOT EXISTS idx_test_specs_result ON test_specs(last_result);
CREATE INDEX IF NOT EXISTS idx_test_specs_search ON test_specs USING GIN(search_vector);

-- Audit log for evidence retrieval
CREATE TABLE IF NOT EXISTS evidence_retrieval_log (
  id TEXT PRIMARY KEY,

  -- Correlation
  session_id TEXT NOT NULL,
  work_item_id TEXT,
  request_id TEXT,
  injector_version TEXT,

  -- Request
  request_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_objective TEXT,
  query_text TEXT,
  budget JSONB,

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
  status TEXT DEFAULT 'ok',
  error_code TEXT,
  error_message TEXT,

  -- Audit trail
  retrieved_ids TEXT[],
  packed_ids TEXT[],
  rejection_reasons JSONB
);

CREATE INDEX IF NOT EXISTS idx_evidence_log_session ON evidence_retrieval_log(session_id);
CREATE INDEX IF NOT EXISTS idx_evidence_log_time ON evidence_retrieval_log(request_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_log_status ON evidence_retrieval_log(status);
