import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { createDatabase, type Database } from './connection.js'
import { migrate, loadMigrations, getCurrentVersion, getPendingMigrations } from './migrations.js'
import { createRepositoryContext } from './repositories/types.js'
import { createRawEnvelopeRepository } from './repositories/raw-envelope.js'
import { createCanonicalEntityRepository } from './repositories/canonical-entity.js'
import { createEntitySourceMappingRepository } from './repositories/entity-source-mapping.js'
import { createSyncJobRepository } from './repositories/sync-job.js'
import { createAccountRepository } from './repositories/account.js'
import { generateCanonicalId, computeRawDataHash, sourceRefToKey } from '../ids.js'

// These tests require a PostgreSQL database
// Set TEST_DATABASE_URL environment variable to run them
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip

describe('Database Module - Unit Tests', () => {
  describe('loadMigrations', () => {
    test('loads migration files from migrations directory', async () => {
      const migrations = await loadMigrations()
      expect(migrations.length).toBeGreaterThan(0)
      expect(migrations[0].version).toBe(1)
      expect(migrations[0].filename).toBe('001_initial.sql')
      expect(migrations[0].sql).toContain('CREATE EXTENSION')
    })

    test('migrations are sorted by version', async () => {
      const migrations = await loadMigrations()
      for (let i = 1; i < migrations.length; i++) {
        expect(migrations[i].version).toBeGreaterThan(migrations[i - 1].version)
      }
    })
  })

  describe('createDatabase', () => {
    test('creates database with provided config', () => {
      const db = createDatabase({
        host: 'localhost',
        database: 'test',
        max: 20,
      })

      expect(db.config.host).toBe('localhost')
      expect(db.config.database).toBe('test')
      expect(db.config.max).toBe(20)
      expect(db.sql).toBeDefined()
    })

    test('creates database config from connection string', () => {
      const db = createDatabase({
        connectionString: 'postgres://user:pass@host:5432/db',
      })

      expect(db.config.connectionString).toBe('postgres://user:pass@host:5432/db')
      expect(db.sql).toBeDefined()
    })
  })
})

describeWithDb('Database Module - Integration Tests', () => {
  let db: Database

  beforeAll(async () => {
    db = createDatabase({
      connectionString: TEST_DATABASE_URL,
      max: 5,
    })

    // Run migrations
    await migrate(db, {
      onMigration: (m, status) => {
        if (status !== 'skipped') {
          console.log(`  Migration ${m.version}: ${status}`)
        }
      },
    })
  })

  afterAll(async () => {
    await db.close()
  })

  describe('Migrations', () => {
    test('getCurrentVersion returns latest version', async () => {
      const version = await getCurrentVersion(db)
      expect(version).toBeGreaterThanOrEqual(1)
    })

    test('getPendingMigrations returns empty when up to date', async () => {
      const pending = await getPendingMigrations(db)
      expect(pending.length).toBe(0)
    })
  })

  describe('RawEnvelopeRepository', () => {
    const repo = () => createRawEnvelopeRepository(createRepositoryContext(db.sql))

    test('creates and retrieves raw envelope', async () => {
      const input = {
        idempotency_key: `test-${generateCanonicalId()}`,
        connector: 'github' as const,
        account_id: 'test-account',
        entity_type: 'issue',
        source_id: '123',
        raw_data: { title: 'Test Issue' },
        raw_data_hash: computeRawDataHash({ title: 'Test Issue' }),
        sync_job_id: generateCanonicalId(),
        collection_method: 'incremental' as const,
      }

      const created = await repo().create(input)
      expect(created.id).toBeDefined()
      expect(created.connector).toBe('github')
      expect(created.raw_data).toEqual({ title: 'Test Issue' })

      const found = await repo().findById(created.id)
      expect(found).not.toBeNull()
      expect(found?.id).toBe(created.id)
    })

    test('finds envelope by idempotency key', async () => {
      const key = `test-idem-${generateCanonicalId()}`
      const input = {
        idempotency_key: key,
        connector: 'gmail' as const,
        account_id: 'test-account',
        entity_type: 'email',
        source_id: '456',
        raw_data: { subject: 'Hello' },
        raw_data_hash: computeRawDataHash({ subject: 'Hello' }),
        sync_job_id: generateCanonicalId(),
        collection_method: 'webhook' as const,
      }

      await repo().create(input)
      const found = await repo().findByIdempotencyKey(key)
      expect(found).not.toBeNull()
      expect(found?.idempotency_key).toBe(key)
    })

    test('marks envelope as processed', async () => {
      const input = {
        idempotency_key: `test-proc-${generateCanonicalId()}`,
        connector: 'github' as const,
        account_id: 'test-account',
        entity_type: 'pr',
        source_id: '789',
        raw_data: {},
        raw_data_hash: computeRawDataHash({}),
        sync_job_id: generateCanonicalId(),
        collection_method: 'backfill' as const,
      }

      const created = await repo().create(input)
      expect(created.processed_at).toBeUndefined()

      const processed = await repo().markProcessed(created.id)
      expect(processed?.processed_at).toBeDefined()
    })
  })

  describe('CanonicalEntityRepository', () => {
    const repo = () => createCanonicalEntityRepository(createRepositoryContext(db.sql))

    test('creates and retrieves canonical entity', async () => {
      const data = {
        id: generateCanonicalId(),
        entity_type: 'person' as const,
        display_name: 'Test User',
        emails: ['test@example.com'],
        phones: [],
        usernames: [],
        org_ids: [],
        identity_ids: [],
        source_refs: [
          {
            connector: 'github' as const,
            account_id: 'acc1',
            entity_type: 'user',
            source_id: '123',
            last_synced_at: new Date().toISOString(),
          },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const created = await repo().create('person', data, 'Test User')
      expect(created.id).toBeDefined()
      expect(created.entity_type).toBe('person')
      expect(created.display_text).toBe('Test User')

      const found = await repo().findById(created.id)
      expect(found).not.toBeNull()
      expect((found?.data as { display_name?: string }).display_name).toBe('Test User')
    })

    test('soft deletes entity', async () => {
      const data = {
        id: generateCanonicalId(),
        entity_type: 'task' as const,
        title: 'Test Task',
        status: 'open' as const,
        source_refs: [
          {
            connector: 'github' as const,
            account_id: 'acc1',
            entity_type: 'issue',
            source_id: '999',
            last_synced_at: new Date().toISOString(),
          },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const created = await repo().create('task', data)
      expect(await repo().findById(created.id)).not.toBeNull()

      await repo().softDelete(created.id)
      expect(await repo().findById(created.id)).toBeNull()

      await repo().restore(created.id)
      expect(await repo().findById(created.id)).not.toBeNull()
    })
  })

  describe('EntitySourceMappingRepository', () => {
    const entityRepo = () => createCanonicalEntityRepository(createRepositoryContext(db.sql))
    const envRepo = () => createRawEnvelopeRepository(createRepositoryContext(db.sql))
    const mappingRepo = () => createEntitySourceMappingRepository(createRepositoryContext(db.sql))

    test('creates and retrieves entity source mapping', async () => {
      // Create canonical entity first
      const entityData = {
        id: generateCanonicalId(),
        entity_type: 'person' as const,
        display_name: 'Mapping Test',
        source_refs: [
          {
            connector: 'github' as const,
            account_id: 'acc1',
            entity_type: 'user',
            source_id: 'map-test',
            last_synced_at: new Date().toISOString(),
          },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        emails: [],
        phones: [],
        usernames: [],
        org_ids: [],
        identity_ids: [],
      }
      const entity = await entityRepo().create('person', entityData)

      // Create raw envelope
      const envInput = {
        idempotency_key: `map-test-${generateCanonicalId()}`,
        connector: 'github' as const,
        account_id: 'acc1',
        entity_type: 'user',
        source_id: 'map-test',
        raw_data: {},
        raw_data_hash: computeRawDataHash({}),
        sync_job_id: generateCanonicalId(),
        collection_method: 'incremental' as const,
      }
      const envelope = await envRepo().create(envInput)

      // Create mapping
      const sourceRefKey = sourceRefToKey({
        connector: 'github',
        account_id: 'acc1',
        entity_type: 'user',
        source_id: `map-test-${entity.id}`,
      })

      const mapping = await mappingRepo().create({
        canonical_entity_id: entity.id,
        canonical_entity_type: 'person',
        raw_envelope_id: envelope.id,
        source_ref_key: sourceRefKey,
        mapping_confidence: 0.95,
      })

      expect(mapping.id).toBeDefined()
      expect(mapping.mapping_confidence).toBe(0.95)

      const found = await mappingRepo().findBySourceRefKey(sourceRefKey)
      expect(found).not.toBeNull()
      expect(found?.canonical_entity_id).toBe(entity.id)
    })
  })

  describe('SyncJobRepository', () => {
    const repo = () => createSyncJobRepository(createRepositoryContext(db.sql))

    test('creates and manages sync job lifecycle', async () => {
      const job = await repo().create({
        connector: 'github',
        account_id: 'test-account',
        job_type: 'incremental',
        priority: 5,
      })

      expect(job.id).toBeDefined()
      expect(job.status).toBe('pending')
      expect(job.priority).toBe(5)

      // Start the job
      const started = await repo().start(job.id)
      expect(started?.status).toBe('running')
      expect(started?.started_at).toBeDefined()

      // Update progress
      await repo().updateProgress(job.id, { fetched: 10, processed: 8, failed: 2 })
      const updated = await repo().findById(job.id)
      expect(updated?.items_fetched).toBe(10)
      expect(updated?.items_processed).toBe(8)
      expect(updated?.items_failed).toBe(2)

      // Complete the job
      const completed = await repo().complete(job.id)
      expect(completed?.status).toBe('completed')
      expect(completed?.completed_at).toBeDefined()
    })

    test('handles job failure and retry', async () => {
      const job = await repo().create({
        connector: 'gmail',
        account_id: 'test-account',
        job_type: 'backfill',
      })

      await repo().start(job.id)
      const failed = await repo().fail(job.id, 'Connection timeout')
      expect(failed?.status).toBe('failed')
      expect(failed?.last_error).toBe('Connection timeout')
      expect(failed?.retry_count).toBe(1)

      // Schedule retry
      const retryAt = new Date(Date.now() + 60000)
      const scheduled = await repo().scheduleRetry(job.id, retryAt)
      expect(scheduled?.status).toBe('pending')
      expect(scheduled?.next_retry_at).toBeDefined()
    })
  })

  describe('AccountRepository', () => {
    const repo = () => createAccountRepository(createRepositoryContext(db.sql))

    test('creates and retrieves account', async () => {
      const externalId = `test-${generateCanonicalId()}`
      const account = await repo().create({
        connector: 'github',
        external_account_id: externalId,
        display_name: 'Test Account',
        email: 'test@example.com',
        auth_type: 'oauth2',
      })

      expect(account.id).toBeDefined()
      expect(account.connector).toBe('github')
      expect(account.is_active).toBe(true)

      const found = await repo().findByConnector('github', externalId)
      expect(found).not.toBeNull()
      expect(found?.display_name).toBe('Test Account')
    })

    test('deactivates and activates account', async () => {
      const externalId = `deact-${generateCanonicalId()}`
      const account = await repo().create({
        connector: 'gmail',
        external_account_id: externalId,
        auth_type: 'oauth2',
      })

      expect(account.is_active).toBe(true)

      await repo().deactivate(account.id)
      let found = await repo().findById(account.id)
      expect(found?.is_active).toBe(false)

      await repo().activate(account.id)
      found = await repo().findById(account.id)
      expect(found?.is_active).toBe(true)
    })
  })
})
