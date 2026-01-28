-- Derived Tasks Triggers Migration
-- Add trigger_config for webhook-based derived tasks

-- Add trigger_config column
ALTER TABLE derived_tasks
  ADD COLUMN IF NOT EXISTS trigger_config JSONB;

-- Create index for webhook trigger lookups
CREATE INDEX IF NOT EXISTS idx_derived_tasks_triggers_webhook
  ON derived_tasks (
    (trigger_config->>'type'),
    (trigger_config->>'connector'),
    (trigger_config->>'eventType')
  )
  WHERE enabled = true
    AND trigger_config IS NOT NULL;

-- Index for general event-based trigger lookups
CREATE INDEX IF NOT EXISTS idx_derived_tasks_triggers_type
  ON derived_tasks ((trigger_config->>'type'))
  WHERE enabled = true
    AND trigger_config IS NOT NULL
    AND mode = 'event';
