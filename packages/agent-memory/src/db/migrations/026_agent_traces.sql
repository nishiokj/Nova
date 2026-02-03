-- Migration: 026_agent_traces
-- Description: Agent trace records for tracking AI code contributions (cursor/agent-trace spec)
-- Version: 26

CREATE TABLE IF NOT EXISTS agent_traces (
  id TEXT PRIMARY KEY,
  CONSTRAINT agent_traces_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  revision VARCHAR(40) NOT NULL,
  session_key TEXT,
  tool_name TEXT NOT NULL DEFAULT 'agent',
  tool_version TEXT NOT NULL DEFAULT '0.1.0',
  trace JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint on git revision (one trace per commit)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_traces_revision ON agent_traces(revision);

-- Index for querying by session
CREATE INDEX IF NOT EXISTS idx_agent_traces_session_key ON agent_traces(session_key) WHERE session_key IS NOT NULL;

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_agent_traces_created_at ON agent_traces(created_at DESC);

-- GIN index for JSONB queries (e.g., finding traces by model_id in files.conversations)
CREATE INDEX IF NOT EXISTS idx_agent_traces_trace ON agent_traces USING GIN (trace jsonb_path_ops);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_agent_traces_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_agent_traces_updated_at
  BEFORE UPDATE ON agent_traces
  FOR EACH ROW EXECUTE FUNCTION update_agent_traces_updated_at();

-- Record this migration
INSERT INTO schema_migrations (version, description)
VALUES (26, 'Agent trace records for tracking AI code contributions');
