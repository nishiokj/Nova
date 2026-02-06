-- Escalations table: human attention requests from agents/watcher
-- Stateful entity with lifecycle: pending → acknowledged → resolved | dismissed

CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  CONSTRAINT escalations_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),

  -- Type and status
  type TEXT NOT NULL CHECK (type IN (
    'architectural', 'uncertainty', 'permission', 'conflict', 'review', 'failure', 'resource'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'acknowledged', 'resolved', 'dismissed'
  )),

  -- Context
  session_key TEXT NOT NULL,
  work_item_id TEXT,

  -- Content
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  tradeoffs_json TEXT,  -- JSON array of strings
  options_json TEXT,    -- JSON array of EscalationOption

  -- Evidence
  references_json TEXT NOT NULL DEFAULT '[]',  -- JSON array of EscalationReference

  -- Resolution
  resolution_json TEXT,  -- JSON EscalationResolution
  resolved_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
CREATE INDEX IF NOT EXISTS idx_escalations_session ON escalations(session_key);
CREATE INDEX IF NOT EXISTS idx_escalations_session_status ON escalations(session_key, status);
CREATE INDEX IF NOT EXISTS idx_escalations_created ON escalations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_escalations_type ON escalations(type);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_escalations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_escalations_updated_at
  BEFORE UPDATE ON escalations
  FOR EACH ROW EXECUTE FUNCTION update_escalations_updated_at();

-- Partial index for pending escalations (most common query)
CREATE INDEX IF NOT EXISTS idx_escalations_pending
  ON escalations(created_at DESC)
  WHERE status = 'pending';
