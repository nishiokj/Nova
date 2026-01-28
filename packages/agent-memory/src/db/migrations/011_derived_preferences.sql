-- Derived preferences table (matches extract.ts output schema)

CREATE TABLE IF NOT EXISTS coding_preferences (
  id TEXT PRIMARY KEY,
  CONSTRAINT derived_preferences_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}
),
  category TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('principle_candidate', 'local_convention', 'ignore')),
  preference TEXT NOT NULL,
  entity_free_formulation TEXT NOT NULL,
  scope TEXT NOT NULL,
  context TEXT NOT NULL,
  failure_mode_prevented TEXT NOT NULL,
  signal_strength TEXT NOT NULL CHECK (signal_strength IN ('explicit', 'implicit')),
  evidence_count INTEGER NOT NULL,
  evidence_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  counterexample TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coding_preferences_category ON coding_preferences(category);
CREATE INDEX IF NOT EXISTS idx_coding_preferences_kind ON coding_preferences(kind);
CREATE INDEX IF NOT EXISTS idx_coding_preferences_confidence ON coding_preferences(confidence);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coding_preferences_unique
  ON coding_preferences(category, kind, preference, entity_free_formulation, scope);
