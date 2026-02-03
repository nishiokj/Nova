# Coding Agent Session Connectors

Connectors for ingesting session data from coding agents (Claude Code, Rex).

## Overview

These connectors read local session data and produce raw envelopes containing session messages. The transformation layer then converts these into canonical `Conversation` and `Message` entities.

## Supported Agents

| Agent | Connector | Default Path | Connector Type |
|-------|-----------|--------------|----------------|
| Claude Code | `ClaudeSessionConnector` | `~/.claude/projects/` | `claude_sessions` |
| Rex | `RexSessionConnector` | `~/.graphd/graphd.db` | `rex_sessions` |

## Data Flow

```
GraphD SQLite Database
       │
       ▼  Connector.fetchPage()
┌──────────────────────┐
│ raw_envelopes        │  ← session_message, session_summary
│ (Bronze)             │
└──────────────────────┘
       │
       ▼  Transformation (deterministic)
┌──────────────────────┐
│ canonical_entities   │  ← Conversation, Message
│ (Silver)             │
└──────────────────────┘
```

## Usage

### Claude Code Sessions

```typescript
import { createClaudeSessionConnector } from '@agent-memory/connectors'

// Default: reads from ~/.claude/projects/
const connector = createClaudeSessionConnector()

// Custom configuration
const connector = createClaudeSessionConnector({
  projectsPath: '/custom/path/to/claude/projects',
  projectFilter: ['my-project', 'another-project'],
  pageSize: 20,
  includeFileHistory: false,
})
```

### Rex Sessions (GraphD)

```typescript
import { createRexSessionConnector } from '@agent-memory/connectors'

const connector = createRexSessionConnector({
  databasePath: '/path/to/graphd.db',
  projectFilter: ['project-a'], // matches working_dir substrings
})
```

## Session File Format

### Claude Code JSONL

Each session is stored as a `.jsonl` file with one JSON object per line:

```json
{"type":"user","uuid":"abc123","sessionId":"session-1","timestamp":"2024-01-01T00:00:00Z","message":{"role":"user","content":"Hello"}}
{"type":"assistant","uuid":"def456","sessionId":"session-1","timestamp":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":"Hi there!"}}
{"type":"summary","leafUuid":"def456","summary":"User greeted the assistant"}
```

Message types:
- `user` - User input messages
- `assistant` - Claude's responses
- `summary` - Auto-generated conversation summaries
- `file-history-snapshot` - File state snapshots (optional)

### Rex GraphD SQLite

The connector reads from the GraphD SQLite database tables:
- `sessions` (session metadata, `working_dir`, `client_type`)
- `conversation_messages` (message rows)

## Transformations

The connector produces raw envelopes with entity types:
- `session_message` - Individual user/assistant messages
- `session_summary` - Conversation summaries

The transformation layer (`transforms.ts`) converts these to:
- `Conversation` - Groups messages by session, includes metadata
- `Message` - Individual conversation turns with role, content, tools used

### Registering Transformations

```typescript
import { TransformationRegistry } from '@agent-memory/transform'
import { claudeSessionTransform, claudeMessageTransform } from '@agent-memory/connectors/coding-sessions'

const registry = new TransformationRegistry()
registry.register(claudeSessionTransform)
registry.register(claudeMessageTransform)
```

## Configuration Options

### ClaudeSessionConnectorConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `projectsPath` | `string` | `~/.claude/projects` | Base path to Claude projects |
| `projectFilter` | `string[]` | `undefined` | Filter to specific project folders |
| `pageSize` | `number` | `10` | Messages per page during sync |
| `includeFileHistory` | `boolean` | `false` | Include file-history-snapshot messages |

### RexSessionConnectorConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `databasePath` | `string` | `~/.graphd/graphd.db` | GraphD SQLite database path |
| `projectFilter` | `string[]` | `undefined` | Filter sessions by working_dir substrings |
| `sessionFilter` | `string[]` | `undefined` | Filter sessions by session_key substrings |
| `clientTypeFilter` | `string[]` | `undefined` | Filter sessions by client_type values |
| `pageSize` | `number` | `100` | Messages per page during sync |
| `webhookDebounceMs` | `number` | `500` | Debounce window for DB change events |
| `webhookStartAtLatest` | `boolean` | `true` | Start webhook ingestion at latest row |
| `webhookBatchSize` | `number` | `500` | Max rows to pull per webhook batch |

## Auth Configuration

Both connectors use `local` auth type - no OAuth or API keys required. They read directly from the local filesystem.

```typescript
connector.authConfig // { type: 'local' }
```

## Capabilities

```typescript
connector.capabilities = {
  supportsBackfill: true,      // Full historical sync
  supportsIncrementalSync: true, // File modification-based delta sync
  supportsWebhook: true,       // Event-driven updates via DB watcher
  supportsWrite: false,        // Read-only
  supportedEntityTypes: ['session_message'],
}
```

## Directory Structure

```
GraphD stores sessions and conversation messages in SQLite, so the connector queries the database directly for incremental and webhook-driven ingestion.
