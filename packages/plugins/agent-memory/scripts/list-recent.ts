import { createDatabaseFromEnv } from '../src/db/connection.js'

async function main() {
  const db = createDatabaseFromEnv()

  try {
    const digests = await db.sql`
      SELECT
        d.conversation_id,
        d.summary,
        d.topic,
        d.updated_at,
        c.source_timestamp,
        d.decisions,
        d.outcome,
        c.data->>'topic' as original_topic
      FROM conversation_digests d
      LEFT JOIN canonical_conversation c ON c.id = d.conversation_id
      ORDER BY COALESCE(c.source_timestamp, d.updated_at) DESC
      LIMIT 15
    `

    console.log('Recent conversations:\n')
    digests.forEach((d, i) => {
      const date = d.source_timestamp || d.updated_at
      console.log(`${i + 1}. ${d.summary}`)
      if (d.topic) console.log(`   Topic: ${d.topic}`)
      if (d.decisions && d.decisions.length > 0) {
        console.log(`   Decisions: ${d.decisions.join(', ')}`)
      }
      if (d.outcome) console.log(`   Outcome: ${d.outcome}`)
      console.log(`   Date: ${date}`)
      console.log('')
    })
  } finally {
    await db.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
