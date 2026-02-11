-- Migration: 019_agent_actions
-- Description: Agent actions table for tracking significant actions and outcomes
-- Version: 19

CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  CONSTRAINT agent_actions_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  action_type TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  predicted_outcome TEXT,
  actual_outcome TEXT,
  outcome_signal TEXT CHECK (outcome_signal IN ('positive', 'negative', 'neutral', 'unknown')) DEFAULT 'unknown',
  feedback JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_agent_actions_type ON agent_actions(action_type);
CREATE INDEX IF NOT EXISTS idx_agent_actions_created_at ON agent_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_actions_outcome_signal ON agent_actions(outcome_signal) WHERE outcome_signal IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_actions_unresolved ON agent_actions(created_at) WHERE resolved_at IS NULL;

-- GIN index for context and metadata queries
CREATE INDEX IF NOT EXISTS idx_agent_actions_context ON agent_actions USING GIN (context jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_agent_actions_metadata ON agent_actions USING GIN (metadata jsonb_path_ops);

-- Partial index for positive outcomes (for learning what works)
CREATE INDEX IF NOT EXISTS idx_agent_actions_positive ON agent_actions(created_at DESC) WHERE outcome_signal = 'positive';

-- Partial index for negative outcomes (for avoiding what doesn't work)
CREATE INDEX IF NOT EXISTS idx_agent_actions_negative ON agent_actions(created_at DESC) WHERE outcome_signal = 'negative';

-- Record this migration
INSERT INTO schema_migrations (version, description)
VALUES (19, 'Agent actions table for tracking significant actions and outcomes');
