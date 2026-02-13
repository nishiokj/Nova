/**
 * Gmail Transformations Tests
 */

import { gmailMessageTransform } from 'agent-memory/connectors/gmail/transforms.js'
import type { GmailMessage } from 'agent-memory/connectors/gmail/schemas.js'

const sampleMessage: GmailMessage = {
  id: 'msg-1',
  threadId: 'thread-1',
  labelIds: ['INBOX', 'UNREAD'],
  snippet: 'Hello world',
  historyId: 'h1',
  internalDate: '1700000000000',
  payload: {
    partId: '0',
    mimeType: 'text/plain',
    filename: '',
    headers: [
      { name: 'From', value: 'Alice <alice@example.com>' },
      { name: 'To', value: 'Bob <bob@example.com>' },
      { name: 'Subject', value: 'Greetings' },
    ],
    body: {
      data: Buffer.from('Hello from Gmail').toString('base64'),
      size: 17,
    },
  },
  sizeEstimate: 1234,
}

describe('gmailMessageTransform', () => {
  test('maps Gmail message to canonical message and identities', () => {
    const result = gmailMessageTransform.transform(sampleMessage, {
      envelope: {
        id: 'env-1',
        idempotency_key: 'key-1',
        connector: 'gmail',
        account_id: 'acct-1',
        entity_type: 'message',
        source_id: 'msg-1',
        raw_data: sampleMessage,
        raw_data_hash: 'hash-1',
        received_at: new Date().toISOString(),
        sync_job_id: 'job-1',
        collection_method: 'backfill',
        source_timestamp: new Date().toISOString(),
      },
      accountId: 'acct-1',
      connector: 'gmail',
      lookupEntity: async () => null,
      lookupEntitiesByType: async () => [],
    })

    const resultArray = Array.isArray(result) ? result : [result]
    expect(resultArray).toHaveLength(1)
    const primary = resultArray[0].primary
    expect(primary.entityType).toBe('message')
    const related = resultArray[0].related ?? []
    expect(related.length).toBeGreaterThan(0)
    const identityOutputs = related.filter((output) => output.entityType === 'identity')
    expect(identityOutputs.length).toBeGreaterThanOrEqual(2)
  })
})
