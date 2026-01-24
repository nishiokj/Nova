# Agent Memory TODO

> Critical gaps and concerns for the agent-memory package
> 
> Last updated: 2026-01-23

---

## 🔴 CRITICAL GAPS (Security & Production Blockers)

### 1. Credential Encryption NOT Implemented
**Priority: CRITICAL**
- `accounts.credentials_encrypted` fields exist but no encryption implementation
- No key management in `connection.ts`
- **Risk**: OAuth tokens stored in plaintext in database

**Action Items**:
- [ ] Implement encryption/decryption functions using KMS or envelope encryption
- [ ] Add key rotation strategy
- [ ] Encrypt existing credentials on next sync cycle
- [ ] Add audit logging for key access

**Files**: `packages/agent-memory/src/connection.ts`, `packages/agent-memory/src/sync/queue.ts`

---

### 2. Raw Envelope Retention Policy Missing
**Priority: HIGH**
- Raw data accumulates forever - no TTL or pruning
- For busy systems, storage costs will explode
- Query performance will degrade over time

**Action Items**:
- [ ] Design retention policy by entity type and age
- [ ] Implement automated pruning job
- [ ] Add archiving strategy (move to cold storage)
- [ ] Add metrics for raw envelope growth rate

**Suggested Policy**:
```
raw_envelopes: { age: '90d', action: 'archive' }
notifications: { age: '30d', action: 'delete' }
messages: { age: '365d', action: 'archive' }
```

**Files**: `packages/agent-memory/src/sync/processor.ts`, Add: `retention.ts`

---

### 3. Single-Process Queue Limitation
**Priority: HIGH (Production)**
- `MicroQueue` is explicitly single-process
- No multi-worker coordination
- Cannot scale horizontally

**Action Items**:
- [ ] Evaluate: Redis/Bull, AWS SQS, or pg-job-queue
- [ ] Migrate queue implementation to support multiple workers
- [ ] Add worker health checks and auto-scaling
- [ ] Implement dead letter queue with retry policy

**Files**: `packages/agent-memory/src/sync/queue.ts`

---

## 🟡 FUNCTIONAL GAPS (Core Features Incomplete)

### 4. Connector Implementations Incomplete
**Priority: HIGH**
- Only GitHub connector is fully implemented
- Gmail, X.com, iMessage are config stubs only
- Missing: OAuth flows, API pagination, webhook parsing

**Action Items**:
- [ ] **Gmail**: Implement OAuth2 flow, Gmail API pagination, webhook for push notifications
- [ ] **X.com**: Implement OAuth1.0a, Twitter API v2 pagination
- [ ] **iMessage**: Design local bridge (AppleScript? Database?)
- [ ] Add connector testing harness with mock responses

**Files**: `packages/agent-memory/src/connectors/`, `packages/agent-memory/src/config/`

---

### 5. Incomplete Entity Resolution
**Priority: MEDIUM**
- Identity→Person merging implemented
- Person→Person merging exists but no conflict detection
- No relationship graph queries
- No temporal resolution

**Action Items**:
- [ ] Add conflict detection for Person→Person merges
- [ ] Implement relationship graph queries:
  - [ ] `findConnectionPath(fromId, toId)`
  - [ ] `findMutualConnections(entityId)`
  - [ ] `findCommonTopics(entityId, depth)`
- [ ] Add temporal resolution (track attribute changes over time)
- [ ] Add confidence decay over time

**Files**: `packages/agent-memory/src/resolution.ts`, Add: `graph.ts`, Add: `temporal.ts`

---

### 6. Embedding Generation Pipeline Missing
**Priority: MEDIUM**
- Schema has `embedding` column and config exists
- No automatic embedding generation in processing pipeline
- Search by similarity not working

**Action Items**:
- [ ] Configure OpenAI embedding model (text-embedding-3-small)
- [ ] Add embedding generation to processing pipeline
- [ ] Implement background job for batch embedding of historical data
- [ ] Add similarity search API
- [ ] Add embedding caching

**Files**: `packages/agent-memory/src/normalization/`, Add: `embeddings.ts`

---

### 7. Write Capabilities Not Implemented
**Priority: MEDIUM**
- `supportsWrite: true` exists in capabilities
- No methods for creating issues, sending messages, etc.
- Currently read-only

**Action Items**:
- [ ] Design write API with permission model
- [ ] Implement GitHub write operations (create issue, add comment)
- [ ] Implement Gmail send/reply
- [ ] Add audit trail for all write operations
- [ ] Implement dry-run mode

**Files**: `packages/agent-memory/src/connectors/github.ts`, Add: `write-manager.ts`

---

### 8. Attachment Storage Missing
**Priority: LOW**
- `Attachment` entity exists but `storage_type` is 'reference' only
- No local file storage implemented
- No attachment download/processing pipeline

**Action Items**:
- [ ] Design storage abstraction (local, S3, GCS)
- [ ] Implement attachment download pipeline
- [ ] Add thumbnail generation for images
- [ ] Implement attachment deduplication (content hash)
- [ ] Add cleanup for orphaned attachments

**Files**: Add: `storage/`, `packages/agent-memory/src/entities/attachment.ts`

---

## 🔨 ENHANCEMENTS (Cool Ideas)

### 9. Entity State Machine
**Track lifecycle states across sources**
- GitHub: open → in_progress → closed
- Gmail: unread → read → archived

**Files**: Add: `state-machine.ts`

---

### 10. Event-Driven Architecture
**Emit events on entity changes**
```typescript
engine.on('entity:created', ({ entityType, entity }) => {
  if (entityType === 'identity') {
    resolutionEngine.resolveIdentity(entity.id)
  }
})
```

**Files**: Add: `events.ts`

---

### 11. Smart Retention Policies
**Configure by entity type and age**
```typescript
const retentionPolicy = {
  raw_envelopes: { age: '90d', action: 'archive' },
  notifications: { age: '30d', action: 'delete' },
  messages: { age: '365d', action: 'archive' }
}
```

**Files**: See item #2

---

### 12. Multi-Source Event Correlation
**Correlate events across platforms**
- GitHub issue + Gmail thread about same topic
- Detect when someone mentions you across multiple platforms

**Files**: Add: `correlation.ts`

---

### 13. Proactive Entity Resolution Triggers
**Auto-resolve on new identity, person update**
- Alert when score near threshold but not confident
- Batch resolve pending identities

**Files**: `packages/agent-memory/src/resolution.ts`

---

## 🔗 REX INTEGRATION

### 14. Rex Memory Query Interface
**Natural language + structured queries**
```typescript
interface RexMemoryClient {
  query(question: string): Promise<{entities, relationships, confidence}>
  findPerson(criteria): Promise<Person[]>
  getEntityWithContext(id): Promise<{entity, related, timeline}>
}
```

**Files**: Add: `rex-client.ts`

---

### 15. Rex Tool Registration
**Register memory access as Rex tools**
```typescript
const rexTools = {
  memory_search: { handler: searchHandler },
  memory_lookup: { handler: lookupHandler },
  memory_resolve: { handler: resolveHandler }
}
```

**Files**: Add: `rex-tools.ts`

---

### 16. Long-Term Memory Layer
**Rex learns from conversations**
- Store what Rex learns about people
- Retrieve context about people in future conversations
- Cross-reference with canonical entities

**Files**: Add: `rex-learning.ts`

---

## 🌘 POSSIBLE INTEGRATIONS

### 17. Obsidian Integration
**Sync notes to memory for search**
- Effort: Medium
- Use: Obsidian Local REST API

---

### 18. Notion API
**Import database content**
- Effort: Medium
- Use: Official Notion API

---

### 19. Slack
**Archive messages, track work conversations**
- Effort: Low
- Use: Slack Events API

---

### 20. Linear
**Sync issues, track project work**
- Effort: Low
- Use: Linear GraphQL API

---

### 21. Calendar APIs
**Track meetings, events**
- Effort: Medium
- Use: Google Calendar, Apple Calendar

---

### 22. Email (IMAP)
**Archive all emails, auto-resolve senders**
- Effort: High
- Use: IMAP protocol

---

### 23. Browser Extension
**Capture interesting pages/articles**
- Effort: High
- Use: Chrome Extension API

---

### 24. Local File System
**Index documents, code repos**
- Effort: High
- Use: File system watcher + git integration

---

## 📋 PRIORITIZED BACKLOG

### Phase 1: Security & Production Readiness (Week 1-2)
1. **Credential encryption** - Blocker for production
2. **Raw envelope retention policy** - Prevents storage explosion
3. **Distributed queue migration** - Enables scaling

### Phase 2: Core Functionality (Week 3-4)
4. **Complete connector implementations** - Gmail (high impact)
5. **Embedding generation pipeline** - Enables semantic search
6. **Entity resolution enhancements** - Better merging

### Phase 3: Advanced Features (Week 5-8)
7. **Write capabilities** - Actionable from memory
8. **Relationship graph queries** - Social intelligence
9. **Attachment storage** - Full document management

### Phase 4: Rex Integration (Week 9-10)
10. **Rex memory query interface** - Core integration
11. **Rex tool registration** - Expose to agents
12. **Long-term memory layer** - Learn from conversations

### Phase 5: Ecosystem (Ongoing)
13. **Additional integrations** - Obsidian, Slack, Linear, etc.
14. **Event-driven architecture** - Reactive system
15. **Multi-source correlation** - Cross-platform insights

---

## 🔍 QUICK WIN CHECKLIST

**Can be done in < 2 hours:**
- [ ] Add metrics for raw envelope growth
- [ ] Add dry-run mode for write operations
- [ ] Add confidence decay to resolution scoring
- [ ] Create connector testing harness
- [ ] Add audit logging for entity changes

**Can be done in < 1 day:**
- [ ] Implement basic retention policy (delete by date)
- [ ] Add similarity search API (once embeddings work)
- [ ] Implement GitHub write operations
- [ ] Add relationship graph query stubs
- [ ] Create Rex tool registration

---

## 📝 NOTES

- Current architecture is **excellent** - well-designed and extensible
- ULID-based IDs are a smart choice (time-ordered, UUID-compatible)
- Two-phase sync pipeline is production-grade
- Main gap is around **production readiness** (encryption, scaling)
- The design is well-suited for **Rex integration** as persistent memory

---

**Total Items**: 24
**Critical**: 3
**High Priority**: 5
**Medium Priority**: 5
**Low Priority**: 1
**Enhancements**: 6
**Integrations**: 8
