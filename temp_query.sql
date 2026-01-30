SELECT
  data->'source_refs'->0->>'connector' AS connector,
  data->'source_refs'->0->>'account_id' AS account_id,
  data->>'thread_id' AS thread_id,
  data->>'body_text' AS body_text,
  display_text,
  COUNT(*) AS count
FROM canonical_message
WHERE display_text IS NULL OR display_text = ''
GROUP BY connector, account_id, thread_id, body_text, display_text
ORDER BY count DESC
LIMIT 10;
