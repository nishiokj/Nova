-- Change embedding columns from 1536 (OpenAI) to 768 (Gemini text-embedding-004)
-- This requires clearing existing embeddings and re-running the embedding task

-- Clear existing embeddings (they were OpenAI ada-002, incompatible with Gemini)
UPDATE coding_preferences SET embedding = NULL WHERE embedding IS NOT NULL;
UPDATE coding_decisions SET embedding = NULL WHERE embedding IS NOT NULL;

-- Alter column types to 768 dimensions
ALTER TABLE coding_preferences ALTER COLUMN embedding TYPE vector(768);
ALTER TABLE coding_decisions ALTER COLUMN embedding TYPE vector(768);

-- Note: Other tables with 1536-dim embeddings that may need updating:
-- - canonical_message, canonical_conversation, canonical_issue, canonical_notification
-- - entity_mentions, runtime_facts, canonical_entities, canonical_event
-- These are left at 1536 for now as they may use different embedding strategies
