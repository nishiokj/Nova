# Agent Memory - Implementation TODO

Tracking remaining work for the sync daemon and transformation layer.

---

## Completed

- [x] SyncDaemon implementation (per `SYNC_DAEMON_SPEC.md`)
  - [x] SyncTask repository + migration
  - [x] Scheduler component
  - [x] HTTP Server + routes
  - [x] SyncDaemon class
- [x] Connector development guide (`src/connectors/README.md`)
- [x] Transformation layer spec (`TRANSFORMATION_LAYER_SPEC.md`)

---

## TODO

### 1. Conversation Canonical Type

**Files to modify:**
- `src/models/canonical.ts` - Add `Conversation` to EntityType, define schema
- `src/db/migrations/` - Add migration (if needed for indexes/comments)

**Schema:**
```typescript
export const ConversationSchema = BaseEntitySchema.extend({
  entityType: z.literal('conversation'),
  platform: PlatformSchema,
  messageIds: z.array(z.string()),  // Ordered list of canonical message IDs
  messageCount: z.number(),
  participants: z.array(CanonicalSourceRefSchema),
  startedAt: z.string(),  // ISO8601
  endedAt: z.string().optional(),
  topic: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})
```

**Checklist:**
- [ ] Add `'conversation'` to `EntityTypeSchema` enum
- [ ] Define `ConversationSchema`
- [ ] Export `Conversation` type
- [ ] Add to `EntitySchemas` registry
- [ ] Update `validateEntity()` if needed

---

### 2. Transformation Layer Implementation

**Per `TRANSFORMATION_LAYER_SPEC.md`, delete:**
- [ ] `src/sync/processor.ts` - Delete file
- [ ] `src/sync/types.ts` - Remove `EntityMapper`, `MapperContext`, `MappedEntity`, `MapperRegistry`
- [ ] `src/connector/sdk/types.ts` - Remove `getMapper()` from Connector interface
- [ ] `src/connector/sdk/base.ts` - Remove `mappers` property, `registerMapper()`, `getMapper()`
- [ ] `src/connectors/github/mappers.ts` - Delete file (or refactor to transforms)
- [ ] Update all index.ts exports

**Create new files:**
```
src/transform/
├── types.ts              # Transformation, TransformContext, TransformResult, etc.
├── registry.ts           # TransformationRegistry class
├── executor.ts           # TransformExecutor class
└── index.ts              # Exports
```

**Database changes:**
- [ ] Add `transformation_runs` table (migration)
- [ ] Update `entity_source_mappings` to reference transformation runs

**Checklist:**
- [ ] Create `src/transform/types.ts` with all type definitions
- [ ] Create `src/transform/registry.ts` with TransformationRegistry
- [ ] Create `src/transform/executor.ts` with TransformExecutor
- [ ] Create `src/transform/index.ts` with exports
- [ ] Create migration for `transformation_runs` table
- [ ] Delete obsolete Processor code
- [ ] Update `src/sync/index.ts` exports
- [ ] Update `src/index.ts` exports
- [ ] Update SyncDaemon to use TransformExecutor instead of Processor

---

### 3. Gmail Transformation

**Files to create/modify:**
- `src/connectors/gmail/transforms.ts` - Define transformations

**Transformations needed:**
- [ ] `gmail_message_to_message` - Gmail message → Message canonical
- [ ] `gmail_thread_to_conversation` - Gmail thread → Conversation + Messages (optional)

**Checklist:**
- [ ] Define `GmailMessageSchema` input validation (already exists in schemas.ts)
- [ ] Write `messageTransform` with field-by-field mapping
- [ ] Register transforms in GmailConnector
- [ ] Add unit tests for transforms

---

### 4. Gmail Webhook Methods

**Per `SYNC_DAEMON_SPEC.md`, GmailConnector needs:**
- [ ] `subscribe(ctx, callbackUrl, options)` - Call Gmail `users.watch` API
- [ ] `unsubscribe(ctx, subscriptionId)` - Call Gmail `users.stop` API
- [ ] `renewSubscription(ctx, subscriptionId)` - Re-register watch (expires after 7 days)

**Files to modify:**
- `src/connectors/gmail/index.ts`

---

### 5. Claude Session Connector (Future)

For syncing Claude conversation data:

**Files to create:**
```
src/connectors/claude/
├── index.ts       # ClaudeConnector class
├── schemas.ts     # Session/turn schemas
├── transforms.ts  # Session → Conversation + Messages
└── README.md      # Setup instructions
```

**Transformations:**
- [ ] `claude_session_to_conversation` - Session → Conversation + Messages

---

### 6. Harness Connector (Future)

For syncing your custom harness data:

**Files to create:**
```
src/connectors/harness/
├── index.ts
├── schemas.ts
├── transforms.ts
└── README.md
```

---

## Priority Order

1. **Conversation canonical type** - Unblocks session/conversation syncing
2. **Transformation layer** - Core architecture change
3. **Gmail transformation** - Validates the new architecture
4. **Gmail webhook methods** - Enables real-time sync
5. **Claude/Harness connectors** - Future work

---

## Related Docs

- `SYNC_DAEMON_SPEC.md` - Original daemon specification
- `TRANSFORMATION_LAYER_SPEC.md` - Transformation layer architecture
- `src/connectors/README.md` - Connector development guide
