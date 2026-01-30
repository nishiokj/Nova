/**
 * DerivedTaskIntegration Tests
 *
 * Comprehensive tests for Task Execution Policy implementation.
 * Tests replay policies, rate limiting, resource pools, and failure classification.
 *
 * Requires a running PostgreSQL instance.
 * Set TEST_DATABASE_URL environment variable to run these tests.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { createDatabase, migrate, type Database } from '../db/index.js'
import {
  createDerivedTaskRepository,
  createDerivedJobRepository,
  createResourcePoolRepository,
  type DerivedTask,
  type DerivedJob,
  type ReplayPolicy,
  type FailureClass,
} from '../db/repositories/index.js'
import { DerivedTaskIntegration, type PolicyCheckResult } from './integration.js'
import { generateCanonicalId } from '../ids.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL

// Skip tests if no database URL is provided
const describeWithDb = TEST_DB_URL ? describe : describe.skip

describeWithDb('DerivedTaskIntegration', () => {
  let db: Database
  let integration: DerivedTaskIntegration
  let taskRepo: ReturnType<typeof createDerivedTaskRepository>
  let jobRepo: ReturnType<typeof createDerivedJobRepository>
  let poolRepo: ReturnType<typeof createResourcePoolRepository>

  // Mock engine for scheduleTask
  const mockEngine = {
    scheduleDerivedJob: async () => {},
  }

  beforeAll(async () => {
    db = createDatabase({ connectionString: TEST_DB_URL! })
    await migrate(db)

    taskRepo = createDerivedTaskRepository({ sql: db.sql })
    jobRepo = createDerivedJobRepository({ sql: db.sql })
    poolRepo = createResourcePoolRepository({ sql: db.sql })
    integration = new DerivedTaskIntegration(db.sql)
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    // Clean up test data
    await db.sql`TRUNCATE derived_jobs CASCADE`
    await db.sql`TRUNCATE derived_tasks CASCADE`
    await db.sql`TRUNCATE resource_pools CASCADE`
  })

  // Helper to create a task with specific policy
  async function createTaskWithPolicy(overrides: Partial<{
    name: string
    replayPolicy: ReplayPolicy
    cooldownMs: number
    rateLimitMax: number
    rateLimitWindowMs: number
    resourcePool: string
  }> = {}): Promise<DerivedTask> {
    return taskRepo.create({
      name: overrides.name ?? `test-task-${generateCanonicalId()}`,
      scriptPath: 'scripts/test.ts',
      mode: 'once',
      replayPolicy: overrides.replayPolicy,
      cooldownMs: overrides.cooldownMs,
      rateLimitMax: overrides.rateLimitMax,
      rateLimitWindowMs: overrides.rateLimitWindowMs,
      resourcePool: overrides.resourcePool,
    })
  }

  // Helper to create a completed job
  async function createCompletedJob(taskId: string, completedAt?: Date): Promise<DerivedJob> {
    const job = await jobRepo.create({ task_id: taskId })
    await jobRepo.start(job.id)
    await jobRepo.complete(job.id)
    if (completedAt) {
      await db.sql`UPDATE derived_jobs SET completed_at = ${completedAt} WHERE id = ${job.id}`
    }
    return (await jobRepo.findById(job.id))!
  }

  // Helper to create a failed job
  async function createFailedJob(taskId: string): Promise<DerivedJob> {
    const job = await jobRepo.create({ task_id: taskId })
    await jobRepo.start(job.id)
    await jobRepo.fail(job.id, 'Test failure')
    return (await jobRepo.findById(job.id))!
  }

  // Helper to create a pending job
  async function createPendingJob(taskId: string): Promise<DerivedJob> {
    return jobRepo.create({ task_id: taskId })
  }

  // Helper to create a running job
  async function createRunningJob(taskId: string): Promise<DerivedJob> {
    const job = await jobRepo.create({ task_id: taskId })
    await jobRepo.start(job.id)
    return (await jobRepo.findById(job.id))!
  }

  describe('Replay Policy: always', () => {
    test('allows execution with no prior jobs', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'always' })
      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('allows execution after completed job', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'always' })
      await createCompletedJob(task.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('allows execution after failed job', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'always' })
      await createFailedJob(task.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('allows execution after multiple completed jobs', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'always' })
      await createCompletedJob(task.id)
      await createCompletedJob(task.id)
      await createCompletedJob(task.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })
  })

  describe('Replay Policy: once', () => {
    test('allows first execution', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'once' })
      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('blocks after successful completion', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'once' })
      await createCompletedJob(task.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('already completed successfully')
      expect(result.reason).toContain('replay_policy=once')
    })

    test('allows execution after only failed jobs (never completed)', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'once' })
      await createFailedJob(task.id)
      await createFailedJob(task.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('blocks even if last job failed (if any completed exists)', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'once' })
      await createCompletedJob(task.id)
      await createFailedJob(task.id) // More recent but doesn't matter

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(false)
    })
  })

  describe('Replay Policy: on_failure', () => {
    test('allows first execution', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'on_failure' })
      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('blocks after successful completion with no subsequent failures', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'on_failure' })
      await createCompletedJob(task.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Last execution succeeded')
    })

    test('allows execution after most recent job failed', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'on_failure' })
      await createCompletedJob(task.id)
      // Small delay to ensure order
      await new Promise(r => setTimeout(r, 10))
      await createFailedJob(task.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('blocks if completed job is more recent than failed job', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'on_failure' })
      await createFailedJob(task.id)
      await new Promise(r => setTimeout(r, 10))
      await createCompletedJob(task.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(false)
    })

    test('allows after multiple failures (no completion)', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'on_failure' })
      await createFailedJob(task.id)
      await createFailedJob(task.id)
      await createFailedJob(task.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })
  })

  describe('Replay Policy: cooldown', () => {
    test('allows first execution', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'cooldown', cooldownMs: 60000 })
      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('allows execution if cooldown has elapsed', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'cooldown', cooldownMs: 1000 })
      // Create job completed 2 seconds ago
      const twoSecondsAgo = new Date(Date.now() - 2000)
      await createCompletedJob(task.id, twoSecondsAgo)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('blocks execution within cooldown period', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'cooldown', cooldownMs: 60000 })
      await createCompletedJob(task.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Cooldown period not elapsed')
      expect(result.reason).toContain('60000ms')
      expect(result.retryAfter).toBeDefined()
      expect(result.retryAfter).toBeGreaterThan(0)
      expect(result.retryAfter).toBeLessThanOrEqual(60000)
    })

    test('calculates correct retryAfter time', async () => {
      const cooldownMs = 10000
      const task = await createTaskWithPolicy({ replayPolicy: 'cooldown', cooldownMs })
      const fiveSecondsAgo = new Date(Date.now() - 5000)
      await createCompletedJob(task.id, fiveSecondsAgo)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(false)
      // Should be roughly 5 seconds remaining (with some tolerance for test execution time)
      expect(result.retryAfter).toBeGreaterThan(4000)
      expect(result.retryAfter).toBeLessThan(6000)
    })

    test('allows immediately if cooldown_ms is null', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'cooldown' }) // No cooldownMs
      await createCompletedJob(task.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('allows immediately if cooldown_ms is 0', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'cooldown', cooldownMs: 0 })
      await createCompletedJob(task.id)

      // Note: cooldownMs of 0 means null in the DB
      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('does not consider failed jobs for cooldown', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'cooldown', cooldownMs: 60000 })
      await createFailedJob(task.id) // Not completed

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })
  })

  describe('Rate Limiting', () => {
    test('allows execution when no rate limit configured', async () => {
      const task = await createTaskWithPolicy({})
      const result = await integration.checkRateLimit(task)
      expect(result.allowed).toBe(true)
    })

    test('allows execution under rate limit', async () => {
      const task = await createTaskWithPolicy({ rateLimitMax: 5, rateLimitWindowMs: 60000 })
      // Create 3 jobs
      await createPendingJob(task.id)
      await createPendingJob(task.id)
      await createPendingJob(task.id)

      const result = await integration.checkRateLimit(task)
      expect(result.allowed).toBe(true)
    })

    test('blocks at rate limit', async () => {
      const task = await createTaskWithPolicy({ rateLimitMax: 3, rateLimitWindowMs: 60000 })
      await createPendingJob(task.id)
      await createPendingJob(task.id)
      await createPendingJob(task.id)

      const result = await integration.checkRateLimit(task)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Rate limit exceeded')
      expect(result.reason).toContain('3/3')
    })

    test('blocks when over rate limit', async () => {
      const task = await createTaskWithPolicy({ rateLimitMax: 2, rateLimitWindowMs: 60000 })
      await createPendingJob(task.id)
      await createPendingJob(task.id)
      await createPendingJob(task.id)

      const result = await integration.checkRateLimit(task)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('3/2')
    })

    test('provides retryAfter when rate limited', async () => {
      const task = await createTaskWithPolicy({ rateLimitMax: 1, rateLimitWindowMs: 10000 })
      await createPendingJob(task.id)

      const result = await integration.checkRateLimit(task)
      expect(result.allowed).toBe(false)
      expect(result.retryAfter).toBeDefined()
      expect(result.retryAfter).toBeGreaterThan(0)
      expect(result.retryAfter).toBeLessThanOrEqual(10000)
    })

    test('allows execution when jobs are outside window', async () => {
      const task = await createTaskWithPolicy({ rateLimitMax: 2, rateLimitWindowMs: 1000 })

      // Create job 2 seconds ago
      const job = await createPendingJob(task.id)
      await db.sql`UPDATE derived_jobs SET created_at = NOW() - INTERVAL '2 seconds' WHERE id = ${job.id}`

      const result = await integration.checkRateLimit(task)
      expect(result.allowed).toBe(true)
    })

    test('handles sliding window correctly', async () => {
      const task = await createTaskWithPolicy({ rateLimitMax: 2, rateLimitWindowMs: 5000 })

      // Job 1: 3 seconds ago
      const job1 = await createPendingJob(task.id)
      await db.sql`UPDATE derived_jobs SET created_at = NOW() - INTERVAL '3 seconds' WHERE id = ${job1.id}`

      // Job 2: 1 second ago
      const job2 = await createPendingJob(task.id)
      await db.sql`UPDATE derived_jobs SET created_at = NOW() - INTERVAL '1 second' WHERE id = ${job2.id}`

      // At limit
      const result = await integration.checkRateLimit(task)
      expect(result.allowed).toBe(false)

      // retryAfter should be ~2 seconds (when job1 leaves window)
      expect(result.retryAfter).toBeGreaterThan(1000)
      expect(result.retryAfter).toBeLessThan(3000)
    })

    test('ensures minimum 1 second retryAfter', async () => {
      // Use a longer window to avoid timing flakiness
      const task = await createTaskWithPolicy({ rateLimitMax: 1, rateLimitWindowMs: 60000 })
      // Create job 59.5 seconds ago (within 60 second window but near end)
      const job = await createPendingJob(task.id)
      await db.sql`UPDATE derived_jobs SET created_at = NOW() - INTERVAL '59500 milliseconds' WHERE id = ${job.id}`

      const result = await integration.checkRateLimit(task)
      expect(result.allowed).toBe(false)
      // retryAfter should be close to 500ms (when job leaves window), but minimum is 1000ms
      expect(result.retryAfter).toBeGreaterThanOrEqual(1000)
    })

    test('allows execution when only rate_limit_max is set (no window)', async () => {
      const task = await createTaskWithPolicy({ rateLimitMax: 5 }) // No window
      await createPendingJob(task.id)
      await createPendingJob(task.id)

      const result = await integration.checkRateLimit(task)
      expect(result.allowed).toBe(true)
    })

    test('allows execution when only rate_limit_window_ms is set (no max)', async () => {
      const task = await createTaskWithPolicy({ rateLimitWindowMs: 60000 }) // No max
      await createPendingJob(task.id)
      await createPendingJob(task.id)

      const result = await integration.checkRateLimit(task)
      expect(result.allowed).toBe(true)
    })
  })

  describe('Resource Pool', () => {
    test('allows execution when no pool configured', async () => {
      const task = await createTaskWithPolicy({})
      const result = await integration.checkResourcePool(task)
      expect(result.allowed).toBe(true)
    })

    test('allows execution when pool not found (with warning)', async () => {
      const task = await createTaskWithPolicy({ resourcePool: 'nonexistent-pool' })
      const result = await integration.checkResourcePool(task)
      expect(result.allowed).toBe(true)
    })

    test('allows execution when under concurrent limit', async () => {
      const pool = await poolRepo.create({ name: 'test-pool', maxConcurrent: 5 })
      const task = await createTaskWithPolicy({ resourcePool: pool.name })

      // Create 3 running jobs (under limit of 5)
      await createRunningJob(task.id)
      await createRunningJob(task.id)
      await createRunningJob(task.id)

      const result = await integration.checkResourcePool(task)
      expect(result.allowed).toBe(true)
    })

    test('blocks at concurrent limit', async () => {
      const pool = await poolRepo.create({ name: 'test-pool-2', maxConcurrent: 2 })
      const task = await createTaskWithPolicy({ resourcePool: pool.name })

      await createRunningJob(task.id)
      await createRunningJob(task.id)

      const result = await integration.checkResourcePool(task)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Concurrent limit reached')
      expect(result.reason).toContain('2/2')
      expect(result.retryAfter).toBe(5000)
    })

    test('blocks when over budget', async () => {
      const pool = await poolRepo.create({
        name: 'budget-pool',
        maxConcurrent: 10,
        dailyBudgetCents: 1000,
      })
      // Spend the entire budget
      await poolRepo.addSpend(pool.id, 1000)

      const task = await createTaskWithPolicy({ resourcePool: pool.name })
      const result = await integration.checkResourcePool(task)

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Daily budget exhausted')
      expect(result.reason).toContain('1000/1000')
    })

    test('auto-resets budget when reset time passes', async () => {
      const pool = await poolRepo.create({
        name: 'reset-pool',
        maxConcurrent: 10,
        dailyBudgetCents: 1000,
      })
      await poolRepo.addSpend(pool.id, 1000)

      // Set reset time to past
      await db.sql`UPDATE resource_pools SET budget_reset_at = NOW() - INTERVAL '1 hour' WHERE id = ${pool.id}`

      const task = await createTaskWithPolicy({ resourcePool: pool.name })
      const result = await integration.checkResourcePool(task)

      expect(result.allowed).toBe(true)

      // Verify budget was reset
      const updatedPool = await poolRepo.findById(pool.id)
      expect(updatedPool?.current_spend_cents).toBe(0)
    })

    test('counts only running jobs for concurrent limit', async () => {
      const pool = await poolRepo.create({ name: 'status-pool', maxConcurrent: 2 })
      const task = await createTaskWithPolicy({ resourcePool: pool.name })

      // Various job statuses
      await createPendingJob(task.id)
      await createCompletedJob(task.id)
      await createFailedJob(task.id)
      await createRunningJob(task.id) // Only this counts

      const result = await integration.checkResourcePool(task)
      expect(result.allowed).toBe(true)
    })
  })

  describe('Combined Policy Checks', () => {
    test('checkAllPolicies checks replay first', async () => {
      const pool = await poolRepo.create({ name: 'all-pool', maxConcurrent: 10 })
      const task = await createTaskWithPolicy({
        replayPolicy: 'once',
        rateLimitMax: 100,
        rateLimitWindowMs: 60000,
        resourcePool: pool.name,
      })
      await createCompletedJob(task.id)

      const result = await integration.checkAllPolicies(task)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('replay_policy=once')
    })

    test('checkAllPolicies checks rate limit after replay passes', async () => {
      const pool = await poolRepo.create({ name: 'all-pool-2', maxConcurrent: 10 })
      const task = await createTaskWithPolicy({
        replayPolicy: 'always',
        rateLimitMax: 1,
        rateLimitWindowMs: 60000,
        resourcePool: pool.name,
      })
      await createPendingJob(task.id)

      const result = await integration.checkAllPolicies(task)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Rate limit exceeded')
    })

    test('checkAllPolicies checks resource pool last', async () => {
      const pool = await poolRepo.create({ name: 'all-pool-3', maxConcurrent: 1 })
      const task = await createTaskWithPolicy({
        replayPolicy: 'always',
        resourcePool: pool.name,
      })
      await createRunningJob(task.id)

      const result = await integration.checkAllPolicies(task)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Concurrent limit')
    })

    test('checkAllPolicies allows when all pass', async () => {
      const pool = await poolRepo.create({ name: 'all-pass-pool', maxConcurrent: 10 })
      const task = await createTaskWithPolicy({
        replayPolicy: 'always',
        rateLimitMax: 10,
        rateLimitWindowMs: 60000,
        resourcePool: pool.name,
      })

      const result = await integration.checkAllPolicies(task)
      expect(result.allowed).toBe(true)
    })
  })

  describe('scheduleTask', () => {
    test('schedules task when all policies pass', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'always' })

      const result = await integration.scheduleTask(mockEngine, task)
      expect(DerivedTaskIntegration.isBlocked(result)).toBe(false)

      const job = result as DerivedJob
      expect(job.id).toBeDefined()
      expect(job.task_id).toBe(task.id)
      expect(job.status).toBe('pending')
    })

    test('returns PolicyCheckResult when blocked', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'once' })
      await createCompletedJob(task.id)

      const result = await integration.scheduleTask(mockEngine, task)
      expect(DerivedTaskIntegration.isBlocked(result)).toBe(true)

      const blocked = result as PolicyCheckResult
      expect(blocked.allowed).toBe(false)
      expect(blocked.reason).toContain('replay_policy=once')
    })

    test('force flag bypasses all policies', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'once' })
      await createCompletedJob(task.id)

      const result = await integration.scheduleTask(mockEngine, task, { force: true })
      expect(DerivedTaskIntegration.isBlocked(result)).toBe(false)

      const job = result as DerivedJob
      expect(job.id).toBeDefined()
    })

    test('returns existing pending job instead of creating new one', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'always' })
      const existingJob = await createPendingJob(task.id)

      const result = await integration.scheduleTask(mockEngine, task)
      expect(DerivedTaskIntegration.isBlocked(result)).toBe(false)

      const job = result as DerivedJob
      expect(job.id).toBe(existingJob.id)
    })

    test('returns existing running job instead of creating new one', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'always' })
      const existingJob = await createRunningJob(task.id)

      const result = await integration.scheduleTask(mockEngine, task)
      expect(DerivedTaskIntegration.isBlocked(result)).toBe(false)

      const job = result as DerivedJob
      expect(job.id).toBe(existingJob.id)
    })

    test('creates new job if existing jobs are completed/failed', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'always' })
      const completedJob = await createCompletedJob(task.id)
      const failedJob = await createFailedJob(task.id)

      const result = await integration.scheduleTask(mockEngine, task)
      expect(DerivedTaskIntegration.isBlocked(result)).toBe(false)

      const job = result as DerivedJob
      expect(job.id).not.toBe(completedJob.id)
      expect(job.id).not.toBe(failedJob.id)
    })

    test('passes priority to created job', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'always' })

      const result = await integration.scheduleTask(mockEngine, task, { priority: 10 })
      expect(DerivedTaskIntegration.isBlocked(result)).toBe(false)

      const job = result as DerivedJob
      expect(job.priority).toBe(10)
    })

    test('passes metadata to created job', async () => {
      const task = await createTaskWithPolicy({ replayPolicy: 'always' })
      const metadata = { foo: 'bar', baz: 123 }

      const result = await integration.scheduleTask(mockEngine, task, { metadata })
      expect(DerivedTaskIntegration.isBlocked(result)).toBe(false)

      const job = result as DerivedJob
      expect(job.metadata).toEqual(metadata)
    })
  })

  describe('isBlocked type guard', () => {
    test('returns true for PolicyCheckResult with allowed=false', () => {
      const blocked: PolicyCheckResult = { allowed: false, reason: 'test' }
      expect(DerivedTaskIntegration.isBlocked(blocked)).toBe(true)
    })

    test('returns false for PolicyCheckResult with allowed=true', () => {
      const allowed: PolicyCheckResult = { allowed: true }
      expect(DerivedTaskIntegration.isBlocked(allowed)).toBe(false)
    })

    test('returns false for DerivedJob', () => {
      const job: DerivedJob = {
        id: 'test',
        task_id: 'task',
        status: 'pending',
        priority: 0,
        created_at: new Date().toISOString(),
        retry_count: 0,
      }
      expect(DerivedTaskIntegration.isBlocked(job)).toBe(false)
    })
  })
})

describeWithDb('DerivedJobRepository - Policy Methods', () => {
  let db: Database
  let jobRepo: ReturnType<typeof createDerivedJobRepository>
  let taskRepo: ReturnType<typeof createDerivedTaskRepository>

  beforeAll(async () => {
    db = createDatabase({ connectionString: TEST_DB_URL! })
    await migrate(db)

    jobRepo = createDerivedJobRepository({ sql: db.sql })
    taskRepo = createDerivedTaskRepository({ sql: db.sql })
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await db.sql`TRUNCATE derived_jobs CASCADE`
    await db.sql`TRUNCATE derived_tasks CASCADE`
  })

  async function createTask(): Promise<DerivedTask> {
    return taskRepo.create({
      name: `test-task-${generateCanonicalId()}`,
      scriptPath: 'scripts/test.ts',
      mode: 'once',
    })
  }

  describe('findLastCompleted', () => {
    test('returns null when no jobs exist', async () => {
      const task = await createTask()
      const result = await jobRepo.findLastCompleted(task.id)
      expect(result).toBeNull()
    })

    test('returns null when no completed jobs exist', async () => {
      const task = await createTask()
      await jobRepo.create({ task_id: task.id })
      const job = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(job.id)
      await jobRepo.fail(job.id, 'error')

      const result = await jobRepo.findLastCompleted(task.id)
      expect(result).toBeNull()
    })

    test('returns most recently completed job', async () => {
      const task = await createTask()

      // First completed
      const job1 = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(job1.id)
      await jobRepo.complete(job1.id)

      await new Promise(r => setTimeout(r, 10))

      // Second completed (more recent)
      const job2 = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(job2.id)
      await jobRepo.complete(job2.id)

      const result = await jobRepo.findLastCompleted(task.id)
      expect(result?.id).toBe(job2.id)
    })

    test('ignores failed jobs when finding last completed', async () => {
      const task = await createTask()

      const job1 = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(job1.id)
      await jobRepo.complete(job1.id)

      await new Promise(r => setTimeout(r, 10))

      const job2 = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(job2.id)
      await jobRepo.fail(job2.id, 'error')

      const result = await jobRepo.findLastCompleted(task.id)
      expect(result?.id).toBe(job1.id)
    })
  })

  describe('countSince', () => {
    test('returns 0 when no jobs exist', async () => {
      const task = await createTask()
      const count = await jobRepo.countSince(task.id, new Date(Date.now() - 60000))
      expect(count).toBe(0)
    })

    test('counts jobs created after given date', async () => {
      const task = await createTask()

      await jobRepo.create({ task_id: task.id })
      await jobRepo.create({ task_id: task.id })
      await jobRepo.create({ task_id: task.id })

      const count = await jobRepo.countSince(task.id, new Date(Date.now() - 60000))
      expect(count).toBe(3)
    })

    test('excludes jobs created before given date', async () => {
      const task = await createTask()

      // Job 1: old
      const job1 = await jobRepo.create({ task_id: task.id })
      await db.sql`UPDATE derived_jobs SET created_at = NOW() - INTERVAL '2 hours' WHERE id = ${job1.id}`

      // Job 2: recent
      await jobRepo.create({ task_id: task.id })

      const count = await jobRepo.countSince(task.id, new Date(Date.now() - 60000))
      expect(count).toBe(1)
    })

    test('counts all job statuses', async () => {
      const task = await createTask()

      await jobRepo.create({ task_id: task.id }) // pending
      const running = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(running.id)
      const completed = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(completed.id)
      await jobRepo.complete(completed.id)
      const failed = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(failed.id)
      await jobRepo.fail(failed.id, 'error')

      const count = await jobRepo.countSince(task.id, new Date(Date.now() - 60000))
      expect(count).toBe(4)
    })
  })

  describe('findOldestInWindow', () => {
    test('returns null when no jobs in window', async () => {
      const task = await createTask()
      const result = await jobRepo.findOldestInWindow(task.id, new Date())
      expect(result).toBeNull()
    })

    test('returns oldest job in window', async () => {
      const task = await createTask()

      const job1 = await jobRepo.create({ task_id: task.id })
      await db.sql`UPDATE derived_jobs SET created_at = NOW() - INTERVAL '30 seconds' WHERE id = ${job1.id}`

      await new Promise(r => setTimeout(r, 10))

      const job2 = await jobRepo.create({ task_id: task.id })
      await db.sql`UPDATE derived_jobs SET created_at = NOW() - INTERVAL '15 seconds' WHERE id = ${job2.id}`

      const windowStart = new Date(Date.now() - 60000)
      const result = await jobRepo.findOldestInWindow(task.id, windowStart)
      expect(result?.id).toBe(job1.id)
    })

    test('excludes jobs outside window', async () => {
      const task = await createTask()

      // Old job (outside window)
      const job1 = await jobRepo.create({ task_id: task.id })
      await db.sql`UPDATE derived_jobs SET created_at = NOW() - INTERVAL '2 hours' WHERE id = ${job1.id}`

      // Recent job (inside window)
      const job2 = await jobRepo.create({ task_id: task.id })

      const windowStart = new Date(Date.now() - 60000)
      const result = await jobRepo.findOldestInWindow(task.id, windowStart)
      expect(result?.id).toBe(job2.id)
    })
  })

  describe('countRunningByPool', () => {
    test('returns 0 when no running jobs', async () => {
      const pool = await db.sql<{ id: string }[]>`
        INSERT INTO resource_pools (id, name, max_concurrent, current_spend_cents, created_at, updated_at)
        VALUES (${generateCanonicalId()}, ${'count-pool-1'}, 10, 0, NOW(), NOW())
        RETURNING id
      `
      const count = await jobRepo.countRunningByPool(pool[0].id)
      expect(count).toBe(0)
    })

    test('counts only running jobs in pool', async () => {
      const poolId = generateCanonicalId()
      await db.sql`
        INSERT INTO resource_pools (id, name, max_concurrent, current_spend_cents, created_at, updated_at)
        VALUES (${poolId}, ${'count-pool-2'}, 10, 0, NOW(), NOW())
      `

      // Task in pool
      const task = await taskRepo.create({
        name: `pool-task-${generateCanonicalId()}`,
        scriptPath: 'scripts/test.ts',
        mode: 'once',
        resourcePool: 'count-pool-2',
      })

      // Pending job (doesn't count)
      await jobRepo.create({ task_id: task.id })

      // Running jobs (count)
      const running1 = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(running1.id)
      const running2 = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(running2.id)

      // Completed job (doesn't count)
      const completed = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(completed.id)
      await jobRepo.complete(completed.id)

      const count = await jobRepo.countRunningByPool(poolId)
      expect(count).toBe(2)
    })
  })

  describe('failWithClass', () => {
    test('sets failure_class on job', async () => {
      const task = await createTask()
      const job = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(job.id)

      const result = await jobRepo.failWithClass(job.id, 'API error', 'transient')
      expect(result?.status).toBe('failed')
      expect(result?.failure_class).toBe('transient')
      expect(result?.last_error).toBe('API error')
    })

    test('sets retry_after when provided', async () => {
      const task = await createTask()
      const job = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(job.id)

      const retryAfter = Date.now() + 60000
      const result = await jobRepo.failWithClass(job.id, 'Rate limited', 'rate_limited', retryAfter)

      expect(result?.failure_class).toBe('rate_limited')
      expect(result?.retry_after).toBe(retryAfter)
    })

    test('handles all failure classes', async () => {
      const task = await createTask()
      const failureClasses: FailureClass[] = ['transient', 'rate_limited', 'resource', 'permanent', 'unknown']

      for (const fc of failureClasses) {
        const job = await jobRepo.create({ task_id: task.id })
        await jobRepo.start(job.id)
        const result = await jobRepo.failWithClass(job.id, `Error: ${fc}`, fc)
        expect(result?.failure_class).toBe(fc)
      }
    })
  })

  describe('recordCost', () => {
    test('records cost on job', async () => {
      const task = await createTask()
      const job = await jobRepo.create({ task_id: task.id })

      const result = await jobRepo.recordCost(job.id, 100)
      expect(result?.cost_cents).toBe(100)
    })

    test('accumulates cost on multiple calls', async () => {
      const task = await createTask()
      const job = await jobRepo.create({ task_id: task.id })

      await jobRepo.recordCost(job.id, 50)
      await jobRepo.recordCost(job.id, 75)
      const result = await jobRepo.recordCost(job.id, 25)

      expect(result?.cost_cents).toBe(150)
    })

    test('starts from 0 when no prior cost', async () => {
      const task = await createTask()
      const job = await jobRepo.create({ task_id: task.id })

      const result = await jobRepo.recordCost(job.id, 1)
      expect(result?.cost_cents).toBe(1)
    })
  })
})

describeWithDb('DerivedTaskRepository - Policy Methods', () => {
  let db: Database
  let taskRepo: ReturnType<typeof createDerivedTaskRepository>

  beforeAll(async () => {
    db = createDatabase({ connectionString: TEST_DB_URL! })
    await migrate(db)

    taskRepo = createDerivedTaskRepository({ sql: db.sql })
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await db.sql`TRUNCATE derived_tasks CASCADE`
  })

  describe('create with policy fields', () => {
    test('creates task with default policy values', async () => {
      const task = await taskRepo.create({
        name: 'default-policy',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })

      expect(task.replay_policy).toBe('always')
      expect(task.idempotent).toBe(true)
      expect(task.cooldown_ms).toBeNull()
      expect(task.timeout_ms).toBe(30000)
      expect(task.heartbeat_interval_ms).toBeNull()
      expect(task.rate_limit_max).toBeNull()
      expect(task.rate_limit_window_ms).toBeNull()
      expect(task.resource_pool).toBeNull()
    })

    test('creates task with custom policy values', async () => {
      const task = await taskRepo.create({
        name: 'custom-policy',
        scriptPath: 'scripts/test.ts',
        mode: 'recurring',
        intervalMs: 60000,
        replayPolicy: 'cooldown',
        idempotent: false,
        cooldownMs: 5000,
        timeoutMs: 120000,
        heartbeatIntervalMs: 10000,
        rateLimitMax: 100,
        rateLimitWindowMs: 3600000,
        resourcePool: 'api-pool',
      })

      expect(task.replay_policy).toBe('cooldown')
      expect(task.idempotent).toBe(false)
      expect(task.cooldown_ms).toBe(5000)
      expect(task.timeout_ms).toBe(120000)
      expect(task.heartbeat_interval_ms).toBe(10000)
      expect(task.rate_limit_max).toBe(100)
      expect(task.rate_limit_window_ms).toBe(3600000)
      expect(task.resource_pool).toBe('api-pool')
    })

    test('creates task with each replay policy', async () => {
      const policies: ReplayPolicy[] = ['always', 'on_failure', 'once', 'cooldown']

      for (const policy of policies) {
        const task = await taskRepo.create({
          name: `policy-${policy}`,
          scriptPath: 'scripts/test.ts',
          mode: 'once',
          replayPolicy: policy,
        })
        expect(task.replay_policy).toBe(policy)
      }
    })
  })

  describe('update policy fields', () => {
    test('updates replay_policy', async () => {
      const task = await taskRepo.create({
        name: 'update-replay',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })

      const updated = await taskRepo.update(task.id, { replay_policy: 'once' })
      expect(updated?.replay_policy).toBe('once')
    })

    test('updates cooldown_ms', async () => {
      const task = await taskRepo.create({
        name: 'update-cooldown',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })

      const updated = await taskRepo.update(task.id, { cooldown_ms: 30000 })
      expect(updated?.cooldown_ms).toBe(30000)
    })

    test('updates rate limiting fields', async () => {
      const task = await taskRepo.create({
        name: 'update-rate',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })

      const updated = await taskRepo.update(task.id, {
        rate_limit_max: 50,
        rate_limit_window_ms: 60000,
      })
      expect(updated?.rate_limit_max).toBe(50)
      expect(updated?.rate_limit_window_ms).toBe(60000)
    })

    test('clears resource_pool with null', async () => {
      const task = await taskRepo.create({
        name: 'clear-pool',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
        resourcePool: 'my-pool',
      })
      expect(task.resource_pool).toBe('my-pool')

      const updated = await taskRepo.update(task.id, { resource_pool: null })
      expect(updated?.resource_pool).toBeNull()
    })
  })

  describe('recordFailure with openCircuit', () => {
    test('opens circuit immediately when openCircuit=true', async () => {
      const task = await taskRepo.create({
        name: 'immediate-circuit',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })

      const updated = await taskRepo.recordFailure(task.id, 'Permanent failure', { openCircuit: true })

      expect(updated?.consecutive_failures).toBe(1)
      expect(updated?.last_error).toBe('Permanent failure')
      expect(updated?.circuit_open_until).not.toBeNull()

      // Circuit should be open for 24 hours
      const circuitOpenUntil = new Date(updated!.circuit_open_until!).getTime()
      const expectedMinTime = Date.now() + 23 * 60 * 60 * 1000 // At least 23 hours from now
      expect(circuitOpenUntil).toBeGreaterThan(expectedMinTime)
    })

    test('does not open circuit immediately without openCircuit flag', async () => {
      const task = await taskRepo.create({
        name: 'normal-failure',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })

      const updated = await taskRepo.recordFailure(task.id, 'Transient failure')

      expect(updated?.consecutive_failures).toBe(1)
      expect(updated?.circuit_open_until).toBeNull()
    })

    test('opens circuit after max_failures reached', async () => {
      const task = await taskRepo.create({
        name: 'threshold-circuit',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })
      // max_failures defaults to 3

      await taskRepo.recordFailure(task.id, 'Failure 1')
      await taskRepo.recordFailure(task.id, 'Failure 2')
      const third = await taskRepo.recordFailure(task.id, 'Failure 3')

      expect(third?.consecutive_failures).toBe(3)
      expect(third?.circuit_open_until).not.toBeNull()
    })
  })

  describe('pause', () => {
    test('disables task and sets error', async () => {
      const task = await taskRepo.create({
        name: 'pause-test',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })
      expect(task.enabled).toBe(true)

      const paused = await taskRepo.pause(task.id, 'Resource exhaustion: Out of memory')

      expect(paused?.enabled).toBe(false)
      expect(paused?.last_error).toBe('Resource exhaustion: Out of memory')
    })
  })
})

describeWithDb('ResourcePoolRepository', () => {
  let db: Database
  let poolRepo: ReturnType<typeof createResourcePoolRepository>

  beforeAll(async () => {
    db = createDatabase({ connectionString: TEST_DB_URL! })
    await migrate(db)

    poolRepo = createResourcePoolRepository({ sql: db.sql })
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await db.sql`TRUNCATE resource_pools CASCADE`
  })

  describe('create', () => {
    test('creates pool with default values', async () => {
      const pool = await poolRepo.create({ name: 'default-pool' })

      expect(pool.id).toBeDefined()
      expect(pool.name).toBe('default-pool')
      expect(pool.max_concurrent).toBe(10)
      expect(pool.requests_per_minute).toBeNull()
      expect(pool.daily_budget_cents).toBeNull()
      expect(pool.current_spend_cents).toBe(0)
    })

    test('creates pool with custom values', async () => {
      const pool = await poolRepo.create({
        name: 'custom-pool',
        maxConcurrent: 5,
        requestsPerMinute: 60,
        dailyBudgetCents: 10000,
      })

      expect(pool.max_concurrent).toBe(5)
      expect(pool.requests_per_minute).toBe(60)
      expect(pool.daily_budget_cents).toBe(10000)
    })
  })

  describe('findByName', () => {
    test('returns null when not found', async () => {
      const pool = await poolRepo.findByName('nonexistent')
      expect(pool).toBeNull()
    })

    test('returns pool when found', async () => {
      await poolRepo.create({ name: 'find-me' })
      const pool = await poolRepo.findByName('find-me')
      expect(pool?.name).toBe('find-me')
    })
  })

  describe('addSpend', () => {
    test('adds to current spend', async () => {
      const pool = await poolRepo.create({ name: 'spend-pool' })

      await poolRepo.addSpend(pool.id, 100)
      let updated = await poolRepo.findById(pool.id)
      expect(updated?.current_spend_cents).toBe(100)

      await poolRepo.addSpend(pool.id, 50)
      updated = await poolRepo.findById(pool.id)
      expect(updated?.current_spend_cents).toBe(150)
    })
  })

  describe('resetBudget', () => {
    test('resets spend and sets next reset time', async () => {
      const pool = await poolRepo.create({ name: 'reset-pool' })
      await poolRepo.addSpend(pool.id, 500)

      const reset = await poolRepo.resetBudget(pool.id)

      expect(reset?.current_spend_cents).toBe(0)
      expect(reset?.budget_reset_at).not.toBeNull()

      // Reset should be tomorrow at midnight
      const resetAt = new Date(reset!.budget_reset_at!)
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      tomorrow.setHours(0, 0, 0, 0)

      expect(resetAt.getDate()).toBe(tomorrow.getDate())
    })
  })

  describe('canAcquire', () => {
    test('returns false when pool not found', async () => {
      const result = await poolRepo.canAcquire('nonexistent', 0)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('not found')
    })

    test('returns true when under concurrent limit', async () => {
      const pool = await poolRepo.create({ name: 'concurrent-pool', maxConcurrent: 5 })
      const result = await poolRepo.canAcquire(pool.id, 3)
      expect(result.allowed).toBe(true)
    })

    test('returns false when at concurrent limit', async () => {
      const pool = await poolRepo.create({ name: 'at-limit-pool', maxConcurrent: 5 })
      const result = await poolRepo.canAcquire(pool.id, 5)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Concurrent limit reached')
      expect(result.retryAfter).toBe(5000)
    })

    test('returns false when over concurrent limit', async () => {
      const pool = await poolRepo.create({ name: 'over-limit-pool', maxConcurrent: 5 })
      const result = await poolRepo.canAcquire(pool.id, 10)
      expect(result.allowed).toBe(false)
    })

    test('returns true when no budget set', async () => {
      const pool = await poolRepo.create({ name: 'no-budget-pool', maxConcurrent: 10 })
      await poolRepo.addSpend(pool.id, 999999)

      const result = await poolRepo.canAcquire(pool.id, 0)
      expect(result.allowed).toBe(true)
    })

    test('returns true when under budget', async () => {
      const pool = await poolRepo.create({
        name: 'under-budget-pool',
        maxConcurrent: 10,
        dailyBudgetCents: 1000,
      })
      await poolRepo.addSpend(pool.id, 500)

      const result = await poolRepo.canAcquire(pool.id, 0)
      expect(result.allowed).toBe(true)
    })

    test('returns false when at budget', async () => {
      const pool = await poolRepo.create({
        name: 'at-budget-pool',
        maxConcurrent: 10,
        dailyBudgetCents: 1000,
      })
      await poolRepo.addSpend(pool.id, 1000)

      const result = await poolRepo.canAcquire(pool.id, 0)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Daily budget exhausted')
    })

    test('returns false when over budget', async () => {
      const pool = await poolRepo.create({
        name: 'over-budget-pool',
        maxConcurrent: 10,
        dailyBudgetCents: 1000,
      })
      await poolRepo.addSpend(pool.id, 1500)

      const result = await poolRepo.canAcquire(pool.id, 0)
      expect(result.allowed).toBe(false)
    })

    test('auto-resets budget when past reset time', async () => {
      const pool = await poolRepo.create({
        name: 'auto-reset-pool',
        maxConcurrent: 10,
        dailyBudgetCents: 1000,
      })
      await poolRepo.addSpend(pool.id, 1000)

      // Set reset time to past
      await db.sql`UPDATE resource_pools SET budget_reset_at = NOW() - INTERVAL '1 minute' WHERE id = ${pool.id}`

      const result = await poolRepo.canAcquire(pool.id, 0)
      expect(result.allowed).toBe(true)

      // Verify budget was reset
      const updated = await poolRepo.findById(pool.id)
      expect(updated?.current_spend_cents).toBe(0)
    })

    test('provides retryAfter when budget exhausted with reset time', async () => {
      const pool = await poolRepo.create({
        name: 'retry-budget-pool',
        maxConcurrent: 10,
        dailyBudgetCents: 1000,
      })
      await poolRepo.addSpend(pool.id, 1000)
      await poolRepo.resetBudget(pool.id)
      // This set budget_reset_at to tomorrow, so now spend again
      await poolRepo.addSpend(pool.id, 1000)

      const result = await poolRepo.canAcquire(pool.id, 0)
      expect(result.allowed).toBe(false)
      expect(result.retryAfter).toBeDefined()
      expect(result.retryAfter).toBeGreaterThan(0)
    })
  })
})

describeWithDb('Edge Cases and Error States', () => {
  let db: Database
  let integration: DerivedTaskIntegration
  let taskRepo: ReturnType<typeof createDerivedTaskRepository>
  let jobRepo: ReturnType<typeof createDerivedJobRepository>

  const mockEngine = {
    scheduleDerivedJob: async () => {},
  }

  beforeAll(async () => {
    db = createDatabase({ connectionString: TEST_DB_URL! })
    await migrate(db)

    taskRepo = createDerivedTaskRepository({ sql: db.sql })
    jobRepo = createDerivedJobRepository({ sql: db.sql })
    integration = new DerivedTaskIntegration(db.sql)
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await db.sql`TRUNCATE derived_jobs CASCADE`
    await db.sql`TRUNCATE derived_tasks CASCADE`
    await db.sql`TRUNCATE resource_pools CASCADE`
  })

  describe('Concurrent job edge cases', () => {
    test('handles cancelled jobs correctly (not pending/running)', async () => {
      const task = await taskRepo.create({
        name: 'cancelled-job-test',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })

      // Create and cancel a job
      const job = await jobRepo.create({ task_id: task.id })
      await jobRepo.cancel(job.id)

      // Should create new job since cancelled doesn't block
      const result = await integration.scheduleTask(mockEngine, task)
      expect(DerivedTaskIntegration.isBlocked(result)).toBe(false)
      expect((result as DerivedJob).id).not.toBe(job.id)
    })

    test('finds pending job among many completed/failed', async () => {
      const task = await taskRepo.create({
        name: 'find-pending-test',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
        replayPolicy: 'always',
      })

      // Many completed jobs
      for (let i = 0; i < 10; i++) {
        const job = await jobRepo.create({ task_id: task.id })
        await jobRepo.start(job.id)
        await jobRepo.complete(job.id)
      }

      // One pending job
      const pendingJob = await jobRepo.create({ task_id: task.id })

      const result = await integration.scheduleTask(mockEngine, task)
      expect((result as DerivedJob).id).toBe(pendingJob.id)
    })
  })

  describe('Policy interaction edge cases', () => {
    test('cooldown with very short window (1ms)', async () => {
      const task = await taskRepo.create({
        name: 'tiny-cooldown',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
        replayPolicy: 'cooldown',
        cooldownMs: 1,
      })

      const job = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(job.id)
      await jobRepo.complete(job.id)

      // Should pass immediately after 1ms
      await new Promise(r => setTimeout(r, 5))
      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(true)
    })

    test('rate limit exactly at boundary', async () => {
      const task = await taskRepo.create({
        name: 'boundary-rate',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
        rateLimitMax: 1,
        rateLimitWindowMs: 10000,
      })

      // One job clearly outside window boundary (10.5 seconds ago with 10 second window)
      const job = await jobRepo.create({ task_id: task.id })
      await db.sql`UPDATE derived_jobs SET created_at = NOW() - INTERVAL '10500 milliseconds' WHERE id = ${job.id}`

      // Should be allowed (job is outside window)
      const result = await integration.checkRateLimit(task)
      expect(result.allowed).toBe(true)
    })

    test('multiple policies all blocking', async () => {
      // Create pool that would block
      const pool = await db.sql<{ id: string }[]>`
        INSERT INTO resource_pools (id, name, max_concurrent, daily_budget_cents, current_spend_cents, created_at, updated_at)
        VALUES (${generateCanonicalId()}, 'multi-block-pool', 1, 100, 100, NOW(), NOW())
        RETURNING id
      `

      const task = await taskRepo.create({
        name: 'multi-block',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
        replayPolicy: 'once',
        rateLimitMax: 1,
        rateLimitWindowMs: 60000,
        resourcePool: 'multi-block-pool',
      })

      // Complete a job (blocks replay_policy=once)
      const job = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(job.id)
      await jobRepo.complete(job.id)

      // First blocking policy wins
      const result = await integration.checkAllPolicies(task)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('replay_policy=once') // First check
    })
  })

  describe('Data type edge cases', () => {
    test('handles very large cooldown_ms', async () => {
      const task = await taskRepo.create({
        name: 'huge-cooldown',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
        replayPolicy: 'cooldown',
        cooldownMs: 2147483647, // Max int32
      })

      const job = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(job.id)
      await jobRepo.complete(job.id)

      const result = await integration.checkReplayPolicy(task)
      expect(result.allowed).toBe(false)
      expect(result.retryAfter).toBeGreaterThan(0)
    })

    test('handles very large cost_cents', async () => {
      const task = await taskRepo.create({
        name: 'huge-cost',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })
      const job = await jobRepo.create({ task_id: task.id })

      const result = await jobRepo.recordCost(job.id, 999999999)
      expect(result?.cost_cents).toBe(999999999)
    })
  })

  describe('Null handling', () => {
    test('handles task with all null optional fields', async () => {
      const task = await taskRepo.create({
        name: 'null-fields',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })

      // All policies should pass with null values
      const replayResult = await integration.checkReplayPolicy(task)
      expect(replayResult.allowed).toBe(true)

      const rateResult = await integration.checkRateLimit(task)
      expect(rateResult.allowed).toBe(true)

      const poolResult = await integration.checkResourcePool(task)
      expect(poolResult.allowed).toBe(true)
    })

    test('handles job with null completed_at in findLastCompleted', async () => {
      const task = await taskRepo.create({
        name: 'null-completed',
        scriptPath: 'scripts/test.ts',
        mode: 'once',
      })

      // Only pending jobs (no completed_at)
      await jobRepo.create({ task_id: task.id })
      await jobRepo.create({ task_id: task.id })

      const result = await jobRepo.findLastCompleted(task.id)
      expect(result).toBeNull()
    })
  })
})
