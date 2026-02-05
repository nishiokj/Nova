-- Add trigram indexes for preference/decision similarity search

CREATE INDEX IF NOT EXISTS idx_coding_preferences_trgm
  ON coding_preferences
  USING GIN ((
    lower(
      coalesce(preference, '') || ' ' ||
      coalesce(entity_free_formulation, '') || ' ' ||
      coalesce(context, '') || ' ' ||
      coalesce(failure_mode_prevented, '') || ' ' ||
      coalesce(counterexample, '') || ' ' ||
      coalesce(category, '') || ' ' ||
      coalesce(kind, '') || ' ' ||
      coalesce(scope, '')
    )
  ) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_coding_decisions_trgm
  ON coding_decisions
  USING GIN ((
    lower(
      coalesce(decision, '') || ' ' ||
      coalesce(rationale, '') || ' ' ||
      coalesce(tradeoffs, '') || ' ' ||
      coalesce(alternatives_considered, '') || ' ' ||
      coalesce(category, '') || ' ' ||
      coalesce(scope, '') || ' ' ||
      coalesce(project_context, '') || ' ' ||
      coalesce(task_context, '')
    )
  ) gin_trgm_ops);
