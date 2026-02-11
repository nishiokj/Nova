-- Migration: 035_workitem_templates_test
-- Description: Add default Test workflow template
-- Version: 35

INSERT INTO workitem_templates (id, name, description, specs) VALUES
  ('01JN0000000000000000000005', 'test', 'Focused testing workflow for writing and validating tests', '[
    {"id": "plan-tests", "objective": "Plan test scenarios and expected behavior", "agent": "planner", "dependencies": []},
    {"id": "write-tests", "objective": "Write or update test coverage", "agent": "coder", "dependencies": ["plan-tests"]},
    {"id": "run-tests", "objective": "Run targeted and full test suites", "agent": "test-runner", "dependencies": ["write-tests"]},
    {"id": "analyze-failures", "objective": "Summarize failures and propose follow-ups", "agent": "coder", "dependencies": ["run-tests"]}
  ]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- Record this migration
INSERT INTO schema_migrations (version, description)
VALUES (35, 'Add default Test workflow template');
