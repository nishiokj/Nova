-- Migration: 033_workitem_templates
-- Description: WorkItem templates - precomputed DAGs for common workflow patterns
-- Version: 33

CREATE TABLE IF NOT EXISTS workitem_templates (
  id TEXT PRIMARY KEY,
  CONSTRAINT workitem_templates_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  specs JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_workitem_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_workitem_templates_updated_at
  BEFORE UPDATE ON workitem_templates
  FOR EACH ROW EXECUTE FUNCTION update_workitem_templates_updated_at();

-- Seed default templates (ULIDs must be 26 chars from Crockford base32: 0-9A-HJKMNP-TV-Z)
INSERT INTO workitem_templates (id, name, description, specs) VALUES
  ('01JN0000000000000000000001', 'feature', 'New feature with full test coverage', '[
    {"id": "plan", "objective": "Plan the feature implementation", "agent": "planner", "dependencies": []},
    {"id": "implement", "objective": "Implement the feature", "agent": "coder", "dependencies": ["plan"]},
    {"id": "unit-tests", "objective": "Write unit tests for new code", "agent": "coder", "dependencies": ["implement"]},
    {"id": "integration-tests", "objective": "Write integration tests", "agent": "coder", "dependencies": ["implement"]},
    {"id": "run-tests", "objective": "Run all tests", "agent": "test-runner", "dependencies": ["unit-tests", "integration-tests"]},
    {"id": "invariants", "objective": "Verify semantic invariants hold", "agent": "coder", "dependencies": ["run-tests"]}
  ]'::jsonb),
  ('01JN0000000000000000000002', 'bugfix', 'Fix a bug with regression tests', '[
    {"id": "reproduce", "objective": "Create failing test that reproduces the bug", "agent": "coder", "dependencies": []},
    {"id": "fix", "objective": "Fix the bug", "agent": "coder", "dependencies": ["reproduce"]},
    {"id": "verify", "objective": "Confirm reproduction test now passes", "agent": "test-runner", "dependencies": ["fix"]},
    {"id": "suite", "objective": "Run existing test suite", "agent": "test-runner", "dependencies": ["fix"]},
    {"id": "regression", "objective": "Add regression tests for similar edge cases", "agent": "coder", "dependencies": ["verify"]}
  ]'::jsonb),
  ('01JN0000000000000000000003', 'prototype', 'Quick prototype with minimal testing', '[
    {"id": "implement", "objective": "Build the prototype", "agent": "coder", "dependencies": []},
    {"id": "sanity", "objective": "Basic sanity test - does it run?", "agent": "test-runner", "dependencies": ["implement"]}
  ]'::jsonb),
  ('01JN0000000000000000000004', 'refactor', 'Refactor with no behavior change', '[
    {"id": "plan", "objective": "Plan the refactor", "agent": "planner", "dependencies": []},
    {"id": "refactor", "objective": "Execute the refactor", "agent": "coder", "dependencies": ["plan"]},
    {"id": "typecheck", "objective": "Run typecheck", "agent": "test-runner", "dependencies": ["refactor"]},
    {"id": "suite", "objective": "Run existing tests (must all pass)", "agent": "test-runner", "dependencies": ["refactor"]}
  ]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- Record this migration
INSERT INTO schema_migrations (version, description)
VALUES (33, 'WorkItem templates - precomputed DAGs for common workflow patterns');
