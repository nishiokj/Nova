-- Architecture boundaries and concern intelligence tables
-- Stores deterministic concern clustering runs and boundary metrics.

CREATE TABLE IF NOT EXISTS architecture_runs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  lookback_days INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  graph_hash TEXT,
  error TEXT,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_architecture_runs_status_started
  ON architecture_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_architecture_runs_config_hash
  ON architecture_runs(config_hash);

CREATE TABLE IF NOT EXISTS architecture_concerns (
  run_id TEXT NOT NULL REFERENCES architecture_runs(id) ON DELETE CASCADE,
  concern_id TEXT NOT NULL,
  label TEXT NOT NULL,
  confidence REAL NOT NULL,
  size_files INTEGER NOT NULL,
  internal_weight REAL NOT NULL,
  external_weight REAL NOT NULL,
  cohesion REAL NOT NULL,
  stability REAL NOT NULL,
  volatility REAL NOT NULL,
  signal_density REAL NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, concern_id)
);

CREATE INDEX IF NOT EXISTS idx_architecture_concerns_run
  ON architecture_concerns(run_id);
CREATE INDEX IF NOT EXISTS idx_architecture_concerns_confidence
  ON architecture_concerns(run_id, confidence DESC);

CREATE TABLE IF NOT EXISTS architecture_concern_files (
  run_id TEXT NOT NULL REFERENCES architecture_runs(id) ON DELETE CASCADE,
  concern_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  membership_score REAL NOT NULL,
  is_core BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_architecture_concern_files_concern
  ON architecture_concern_files(run_id, concern_id);
CREATE INDEX IF NOT EXISTS idx_architecture_concern_files_file
  ON architecture_concern_files(run_id, file_path);

CREATE TABLE IF NOT EXISTS architecture_boundaries (
  run_id TEXT NOT NULL REFERENCES architecture_runs(id) ON DELETE CASCADE,
  left_concern_id TEXT NOT NULL,
  right_concern_id TEXT NOT NULL,
  cross_weight REAL NOT NULL,
  internal_left REAL NOT NULL,
  internal_right REAL NOT NULL,
  pressure REAL NOT NULL,
  pressure_norm REAL NOT NULL,
  hardness REAL NOT NULL,
  interface_ratio REAL NOT NULL,
  direct_bypass_ratio REAL NOT NULL,
  directional_left_to_right REAL NOT NULL,
  directional_right_to_left REAL NOT NULL,
  symmetry_ratio REAL NOT NULL,
  top_cross_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (run_id, left_concern_id, right_concern_id)
);

CREATE INDEX IF NOT EXISTS idx_architecture_boundaries_pressure
  ON architecture_boundaries(run_id, pressure_norm DESC);
CREATE INDEX IF NOT EXISTS idx_architecture_boundaries_hardness
  ON architecture_boundaries(run_id, hardness ASC);

CREATE TABLE IF NOT EXISTS architecture_alerts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES architecture_runs(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')) DEFAULT 'open',
  concern_id TEXT,
  left_concern_id TEXT,
  right_concern_id TEXT,
  file_path TEXT,
  score REAL NOT NULL,
  threshold REAL NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_architecture_alerts_status_severity_created
  ON architecture_alerts(status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_architecture_alerts_run
  ON architecture_alerts(run_id);
CREATE INDEX IF NOT EXISTS idx_architecture_alerts_type
  ON architecture_alerts(alert_type);
