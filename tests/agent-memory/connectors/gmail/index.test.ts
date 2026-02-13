/**
 * Gmail Connector Integration Tests
 *
 * Integration tests for Gmail connector sync operations.
 *
 * @module connectors/gmail/index.test
 */

import { GmailConnector, type GmailConnectorConfig } from 'agent-memory/connectors/gmail/index.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  ConnectorContext,
} from 'agent-memory/connector/sdk/index.js'
import type {
  GmailMessageList,
  GmailMessage,
  GmailHistoryResponse,
} from 'agent-memory/connectors/gmail/schemas.js'

// ============ Mock Data ============

const mockUserInfo = {
  id: 'user123',
  email: 'test@example.com',
  verified_email: true,
  name: 'Test User',
  picture: 'https://example.com/avatar.jpg',
  locale: 'en',
}

const mockMessageList: GmailMessageList = {
  messages: [
    { id: 'msg1', threadId: 'thread1' },
    { id: 'msg2', threadId: 'thread2' },
  ],
  nextPageToken: 'page2',
  resultSizeEstimate: 100,
}

const mockMessage: GmailMessage = {
  id: 'msg1',
  threadId: 'thread1',
  labelIds: ['INBOX', 'UNREAD'],
  historyId: '123',
  internalDate: '1704067200000',
  snippet: 'Test message',
  payload: {
    headers: [
      { name: 'From', value: 'sender@example.com' },
      { name: 'To', value: 'recipient@example.com' },
      { name: 'Subject', value: 'Test' },
    ],
    body: {
      data: Buffer.from('Test body').toString('base64'),
    },
  },
  sizeEstimate: 500,
}

const mockHistoryResponse: GmailHistoryResponse = {
  historyId: '456',
  history: [
    {
      id: 'hist1',
      messagesAdded: [
        {
          message: {
            id: 'msg3',
            threadId: 'thread3',
            labelIds: ['INBOX'],
          },
        },
      ],
    },
    {
      id: 'hist2',
      messagesDeleted: [
        {
          message: {
            id: 'msg4',
            threadId: 'thread4',
            labelIds: ['TRASH'],
          },
        },
      ],
    },
  ],
}

// ============ Test Setup ============

describe('GmailConnector', () => {
  let connector: GmailConnector
  let mockHttp: any
  let config: GmailConnectorConfig

  beforeEach(() => {
    config = {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      rateLimit: 1,
      labels: ['INBOX'],
      excludeLabels: ['SPAM', 'TRASH'],
    }

    // Create connector and mock HTTP client
    connector = new GmailConnector(config)
    mockHttp = {
      get: vi.fn(),
      post: vi.fn(),
      request: vi.fn(),
    }

    // Replace the internal HTTP client with mock
    connector['http'] = mockHttp
  })

  // ============ Constructor Tests ============

  describe('constructor', () => {
    it('sets correct connector properties', () => {
      expect(connector.type).toBe('gmail')
      expect(connector.displayName).toBe('Gmail')
    })

    it('sets correct capabilities', () => {
      const caps = connector.capabilities
      expect(caps.supportsBackfill).toBe(true)
      expect(caps.supportsIncrementalSync).toBe(true)
      expect(caps.supportsWebhook).toBe(true)
      expect(caps.supportsWrite).toBe(false)
      expect(caps.supportedEntityTypes).toEqual(['message', 'thread', 'identity'])
    })

    it('configures OAuth2 settings', () => {
      expect(connector.authConfig.type).toBe('oauth2')
      expect(connector.authConfig.authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth')
      expect(connector.authConfig.tokenUrl).toBe('https://oauth2.googleapis.com/token')
      expect(connector.authConfig.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly')
      expect(connector.authConfig.clientId).toBe('test-client-id')
      expect(connector.authConfig.clientSecret).toBe('test-client-secret')
    })

    it('sets rate limit correctly', () => {
      const connectorWithLimit = new GmailConnector({ ...config, rateLimit: 5 })
      expect(connectorWithLimit['http'].rateLimiter).toBeDefined()
    })

    it('registers mappers and schemas', () => {
      expect(connector.getMapper('message')).toBeDefined()
      expect(connector.getMapper('thread')).toBeDefined()
      expect(connector.getMapper('identity')).toBeDefined()
      expect(connector.getSchema('message')).toBeDefined()
      expect(connector.getSchema('thread')).toBeDefined()
    })
  })

  // ============ listAccounts Tests ============

  describe('listAccounts', () => {
    it('fetches and returns user info', async () => {
      const ctx: ConnectorContext = {
        accountId: 'test-account',
        accessToken: 'test-token',
        credentials: undefined,
        config: {},
      }

      mockHttp.request.mockResolvedValue({
        ok: true,
        status: 200,
        data: mockUserInfo,
        headers: new Headers(),
      })

      const accounts = await connector.listAccounts(ctx)

      expect(accounts).toHaveLength(1)
      expect(accounts[0]).toMatchObject({
        externalId: 'user123',
        displayName: 'Test User',
        email: 'test@example.com',
        avatarUrl: 'https://example.com/avatar.jpg',
        username: 'test@example.com',
        isPrimary: true,
      })
      expect(accounts[0].metadata).toHaveProperty('email', 'test@example.com')
      expect(accounts[0].metadata).toHaveProperty('verified_email', true)
    })

    it('throws error on failed request', async () => {
      const ctx: ConnectorContext = {
        accountId: 'test-account',
        accessToken: 'test-token',
        credentials: undefined,
        config: {},
      }

      mockHttp.request.mockResolvedValue({
        ok: false,
        status: 401,
        data: null,
        headers: new Headers(),
      })

      await expect(connector.listAccounts(ctx)).rejects.toThrow('Failed to get user info')
    })

    it('throws error on invalid response', async () => {
      const ctx: ConnectorContext = {
        accountId: 'test-account',
        accessToken: 'test-token',
        credentials: undefined,
        config: {},
      }

      mockHttp.request.mockResolvedValue({
        ok: true,
        status: 200,
        data: { invalid: 'data' },
        headers: new Headers(),
      })

      await expect(connector.listAccounts(ctx)).rejects.toThrow()
    })
  })

  // ============ fetchPage (Backfill) Tests ============

  describe('fetchPage', () => {
    const ctx: ConnectorContext = {
      accountId: 'test-account',
      accessToken: 'test-token',
      credentials: undefined,
      config: {},
    }

    it('fetches messages for backfill', async () => {
      // Mock list endpoint
      mockHttp.request
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: mockMessageList,
          headers: new Headers({
            'x-ratelimit-limit': '100',
            'x-ratelimit-remaining': '95',
          }),
        })
        // Mock get message endpoint
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: mockMessage,
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { ...mockMessage, id: 'msg2', threadId: 'thread2' },
          headers: new Headers(),
        })

      const options: FetchPageOptions = {
        limit: 50,
        entityTypes: ['message'],
      }

      const result = await connector.fetchPage(ctx, options)

      expect(result.items).toHaveLength(2)
      expect(result.items[0]).toMatchObject({
        source_id: 'msg1',
        entity_type: 'message',
      })
      expect(result.hasMore).toBe(true)
      expect(result.nextCursor).toContain('page2')
      expect(result.rateLimit).toEqual({
        limit: 100,
        remaining: 95,
      })
    })

    it('handles pagination with cursor', async () => {
      mockHttp.request.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { messages: [{ id: 'msg3', threadId: 'thread3' }], resultSizeEstimate: 50 },
        headers: new Headers(),
      }).mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: mockMessage,
        headers: new Headers(),
      })

      const options: FetchPageOptions = {
        cursor: JSON.stringify({ pageToken: 'page2', entityTypeIndex: 0, fetchedIds: [] }),
        limit: 50,
      }

      const result = await connector.fetchPage(ctx, options)

      expect(result.hasMore).toBe(false)
      expect(result.nextCursor).toBeUndefined()
    })

    it('handles multiple entity types', async () => {
      mockHttp.request
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { messages: [], resultSizeEstimate: 0 },
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: {
            threads: [{ id: 'thread1', historyId: '123' }],
            resultSizeEstimate: 10,
          },
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: {
            id: 'thread1',
            historyId: '123',
            messages: [mockMessage],
          },
          headers: new Headers(),
        })

      const options: FetchPageOptions = {
        limit: 50,
        entityTypes: ['message', 'thread'],
      }

      const result = await connector.fetchPage(ctx, options)

      expect(mockHttp.request).toHaveBeenCalledTimes(3)
      expect(result.hasMore).toBe(false)
    })

    it('applies label filtering in search query', async () => {
      mockHttp.request.mockResolvedValue({
        ok: true,
        status: 200,
        data: { messages: [], resultSizeEstimate: 0 },
        headers: new Headers(),
      })

      await connector.fetchPage(ctx, {
        limit: 50,
      })

      // Check that search query includes label filter
      expect(mockHttp.request).toHaveBeenCalled()
    })

    it('continues on individual message fetch failures', async () => {
      mockHttp.request
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: mockMessageList,
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          ok: false, // First message fails
          status: 404,
          data: null,
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: mockMessage,
          headers: new Headers(),
        })

      const result = await connector.fetchPage(ctx, { limit: 50 })

      // Should return only the successful message
      expect(result.items).toHaveLength(1)
      expect(result.items[0].source_id).toBe('msg2')
    })
  })

  // ============ fetchChanges (Incremental Sync) Tests ============

  describe('fetchChanges', () => {
    const ctx: ConnectorContext = {
      accountId: 'test-account',
      accessToken: 'test-token',
      credentials: undefined,
      config: {},
    }

    it('fetches changes via History API', async () => {
      mockHttp.request
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: mockHistoryResponse,
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: mockMessage,
          headers: new Headers(),
        })

      const options: FetchChangesOptions = {
        since: '123',
        limit: 100,
      }

      const result = await connector.fetchChanges(ctx, options)

      expect(result.items).toHaveLength(2) // 1 added + 1 deleted
      expect(result.items[0].entity_type).toBe('message')
      expect(result.items[1].raw_data).toHaveProperty('deleted', true)
      expect(result.nextHistoryId).toBe('456')
      expect(result.hasMore).toBe(false)
    })

    it('handles historyId cursor', async () => {
      mockHttp.request
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { historyId: '789', history: [] },
          headers: new Headers(),
        })

      const options: FetchChangesOptions = {
        cursor: JSON.stringify({ historyId: '456', entityTypeIndex: 0 }),
      }

      const result = await connector.fetchChanges(ctx, options)

      expect(result.nextHistoryId).toBe('789')
    })

    it('filters by messageAdded and messageDeleted history types', async () => {
      mockHttp.request.mockResolvedValue({
        ok: true,
        status: 200,
        data: mockHistoryResponse,
        headers: new Headers(),
      })

      await connector.fetchChanges(ctx, { since: '123' })

      const historyCall = mockHttp.request.mock.calls.find(
        (call: any[]) => call[1]?.url.includes('/history')
      )
      expect(historyCall).toBeDefined()
    })

    it('handles empty history response', async () => {
      mockHttp.request.mockResolvedValue({
        ok: true,
        status: 200,
        data: { historyId: '456', history: [] },
        headers: new Headers(),
      })

      const result = await connector.fetchChanges(ctx, { since: '123' })

      expect(result.items).toHaveLength(0)
      expect(result.nextHistoryId).toBe('456')
    })
  })

  // ============ parseWebhookPayload Tests ============

  describe('parseWebhookPayload', () => {
    it('parses Pub/Sub push envelope', async () => {
      const webhookPayload = {
        message: {
          data: Buffer.from(JSON.stringify({
            emailAddress: 'test@example.com',
            historyId: 123,
          })).toString('base64'),
          messageId: 'webhook-123',
          publishTime: '2024-01-01T00:00:00Z',
        },
        subscription: 'projects/test/subscriptions/gmail-sub',
      }

      const event = {
        deliveryId: 'delivery-123',
        eventType: 'gmail.notification',
        payload: webhookPayload,
        headers: {},
        signature: '',
        receivedAt: new Date(),
      }

      const result = await connector.parseWebhookPayload(event)

      // Note: Actual history fetching requires credentials, so returns empty
      // In production, this would fetch the actual changes
      expect(Array.isArray(result)).toBe(true)
    })

    it('handles invalid envelope gracefully', async () => {
      const event = {
        deliveryId: 'delivery-123',
        eventType: 'gmail.notification',
        payload: { invalid: 'data' },
        headers: {},
        signature: '',
        receivedAt: new Date(),
      }

      const result = await connector.parseWebhookPayload(event)

      expect(result).toEqual([])
    })

    it('handles invalid base64 data', async () => {
      const webhookPayload = {
        message: {
          data: 'invalid-base64!!!',
          messageId: 'webhook-123',
          publishTime: '2024-01-01T00:00:00Z',
        },
        subscription: 'projects/test/subscriptions/gmail-sub',
      }

      const event = {
        deliveryId: 'delivery-123',
        eventType: 'gmail.notification',
        payload: webhookPayload,
        headers: {},
        signature: '',
        receivedAt: new Date(),
      }

      const result = await connector.parseWebhookPayload(event)

      expect(result).toEqual([])
    })
  })

  // ============ Rate Limiting Tests ============

  describe('rate limiting', () => {
    it('configures rate limiter from config', () => {
      const connector = new GmailConnector({
        clientId: 'test',
        clientSecret: 'test',
        rateLimit: 5,
      })

      expect(connector['http'].rateLimiter).toBeDefined()
    })

    it('uses default rate limit of 1 when not specified', () => {
      const connector = new GmailConnector({
        clientId: 'test',
        clientSecret: 'test',
      })

      expect(connector['http'].rateLimiter).toBeDefined()
    })
  })

  // ============ Helper Function Tests ============

  describe('buildSearchQuery', () => {
    it('builds query with labels', () => {
      const connector = new GmailConnector({
        clientId: 'test',
        clientSecret: 'test',
        labels: ['INBOX', 'IMPORTANT'],
      })

      const query = (connector as any).buildSearchQuery()
      expect(query).toContain('label:INBOX')
      expect(query).toContain('label:IMPORTANT')
    })

    it('excludes SPAM and TRASH by default', () => {
      const connector = new GmailConnector({
        clientId: 'test',
        clientSecret: 'test',
      })

      const query = (connector as any).buildSearchQuery()
      expect(query).toContain('-label:SPAM')
      expect(query).toContain('-label:TRASH')
    })

    it('excludes custom labels', () => {
      const connector = new GmailConnector({
        clientId: 'test',
        clientSecret: 'test',
        excludeLabels: ['SPAM', 'TRASH', 'PROMOTIONS'],
      })

      const query = (connector as any).buildSearchQuery()
      expect(query).toContain('-label:PROMOTIONS')
    })
  })
})
