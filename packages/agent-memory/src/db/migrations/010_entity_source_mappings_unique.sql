-- Update entity_source_mappings uniqueness to include transformation_id

DROP INDEX IF EXISTS idx_entity_source_mappings_source_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_source_mappings_source_key
  ON entity_source_mappings (source_ref_key, transformation_id);
