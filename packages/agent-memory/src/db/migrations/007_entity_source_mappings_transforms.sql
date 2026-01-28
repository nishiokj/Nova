-- Entity Source Mappings: Transformation lineage

ALTER TABLE entity_source_mappings
  ADD COLUMN IF NOT EXISTS transformation_id TEXT REFERENCES transformations(id) ON DELETE SET NULL;

ALTER TABLE entity_source_mappings
  ADD COLUMN IF NOT EXISTS transformation_version INTEGER;

CREATE INDEX IF NOT EXISTS idx_entity_source_mappings_transformation
  ON entity_source_mappings (transformation_id);
