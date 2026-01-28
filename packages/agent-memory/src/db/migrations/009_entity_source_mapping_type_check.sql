-- Enforce canonical entity types on entity_source_mappings

-- First, remove any rows that don't match the new constraint
DELETE FROM entity_source_mappings
WHERE canonical_entity_type NOT IN ('message', 'conversation', 'issue', 'notification');

ALTER TABLE entity_source_mappings
  DROP CONSTRAINT IF EXISTS entity_source_mappings_entity_type_check;

ALTER TABLE entity_source_mappings
  ADD CONSTRAINT entity_source_mappings_entity_type_check
  CHECK (canonical_entity_type IN ('message', 'conversation', 'issue', 'notification'));
