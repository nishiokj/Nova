# Coding Agent Session Connectors

Connectors for ingesting session data from coding agents (Claude Code, Rex).

## Overview

These connectors read JSONL session files from local directories and produce raw envelopes containing session messages. The transformation layer then converts these into canonical `Conversation` and `Message` entities.

## Supported Agents

| Agent | Connector | Default Path | Connector Type |
|-------|-----------|--------------|----------------|
| Claude Code | `ClaudeSessionConnector` | `~/.claude/projects/` | `claude_sessions` |
| Rex | `RexSessionConnector` | (configurable) | `rex_sessions` |

## Data Flow

```
Session JSONL Files
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

### Rex Sessions

```typescript
import { createRexSessionConnector } from '@agent-memory/connectors'

// Path is required for Rex
const connector = createRexSessionConnector({
  sessionsPath: '/path/to/rex/sessions',
  projectFilter: ['project-a'],
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

### Rex JSONL

```json
{"type":"user","id":"msg-1","session_id":"session-1","timestamp":"2024-01-01T00:00:00Z","content":"Hello"}
{"type":"assistant","id":"msg-2","session_id":"session-1","timestamp":"2024-01-01T00:00:01Z","content":"Hi!","model":"gpt-4"}
```

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
| `sessionsPath` | `string` | (required) | Base path to Rex sessions |
| `projectFilter` | `string[]` | `undefined` | Filter to specific project folders |
| `pageSize` | `number` | `10` | Messages per page during sync |

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
  supportsWebhook: false,      // No real-time push
  supportsWrite: false,        // Read-only
  supportedEntityTypes: ['session_message', 'session_summary'],
}
```

## Directory Structure

```
~/.claude/projects/
├── -Users-alice-myproject/
│   ├── abc123.jsonl           # Session file
│   ├── def456.jsonl           # Another session
│   └── ...
├── -Users-alice-another-project/
│   └── ...
```

The connector iterates through:
1. Project folders (directories in projectsPath)
2. Session files (*.jsonl in each project)
3. Messages (lines in each JSONL file)

## Incremental Sync

For incremental sync (`fetchChanges`), the connector uses file modification times to detect changed sessions. Only sessions modified since the last sync are processed.

Note: This may re-process entire session files if any message is added. For large sessions, consider using backfill mode with proper cursor handling.
