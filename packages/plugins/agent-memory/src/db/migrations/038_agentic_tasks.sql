-- Agentic tasks: intent-driven, agent-executed cron jobs
-- with semantic compiler verification

CREATE TABLE agentic_tasks (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL UNIQUE,
  intent               TEXT NOT NULL,
  success_criteria     TEXT,
  -- Semantic verification (compiled at setup time, not runtime)
  invariants           JSONB NOT NULL DEFAULT '[]',
  system_surface       JSONB NOT NULL DEFAULT '{}',
  compiled_vp_path     TEXT,
  compiled_vp_hash     TEXT,
  pending_questions    JSONB NOT NULL DEFAULT '[]',
  -- Execution scoping
  capability_scope     JSONB NOT NULL DEFAULT '{}',
  mutation_budget      JSONB NOT NULL DEFAULT '{}',
  -- Schedule
  mode                 TEXT NOT NULL DEFAULT 'once',
  interval_ms          BIGINT,
  status               TEXT NOT NULL DEFAULT 'draft',
  -- Circuit breaker
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  max_failures         INTEGER NOT NULL DEFAULT 3,
  circuit_open_until   TIMESTAMPTZ,
  last_error           TEXT,
  last_success_at      TIMESTAMPTZ,
  last_error_at        TIMESTAMPTZ,
  -- Scheduling
  next_run_at          TIMESTAMPTZ,
  last_run_id          TEXT,
  -- Execution policy
  timeout_ms           INTEGER NOT NULL DEFAULT 300000,
  idempotent           BOOLEAN NOT NULL DEFAULT true,
  cooldown_ms          INTEGER,
  -- Metadata
  metadata             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Scheduler index: active tasks ordered by next_run_at
-- Circuit breaker check (circuit_open_until <= NOW()) is done at query time
CREATE INDEX idx_agentic_tasks_due ON agentic_tasks (next_run_at)
  WHERE status = 'active';

-- Agentic runs: per-execution records
CREATE TABLE agentic_runs (
  id                       TEXT PRIMARY KEY,
  task_id                  TEXT NOT NULL REFERENCES agentic_tasks(id),
  status                   TEXT NOT NULL DEFAULT 'pending',
  -- Agent execution
  agent_output             TEXT,
  agent_summary            TEXT,
  mutations_observed       JSONB,
  budget_exceeded          BOOLEAN NOT NULL DEFAULT false,
  -- Verification
  verdict                  TEXT,
  verdict_report           JSONB,
  evidence_path            TEXT,
  -- Timing
  started_at               TIMESTAMPTZ,
  agent_completed_at       TIMESTAMPTZ,
  verification_started_at  TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  duration_ms              INTEGER,
  error                    TEXT,
  metadata                 JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agentic_runs_task ON agentic_runs (task_id, created_at DESC);

-- Hot index for preventing double-scheduling
CREATE INDEX idx_agentic_runs_active ON agentic_runs (task_id)
  WHERE status IN ('pending', 'running', 'verifying');
