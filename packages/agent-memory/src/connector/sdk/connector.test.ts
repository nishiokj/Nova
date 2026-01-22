/**
 * Connector SDK Tests
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { z } from 'zod'
import type { ConnectorType } from '../../ids.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  FetchPageResult,
  SourceItem,
  EntityMapper,
  MapperContext,
  MappedEntity,
} from '../../sync/types.js'
import {
  BaseConnector,
  ConnectorRegistry,
  connectorRegistry,
  noopLogger,
} from './connector.js'
import type {
  ConnectorCapabilities,
  AuthConfig,
  ConnectorContext,
  AccountInfo,
  WebhookEvent,
  AuthTokens,
} from './types.js'
import {
  ConnectorCapabilitiesSchema,
  OAuth2ConfigSchema,
  ApiKeyConfigSchema,
  LocalAuthConfigSchema,
  AuthTokensSchema,
  AccountInfoSchema,
  WebhookEventSchema,
} from './types.js'

// ============ Test Connector Implementation ============

class TestConnector extends BaseConnector {
  readonly type: ConnectorType = 'github'
  readonly displayName = 'Test GitHub'
  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: true,
    supportsWebhook: true,
    supportsWrite: false,
    supportedEntityTypes: ['issue', 'pull_request', 'user'],
  }
  readonly authConfig: AuthConfig = {
    type: 'oauth2',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user'],
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
  }

  constructor() {
    super({ httpConfig: { maxRetries: 0 }, logger: noopLogger }) // Disable retries and logging for tests

    // Register test mapper
    this.registerMapper({
      sourceEntityType: 'issue',
      targetEntityType: 'task',
      sourceSchema: z.object({
        id: z.number(),
        title: z.string(),
        body: z.string().optional(),
      }),
      map: (source, context): MappedEntity => ({
        entityType: 'task',
        data: {
          id: 'test-id',
          entity_type: 'task',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          source_refs: [context.sourceRef],
          title: source.title,
          description: source.body,
          status: 'open',
        },
        sourceRefKey: context.sourceRef.account_id + ':issue:' + source.id,
      }),
    })

    // Register test schema
    this.registerSchema('issue', z.object({
      id: z.number(),
      title: z.string(),
      body: z.string().optional(),
      state: z.enum(['open', 'closed']),
    }))
  }

  async listAccounts(ctx: ConnectorContext): Promise<AccountInfo[]> {
    return [{
      externalId: 'test-user-123',
      displayName: 'Test User',
      email: 'test@example.com',
      isPrimary: true,
    }]
  }

  async fetchPage(ctx: ConnectorContext, options: FetchPageOptions): Promise<FetchPageResult> {
    return {
      items: [{
        source_id: '1',
        entity_type: 'issue',
        raw_data: { id: 1, title: 'Test Issue', state: 'open' },
      }],
      hasMore: false,
    }
  }

  async fetchChanges(ctx: ConnectorContext, options: FetchChangesOptions): Promise<FetchPageResult> {
    return {
      items: [],
      hasMore: false,
      nextCursor: 'cursor-123',
    }
  }

  async parseWebhookPayload(event: WebhookEvent): Promise<SourceItem[]> {
    const payload = event.payload as { action: string; issue: { id: number; title: string } }
    return [{
      source_id: String(payload.issue.id),
      entity_type: 'issue',
      raw_data: payload.issue,
    }]
  }
}

// ============ Schema Validation Tests ============

describe('Connector SDK Schemas', () => {
  test('ConnectorCapabilitiesSchema validates capabilities', () => {
    const valid = {
      supportsBackfill: true,
      supportsIncrementalSync: false,
      supportsWebhook: true,
      supportsWrite: false,
      supportedEntityTypes: ['issue', 'user'],
    }

    const result = ConnectorCapabilitiesSchema.parse(valid)
    expect(result.supportsBackfill).toBe(true)
    expect(result.supportedEntityTypes).toEqual(['issue', 'user'])
  })

  test('OAuth2ConfigSchema validates OAuth config', () => {
    const valid = {
      type: 'oauth2' as const,
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      scopes: ['read', 'write'],
      clientId: 'client-123',
      clientSecret: 'secret-456',
    }

    const result = OAuth2ConfigSchema.parse(valid)
    expect(result.type).toBe('oauth2')
    expect(result.scopes).toEqual(['read', 'write'])
  })

  test('ApiKeyConfigSchema validates API key config', () => {
    const valid = {
      type: 'api_key' as const,
      headerName: 'X-API-Key',
      headerPrefix: 'Bearer',
    }

    const result = ApiKeyConfigSchema.parse(valid)
    expect(result.headerName).toBe('X-API-Key')
  })

  test('LocalAuthConfigSchema validates local auth config', () => {
    const valid = {
      type: 'local' as const,
      dataPath: '/path/to/data',
      requiresSystemAccess: true,
    }

    const result = LocalAuthConfigSchema.parse(valid)
    expect(result.dataPath).toBe('/path/to/data')
  })

  test('AuthTokensSchema validates tokens', () => {
    const valid = {
      accessToken: 'token-123',
      refreshToken: 'refresh-456',
      tokenType: 'Bearer',
      expiresIn: 3600,
    }

    const result = AuthTokensSchema.parse(valid)
    expect(result.accessToken).toBe('token-123')
  })

  test('AccountInfoSchema validates account info', () => {
    const valid = {
      externalId: 'user-123',
      displayName: 'Test User',
      email: 'test@example.com',
      isPrimary: true,
    }

    const result = AccountInfoSchema.parse(valid)
    expect(result.externalId).toBe('user-123')
  })

  test('WebhookEventSchema validates webhook events', () => {
    const valid = {
      eventType: 'issue.created',
      payload: { action: 'created', issue: { id: 1 } },
      headers: { 'x-github-event': 'issues' },
      receivedAt: new Date(),
    }

    const result = WebhookEventSchema.parse(valid)
    expect(result.eventType).toBe('issue.created')
  })
})

// ============ BaseConnector Tests ============

describe('BaseConnector', () => {
  let connector: TestConnector

  beforeEach(() => {
    connector = new TestConnector()
  })

  test('has correct type and display name', () => {
    expect(connector.type).toBe('github')
    expect(connector.displayName).toBe('Test GitHub')
  })

  test('has correct capabilities', () => {
    expect(connector.capabilities.supportsBackfill).toBe(true)
    expect(connector.capabilities.supportsIncrementalSync).toBe(true)
    expect(connector.capabilities.supportsWebhook).toBe(true)
    expect(connector.capabilities.supportsWrite).toBe(false)
    expect(connector.capabilities.supportedEntityTypes).toContain('issue')
  })

  test('hasCapability returns correct values', () => {
    expect(connector.hasCapability('supportsBackfill')).toBe(true)
    expect(connector.hasCapability('supportsWrite')).toBe(false)
  })

  test('supportsEntityType returns correct values', () => {
    expect(connector.supportsEntityType('issue')).toBe(true)
    expect(connector.supportsEntityType('unknown')).toBe(false)
  })

  test('getAuthorizationUrl generates correct URL', () => {
    const url = connector.getAuthorizationUrl('state-123', 'https://example.com/callback')
    const parsedUrl = new URL(url)

    expect(parsedUrl.origin + parsedUrl.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(parsedUrl.searchParams.get('client_id')).toBe('test-client-id')
    expect(parsedUrl.searchParams.get('redirect_uri')).toBe('https://example.com/callback')
    expect(parsedUrl.searchParams.get('state')).toBe('state-123')
    expect(parsedUrl.searchParams.get('scope')).toBe('repo read:user')
    expect(parsedUrl.searchParams.get('response_type')).toBe('code')
  })

  test('getSourceSchema returns registered schema', () => {
    const schema = connector.getSourceSchema('issue')
    expect(schema).toBeDefined()

    const valid = { id: 1, title: 'Test', state: 'open' }
    const result = schema!.safeParse(valid)
    expect(result.success).toBe(true)
  })

  test('getSourceSchema returns undefined for unknown type', () => {
    const schema = connector.getSourceSchema('unknown')
    expect(schema).toBeUndefined()
  })

  test('getMapper returns registered mapper', () => {
    const mapper = connector.getMapper('issue')
    expect(mapper).toBeDefined()
    expect(mapper!.sourceEntityType).toBe('issue')
    expect(mapper!.targetEntityType).toBe('task')
  })

  test('getMapper returns undefined for unknown type', () => {
    const mapper = connector.getMapper('unknown')
    expect(mapper).toBeUndefined()
  })

  test('listAccounts returns account info', async () => {
    const ctx: ConnectorContext = { accountId: 'test' }
    const accounts = await connector.listAccounts(ctx)

    expect(accounts).toHaveLength(1)
    expect(accounts[0].externalId).toBe('test-user-123')
    expect(accounts[0].displayName).toBe('Test User')
  })

  test('fetchPage returns items', async () => {
    const ctx: ConnectorContext = { accountId: 'test', accessToken: 'token' }
    const result = await connector.fetchPage(ctx, {})

    expect(result.items).toHaveLength(1)
    expect(result.items[0].entity_type).toBe('issue')
    expect(result.hasMore).toBe(false)
  })

  test('fetchChanges returns empty for no changes', async () => {
    const ctx: ConnectorContext = { accountId: 'test', accessToken: 'token' }
    const result = await connector.fetchChanges!(ctx, { since: 'cursor' })

    expect(result.items).toHaveLength(0)
    expect(result.nextCursor).toBe('cursor-123')
  })

  test('parseWebhookPayload extracts items', async () => {
    const event: WebhookEvent = {
      eventType: 'issues',
      payload: { action: 'opened', issue: { id: 123, title: 'New Issue' } },
      headers: {},
      receivedAt: new Date(),
    }

    const items = await connector.parseWebhookPayload!(event)

    expect(items).toHaveLength(1)
    expect(items[0].source_id).toBe('123')
    expect(items[0].entity_type).toBe('issue')
  })

  test('verifyWebhookSignature validates HMAC-SHA256', async () => {
    const event: WebhookEvent = {
      eventType: 'test',
      payload: '{"test":true}',
      headers: {},
      signature: 'sha256=5d5d139563c95b5967b9bd9a8c9b5a3c8d8e2f1a0b3c4d5e6f7a8b9c0d1e2f3a',
      receivedAt: new Date(),
    }

    const result = await connector.verifyWebhookSignature(event, 'secret')

    // Will fail because signature doesn't match, but verifies the flow works
    expect(result.valid).toBe(false)
    expect(result.computedSignature).toBeDefined()
  })

  test('verifyWebhookSignature fails without signature', async () => {
    const event: WebhookEvent = {
      eventType: 'test',
      payload: '{"test":true}',
      headers: {},
      receivedAt: new Date(),
    }

    const result = await connector.verifyWebhookSignature(event, 'secret')

    expect(result.valid).toBe(false)
    expect(result.error).toBe('No signature provided')
  })

  test('getHttpStats returns stats', () => {
    const stats = connector.getHttpStats()

    expect(stats.rateLimiter).toBeDefined()
    expect(stats.circuitBreaker).toBeDefined()
    expect(stats.circuitBreaker.state).toBe('closed')
  })
})

// ============ ConnectorRegistry Tests ============

describe('ConnectorRegistry', () => {
  let registry: ConnectorRegistry
  let connector: TestConnector

  beforeEach(() => {
    registry = new ConnectorRegistry()
    connector = new TestConnector()
  })

  test('register adds connector', () => {
    registry.register(connector)
    expect(registry.has('github')).toBe(true)
  })

  test('register throws on duplicate', () => {
    registry.register(connector)
    expect(() => registry.register(connector)).toThrow('already registered')
  })

  test('get returns registered connector', () => {
    registry.register(connector)
    const result = registry.get('github')
    expect(result).toBe(connector)
  })

  test('get returns undefined for unknown type', () => {
    const result = registry.get('gmail')
    expect(result).toBeUndefined()
  })

  test('getOrThrow returns connector', () => {
    registry.register(connector)
    const result = registry.getOrThrow('github')
    expect(result).toBe(connector)
  })

  test('getOrThrow throws for unknown type', () => {
    expect(() => registry.getOrThrow('gmail')).toThrow('not registered')
  })

  test('types returns registered types', () => {
    registry.register(connector)
    const types = registry.types()
    expect(types).toEqual(['github'])
  })

  test('all returns all connectors', () => {
    registry.register(connector)
    const all = registry.all()
    expect(all).toHaveLength(1)
    expect(all[0]).toBe(connector)
  })

  test('clear removes all connectors', () => {
    registry.register(connector)
    registry.clear()
    expect(registry.has('github')).toBe(false)
    expect(registry.types()).toEqual([])
  })
})

// ============ Logger Tests ============

describe('Connector Logging', () => {
  test('logs errors on webhook verification failure', async () => {
    const logs: { level: string; message: string; error?: Error }[] = []
    const testLogger = {
      debug: (msg: string) => logs.push({ level: 'debug', message: msg }),
      info: (msg: string) => logs.push({ level: 'info', message: msg }),
      warn: (msg: string, error?: Error) => logs.push({ level: 'warn', message: msg, error }),
      error: (msg: string, error: Error) => logs.push({ level: 'error', message: msg, error }),
    }

    class LoggingConnector extends BaseConnector {
      readonly type: ConnectorType = 'github'
      readonly displayName = 'Logging Test'
      readonly capabilities: ConnectorCapabilities = {
        supportsBackfill: true,
        supportsIncrementalSync: false,
        supportsWebhook: true,
        supportsWrite: false,
        supportedEntityTypes: ['issue'],
      }
      readonly authConfig: AuthConfig = { type: 'local' }

      constructor() {
        super({ logger: testLogger })
      }

      async listAccounts(): Promise<AccountInfo[]> {
        return []
      }

      async fetchPage(): Promise<FetchPageResult> {
        return { items: [], hasMore: false }
      }
    }

    const connector = new LoggingConnector()

    // Test missing signature logs a warning
    const event: WebhookEvent = {
      eventType: 'test',
      payload: '{}',
      headers: {},
      receivedAt: new Date(),
    }

    await connector.verifyWebhookSignature(event, 'secret')

    expect(logs.some(l => l.level === 'warn' && l.message.includes('No signature'))).toBe(true)
  })

  test('logs errors on signature mismatch', async () => {
    const logs: { level: string; message: string }[] = []
    const testLogger = {
      debug: (msg: string) => logs.push({ level: 'debug', message: msg }),
      info: (msg: string) => logs.push({ level: 'info', message: msg }),
      warn: (msg: string) => logs.push({ level: 'warn', message: msg }),
      error: (msg: string) => logs.push({ level: 'error', message: msg }),
    }

    class LoggingConnector extends BaseConnector {
      readonly type: ConnectorType = 'github'
      readonly displayName = 'Logging Test'
      readonly capabilities: ConnectorCapabilities = {
        supportsBackfill: true,
        supportsIncrementalSync: false,
        supportsWebhook: true,
        supportsWrite: false,
        supportedEntityTypes: ['issue'],
      }
      readonly authConfig: AuthConfig = { type: 'local' }

      constructor() {
        super({ logger: testLogger })
      }

      async listAccounts(): Promise<AccountInfo[]> {
        return []
      }

      async fetchPage(): Promise<FetchPageResult> {
        return { items: [], hasMore: false }
      }
    }

    const connector = new LoggingConnector()

    const event: WebhookEvent = {
      eventType: 'test',
      payload: '{}',
      headers: {},
      signature: 'sha256=invalid',
      receivedAt: new Date(),
    }

    await connector.verifyWebhookSignature(event, 'secret')

    expect(logs.some(l => l.level === 'warn' && l.message.includes('mismatch'))).toBe(true)
  })
})

// ============ Global Registry Tests ============

describe('Global connectorRegistry', () => {
  beforeEach(() => {
    connectorRegistry.clear()
  })

  test('is a ConnectorRegistry instance', () => {
    expect(connectorRegistry).toBeInstanceOf(ConnectorRegistry)
  })

  test('can register and retrieve connectors', () => {
    const connector = new TestConnector()
    connectorRegistry.register(connector)

    expect(connectorRegistry.get('github')).toBe(connector)
  })
})

// ============ API Key Connector Tests ============

class ApiKeyConnector extends BaseConnector {
  readonly type: ConnectorType = 'gmail'
  readonly displayName = 'API Key Test'
  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: false,
    supportsWebhook: false,
    supportsWrite: false,
    supportedEntityTypes: ['message'],
  }
  readonly authConfig: AuthConfig = {
    type: 'api_key',
    headerName: 'X-API-Key',
    headerPrefix: 'Bearer',
  }

  constructor() {
    super({ logger: noopLogger })
  }

  async listAccounts(ctx: ConnectorContext): Promise<AccountInfo[]> {
    return [{ externalId: 'api-user' }]
  }

  async fetchPage(ctx: ConnectorContext, options: FetchPageOptions): Promise<FetchPageResult> {
    return { items: [], hasMore: false }
  }
}

describe('ApiKeyConnector', () => {
  test('throws on OAuth methods', () => {
    const connector = new ApiKeyConnector()

    expect(() => connector.getAuthorizationUrl('state', 'redirect')).toThrow('does not support OAuth2')
  })

  test('has api_key auth config', () => {
    const connector = new ApiKeyConnector()
    expect(connector.authConfig.type).toBe('api_key')
  })
})

// ============ Local Auth Connector Tests ============

class LocalConnector extends BaseConnector {
  readonly type: ConnectorType = 'imessage'
  readonly displayName = 'Local Test'
  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: false,
    supportsWebhook: false,
    supportsWrite: false,
    supportedEntityTypes: ['message'],
  }
  readonly authConfig: AuthConfig = {
    type: 'local',
    dataPath: '~/Library/Messages/chat.db',
    requiresSystemAccess: true,
  }

  constructor() {
    super({ logger: noopLogger })
  }

  async listAccounts(ctx: ConnectorContext): Promise<AccountInfo[]> {
    return [{ externalId: 'local-user' }]
  }

  async fetchPage(ctx: ConnectorContext, options: FetchPageOptions): Promise<FetchPageResult> {
    return { items: [], hasMore: false }
  }
}

describe('LocalConnector', () => {
  test('has local auth config', () => {
    const connector = new LocalConnector()
    expect(connector.authConfig.type).toBe('local')
    expect((connector.authConfig as { dataPath?: string }).dataPath).toBe('~/Library/Messages/chat.db')
  })

  test('throws on OAuth methods', () => {
    const connector = new LocalConnector()

    expect(() => connector.getAuthorizationUrl('state', 'redirect')).toThrow('does not support OAuth2')
  })
})
