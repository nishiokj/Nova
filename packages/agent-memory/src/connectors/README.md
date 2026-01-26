# Connector Registration

How to add a new connector to the system.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     CONNECTOR REGISTRATION FLOW                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. IMPLEMENT                                                                │
│     src/connectors/myconnector/index.ts                                      │
│     └── class MyConnector implements Connector { ... }                       │
│     └── export function createMyConnector(config): MyConnector               │
│                                                                              │
│  2. REGISTER FACTORY                                                         │
│     src/connectors/registry.ts                                               │
│     └── registerFactory<MyConnectorConfig>('myconnector', createMyConnector) │
│                                                                              │
│  3. ADD CONFIG SCHEMA                                                        │
│     src/config/schema.ts                                                     │
│     └── myconnector: z.object({                                              │
│           enabled: z.boolean().default(false),                               │
│           ...options                                                         │
│         })                                                                   │
│                                                                              │
│  4. ENABLE IN CONFIG (env vars or config file)                               │
│     connectors.myconnector.enabled = true                                    │
│                                                                              │
│  5. DAEMON LOADS                                                             │
│     loadConnectors(config, daemon.registerConnector)                         │
│     └── Creates connector from factory                                       │
│     └── Registers with daemon                                                │
│                                                                              │
│  6. CLI DISCOVERS                                                            │
│     GET /api/connectors                                                      │
│     └── Returns: { type, displayName, entityTypes, capabilities }            │
│                                                                              │
│  7. CLI USES                                                                 │
│     tasks myconnector backfill [entityTypes...]                              │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 1: Implement the Connector

Create your connector directory:

```
src/connectors/myconnector/
├── index.ts       # Connector class + factory function
├── schemas.ts     # Zod schemas for external API responses
├── transforms.ts  # Transformations to canonical types
└── types.ts       # Config and internal types (optional)
```

### index.ts

```typescript
import { z } from 'zod'
import { BaseConnector, type ConnectorCapabilities } from '../../connector/sdk/index.js'
import type { FetchPageOptions, FetchPageResult } from '../../sync/types.js'
import { MyEntitySchema } from './schemas.js'

export interface MyConnectorConfig {
  apiKey?: string
  rateLimit?: number
}

export class MyConnector extends BaseConnector {
  readonly type = 'myconnector' as const
  readonly displayName = 'My Connector'

  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: true,
    supportsWebhook: false,
    supportsWrite: false,
    supportedEntityTypes: ['entity_a', 'entity_b'],
  }

  readonly authConfig = {
    type: 'oauth2_provider' as const,
    provider: 'google' as const,  // or 'github', 'microsoft', etc.
    scopes: ['https://www.googleapis.com/auth/myservice.readonly'],
  }

  constructor(config: MyConnectorConfig) {
    super()
    // store config
  }

  async fetchPage(ctx: ConnectorContext, options: FetchPageOptions): Promise<FetchPageResult> {
    // Implement pagination logic
  }

  getSourceSchema(entityType: string): z.ZodSchema | undefined {
    switch (entityType) {
      case 'entity_a': return MyEntitySchema
      default: return undefined
    }
  }
}

export function createMyConnector(config: MyConnectorConfig): MyConnector {
  return new MyConnector(config)
}
```

### schemas.ts

```typescript
import { z } from 'zod'

export const MyEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  // ... match external API response shape exactly
})

export type MyEntity = z.infer<typeof MyEntitySchema>
```

---

## Step 2: Register Factory

Add one line to `src/connectors/registry.ts`:

```typescript
import { createMyConnector, type MyConnectorConfig } from './myconnector/index.js'

// In the built-in factories section:
registerFactory<MyConnectorConfig>('myconnector', (config) => {
  return createMyConnector(config)
})
```

---

## Step 3: Add Config Schema

Add to `src/config/schema.ts` in `ConnectorConfigSchema`:

```typescript
export const ConnectorConfigSchema = z.object({
  // ... existing connectors

  /** My Connector settings */
  myconnector: z.object({
    /** Enable this connector */
    enabled: z.boolean().default(false),
    /** API key (if using API key auth) */
    apiKey: z.string().optional(),
    /** Requests per second limit */
    rateLimit: z.number().positive().default(10),
  }).default({}),
})
```

---

## Step 4: Enable in Config

Set environment variables or modify config:

```bash
# Environment variables
MYCONNECTOR_ENABLED=true
MYCONNECTOR_API_KEY=xxx

# Or in sync-daemon.ts connector config:
const connectorConfig = {
  myconnector: {
    enabled: true,
    apiKey: process.env.MYCONNECTOR_API_KEY,
  },
}
```

---

## Step 5: Export from Module

Add exports to `src/connectors/index.ts`:

```typescript
// My Connector
export {
  MyConnector,
  createMyConnector,
  type MyConnectorConfig,
  MyEntitySchema,
  type MyEntity,
} from './myconnector/index.js'
```

---

## Step 6: Add ConnectorType

Add to `src/ids.ts`:

```typescript
export type ConnectorType =
  | 'gmail'
  | 'github'
  | 'telegram'
  | 'myconnector'  // Add here
```

---

## Verification

Once registered, verify via CLI:

```bash
# List connectors
bun run scripts/sync-api-cli.ts connectors list
# Should show: myconnector - My Connector
#              Entity types: entity_a, entity_b

# Auth (if OAuth)
bun run scripts/sync-api-cli.ts auth login myconnector

# Backfill
bun run scripts/sync-api-cli.ts tasks myconnector backfill entity_a
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/connectors/{name}/index.ts` | Connector implementation |
| `src/connectors/{name}/schemas.ts` | Zod schemas for external API |
| `src/connectors/registry.ts` | Factory registration |
| `src/config/schema.ts` | Config schema with `enabled` flag |
| `src/ids.ts` | ConnectorType union |

---

## Auth Types

### OAuth2 Provider (Centralized)

Uses shared credentials from `OAuthProviderRegistry`. Best for Google, GitHub, Microsoft, etc.

```typescript
readonly authConfig = {
  type: 'oauth2_provider' as const,
  provider: 'google' as const,
  scopes: ['scope1', 'scope2'],
}
```

### Direct OAuth2

Connector manages its own OAuth credentials.

```typescript
readonly authConfig: OAuth2Config = {
  type: 'oauth2',
  authorizationUrl: 'https://api.example.com/oauth/authorize',
  tokenUrl: 'https://api.example.com/oauth/token',
  scopes: ['read', 'write'],
  clientId: process.env.MY_CLIENT_ID!,
  clientSecret: process.env.MY_CLIENT_SECRET!,
}
```

### API Key

```typescript
readonly authConfig: ApiKeyConfig = {
  type: 'api_key',
  headerName: 'Authorization',
  headerPrefix: 'Bearer',
}
```

### Local

For filesystem or local service connectors.

```typescript
readonly authConfig: LocalAuthConfig = {
  type: 'local',
  dataPath: '~/Library/Application Support/MyApp',
  requiresSystemAccess: true,
}
```

---

## Existing Connectors

| Type | Display Name | Entity Types | Auth |
|------|--------------|--------------|------|
| `gmail` | Gmail | message, thread, history | oauth2_provider (google) |
| `github` | GitHub | user, issue, pull_request, comment, notification | oauth2 |
| `telegram` | Telegram | (real-time bridge) | bot token |
| `claude_sessions` | Claude Code Sessions | session_message, session_summary, file_history | local |
| `rex_sessions` | Rex Sessions | session_message, session_summary | local |

---

## Checklist

- [ ] Create `src/connectors/{name}/` directory
- [ ] Implement `Connector` interface in `index.ts`
- [ ] Define source schemas in `schemas.ts`
- [ ] Add factory to `registry.ts`
- [ ] Add config schema to `config/schema.ts`
- [ ] Add to `ConnectorType` in `ids.ts`
- [ ] Export from `connectors/index.ts`
- [ ] Test: `connectors list` shows your connector
- [ ] Test: `auth login {name}` works
- [ ] Test: `tasks {name} backfill` works
