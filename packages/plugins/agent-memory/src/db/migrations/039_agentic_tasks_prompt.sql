-- Add compiled prompt path to agentic tasks
-- The compiled prompt is the comprehensive agent mission briefing
-- produced by the agentic-tasks skill during setup.

ALTER TABLE agentic_tasks ADD COLUMN compiled_prompt_path TEXT;

-- Remove pending_questions — question resolution happens in the
-- skill conversation, not in the daemon API.
ALTER TABLE agentic_tasks DROP COLUMN pending_questions;
