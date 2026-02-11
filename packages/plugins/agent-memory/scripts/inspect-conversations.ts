import { createDatabaseFromEnv } from '../dist/db/connection.js'

async function main() {
  const db = createDatabaseFromEnv()

  try {
    // Get recent conversations with more details
    const conversations = await db.sql`
      SELECT
        cc.id,
        cc.data->>'source' as source,
        cc.data->>'source_timestamp' as source_timestamp,
        cc.data,
        cd.summary,
        cd.decisions,
        cd.outcome,
        COUNT(cm.id) as message_count
      FROM canonical_conversation cc
      LEFT JOIN conversation_digests cd ON cc.id = cd.conversation_id
      LEFT JOIN canonical_message cm ON cc.id = cm.data->>'conversation_id'
      WHERE cd.summary IS NOT NULL OR cc.data->>'source' = 'telegram'
      GROUP BY cc.id, cd.summary, cd.decisions, cd.outcome
      ORDER BY (cc.data->>'source_timestamp')::timestamptz DESC NULLS LAST
      LIMIT 10
    `

    console.log('Recent conversations with details:\n')
    conversations.forEach((c, i) => {
      console.log(`${i + 1}. Source: ${c.source} | ID: ${c.id}`)
      console.log(`   Summary: ${c.summary || '(no digest)'}`)
      console.log(`   Messages: ${c.message_count}`)
      if (c.source_timestamp) {
        console.log(`   Date: ${c.source_timestamp}`)
      }
      if (c.decisions && c.decisions.length > 0) {
        console.log(`   Decisions: ${c.decisions.join(', ')}`)
      }
      if (c.outcome) console.log(`   Outcome: ${c.outcome}`)
      console.log('')
    })
  } finally {
    await db.close()
  }

  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
