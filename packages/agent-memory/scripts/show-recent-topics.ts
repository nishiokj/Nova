import { createDatabaseFromEnv } from '../dist/db/connection.js'

async function main() {
  const db = createDatabaseFromEnv()

  try {
    // Get recent conversations with their message content
    const conversations = await db.sql`
      SELECT DISTINCT
        cc.id,
        cc.data,
        cd.summary,
        cd.decisions,
        cd.outcome,
        cd.updated_at
      FROM canonical_conversation cc
      LEFT JOIN conversation_digests cd ON cc.id = cd.conversation_id
      WHERE cd.summary IS NOT NULL
      ORDER BY cd.updated_at DESC
      LIMIT 10
    `

    console.log('Recent conversations:\n')
    for (const conv of conversations) {
      console.log(`📌 ${conv.summary || '(Untitled)'}`)
      console.log(`   ID: ${conv.id}`)
      if (conv.decisions && conv.decisions.length > 0) {
        console.log(`   Decisions: ${conv.decisions.join(', ')}`)
      }
      if (conv.outcome) {
        console.log(`   Outcome: ${conv.outcome}`)
      }

      // Get recent messages for this conversation
      const messages = await db.sql`
        SELECT
          display_text,
          data->>'body_text' as body_text,
          data->>'created_at' as created_at
        FROM canonical_message
        WHERE data->>'conversation_id' = ${conv.id}
        ORDER BY data->>'created_at' DESC
        LIMIT 5
      `

      if (messages.length > 0) {
        console.log(`   Recent messages:`)
        messages.forEach(m => {
          const text = m.display_text || m.body_text || '(empty)'
          const preview = text.length > 80 ? text.slice(0, 80) + '...' : text
          console.log(`     - "${preview}"`)
        })
      } else {
        console.log(`   No messages found`)
      }
      console.log('')
    }
  } finally {
    await db.close()
  }

  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
