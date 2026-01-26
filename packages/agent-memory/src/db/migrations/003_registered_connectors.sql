-- Registered Connectors Migration
-- Persistent storage for dynamically registered connectors

CREATE TABLE IF NOT EXISTS registered_connectors (
  type TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for finding enabled connectors (used at daemon startup)
CREATE INDEX IF NOT EXISTS idx_registered_connectors_enabled ON registered_connectors(enabled) WHERE enabled = true;

-- Comment for documentation
COMMENT ON TABLE registered_connectors IS 'Stores which connectors are registered and their runtime configuration. Factory implementations live in registry.ts; this table tracks which are ACTIVE.';
COMMENT ON COLUMN registered_connectors.type IS 'Connector type (e.g., gmail, github) - must match a registered factory';
COMMENT ON COLUMN registered_connectors.config IS 'Runtime configuration passed to the factory function';
