-- Circuit Breaker for Tasks
-- Prevents backlog buildup when tasks have persistent failures

-- Add circuit breaker columns to derived_tasks
ALTER TABLE derived_tasks
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_failures INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS circuit_open_until TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_error TEXT DEFAULT NULL;

-- Add circuit breaker columns to sync_tasks
ALTER TABLE sync_tasks
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_failures INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS circuit_open_until TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_error TEXT DEFAULT NULL;

-- Note: We don't use a partial index with NOW() since it's not immutable.
-- The scheduler query handles circuit_open_until filtering at runtime.

COMMENT ON COLUMN derived_tasks.consecutive_failures IS 'Number of consecutive job failures';
COMMENT ON COLUMN derived_tasks.max_failures IS 'Max failures before circuit opens (0 = disabled)';
COMMENT ON COLUMN derived_tasks.circuit_open_until IS 'Circuit open until this time (NULL = closed)';
COMMENT ON COLUMN derived_tasks.last_error IS 'Last error message from failed job';
