-- Add structured training signal payload for memory retrieval traces.

ALTER TABLE evidence_retrieval_log
  ADD COLUMN IF NOT EXISTS training_signal JSONB;
