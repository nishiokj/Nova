-- First get the embedding for reference
WITH source AS (
  SELECT embedding
  FROM coding_preferences
  WHERE id = '01KFZ0Z85B8VKMMKARFCCE3EFR'
    AND embedding IS NOT NULL
)
SELECT p.id, LEFT(p.preference, 50) as pref, p.category
FROM coding_preferences p, source s
WHERE p.embedding IS NOT NULL
  AND p.id != '01KFZ0Z85B8VKMMKARFCCE3EFR'
ORDER BY p.embedding <-> s.embedding
LIMIT 5
