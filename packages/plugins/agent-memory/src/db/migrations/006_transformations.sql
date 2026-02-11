-- Transformations Catalog Migration
-- Persistent registry for transformations

CREATE TABLE IF NOT EXISTS transformations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connector TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  output_type JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transformations_source
  ON transformations (connector, entity_type);

CREATE INDEX IF NOT EXISTS idx_transformations_enabled
  ON transformations (enabled);
