# Auth Specification: Connector Implementation & Registration Protocol

## Executive Summary

This spec defines a protocol for connector auth configuration and registration that reduces work by:

1. **Declarative Auth Config**: Conneactors expose `authConfig` that describes their auth requirements
2. **Credential Reuse**: Multiple connector instances can share the same OAuth credentials
3. **Self-Describing Registration**: Connectors tell the system what auth they need at registration time
4. **Minimal Boilerplate**: Base classes provide OAuth flow implementations

## Core Principles

1. **Auth is connector-owned**: Each connector declares its auth config in its constructor
2. **Credentials are account-scoped**: An `Account` has credentials, connectors reference accounts
3. **Reusable OAuth**: One OAuth flow can serve multiple connector instances
4. **Type-safe**: Zod schemas validate all auth configurations

---

## Current State Analysis

### What Already Works

The connector SDK already has solid foundations:

```typescript
// packages/plugins/agent-memory/src/connector/sdk/types.ts

// Auth configuration types
export type AuthConfig = OAuth2Config | ApiKeyConfig | LocalAuthConfig

export interface OAuth2Config {
  type: 'oauth2'
  authorizationUrl: string
  tokenUrl: string
  scopes: string[]
  clientId: string
  clientSecret: string
}

// Connector interface requires authConfig
export interface Connector {
  readonly authConfig: AuthConfig
  getAuthorizationUrl?(state: string, redirectUri: string): string
  exchangeCodeForTokens?(code: string, redirectUri: string): Promise<AuthTokens>
  refreshTokens?(refreshToken: string): Promise<AuthTokens>
}
```

### Current Connector Implementations

**GitHub Connector:**
```typescript
export class GitHubConnector extends BaseConnector {
  readonly authConfig: OAuth2Config = {
    type: 'oauth2',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user', 'read:org', 'notifications'],
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  }
}
```

**Gmail Connector:**
```typescript
export class GmailConnector extends BaseConnector {
  readonly authConfig: OAuth2Config = {
    type: 'oauth2',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.metadata',
    ],
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  }
}
```

### What's Missing

1. **Credential Reuse Protocol**: No way to share OAuth credentials between connector instances
2. **Registration Auth Check**: No way to determine if new OAuth is needed or existing can be reused
3. **Credential Reference**: No way to reference existing credentials when registering a connector
4. **Encryption**: Tokens stored in plaintext (critical security gap)

---

## Auth Protocol Design

### 1. Enhanced AuthConfig

Extend `AuthConfig` to support credential references:

```typescript
/**
 * Auth configuration extended with credential reference support.
 */
export type AuthConfig = OAuth2Config | ApiKeyConfig | LocalAuthConfig | CredentialReferenceConfig

/**
 * Reference to existing credentials (for credential reuse).
 * Used when you want to reuse OAuth credentials across multiple connector instances.
 */
export interface CredentialReferenceConfig {
  type: 'credential_reference'
  /** Account ID that holds the credentials to reuse */
  accountId: string
  /** Optional: Additional scopes beyond what the original account has */
  additionalScopes?: string[]
}

export const CredentialReferenceConfigSchema = z.object({
  type: z.literal('credential_reference'),
  accountId: z.string().min(1),
  additionalScopes: z.array(z.string()).optional(),
})
```

### 2. Connector Registration Protocol

Connectors must declare whether they support credential reuse:

```typescript
/**
 * Connector registration options.
 */
export interface ConnectorRegistrationOptions {
  /** Connector instance to register */
  connector: Connector
  /**
   * Account ID for credential reuse.
   * If provided, this connector will use the account's credentials.
   * If not provided, OAuth flow will be triggered.
   */
  accountId?: string
  /**
   * Force OAuth flow even if accountId is provided.
   * Useful for re-authorizing with different scopes.
   */
  forceOAuth?: boolean
}

/**
 * Result of connector registration.
 */
export interface ConnectorRegistrationResult {
  /** Registration successful */
  success: boolean
  /** Connector type */
  connectorType: ConnectorType
  /** Account ID (existing or newly created) */
  accountId: string
  /** Whether OAuth is required */
  requiresOAuth: boolean
  /** OAuth authorization URL (if OAuth required) */
  authUrl?: string
  /** State parameter for OAuth flow */
  authState?: string
}
```

### 3. Auth Provider Interface

New layer that provides `ConnectorContext` with credentials:

```typescript
/**
 * Auth provider interface.
 * Responsible for fetching and decrypting credentials for connectors.
 */
export interface AuthProvider {
  /**
   * Get connector context with credentials for an account.
   * @param accountId - Account ID to get credentials for
   * @param additionalScopes - Optional additional scopes (for credential reuse)
   */
  getContext(
    accountId: string,
    additionalScopes?: string[]
  ): Promise<ConnectorContext>

  /**
   * Refresh expired access token.
   * @param accountId - Account ID to refresh token for
   */
  refreshIfNeeded(accountId: string): Promise<void>

  /**
   * Check if account has credentials.
   * @param accountId - Account ID to check
   */
  hasCredentials(accountId: string): Promise<boolean>

  /**
   * Verify that credentials cover required scopes.
   * @param accountId - Account ID to verify
   * @param requiredScopes - Scopes required by connector
   */
  verifyScopes(accountId: string, requiredScopes: string[]): Promise<boolean>
}
```

### 4. Credential Storage Schema

Update account schema to track credential sources:

```typescript
/**
 * Account credential metadata.
 */
export interface AccountCredentials {
  /** Encrypted access token */
  credentials_encrypted: Buffer
  /** Initialization vector for encryption */
  credentials_iv: Buffer
  /** Encrypted refresh token (if available) */
  refresh_token_encrypted?: Buffer
  /** Token expiration time */
  token_expires_at?: Date
  /** Granted scopes */
  granted_scopes: string[]
  /** Connector type these credentials are for */
  connector_type: ConnectorType
  /** Original account ID (if this is a credential reference) */
  source_account_id?: string
}
```

---

## Registration Flow

### Scenario 1: First-Time Registration (New OAuth Required)

```typescript
import { SyncEngine, AuthProvider } from '@jesus/agent-memory'
import { createGitHubConnector } from '@jesus/agent-memory/connectors/github'

// 1. Create sync engine with auth provider
const authProvider = new DatabaseAuthProvider(db)
const engine = new SyncEngine(db, { authProvider })

// 2. Create connector instance
const connector = createGitHubConnector({
  clientId: process.env.GITHUB_CLIENT_ID!,
  clientSecret: process.env.GITHUB_CLIENT_SECRET!
})

// 3. Register connector (no accountId = OAuth required)
const result = await engine.registerConnector(connector)

// result.requiresOAuth === true
// result.authUrl = "https://github.com/login/oauth/authorize?client_id=...&scope=...&state=..."
// result.authState = "random-state-string"

// 4. Redirect user to result.authUrl
```

### Scenario 2: Credential Reuse (No OAuth Required)

```typescript
// Assume we already have a GitHub account with credentials:
// existingAccountId = "acc_123"

// 1. Create new connector instance (same or different config)
const connector2 = createGitHubConnector({
  clientId: process.env.GITHUB_CLIENT_ID!,
  clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  // Different labels/filters for this instance
})

// 2. Register with existing accountId
const result = await engine.registerConnector(connector2, {
  accountId: existingAccountId
})

// result.requiresOAuth === false
// result.accountId === existingAccountId
// Connector2 can now use the same credentials as Connector1
```

### Scenario 3: Force Re-Authorization (New Scopes)

```typescript
// Existing account with limited scopes
const existingAccountId = "acc_123"

// 1. Create connector that needs additional scopes
const connector = createGitHubConnector({
  clientId: process.env.GITHUB_CLIENT_ID!,
  clientSecret: process.env.GITHUB_CLIENT_SECRET!
})
// Modify scopes to require additional permissions
connector.authConfig.scopes.push('admin:org')

// 2. Force OAuth flow
const result = await engine.registerConnector(connector, {
  accountId: existingAccountId,
  forceOAuth: true
})

// result.requiresOAuth === true
// result.authUrl = "..." (with new scopes)
// New credentials will be stored, replacing old ones
```

---

## Implementation Plan

### Phase 1: Auth Provider (Critical)

**Files to create:**
- `packages/plugins/agent-memory/src/auth/provider.ts`

**Key implementation:**
```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

interface AuthProviderConfig {
  encryptionKey: Buffer  // 32-byte key from KMS or environment
  accountRepo: AccountRepository
}

export class DatabaseAuthProvider implements AuthProvider {
  constructor(private config: AuthProviderConfig) {}

  async getContext(accountId: string): Promise<ConnectorContext> {
    const creds = await this.config.accountRepo.getCredentials(accountId)
    if (!creds) throw new AuthError('No credentials found')

    // Decrypt credentials
    const accessToken = this.decrypt(
      creds.credentials_encrypted,
      creds.credentials_iv
    )

    // Check expiration and refresh if needed
    if (creds.token_expires_at && creds.token_expires_at < new Date()) {
      const refreshed = await this.refresh(accountId)
      return refreshed
    }

    return {
      accountId,
      accessToken,
      credentials: {
        scopes: creds.granted_scopes
      }
    }
  }

  private decrypt(encrypted: Buffer, iv: Buffer): string {
    const decipher = createDecipheriv('aes-256-gcm', this.config.encryptionKey, iv)
    let decrypted = decipher.update(encrypted)
    decrypted = Buffer.concat([decrypted, decipher.final()])
    return decrypted.toString('utf8')
  }

  async refreshIfNeeded(accountId: string): Promise<void> {
    const creds = await this.config.accountRepo.getCredentials(accountId)
    if (!creds?.token_expires_at) return

    const expiresSoon = creds.token_expires_at < new Date(Date.now() + 5 * 60 * 1000)
    if (expiresSoon) {
      await this.refresh(accountId)
    }
  }
}
```

### Phase 2: Enhanced Sync Engine Registration

**Modify:** `packages/plugins/agent-memory/src/sync/engine.ts`

```typescript
export class SyncEngine {
  private authProvider?: AuthProvider

  constructor(
    private db: Database,
    options: SyncEngineOptions = {}
  ) {
    this.authProvider = options.authProvider
    // ... existing code
  }

  async registerConnector(
    connector: Connector,
    options: ConnectorRegistrationOptions = {}
  ): Promise<ConnectorRegistrationResult> {
    const { accountId, forceOAuth = false } = options

    // Check if we can reuse existing credentials
    if (accountId && !forceOAuth && this.authProvider) {
      const hasCreds = await this.authProvider.hasCredentials(accountId)
      const hasScopes = await this.authProvider.verifyScopes(
        accountId,
        connector.authConfig.scopes
      )

      if (hasCreds && hasScopes) {
        return {
          success: true,
          connectorType: connector.type,
          accountId,
          requiresOAuth: false
        }
      }
    }

    // OAuth flow required
    const authUrl = this.generateAuthUrl(connector)
    return {
      success: true,
      connectorType: connector.type,
      accountId: '',  // Will be set after OAuth callback
      requiresOAuth: true,
      authUrl,
      authState: this.generateState()
    }
  }

  async handleOAuthCallback(
    connectorType: ConnectorType,
    state: string,
    code: string
  ): Promise<ConnectorRegistrationResult> {
    const connector = this.connectors.get(connectorType)
    if (!connector) throw new Error('Connector not registered')

    // Exchange code for tokens
    const tokens = await connector.exchangeCodeForTokens(code, this.redirectUri)

    // Create or update account
    const account = await this.createOrUpdateAccount(
      connectorType,
      tokens
    )

    // Store encrypted credentials
    await this.authProvider?.storeCredentials(account.id, tokens)

    return {
      success: true,
      connectorType,
      accountId: account.id,
      requiresOAuth: false
    }
  }
}
```

### Phase 3: Collector Integration

**Modify:** `packages/plugins/agent-memory/src/sync/collector.ts`

```typescript
export class Collector {
  constructor(
    private db: Database,
    private config: Config,
    private authProvider?: AuthProvider  // NEW
  ) {}

  async collect(job: CollectJob): Promise<CollectResult> {
    const connector = this.connectors.get(job.connector)
    if (!connector) throw new Error('Connector not found')

    // Get auth context
    const ctx = await this.authProvider?.getContext(job.accountId)
    if (!ctx) throw new AuthError('No auth context available')

    // Fetch with auth
    const result = await connector.fetchPage(ctx, {
      cursor: job.cursor,
      limit: job.limit,
      entityTypes: job.entityTypes
    })

    // ... rest of collection logic
  }
}
```

### Phase 4: Credential Reuse Implementation

**Modify:** `packages/plugins/agent-memory/src/db/repositories/account.ts`

```typescript
export class AccountRepository {
  /**
   * Create a credential reference (reuse existing credentials).
   */
  async createCredentialReference(
    accountId: string,
    sourceAccountId: string,
    additionalScopes?: string[]
  ): Promise<Account> {
    const source = await this.findById(sourceAccountId)
    if (!source) throw new Error('Source account not found')

    const creds = await this.getCredentials(sourceAccountId)
    if (!creds) throw new Error('Source has no credentials')

    // Verify scope compatibility
    const hasRequiredScopes = this.verifyScopeCompatibility(
      creds.granted_scopes,
      additionalScopes ?? []
    )
    if (!hasRequiredScopes) throw new Error('Insufficient scopes')

    // Create new account reference
    const account = await this.create({
      connector: source.connector,
      external_account_id: source.external_account_id,
      auth_type: source.auth_type
    })

    // Store credential reference metadata
    await this.updateCredentialReference(account.id, {
      source_account_id: sourceAccountId,
      additional_scopes: additionalScopes
    })

    return account
  }

  private verifyScopeCompatibility(
    granted: string[],
    required: string[]
  ): boolean {
    // All required scopes must be in granted scopes
    return required.every(scope =>
      granted.some(granted => granted.includes(scope))
    )
  }
}
```

---

## Connector Implementation Guidelines

### When to Implement Custom Auth

**Default behavior (BaseConnector provides):**
- OAuth2 authorization URL generation
- Code exchange for tokens
- Token refresh
- Authenticated HTTP requests

**Custom auth when:**
- OAuth flow uses non-standard parameters (override `getAuthorizationUrl()`)
- Token response has non-standard structure (override `parseTokenResponse()`)
- Need custom token refresh logic (override `refreshTokens()`)

### Example: Custom OAuth Implementation

```typescript
export class CustomConnector extends BaseConnector {
  readonly authConfig: OAuth2Config = {
    type: 'oauth2',
    authorizationUrl: 'https://api.example.com/oauth/authorize',
    tokenUrl: 'https://api.example.com/oauth/token',
    scopes: ['read', 'write'],
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    // Custom auth params for PKCE
    codeChallengeMethod: 'S256',
    authParams: {
      response_mode: 'query',
      prompt: 'consent'
    }
  }

  // Override for custom token parsing
  protected override parseTokenResponse(response: any): AuthTokens {
    const tokens = super.parseTokenResponse(response)
    // Add custom fields
    tokens.expiresAt = new Date(Date.now() + response.expires_in * 1000)
    return tokens
  }
}
```

### Example: API Key Connector

```typescript
export class ApiKeyConnector extends BaseConnector {
  readonly authConfig: ApiKeyConfig = {
    type: 'api_key',
    headerName: 'X-API-Key',
    headerPrefix: 'Token'
  }

  async listAccounts(ctx: ConnectorContext): Promise<AccountInfo[]> {
    const response = await this.authenticatedRequest<{data: any[]}>(
      ctx,
      'https://api.example.com/accounts'
    )
    return response.data.data.map(account => ({
      externalId: account.id,
      displayName: account.name
    }))
  }

  async fetchPage(ctx: ConnectorContext, options: FetchPageOptions): Promise<FetchPageResult> {
    // API key auth is handled automatically by authenticatedRequest()
    const response = await this.authenticatedRequest<any>(
      ctx,
      'https://api.example.com/data'
    )
    // ... process response
  }
}
```

---

## Security Considerations

### Encryption

**Required implementation:**
```typescript
// Use envelope encryption or KMS
export class CredentialEncryption {
  private static readonly ALGORITHM = 'aes-256-gcm'
  private static readonly IV_LENGTH = 16
  private static readonly TAG_LENGTH = 16

  static encrypt(plaintext: string, key: Buffer): {
    encrypted: Buffer
    iv: Buffer
    tag: Buffer
  } {
    const iv = randomBytes(this.IV_LENGTH)
    const cipher = createCipheriv(this.ALGORITHM, key, iv)

    let encrypted = cipher.update(plaintext, 'utf8')
    encrypted = Buffer.concat([encrypted, cipher.final()])
    const tag = cipher.getAuthTag()

    return { encrypted, iv, tag }
  }

  static decrypt(encrypted: Buffer, key: Buffer, iv: Buffer, tag: Buffer): string {
    const decipher = createDecipheriv(this.ALGORITHM, key, iv)
    decipher.setAuthTag(tag)

    let decrypted = decipher.update(encrypted)
    decrypted = Buffer.concat([decrypted, decipher.final()])

    return decrypted.toString('utf8')
  }
}
```

### Key Management

**Options:**
1. **Environment variable** (development):
   ```bash
   export CREDENTIAL_ENCRYPTION_KEY="32-byte-hex-key-here"
   ```

2. **AWS KMS** (production):
   ```typescript
   import { KMSClient, DecryptCommand, EncryptCommand } from '@aws-sdk/client-kms'

   class KMSKeyProvider {
     async encrypt(plaintext: string): Promise<Buffer> {
       const command = new EncryptCommand({
         KeyId: process.env.KMS_KEY_ID,
         Plaintext: Buffer.from(plaintext)
       })
       const result = await kms.send(command)
       return result.CiphertextBlob!
     }

     async decrypt(ciphertext: Buffer): Promise<string> {
       const command = new DecryptCommand({
         CiphertextBlob: ciphertext
       })
       const result = await kms.send(command)
       return result.Plaintext!.toString()
     }
   }
   ```

### Scope Verification

**Always verify scopes before reuse:**
```typescript
async verifyScopes(accountId: string, requiredScopes: string[]): Promise<boolean> {
  const creds = await this.accountRepo.getCredentials(accountId)
  if (!creds) return false

  const granted = new Set(creds.granted_scopes)
  return requiredScopes.every(scope =>
    // Exact match or prefix match (e.g., "repo" covers "repo:status")
    [...granted].some(granted =>
      granted === scope || granted.startsWith(`${scope}:`) || scope.startsWith(`${granted}:`)
    )
  )
}
```

---

## Testing Strategy

### Unit Tests

```typescript
describe('DatabaseAuthProvider', () => {
  it('should decrypt credentials correctly', async () => {
    const provider = new DatabaseAuthProvider({ encryptionKey: testKey, accountRepo })
    const encrypted = provider.encrypt('test-token', iv)

    const ctx = await provider.getContext('account-id')
    expect(ctx.accessToken).toBe('test-token')
  })

  it('should refresh expired tokens', async () => {
    const provider = new DatabaseAuthProvider({ encryptionKey: testKey, accountRepo })
    // Mock expired token
    await expect(provider.refreshIfNeeded('account-id')).resolves.not.toThrow()
  })
})

describe('SyncEngine.registerConnector', () => {
  it('should require OAuth for new registration', async () => {
    const engine = new SyncEngine(db, { authProvider })
    const result = await engine.registerConnector(connector)
    expect(result.requiresOAuth).toBe(true)
    expect(result.authUrl).toBeDefined()
  })

  it('should reuse existing credentials', async () => {
    const engine = new SyncEngine(db, { authProvider })
    const result = await engine.registerConnector(connector, { accountId: 'existing' })
    expect(result.requiresOAuth).toBe(false)
  })
})
```

### Integration Tests

```typescript
describe('Auth E2E', () => {
  it('should complete OAuth flow and sync', async () => {
    // 1. Register connector
    const result = await engine.registerConnector(githubConnector)
    expect(result.requiresOAuth).toBe(true)

    // 2. Mock OAuth callback
    const mockCode = 'mock-auth-code'
    const callbackResult = await engine.handleOAuthCallback(
      'github',
      result.authState!,
      mockCode
    )

    // 3. Verify account created
    const account = await accountRepo.findById(callbackResult.accountId)
    expect(account).toBeDefined()

    // 4. Schedule and run sync
    await engine.scheduleBackfill('github', callbackResult.accountId)
    const job = await engine.getJobStatus(jobId)
    expect(job.status).toBe('completed')
  })

  it('should reuse credentials across connectors', async () => {
    // 1. Create first connector with OAuth
    const result1 = await engine.registerConnector(connector1)
    await engine.handleOAuthCallback('github', result1.authState!, 'code')

    // 2. Create second connector with credential reuse
    const result2 = await engine.registerConnector(connector2, {
      accountId: result1.accountId
    })

    expect(result2.requiresOAuth).toBe(false)
    expect(result2.accountId).toBe(result1.accountId)
  })
})
```

---

## Migration Path

### Step 1: Add AuthProvider (1 day)
- Create `packages/plugins/agent-memory/src/auth/provider.ts`
- Implement `DatabaseAuthProvider`
- Add unit tests

### Step 2: Update Collector (0.5 day)
- Add `authProvider` to Collector constructor
- Use `getContext()` before `fetchPage()`
- Update tests

### Step 3: Update SyncEngine (1 day)
- Add `registerConnector()` with registration options
- Add `handleOAuthCallback()` method
- Add credential verification logic
- Update tests

### Step 4: Add Credential Reference (0.5 day)
- Update AccountRepository with `createCredentialReference()`
- Add scope verification logic
- Update tests

### Step 5: Documentation & Examples (0.5 day)
- Write connector implementation guide
- Add OAuth flow examples
- Add credential reuse examples

**Total: 3.5 days**

---

## Open Questions

1. **KMS vs Environment Key**: Should we use AWS KMS for encryption or environment variables? (Recommend: KMS for prod, env for dev)

2. **Scope Mismatch Handling**: What should happen when an existing credential doesn't have required scopes? (Options: force OAuth, reject registration, partial functionality)

3. **Multi-Tenant**: Do we need tenant isolation for credentials? (If so, add `tenantId` to accounts table)

4. **Credential Rotation**: How should we handle credential rotation when scopes change? (Recommend: create new account, deprecate old one)

5. **Webhook Auth**: How do webhooks verify they're from the right account? (Recommend: store webhook secret with account credentials)
