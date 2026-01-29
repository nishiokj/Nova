-- Migration: 018_agent_goals
-- Description: Agent goals table for hierarchical objectives and progress tracking
-- Version: 18

CREATE TABLE IF NOT EXISTS agent_goals (
  id TEXT PRIMARY KEY,
  CONSTRAINT agent_goals_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  parent_id TEXT REFERENCES agent_goals(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  success_criteria JSONB,
  priority FLOAT NOT NULL DEFAULT 0.0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'failed', 'abandoned')),
  deadline TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_agent_goals_parent_id ON agent_goals(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_goals_status ON agent_goals(status);
CREATE INDEX IF NOT EXISTS idx_agent_goals_priority ON agent_goals(priority DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_agent_goals_deadline ON agent_goals(deadline) WHERE deadline IS NOT NULL AND status = 'active';

-- GIN index for metadata queries
CREATE INDEX IF NOT EXISTS idx_agent_goals_metadata ON agent_goals USING GIN (metadata jsonb_path_ops);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_agent_goals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_agent_goals_updated_at
  BEFORE UPDATE ON agent_goals
  FOR EACH ROW EXECUTE FUNCTION update_agent_goals_updated_at();

-- Record this migration
INSERT INTO schema_migrations (version, description)
VALUES (18, 'Agent goals table for hierarchical objectives and progress tracking');
