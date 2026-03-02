# Conversational Memory Design

## Overview

A tiered memory system for coding agents that enables:
1. **Personal assistant mode**: See recent conversation summaries without full context
2. **Deterministic drill-down**: Link directly to source conversations/messages
3. **Temporal salience**: Timestamps make interactions personable ("you discussed this 2 weeks ago")

## Core Principle: Identity Persistence vs Searchability

The key design question: *does this thing need to be tracked across time, or just found?*

| Type | Needs Identity? | Why |
|------|-----------------|-----|
| **Projects** | Yes | Long-running, revisited, has children (features, issues) |
| **Goals** | Yes | Personal, evolves over time, track progress |
| **People** | Yes | Already have (Person, Identity in canonical) |
| **Issues** | Yes | Already have (from GitHub, etc.) |
| **Features** | No | Child of Project, searchable context |
| **Ideas/Concepts** | No | Emergent, fuzzy boundaries, use embeddings |

## Architecture

### Data Flow

```
Raw Envelopes (GraphD sessions, etc.)
        ↓
[Sync Collector] → raw_envelopes table
        ↓
[Transformation] → canonical_conversation, canonical_message
        ↓
[Derived ETL] → ConversationDigest, EntityMention, Project, Goal
        ↓
[Query Time] → Temporal bucketing, relevance ranking, context expansion
```

### ETL vs Post-Retrieval

| Operation | ETL (Derived Task) | Post-Retrieval |
|-----------|-------------------|----------------|
| Summary extraction | ✓ | |
| Entity mention extraction | ✓ | |
| Entity resolution (linking) | ✓ | |
| Digest generation | ✓ | |
| Temporal bucketing | | ✓ (relative to "now") |
| Context expansion | | ✓ (based on current query) |
| Relevance ranking | | ✓ (based on query) |

**Principle**: Structure in ETL, relevance at query-time.

## Schema Design

### First-Class Entities

#### Project

Things you work on over time. Has a codebase, features, issues.

```typescript
Project {
  id: ULID
  name: string                    // "jesus monorepo", "agent-memory"
  description: string
  status: 'active' | 'paused' | 'completed' | 'abandoned'

  // Optional linking
  repo_url?: string               // GitHub repo if applicable
  parent_project_id?: ULID        // For sub-projects

  // Derived stats
  conversation_count: number
  last_discussed_at: datetime

  created_at: datetime
  updated_at: datetime
}
```

#### Goal

Personal objectives you're trying to achieve. Long-running, aspirational.

```typescript
Goal {
  id: ULID
  title: string                   // "Ship conversational memory"
  description: string
  status: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'

  // Optional hierarchy
  parent_goal_id?: ULID           // For sub-goals
  project_id?: ULID               // If tied to a project

  // Progress tracking
  progress_notes: string[]        // Append-only log
  target_date?: datetime
  completed_at?: datetime

  // Derived stats
  conversation_count: number
  last_discussed_at: datetime

  created_at: datetime
  updated_at: datetime
}
```

### Derived Entities

#### ConversationDigest

LLM-extracted summary for a conversation. The "tier 1" view for personal assistant mode.

```typescript
ConversationDigest {
  id: ULID
  conversation_id: ULID           // FK to canonical_conversation

  // Summary (1-2 sentences)
  summary: string

  // Extracted decisions/commitments
  decisions: Array<{
    description: string
    message_id: ULID              // Exact message where decision was made
    confidence: number            // 0.0 - 1.0
  }>

  // Key outcomes
  outcome?: 'resolved' | 'ongoing' | 'blocked' | 'abandoned'

  // Processor versioning (for reprocessing on model changes)
  processor_version: string
  model_version: string

  created_at: datetime
  updated_at: datetime
}
```

#### EntityMention

Links conversations to entities (resolved or unresolved). The bridge between conversations and tracked entities.

```typescript
EntityMention {
  id: ULID
  conversation_id: ULID

  // What was mentioned
  entity_type: 'project' | 'goal' | 'person' | 'issue' | 'concept'
  entity_id: ULID | null          // null for unresolved concepts
  surface_form: string            // "auth refactor", "the memory thing"

  // Evidence
  message_ids: ULID[]             // Where it was mentioned
  confidence: number              // 0.0 - 1.0

  // For unresolved concepts (entity_id = null)
  embedding?: vector              // For similarity search

  created_at: datetime
}
```

**Key insight**: Unresolved concepts (`entity_id: null`) are searchable via embeddings without forcing them into a taxonomy. When a concept becomes important enough to track, create the entity and resolve existing mentions.

## Retrieval Patterns

### Pattern 1: Recent Activity Summary

Personal assistant wants to show what user has been working on.

```
1. Query recent ConversationDigests (last 7 days)
2. Group by resolved EntityMentions (Projects, Goals)
3. Return summaries with temporal context:

   "You've been working on:
    - agent-memory (3 conversations, most recent 2 hours ago)
    - watcher reliability (2 conversations, most recent yesterday)

    Recent decisions:
    - Use EntityMention linking instead of flat topics (2 hours ago)"
```

### Pattern 2: Topic Drill-Down

User asks about something specific.

```
User: "What's the status on the memory work?"

1. Semantic search "memory work" → EntityMentions
2. Resolve to entities:
   - Goal: "ship conversational memory" (entity_id resolved)
   - Concept: "memory architecture" (entity_id null, embedding match)

3. Fetch ConversationDigests for those conversations
4. Return with timestamps:

   "Goal: Ship conversational memory (active)
    - Discussed 2 hours ago: Designed tiered retrieval system
    - Discussed 3 days ago: Reviewed ETL vs post-retrieval split

    Related conversations about 'memory architecture':
    - 1 week ago: Initial brainstorm on conversation indexing"
```

### Pattern 3: Entity History

User wants full context on a tracked entity.

```
User: "Show me everything about the agent-memory project"

1. Get Project entity by name
2. Get all EntityMentions where entity_id = project.id
3. Fetch ConversationDigests for those conversations
4. Optionally fetch full messages for specific decisions

Return:
- Project metadata (status, description, repo)
- Conversation timeline with summaries
- Key decisions with links to exact messages
- Related Goals
```

### Pattern 4: Concept Resolution

Unresolved concept becomes important enough to track.

```
User: "Create a goal for the auth refactor work"

1. Find EntityMentions where surface_form ~ "auth refactor"
2. Create Goal entity
3. Update EntityMentions to set entity_id = new goal ID
4. Future mentions auto-resolve via embedding similarity
```

## Implementation Notes

### Entity Resolution Strategy

When extracting EntityMentions during ETL:

1. **Exact match**: Check if surface_form matches existing entity name
2. **Embedding similarity**: Compare mention embedding to entity embeddings
3. **Threshold**: If similarity > 0.85, resolve to entity
4. **Below threshold**: Leave as unresolved concept

Unresolved concepts can be:
- Searched via embeddings at query time
- Bulk-resolved later when patterns emerge
- Manually resolved by user

### Temporal Bucketing (Query-Time)

Calculate relative to "now" when presenting:

```typescript
function temporalBucket(timestamp: Date): string {
  const hours = (Date.now() - timestamp.getTime()) / (1000 * 60 * 60)
  if (hours < 24) return 'today'
  if (hours < 48) return 'yesterday'
  if (hours < 168) return 'this_week'
  if (hours < 720) return 'this_month'
  return 'older'
}
```

### Context Expansion

When user drills into a topic, fetch related context:

```typescript
async function expandContext(entityId: string, currentConversationId: string) {
  // Get all conversations mentioning this entity
  const mentions = await entityMentions.findByEntityId(entityId)

  // Filter out current, sort by recency
  const historical = mentions
    .filter(m => m.conversation_id !== currentConversationId)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 5)

  // Return with temporal context
  return historical.map(m => ({
    digest: await digests.get(m.conversation_id),
    relative_time: formatRelative(m.created_at), // "2 weeks ago"
  }))
}
```

## Why Not Pure RAG?

Traditional RAG approach:
1. Embed user query
2. Search all message embeddings
3. Return top-k similar chunks
4. Hope context is relevant

Problems:
- Loses conversation structure
- No concept of "this was discussed 2 weeks ago vs yesterday"
- Can't deterministically find "the conversation where we decided X"
- Fragments context across multiple conversations

This design:
1. **Structure in ETL**: Extract entities, decisions, summaries upfront
2. **Direct linking**: EntityMention → Conversation → Messages
3. **Temporal awareness**: Timestamps preserved throughout
4. **Deterministic drill-down**: Can always trace back to exact source

RAG becomes a fallback for truly novel queries, not the primary retrieval mechanism.

## Migration Path

1. **Phase 1**: Add ConversationDigest derived task
   - Process existing canonical_conversations
   - Extract summaries and decisions

2. **Phase 2**: Add EntityMention extraction
   - Extract mentions from conversations
   - Leave all as unresolved initially

3. **Phase 3**: Add Project and Goal entities
   - Create based on high-frequency unresolved mentions
   - Resolve existing EntityMentions

4. **Phase 4**: Query API
   - Implement retrieval patterns
   - Add temporal bucketing
   - Build context expansion
