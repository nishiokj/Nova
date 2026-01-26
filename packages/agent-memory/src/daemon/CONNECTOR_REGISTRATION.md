# Dynamic Connector Registration

## Problem

Current implementation requires 5+ file changes and daemon restart to add a connector:

1. `src/connectors/<name>/index.ts` - implement connector
2. `src/connectors/registry.ts` - add factory
3. `src/config/schema.ts` - add config schema
4. `src/ids.ts` - add to ConnectorType
5. `scripts/sync-daemon.ts` - enable in connectorConfig
6. Restart daemon

This is scattered, error-prone, and doesn't scale.

---

## Solution: Database-Backed Registration

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONNECTOR LIFECYCLE                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. IMPLEMENT (single touch point)                              │
│     src/connectors/myconnector/index.ts                         │
│     └── class MyConnector extends BaseConnector                 │
│     └── export createMyConnector factory                        │
│     └── Self-registers: registerFactory('myconnector', ...)     │
│                                                                  │
│  2. REGISTER VIA CLI (no restart)                               │
│     $ sync-api-cli connectors register myconnector              │
│     └── POST /api/connectors/register { type: 'myconnector' }   │
│     └── Validates factory exists                                │
│     └── Persists to registered_connectors table                 │
│     └── Instantiates and loads immediately                      │
│                                                                  │
│  3. CONFIGURE (optional, no restart)                            │
│     $ sync-api-cli connectors config myconnector --set key=val  │
│     └── PATCH /api/connectors/:type/config                      │
│     └── Updates config in DB                                    │
│     └── Reloads connector with new config                       │
│                                                                  │
│  4. ENABLE/DISABLE (no restart)                                 │
│     $ sync-api-cli connectors disable myconnector               │
│     └── PATCH /api/connectors/:type { enabled: false }          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

```sql
CREATE TABLE registered_connectors (
  type TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_registered_connectors_enabled ON registered_connectors(enabled);
```

---

## API Endpoints

### Register Connector

```
POST /api/connectors/register
Content-Type: application/json

{
  "type": "myconnector",
  "config": {
    "apiKey": "...",
    "rateLimit": 10
  }
}

Response 201:
{
  "connector": {
    "type": "myconnector",
    "displayName": "My Connector",
    "entityTypes": ["entity_a", "entity_b"],
    "enabled": true
  }
}

Errors:
- 400: Factory not found (connector code not implemented)
- 409: Already registered
```

### Update Config

```
PATCH /api/connectors/:type/config
Content-Type: application/json

{
  "apiKey": "new-key",
  "rateLimit": 20
}

Response 200:
{
  "connector": { ... }
}
```

### Enable/Disable

```
PATCH /api/connectors/:type
Content-Type: application/json

{
  "enabled": false
}
```

### Unregister

```
DELETE /api/connectors/:type

Response 204
```

---

## Implementation

### 1. Repository: `src/daemon/repos/connector-repo.ts`

```typescript
export interface RegisteredConnector {
  type: string
  enabled: boolean
  config: Record<string, unknown>
  registered_at: Date
  updated_at: Date
}

export class ConnectorRepository {
  constructor(private sql: Sql) {}

  async findAll(): Promise<RegisteredConnector[]>
  async findEnabled(): Promise<RegisteredConnector[]>
  async findByType(type: string): Promise<RegisteredConnector | null>
  async register(type: string, config?: Record<string, unknown>): Promise<RegisteredConnector>
  async updateConfig(type: string, config: Record<string, unknown>): Promise<RegisteredConnector>
  async setEnabled(type: string, enabled: boolean): Promise<RegisteredConnector>
  async unregister(type: string): Promise<void>
}
```

### 2. Daemon Changes: `src/daemon/index.ts`

```typescript
class SyncDaemon {
  private connectorRepo: ConnectorRepository

  async loadRegisteredConnectors(): Promise<void> {
    const registered = await this.connectorRepo.findEnabled()

    for (const { type, config } of registered) {
      const factory = getFactory(type as ConnectorType)
      if (!factory) {
        console.warn(`Factory not found for registered connector: ${type}`)
        continue
      }

      const connector = await factory.factory(config)
      this.registerConnector(connector)
    }
  }

  async registerConnectorDynamic(type: string, config?: Record<string, unknown>): Promise<void> {
    // 1. Validate factory exists
    const factory = getFactory(type as ConnectorType)
    if (!factory) throw new Error(`No factory for connector: ${type}`)

    // 2. Persist to DB
    await this.connectorRepo.register(type, config)

    // 3. Instantiate and load
    const connector = await factory.factory(config ?? {})
    this.registerConnector(connector)
  }
}
```

### 3. Routes: `src/daemon/routes/connectors.ts`

```typescript
// Register a new connector
server.post('/connectors/register', async (req) => {
  const { type, config } = req.body

  if (!hasFactory(type)) {
    throw badRequest(`Unknown connector type: ${type}. Is it implemented?`)
  }

  const existing = await daemon.connectorRepo.findByType(type)
  if (existing) {
    throw conflict(`Connector already registered: ${type}`)
  }

  await daemon.registerConnectorDynamic(type, config)
  const info = daemon.getConnectorInfo(type)

  return { status: 201, body: { connector: info } }
})

// Update connector config
server.patch('/connectors/:type/config', async (req) => {
  const { type } = req.params
  const config = req.body

  await daemon.connectorRepo.updateConfig(type, config)
  await daemon.reloadConnector(type)

  return { body: { connector: daemon.getConnectorInfo(type) } }
})

// Enable/disable connector
server.patch('/connectors/:type', async (req) => {
  const { type } = req.params
  const { enabled } = req.body

  await daemon.connectorRepo.setEnabled(type, enabled)

  if (enabled) {
    await daemon.loadConnector(type)
  } else {
    daemon.unloadConnector(type)
  }

  return { body: { connector: daemon.getConnectorInfo(type) } }
})

// Unregister connector
server.delete('/connectors/:type', async (req) => {
  const { type } = req.params

  daemon.unloadConnector(type)
  await daemon.connectorRepo.unregister(type)

  return { status: 204 }
})
```

### 4. CLI: `scripts/sync-api-cli.ts`

```typescript
// connectors register <type> [--config key=value...]
async function cmdConnectorsRegister(type: string, config?: Record<string, string>): Promise<void> {
  const connector = await client.connectors.register(type, config)
  printSuccess(`Registered ${connector.displayName}`)
  console.log(`  Entity types: ${connector.entityTypes.join(', ')}`)
}

// connectors config <type> --set key=value
async function cmdConnectorsConfig(type: string, updates: Record<string, string>): Promise<void> {
  await client.connectors.updateConfig(type, updates)
  printSuccess(`Updated config for ${type}`)
}

// connectors enable/disable <type>
async function cmdConnectorsEnable(type: string): Promise<void> {
  await client.connectors.setEnabled(type, true)
  printSuccess(`Enabled ${type}`)
}

async function cmdConnectorsDisable(type: string): Promise<void> {
  await client.connectors.setEnabled(type, false)
  printSuccess(`Disabled ${type}`)
}

// connectors unregister <type>
async function cmdConnectorsUnregister(type: string): Promise<void> {
  await client.connectors.unregister(type)
  printSuccess(`Unregistered ${type}`)
}
```

---

## Daemon Startup Changes

**Before (sync-daemon.ts):**
```typescript
const connectorConfig = {
  gmail: { enabled: true },
  github: { enabled: Boolean(process.env.GITHUB_CLIENT_ID), ... },
  claude_sessions: { enabled: true },
  // ... more hardcoded config
}
const loadResult = await loadConnectors(connectorConfig, ...)
```

**After:**
```typescript
// Load from database instead of hardcoded config
await daemon.loadRegisteredConnectors()
```

---

## Migration Path

1. Add `registered_connectors` table
2. Add repository and routes
3. Update daemon to load from DB
4. Remove hardcoded `connectorConfig` from sync-daemon.ts
5. Update CLI with register/config/enable/disable commands
6. On first run, auto-register existing connectors (optional migration)

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/daemon/repos/connector-repo.ts` | NEW: Repository for registered_connectors |
| `src/daemon/routes/connectors.ts` | ADD: register, config, enable/disable, unregister |
| `src/daemon/index.ts` | ADD: loadRegisteredConnectors, registerConnectorDynamic |
| `scripts/sync-daemon.ts` | REMOVE: hardcoded connectorConfig |
| `scripts/sync-api-cli.ts` | ADD: register, config, enable, disable, unregister |
| `src/client/index.ts` | ADD: connectors.register, updateConfig, setEnabled, unregister |

---

## CLI Usage After Implementation

```bash
# List available factories (implemented but not registered)
sync-api-cli connectors available

# Register a connector
sync-api-cli connectors register gmail
sync-api-cli connectors register github

# Update config
sync-api-cli connectors config github --set rateLimit=10

# Enable/disable
sync-api-cli connectors disable github
sync-api-cli connectors enable github

# Unregister
sync-api-cli connectors unregister github

# List registered (current behavior)
sync-api-cli connectors list
```

---

## Benefits

1. **Single touch point**: Implement connector → register via CLI
2. **No restarts**: All changes are dynamic
3. **Config in DB**: No env vars scattered everywhere
4. **Audit trail**: registered_at, updated_at timestamps
5. **Clean separation**: Code (factory) vs State (DB)
