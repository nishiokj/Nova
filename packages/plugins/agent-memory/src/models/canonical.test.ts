import { describe, test, expect } from 'bun:test'
import { generateCanonicalId } from '../ids.js'
import {
  CanonicalSourceRefSchema,
  BaseEntitySchema,
  PlatformSchema,
  PersonSchema,
  IdentitySchema,
  OrgSchema,
  AccountSchema,
  MessageSchema,
  EventSchema,
  IssueSchema,
  NotificationSchema,
  ObservationSchema,
  LinkSchema,
  AttachmentSchema,
  EntityTypeSchema,
  EntitySchemas,
  validateEntity,
} from './canonical.js'

// Helper to create valid source ref
function createSourceRef(overrides = {}) {
  return {
    connector: 'github',
    account_id: 'user123',
    entity_type: 'issue',
    source_id: '456',
    last_synced_at: new Date().toISOString(),
    ...overrides,
  }
}

// Helper to create base entity fields
function createBaseFields(overrides = {}) {
  const now = new Date().toISOString()
  return {
    id: generateCanonicalId(),
    created_at: now,
    updated_at: now,
    source_refs: [createSourceRef()],
    ...overrides,
  }
}

describe('Canonical Data Model', () => {
  describe('CanonicalSourceRefSchema', () => {
    test('validates correct source ref', () => {
      const ref = createSourceRef()
      const result = CanonicalSourceRefSchema.safeParse(ref)
      expect(result.success).toBe(true)
    })

    test('requires last_synced_at', () => {
      const ref = {
        connector: 'github',
        account_id: 'user123',
        entity_type: 'issue',
        source_id: '456',
      }
      const result = CanonicalSourceRefSchema.safeParse(ref)
      expect(result.success).toBe(false)
    })

    test('validates datetime format', () => {
      const ref = createSourceRef({ last_synced_at: 'not-a-date' })
      const result = CanonicalSourceRefSchema.safeParse(ref)
      expect(result.success).toBe(false)
    })
  })

  describe('BaseEntitySchema', () => {
    test('validates correct base entity', () => {
      const entity = createBaseFields()
      const result = BaseEntitySchema.safeParse(entity)
      expect(result.success).toBe(true)
    })

    test('requires at least one source ref', () => {
      const entity = createBaseFields({ source_refs: [] })
      const result = BaseEntitySchema.safeParse(entity)
      expect(result.success).toBe(false)
    })

    test('validates ULID format for id', () => {
      const entity = createBaseFields({ id: 'invalid-id' })
      const result = BaseEntitySchema.safeParse(entity)
      expect(result.success).toBe(false)
    })
  })

  describe('PlatformSchema', () => {
    test('accepts valid platforms', () => {
      expect(PlatformSchema.safeParse('github').success).toBe(true)
      expect(PlatformSchema.safeParse('gmail').success).toBe(true)
      expect(PlatformSchema.safeParse('xcom').success).toBe(true)
      expect(PlatformSchema.safeParse('imessage').success).toBe(true)
      expect(PlatformSchema.safeParse('unknown').success).toBe(true)
    })

    test('rejects invalid platforms', () => {
      expect(PlatformSchema.safeParse('twitter').success).toBe(false)
    })
  })

  describe('PersonSchema', () => {
    test('validates correct person', () => {
      const person = {
        ...createBaseFields(),
        entity_type: 'person',
        display_name: 'John Doe',
        emails: ['john@example.com'],
      }
      const result = PersonSchema.safeParse(person)
      expect(result.success).toBe(true)
    })

    test('applies defaults', () => {
      const person = {
        ...createBaseFields(),
        entity_type: 'person',
      }
      const result = PersonSchema.parse(person)
      expect(result.emails).toEqual([])
      expect(result.phones).toEqual([])
      expect(result.usernames).toEqual([])
      expect(result.org_ids).toEqual([])
      expect(result.identity_ids).toEqual([])
    })

    test('validates email format', () => {
      const person = {
        ...createBaseFields(),
        entity_type: 'person',
        emails: ['not-an-email'],
      }
      const result = PersonSchema.safeParse(person)
      expect(result.success).toBe(false)
    })
  })

  describe('IdentitySchema', () => {
    test('validates correct identity', () => {
      const identity = {
        ...createBaseFields(),
        entity_type: 'identity',
        platform: 'github',
        platform_user_id: '12345',
        username: 'johndoe',
      }
      const result = IdentitySchema.safeParse(identity)
      expect(result.success).toBe(true)
    })

    test('requires platform_user_id', () => {
      const identity = {
        ...createBaseFields(),
        entity_type: 'identity',
        platform: 'github',
      }
      const result = IdentitySchema.safeParse(identity)
      expect(result.success).toBe(false)
    })

    test('validates URL formats', () => {
      const identity = {
        ...createBaseFields(),
        entity_type: 'identity',
        platform: 'github',
        platform_user_id: '12345',
        profile_url: 'not-a-url',
      }
      const result = IdentitySchema.safeParse(identity)
      expect(result.success).toBe(false)
    })
  })

  describe('OrgSchema', () => {
    test('validates correct org', () => {
      const org = {
        ...createBaseFields(),
        entity_type: 'org',
        name: 'Acme Corp',
        domain: 'acme.com',
      }
      const result = OrgSchema.safeParse(org)
      expect(result.success).toBe(true)
    })

    test('requires name', () => {
      const org = {
        ...createBaseFields(),
        entity_type: 'org',
      }
      const result = OrgSchema.safeParse(org)
      expect(result.success).toBe(false)
    })
  })

  describe('AccountSchema', () => {
    test('validates correct account', () => {
      const account = {
        ...createBaseFields(),
        entity_type: 'account',
        connector: 'github',
        account_id: 'user123',
      }
      const result = AccountSchema.safeParse(account)
      expect(result.success).toBe(true)
    })

    test('applies default is_active', () => {
      const account = {
        ...createBaseFields(),
        entity_type: 'account',
        connector: 'github',
        account_id: 'user123',
      }
      const result = AccountSchema.parse(account)
      expect(result.is_active).toBe(true)
    })
  })

  describe('MessageSchema', () => {
    test('validates correct message', () => {
      const message = {
        ...createBaseFields(),
        entity_type: 'message',
        subject: 'Hello',
        body_text: 'World',
      }
      const result = MessageSchema.safeParse(message)
      expect(result.success).toBe(true)
    })

    test('applies defaults', () => {
      const message = {
        ...createBaseFields(),
        entity_type: 'message',
      }
      const result = MessageSchema.parse(message)
      expect(result.recipient_identity_ids).toEqual([])
      expect(result.attachment_ids).toEqual([])
      expect(result.labels).toEqual([])
    })
  })

  describe('EventSchema', () => {
    test('validates correct event', () => {
      const event = {
        ...createBaseFields(),
        entity_type: 'event',
        title: 'Team Meeting',
        start_at: new Date().toISOString(),
      }
      const result = EventSchema.safeParse(event)
      expect(result.success).toBe(true)
    })

    test('requires title and start_at', () => {
      const event = {
        ...createBaseFields(),
        entity_type: 'event',
      }
      const result = EventSchema.safeParse(event)
      expect(result.success).toBe(false)
    })

    test('applies default status', () => {
      const event = {
        ...createBaseFields(),
        entity_type: 'event',
        title: 'Meeting',
        start_at: new Date().toISOString(),
      }
      const result = EventSchema.parse(event)
      expect(result.status).toBe('confirmed')
    })
  })

  describe('IssueSchema', () => {
    test('validates correct issue', () => {
      const issue = {
        ...createBaseFields(),
        entity_type: 'issue',
        title: 'Fix bug',
        status: 'open',
        priority: 'high',
      }
      const result = IssueSchema.safeParse(issue)
      expect(result.success).toBe(true)
    })

    test('applies default status', () => {
      const issue = {
        ...createBaseFields(),
        entity_type: 'issue',
        title: 'Fix bug',
      }
      const result = IssueSchema.parse(issue)
      expect(result.status).toBe('open')
    })

    test('validates priority enum', () => {
      const issue = {
        ...createBaseFields(),
        entity_type: 'issue',
        title: 'Fix bug',
        priority: 'invalid',
      }
      const result = IssueSchema.safeParse(issue)
      expect(result.success).toBe(false)
    })
  })

  describe('NotificationSchema', () => {
    test('validates correct notification', () => {
      const notification = {
        ...createBaseFields(),
        entity_type: 'notification',
        notification_type: 'mention',
        triggered_at: new Date().toISOString(),
      }
      const result = NotificationSchema.safeParse(notification)
      expect(result.success).toBe(true)
    })

    test('requires triggered_at', () => {
      const notification = {
        ...createBaseFields(),
        entity_type: 'notification',
        notification_type: 'mention',
      }
      const result = NotificationSchema.safeParse(notification)
      expect(result.success).toBe(false)
    })
  })

  describe('ObservationSchema', () => {
    test('validates correct observation', () => {
      const observation = {
        ...createBaseFields(),
        entity_type: 'observation',
        content: 'User seems interested in AI topics',
        observation_type: 'insight',
        confidence: 0.85,
      }
      const result = ObservationSchema.safeParse(observation)
      expect(result.success).toBe(true)
    })

    test('validates confidence range', () => {
      const observation = {
        ...createBaseFields(),
        entity_type: 'observation',
        content: 'Test',
        observation_type: 'note',
        confidence: 1.5,
      }
      const result = ObservationSchema.safeParse(observation)
      expect(result.success).toBe(false)
    })

    test('validates observation_type enum', () => {
      const observation = {
        ...createBaseFields(),
        entity_type: 'observation',
        content: 'Test',
        observation_type: 'invalid',
      }
      const result = ObservationSchema.safeParse(observation)
      expect(result.success).toBe(false)
    })
  })

  describe('LinkSchema', () => {
    test('validates correct link', () => {
      const link = {
        ...createBaseFields(),
        entity_type: 'link',
        from_entity_id: generateCanonicalId(),
        from_entity_type: 'person',
        to_entity_id: generateCanonicalId(),
        to_entity_type: 'org',
        link_type: 'works_at',
      }
      const result = LinkSchema.safeParse(link)
      expect(result.success).toBe(true)
    })

    test('requires all link fields', () => {
      const link = {
        ...createBaseFields(),
        entity_type: 'link',
        from_entity_id: generateCanonicalId(),
      }
      const result = LinkSchema.safeParse(link)
      expect(result.success).toBe(false)
    })
  })

  describe('AttachmentSchema', () => {
    test('validates correct attachment', () => {
      const attachment = {
        ...createBaseFields(),
        entity_type: 'attachment',
        filename: 'report.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024,
        content_hash: 'abc123',
        storage_type: 'local',
        storage_path: '/files/report.pdf',
      }
      const result = AttachmentSchema.safeParse(attachment)
      expect(result.success).toBe(true)
    })

    test('validates size_bytes is non-negative', () => {
      const attachment = {
        ...createBaseFields(),
        entity_type: 'attachment',
        filename: 'test.txt',
        mime_type: 'text/plain',
        size_bytes: -1,
        content_hash: 'abc123',
        storage_type: 'local',
      }
      const result = AttachmentSchema.safeParse(attachment)
      expect(result.success).toBe(false)
    })

    test('validates storage_type enum', () => {
      const attachment = {
        ...createBaseFields(),
        entity_type: 'attachment',
        filename: 'test.txt',
        mime_type: 'text/plain',
        size_bytes: 100,
        content_hash: 'abc123',
        storage_type: 'cloud',
      }
      const result = AttachmentSchema.safeParse(attachment)
      expect(result.success).toBe(false)
    })
  })

  describe('EntityTypeSchema', () => {
    test('includes all entity types', () => {
      const types = EntityTypeSchema.options
      expect(types).toContain('message')
      expect(types).toContain('conversation')
      expect(types).toContain('issue')
      expect(types).toContain('notification')
      expect(types.length).toBe(4)
    })
  })

  describe('EntitySchemas registry', () => {
    test('has schema for each entity type', () => {
      const types = EntityTypeSchema.options
      for (const type of types) {
        expect(EntitySchemas[type]).toBeDefined()
      }
    })
  })

  describe('validateEntity', () => {
    test('validates issue entity', () => {
      const issue = {
        ...createBaseFields(),
        entity_type: 'issue',
        title: 'Test Issue',
      }
      const result = validateEntity('issue', issue)
      expect(result.success).toBe(true)
    })

    test('returns error for invalid entity', () => {
      const issue = {
        entity_type: 'issue',
        // Missing required fields
      }
      const result = validateEntity('issue', issue)
      expect(result.success).toBe(false)
    })
  })
})
