# Auth Implementation Summary

## What Was Implemented

### 1. Auth Spec (`AUTH_SPEC.md`)
Comprehensive specification for connector auth and registration protocol:
- Declarative `AuthConfig` on connectors
- Credential reuse across connector instances
- OAuth flow with CSRF protection
- Scope verification for credential reuse

### 2. Auth Provider (`auth/provider.ts`)
`DatabaseAuthProvider` class that:
- Fetches and decrypts credentials from database
- Provides `ConnectorContext` with `accessToken`
- Handles automatic token refresh
- Caches credentials (5-minute TTL)
- Uses AES-256-GCM encryption

Key exports:
```typescript
DatabaseAuthProvider
createAuthProvider(config)
createAuthProviderFromEnv(accountRepo, getConnector)
deriveKey(passphrase, salt)
generateSalt()
```

### 3. Auth Registration (`auth/registration.ts`)
`AuthRegistrationService` class that:
- Determines if OAuth is required or credentials can be reused
- Generates OAuth authorization URLs with state for CSRF protection
- Handles OAuth callbacks
- Creates credential references for credential reuse

Key exports:
```typescript
AuthRegistrationService
createRegistrationService(config)
type ConnectorRegistrationOptions
type ConnectorRegistrationResult
type OAuthCallbackResult
```

### 4. Credential Reference Config (`connector/sdk/types.ts`)
Added `CredentialReferenceConfig` for credential reuse:
```typescript
interface CredentialReferenceConfig {
  type: 'credential_reference'
  accountId: string
  additionalScopes?: string[]
}
```

### 5. Collector Integration (`sync/collector.ts`)
Updated to:
- Accept `authProvider` in config
- Build `ConnectorContext` before calling connector methods
- Handle auth context errors gracefully

### 6. Sync Engine Integration (`sync/engine.ts`)
Updated to:
- Accept `authProvider` in config
- Pass `authProvider` to collector
- Exported `AuthProvider` type

### 7. ConnectorAdapter Interface Fix (`sync/types.ts`)
Fixed signature mismatch:
- Changed from `fetchPage(accountId: string, ...)` to `fetchPage(ctx: ConnectorContext, ...)`
- Added import of `ConnectorContext` from connector/sdk/types

### 8. Account Repository Update (`db/repositories/account.ts`)
Updated `getCredentials()` to return `connector_type` for token refresh:
```typescript
interface AccountCredentials {
  credentials_encrypted: Buffer
  credentials_iv: Buffer
  refresh_token_encrypted?: Buffer
  token_expires_at?: Date | null
  connector_type?: ConnectorType
}
```

### 9. Auth Error Class (`errors/types.ts`)
Added `AuthError` as simplified alias for `AuthenticationError`:
```typescript
class AuthError extends AuthenticationError {
  constructor(message, options?)
}
```

### 10. Module Exports
Updated `src/index.ts` to export auth module:
- `DatabaseAuthProvider`
- `createAuthProvider`
- `createAuthProviderFromEnv`
- `AuthRegistrationService`
- Various types

## How to Use

### 1. Set Up Auth Provider

```typescript
import { createDatabase, SyncEngine, createAuthProviderFromEnv } from '@jesus/agent-memory'
import { createGitHubConnector } from '@jesus/agent-memory/connectors/github'

// Set encryption key in environment
// export CREDENTIAL_ENCRYPTION_KEY="your-32-byte-hex-key"

const db = await createDatabase({ connectionString: '...' })
await db.migrate()

const accountRepo = db.accountRepo
const authProvider = await createAuthProviderFromEnv(
  accountRepo,
  (type) => engine.getConnector(type)  // Get connector for token refresh
)
```

### 2. Create Sync Engine with Auth

```typescript
const engine = new SyncEngine(db.sql, {
  authProvider,
})
```

### 3. Register Connector

```typescript
const connector = createGitHubConnector({
  clientId: process.env.GITHUB_CLIENT_ID!,
  clientSecret: process.env.GITHUB_CLIENT_SECRET!,
})

engine.registerConnector(connector)
```

### 4. Register Account via OAuth

```typescript
// Create registration service
const registrationService = createRegistrationService({
  redirectUri: 'https://myapp.com/oauth/callback',
  authProvider,
  accountRepo,
  getConnector: (type) => engine.getConnector(type),
})

// Register connector (returns auth URL if OAuth needed)
const result = await registrationService.registerConnector(connector)

if (result.requiresOAuth) {
  // Redirect user to result.authUrl
  // After callback: registrationService.handleOAuthCallback('github', result.authState, code)
} else {
  // Account ID is result.accountId
  console.log('Reusing existing account:', result.accountId)
}
```

### 5. Schedule Sync

```typescript
await engine.scheduleBackfill('github', accountId)
await engine.start()
```

### 6. Credential Reuse

```typescript
// Reuse existing credentials
const result2 = await registrationService.registerConnector(anotherConnector, {
  accountId: existingAccountId
})
```

## Remaining Work

### High Priority
1. **Encryption key management**: Currently uses env var; consider AWS KMS for production
2. **Scope tracking**: Add `granted_scopes` to accounts table and track during OAuth
3. **Integration tests**: E2E tests for OAuth flow and credential reuse

### Medium Priority
1. **Webhook auth**: Store webhook secrets with account credentials
2. **Credential rotation**: Support upgrading scopes with new OAuth flow
3. **Multi-tenant**: Add tenant isolation for credentials

### Low Priority
1. **Raw envelope retention**: Add TTL/pruning (documented in AGENT_MEMORY_TODO.md)
2. **Embedding generation**: Pipeline for semantic search (columns exist but no implementation)

## Files Modified

- `AUTH_SPEC.md` (new)
- `src/auth/provider.ts` (new)
- `src/auth/registration.ts` (new)
- `src/auth/index.ts` (new)
- `src/connector/sdk/types.ts` (added `CredentialReferenceConfig`)
- `src/connector/sdk/index.ts` (export new config type)
- `src/db/repositories/account.ts` (added `connector_type` to credentials)
- `src/sync/collector.ts` (auth provider integration)
- `src/sync/engine.ts` (auth provider integration)
- `src/sync/types.ts` (fixed `ConnectorAdapter` interface)
- `src/errors/types.ts` (added `AuthError` class)
- `src/errors/index.ts` (export `AuthError`)
- `src/index.ts` (export auth module)
