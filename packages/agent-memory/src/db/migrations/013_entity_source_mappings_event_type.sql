-- Add 'event' and 'preference' to allowed entity types in entity_source_mappings

ALTER TABLE entity_source_mappings
  DROP CONSTRAINT IF EXISTS entity_source_mappings_entity_type_check;

ALTER TABLE entity_source_mappings
  ADD CONSTRAINT entity_source_mappings_entity_type_check
  CHECK (canonical_entity_type IN ('message', 'conversation', 'issue', 'notification', 'event', 'preference'));
