SELECT c2.id, LEFT(c2.preference, 50) as similar_pref, c2.category
FROM coding_preferences c1, coding_preferences c2
WHERE c1.id = '01KFZ0Z85B8VKMMKARFCCE3EFR'
  AND c2.embedding IS NOT NULL
  AND c1.embedding IS NOT NULL
  AND c1.id != c2.id
ORDER BY c1.embedding <-> c2.embedding
LIMIT 5
