/**
 * MicroQueue Tests
 *
 * Tests for the PostgreSQL-backed job queue system.
 * Requires a running PostgreSQL instance with the agent_memory database.
 */

import { MicroQueue, TimeoutError, type Job, type JobResult } from 'agent-memory/sync/queue.js'
import { createDatabase, migrate, type Database } from 'agent-memory/db/index.js'
import { createJobQueueRepository, type JobQueueRepository } from 'agent-memory/db/repositories/job-queue.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/agent_memory_test'

describe('MicroQueue', () => {
  let db: Database
  let repo: JobQueueRepository

  beforeAll(async () => {
    db = createDatabase({ connectionString: TEST_DB_URL })

    // Run migrations
    const migrationDir = new URL('../db/migrations', import.meta.url).pathname
    await migrate(db.sql, migrationDir)

    repo = createJobQueueRepository({ sql: db.sql })
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    // Clean up job_queue table
    await db.sql`TRUNCATE job_queue`
  })

  describe('enqueue', () => {
    test('enqueues a job with default options', async () => {
      const queue = new MicroQueue(db.sql)
      const job = await queue.enqueue('test-job', { foo: 'bar' })

      expect(job.id).toBeDefined()
      expect(job.job_type).toBe('test-job')
      expect(job.payload).toEqual({ foo: 'bar' })
      expect(job.status).toBe('pending')
      expect(job.priority).toBe(0)
      expect(job.attempt_count).toBe(0)
    })

    test('enqueues a job with priority', async () => {
      const queue = new MicroQueue(db.sql)
      const job = await queue.enqueue('test-job', { x: 1 }, { priority: 10 })

      expect(job.priority).toBe(10)
    })

    test('enqueues a job with delay', async () => {
      const queue = new MicroQueue(db.sql)
      const before = Date.now()
      const job = await queue.enqueue('test-job', { x: 1 }, { delay: 5000 })

      const visibleAt = new Date(job.visible_at).getTime()
      expect(visibleAt).toBeGreaterThanOrEqual(before + 5000)
    })

    test('respects idempotency key', async () => {
      const queue = new MicroQueue(db.sql)

      const job1 = await queue.enqueue('test-job', { x: 1 }, { idempotencyKey: 'unique-key' })
      const job2 = await queue.enqueue('test-job', { x: 2 }, { idempotencyKey: 'unique-key' })

      // Should return the same job
      expect(job1.id).toBe(job2.id)
      // Original payload preserved
      expect(job1.payload).toEqual({ x: 1 })
    })
  })

  describe('processOne', () => {
    test('processes a job successfully', async () => {
      const queue = new MicroQueue(db.sql)
      let processedPayload: unknown = null

      queue.register('test-job', async (job: Job<{ value: number }>) => {
        processedPayload = job.payload
        return { success: true }
      })

      await queue.enqueue('test-job', { value: 42 })
      const processed = await queue.processOne()

      expect(processed).toBe(true)
      expect(processedPayload).toEqual({ value: 42 })

      // Verify job is completed
      const stats = await queue.getStats()
      expect(stats.completed).toBe(1)
    })

    test('returns false when queue is empty', async () => {
      const queue = new MicroQueue(db.sql)
      queue.register('test-job', async () => ({ success: true }))

      const processed = await queue.processOne()
      expect(processed).toBe(false)
    })

    test('marks job as dead when no handler registered', async () => {
      const queue = new MicroQueue(db.sql)

      // Enqueue without registering handler
      await queue.enqueue('unknown-job', { x: 1 })
      await queue.processOne()

      const stats = await queue.getStats()
      expect(stats.dead).toBe(1)
    })

    test('retries failed jobs with backoff', async () => {
      const queue = new MicroQueue(db.sql, { maxAttempts: 3 })
      let attempts = 0

      queue.register('flaky-job', async () => {
        attempts++
        return { success: false, error: new Error('Temporary failure') }
      })

      await queue.enqueue('flaky-job', { x: 1 })

      // First attempt
      await queue.processOne()
      expect(attempts).toBe(1)

      // Job should be pending again with future visible_at
      const job = (await repo.findByType('flaky-job')).items[0]
      expect(job.status).toBe('pending')
      expect(job.attempt_count).toBe(1)
    })

    test('marks job dead after max attempts', async () => {
      const queue = new MicroQueue(db.sql, { maxAttempts: 2, baseRetryDelay: 0 })
      let attempts = 0

      queue.register('fail-job', async () => {
        attempts++
        return { success: false, error: new Error('Always fails') }
      })

      const enqueuedJob = await queue.enqueue('fail-job', { x: 1 })

      // Manually simulate retries by directly processing
      // First attempt
      await queue.processOne()
      // Make job visible immediately for second attempt
      await db.sql`UPDATE job_queue SET visible_at = NOW() WHERE id = ${enqueuedJob.id}`
      await queue.processOne()

      expect(attempts).toBe(2)

      const stats = await queue.getStats()
      expect(stats.dead).toBe(1)
    })

    test('handles handler throwing exception', async () => {
      const queue = new MicroQueue(db.sql, { maxAttempts: 1 })

      queue.register('throw-job', async () => {
        throw new Error('Unexpected error')
      })

      await queue.enqueue('throw-job', { x: 1 })
      await queue.processOne()

      const stats = await queue.getStats()
      expect(stats.dead).toBe(1)
    })

    test('respects priority ordering', async () => {
      const queue = new MicroQueue(db.sql)
      const processedOrder: number[] = []

      queue.register('priority-job', async (job: Job<{ order: number }>) => {
        processedOrder.push(job.payload.order)
        return { success: true }
      })

      // Enqueue in wrong order
      await queue.enqueue('priority-job', { order: 3 }, { priority: 1 })
      await queue.enqueue('priority-job', { order: 1 }, { priority: 10 })
      await queue.enqueue('priority-job', { order: 2 }, { priority: 5 })

      await queue.processOne()
      await queue.processOne()
      await queue.processOne()

      // Should process highest priority first
      expect(processedOrder).toEqual([1, 2, 3])
    })
  })

  describe('job timeout', () => {
    test('times out long-running jobs', async () => {
      const queue = new MicroQueue(db.sql, {
        maxJobRuntime: 100,
        maxAttempts: 1,
      })

      queue.register('slow-job', async () => {
        await new Promise(resolve => setTimeout(resolve, 500))
        return { success: true }
      })

      await queue.enqueue('slow-job', {})
      await queue.processOne()

      const stats = await queue.getStats()
      expect(stats.dead).toBe(1)

      const deadJobs = await queue.getDeadJobs()
      expect(deadJobs[0].last_error).toContain('exceeded max runtime')
    })
  })

  describe('statistics', () => {
    test('tracks job counts by status', async () => {
      const queue = new MicroQueue(db.sql)

      queue.register('success-job', async () => ({ success: true }))
      queue.register('fail-job', async () => ({ success: false, noRetry: true }))

      await queue.enqueue('success-job', {})
      await queue.enqueue('fail-job', {})
      await queue.enqueue('success-job', {}) // pending

      await queue.processOne() // success
      await queue.processOne() // dead

      const stats = await queue.getStats()
      expect(stats.completed).toBe(1)
      expect(stats.dead).toBe(1)
      expect(stats.pending).toBe(1)
    })
  })

  describe('dead job management', () => {
    test('can retrieve dead jobs', async () => {
      const queue = new MicroQueue(db.sql, { maxAttempts: 1 })

      queue.register('fail-job', async () => ({
        success: false,
        noRetry: true,
      }))

      await queue.enqueue('fail-job', { important: 'data' })
      await queue.processOne()

      const deadJobs = await queue.getDeadJobs()
      expect(deadJobs).toHaveLength(1)
      expect(deadJobs[0].payload).toEqual({ important: 'data' })
    })

    test('can resurrect dead jobs', async () => {
      const queue = new MicroQueue(db.sql, { maxAttempts: 1 })

      queue.register('fail-job', async () => ({
        success: false,
        noRetry: true,
      }))

      const job = await queue.enqueue('fail-job', { x: 1 })
      await queue.processOne()

      // Resurrect
      const resurrected = await queue.retryDeadJob(job.id)
      expect(resurrected).not.toBeNull()
      expect(resurrected!.status).toBe('pending')
      expect(resurrected!.attempt_count).toBe(0)
    })
  })

  describe('pruning', () => {
    test('prunes old completed jobs', async () => {
      const queue = new MicroQueue(db.sql)

      queue.register('test-job', async () => ({ success: true }))

      await queue.enqueue('test-job', {})
      await queue.processOne()

      // Manually backdate the completed_at
      await db.sql`
        UPDATE job_queue
        SET completed_at = NOW() - INTERVAL '1 day'
        WHERE status = 'completed'
      `

      // Prune jobs older than 1 hour
      const pruned = await queue.pruneCompleted(60 * 60 * 1000)
      expect(pruned).toBe(1)

      const stats = await queue.getStats()
      expect(stats.completed).toBe(0)
    })
  })

  describe('handler registration', () => {
    test('throws when registering duplicate handler', () => {
      const queue = new MicroQueue(db.sql)

      queue.register('test-job', async () => ({ success: true }))

      expect(() => {
        queue.register('test-job', async () => ({ success: true }))
      }).toThrow('Handler already registered')
    })

    test('can unregister handlers', () => {
      const queue = new MicroQueue(db.sql)

      queue.register('test-job', async () => ({ success: true }))
      const removed = queue.unregister('test-job')

      expect(removed).toBe(true)

      // Can register again
      queue.register('test-job', async () => ({ success: true }))
    })
  })
})

describe('JobQueueRepository', () => {
  let db: Database
  let repo: JobQueueRepository

  beforeAll(async () => {
    db = createDatabase({ connectionString: TEST_DB_URL })
    const migrationDir = new URL('../db/migrations', import.meta.url).pathname
    await migrate(db.sql, migrationDir)
    repo = createJobQueueRepository({ sql: db.sql })
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await db.sql`TRUNCATE job_queue`
  })

  describe('dequeue', () => {
    test('atomically locks job', async () => {
      await repo.enqueue('test', { x: 1 })

      const job1 = await repo.dequeue('worker-1', 30000)
      const job2 = await repo.dequeue('worker-2', 30000)

      expect(job1).not.toBeNull()
      expect(job2).toBeNull() // No other pending jobs
    })

    test('does not return jobs with future visible_at', async () => {
      await repo.enqueue('test', { x: 1 }, { delay: 60000 })

      const job = await repo.dequeue('worker-1', 30000)
      expect(job).toBeNull()
    })
  })

  describe('extendLock', () => {
    test('extends lock for owned job', async () => {
      await repo.enqueue('test', { x: 1 })
      const job = await repo.dequeue('worker-1', 30000)

      const extended = await repo.extendLock(job!.id, 'worker-1', 60000)
      expect(extended).not.toBeNull()

      const newLockUntil = new Date(extended!.locked_until!).getTime()
      expect(newLockUntil).toBeGreaterThan(Date.now() + 50000)
    })

    test('fails to extend lock for unowned job', async () => {
      await repo.enqueue('test', { x: 1 })
      const job = await repo.dequeue('worker-1', 30000)

      const extended = await repo.extendLock(job!.id, 'worker-2', 60000)
      expect(extended).toBeNull()
    })
  })

  describe('reclaimStale', () => {
    test('reclaims jobs with expired locks', async () => {
      await repo.enqueue('test', { x: 1 })
      const job = await repo.dequeue('worker-1', 100) // Very short lock

      // Wait for lock to expire
      await new Promise(resolve => setTimeout(resolve, 200))

      const reclaimed = await repo.reclaimStale()
      expect(reclaimed).toBe(1)

      // Job should be pending again
      const updated = await repo.findById(job!.id)
      expect(updated!.status).toBe('pending')
      expect(updated!.locked_by).toBeUndefined()
    })
  })
})
