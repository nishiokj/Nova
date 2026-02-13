/**
 * Derived Task Routes Tests
 *
 * Integration tests for derived task HTTP endpoints.
 * Tests validation, policy checks, and job scheduling end-to-end.
 *
 * Requires a running PostgreSQL instance.
 * Set TEST_DATABASE_URL environment variable to run these tests.
 */

import { createDatabase, migrate, type Database } from 'agent-memory/db/index.js'
import { HttpServer } from 'agent-memory/daemon/server.js'
import { SyncDaemon } from 'agent-memory/daemon/index.js'
import { createDerivedTaskRepository, createDerivedJobRepository, generateCanonicalId } from 'agent-memory/db/repositories/index.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL

// Skip tests if no database URL is provided
const describeWithDb = TEST_DB_URL ? describe : describe.skip

describeWithDb('Derived Task Routes - Integration Tests', () => {
  let db: Database
  let daemon: SyncDaemon
  let server: HttpServer
  let port: number

  // Get a random port to avoid conflicts
  const getTestPort = () => 3000 + Math.floor(Math.random() * 1000)

  // Helper to make HTTP requests
  async function request(method: string, path: string, body?: unknown) {
    const url = `http://127.0.0.1:${port}${path}`
    const options: RequestInit = {
      method,
      headers: {},
    }

    if (body !== undefined) {
      options.headers = {
        'Content-Type': 'application/json',
      }
      options.body = JSON.stringify(body)
    }

    const response = await fetch(url, options)
    const responseBody = await response.text()
    let json: unknown = null
    try {
      json = JSON.parse(responseBody)
    } catch {
      // Not JSON
    }

    return {
      status: response.status,
      body: json || responseBody,
    }
  }

  // Create a minimal test script path that exists
  const testScriptPath = 'scripts/derive-preferences.ts'

  beforeAll(async () => {
    // Create database connection
    db = createDatabase({ connectionString: TEST_DB_URL! })
    await migrate(db)

    // Create daemon
    port = getTestPort()
    daemon = await SyncDaemon.create({
      sql: db.sql,
      encryptionKey: Buffer.from('0000000000000000000000000000000000000000000000000000000000000000000', 'hex'),
      port,
      webhookBaseUrl: 'http://localhost:3001',
      engine: {
        autoProcess: false, // Don't start queue worker for tests
      },
    })

    // Start daemon
    await daemon.start()
    server = daemon.server

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 100))
  })

  afterAll(async () => {
    await daemon.stop()
    await db.close()
  })

  beforeEach(async () => {
    // Clean up test data
    await db.sql`TRUNCATE derived_jobs CASCADE`
    await db.sql`TRUNCATE derived_tasks CASCADE`
  })

  describe('GET /api/derived/tasks', () => {
    it('returns empty list when no tasks exist', async () => {
      const response = await request('GET', '/api/derived/tasks')
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ tasks: [] })
    })

    it('returns list of tasks', async () => {
      const taskRepo = createDerivedTaskRepository({ sql: db.sql })

      await taskRepo.create({
        name: 'task1',
        scriptPath: testScriptPath,
        mode: 'once',
      })
      await taskRepo.create({
        name: 'task2',
        scriptPath: testScriptPath,
        mode: 'once',
      })

      const response = await request('GET', '/api/derived/tasks')
      expect(response.status).toBe(200)
      const body = response.body as { tasks: unknown[] }
      expect(body.tasks).toHaveLength(2)
    })

    it('filters tasks by enabled=true', async () => {
      const taskRepo = createDerivedTaskRepository({ sql: db.sql })

      const task1 = await taskRepo.create({
        name: 'enabled-task',
        scriptPath: testScriptPath,
        mode: 'once',
      })
      const task2 = await taskRepo.create({
        name: 'disabled-task',
        scriptPath: testScriptPath,
        mode: 'once',
      })
      await taskRepo.update(task2.id, { enabled: false })

      const response = await request('GET', '/api/derived/tasks?enabled=true')
      expect(response.status).toBe(200)
      const body = response.body as { tasks: unknown[] }
      expect(body.tasks).toHaveLength(1)
      expect((body.tasks[0] as { id: string }).id).toBe(task1.id)
    })

    it('filters tasks by enabled=false', async () => {
      const taskRepo = createDerivedTaskRepository({ sql: db.sql })

      const task1 = await taskRepo.create({
        name: 'enabled-task',
        scriptPath: testScriptPath,
        mode: 'once',
      })
      const task2 = await taskRepo.create({
        name: 'disabled-task',
        scriptPath: testScriptPath,
        mode: 'once',
      })
      await taskRepo.update(task2.id, { enabled: false })

      const response = await request('GET', '/api/derived/tasks?enabled=false')
      expect(response.status).toBe(200)
      const body = response.body as { tasks: unknown[] }
      expect(body.tasks).toHaveLength(1)
      expect((body.tasks[0] as { id: string }).id).toBe(task2.id)
    })

    it('filters tasks by name', async () => {
      const taskRepo = createDerivedTaskRepository({ sql: db.sql })

      await taskRepo.create({
        name: 'task-abc',
        scriptPath: testScriptPath,
        mode: 'once',
      })
      await taskRepo.create({
        name: 'task-xyz',
        scriptPath: testScriptPath,
        mode: 'once',
      })

      const response = await request('GET', '/api/derived/tasks?name=task-abc')
      expect(response.status).toBe(200)
      const body = response.body as { tasks: unknown[] }
      expect(body.tasks).toHaveLength(1)
      expect((body.tasks[0] as { name: string }).name).toBe('task-abc')
    })
  })

  describe('GET /api/derived/tasks/:id', () => {
    it('returns 404 for non-existent task', async () => {
      const response = await request('GET', '/api/derived/tasks/nonexistent')
      expect(response.status).toBe(404)
      const body = response.body as { error: string }
      expect(body.error).toContain('Derived task not found')
    })

    it('returns task with recent jobs', async () => {
      const taskRepo = createDerivedTaskRepository({ sql: db.sql })
      const jobRepo = createDerivedJobRepository({ sql: db.sql })

      const task = await taskRepo.create({
        name: 'test-task',
        scriptPath: testScriptPath,
        mode: 'once',
      })

      // Create some jobs
      const job1 = await jobRepo.create({ task_id: task.id })
      const job2 = await jobRepo.create({ task_id: task.id })
      await jobRepo.start(job1.id)
      await jobRepo.complete(job1.id)

      const response = await request('GET', `/api/derived/tasks/${task.id}`)
      expect(response.status).toBe(200)
      const body = response.body as { task: unknown; recentJobs: unknown[] }
      expect(body.task).toBeDefined()
      expect(body.recentJobs).toHaveLength(2)
    })
  })

  describe('POST /api/derived/tasks', () => {
    it('creates task with required fields', async () => {
      const body = {
        name: 'test-create',
        scriptPath: testScriptPath,
        mode: 'once',
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(201)
      const responseBody = response.body as {
        task: { id: string; name: string; scriptPath: string; mode: string }
      }
      expect(responseBody.task.id).toBeDefined()
      expect(responseBody.task.name).toBe('test-create')
      expect(responseBody.task.scriptPath).toBe(testScriptPath)
      expect(responseBody.task.mode).toBe('once')
    })

    it('returns 400 for missing name', async () => {
      const body = {
        scriptPath: testScriptPath,
        mode: 'once',
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(400)
      const responseBody = response.body as { error: string; code: string }
      expect(responseBody.error).toContain('Missing required field: name')
      expect(responseBody.code).toBe('BAD_REQUEST')
    })

    it('returns 400 for missing scriptPath', async () => {
      const body = {
        name: 'test',
        mode: 'once',
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(400)
      const responseBody = response.body as { error: string }
      expect(responseBody.error).toContain('Missing required field: scriptPath')
    })

    it('returns 400 for missing mode', async () => {
      const body = {
        name: 'test',
        scriptPath: testScriptPath,
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(400)
      const responseBody = response.body as { error: string }
      expect(responseBody.error).toContain('Missing required field: mode')
    })

    it('returns 400 for invalid intervalMs with recurring mode', async () => {
      const body = {
        name: 'test',
        scriptPath: testScriptPath,
        mode: 'recurring',
        intervalMs: 500, // Too low (< 1000)
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(400)
      const responseBody = response.body as { error: string }
      expect(responseBody.error).toContain('intervalMs must be at least 1000ms')
    })

    it('returns 400 for missing triggerConfig with event mode', async () => {
      const body = {
        name: 'test',
        scriptPath: testScriptPath,
        mode: 'event',
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(400)
      const responseBody = response.body as { error: string }
      expect(responseBody.error).toContain('triggerConfig is required for event mode tasks')
    })

    it('returns 400 for triggerConfig with non-event mode', async () => {
      const body = {
        name: 'test',
        scriptPath: testScriptPath,
        mode: 'once',
        triggerConfig: { type: 'webhook' },
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(400)
      const responseBody = response.body as { error: string }
      expect(responseBody.error).toContain('triggerConfig is only valid for event mode tasks')
    })

    it('returns 400 for cooldown replayPolicy without cooldownMs', async () => {
      const body = {
        name: 'test',
        scriptPath: testScriptPath,
        mode: 'once',
        replayPolicy: 'cooldown',
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(400)
      const responseBody = response.body as { error: string }
      expect(responseBody.error).toContain('cooldownMs is required when replayPolicy is "cooldown"')
    })

    it('returns 400 for rateLimitMax without rateLimitWindowMs', async () => {
      const body = {
        name: 'test',
        scriptPath: testScriptPath,
        mode: 'once',
        rateLimitMax: 100,
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(400)
      const responseBody = response.body as { error: string }
      expect(responseBody.error).toContain('rateLimitWindowMs is required when rateLimitMax is set')
    })

    it('creates task with all policy fields', async () => {
      const body = {
        name: 'test-policies',
        scriptPath: testScriptPath,
        mode: 'recurring',
        intervalMs: 60000,
        replayPolicy: 'cooldown' as const,
        cooldownMs: 5000,
        idempotent: false,
        rateLimitMax: 10,
        rateLimitWindowMs: 60000,
        resourcePool: 'test-pool',
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(201)
      const responseBody = response.body as { task: unknown }
      const task = responseBody.task as {
        replay_policy: string
        cooldown_ms: number
        idempotent: boolean
        rate_limit_max: number
        rate_limit_window_ms: number
        resource_pool: string
      }
      expect(task.replay_policy).toBe('cooldown')
      expect(task.cooldown_ms).toBe(5000)
      expect(task.idempotent).toBe(false)
      expect(task.rate_limit_max).toBe(10)
      expect(task.rate_limit_window_ms).toBe(60000)
      expect(task.resource_pool).toBe('test-pool')
    })

    it('runs sandbox validation on create', async () => {
      const body = {
        name: 'test-sandbox',
        scriptPath: testScriptPath,
        mode: 'once',
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(201)
      const responseBody = response.body as { sandbox: unknown; task: unknown }
      // Sandbox should observe the job
      expect(responseBody.sandbox).toBeDefined()
      expect((responseBody.sandbox as { job: unknown }).job).toBeDefined()
    })

    it('disables once mode task after execution', async () => {
      const body = {
        name: 'test-once',
        scriptPath: testScriptPath,
        mode: 'once',
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(201)
      const responseBody = response.body as { task: unknown }
      const task = responseBody.task as { enabled: boolean }
      expect(task.enabled).toBe(false)
    })

    it('sets nextRunAt for recurring mode task', async () => {
      const body = {
        name: 'test-recurring',
        scriptPath: testScriptPath,
        mode: 'recurring',
        intervalMs: 60000,
      }

      const response = await request('POST', '/api/derived/tasks', body)
      expect(response.status).toBe(201)
      const responseBody = response.body as { task: unknown }
      const task = responseBody.task as { next_run_at: string }
      expect(task.next_run_at).toBeDefined()
      const nextRunAt = new Date(task.next_run_at)
      const now = new Date()
      // Should be about 60 seconds in the future
      expect(nextRunAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(59000)
      expect(nextRunAt.getTime() - now.getTime()).toBeLessThanOrEqual(61000)
    })
  })

  describe('POST /api/derived/tasks/:id/run', () => {
    it('returns 404 for non-existent task', async () => {
      const response = await request('POST', '/api/derived/tasks/nonexistent/run')
      expect(response.status).toBe(404)
      const body = response.body as { error: string }
      expect(body.error).toContain('Derived task not found')
    })

    it('runs task and creates job', async () => {
      const taskRepo = createDerivedTaskRepository({ sql: db.sql })

      const task = await taskRepo.create({
        name: 'test-run',
        scriptPath: testScriptPath,
        mode: 'recurring',
        intervalMs: 60000,
      })

      const response = await request('POST', `/api/derived/tasks/${task.id}/run`)
      expect(response.status).toBe(201)
      const responseBody = response.body as { task: unknown; job: unknown }
      expect(responseBody.job).toBeDefined()
      expect((responseBody.job as { id: string; task_id: string }).task_id).toBe(task.id)
    })

    it('returns 429 when blocked by replay policy', async () => {
      const taskRepo = createDerivedTaskRepository({ sql: db.sql })

      const task = await taskRepo.create({
        name: 'test-blocked',
        scriptPath: testScriptPath,
        mode: 'once',
        replayPolicy: 'once',
      })

      // First run
      await request('POST', `/api/derived/tasks/${task.id}/run`)

      // Second run should be blocked by replayPolicy: once
      const response = await request('POST', `/api/derived/tasks/${task.id}/run`)
      expect(response.status).toBe(429)
      const responseBody = response.body as { error: string; message: string }
      expect(responseBody.error).toBe('policy_blocked')
      expect(responseBody.message).toContain('replay_policy=once')
    })

    it('respects priority parameter', async () => {
      const taskRepo = createDerivedTaskRepository({ sql: db.sql })
      const jobRepo = createDerivedJobRepository({ sql: db.sql })

      const task = await taskRepo.create({
        name: 'test-priority',
        scriptPath: testScriptPath,
        mode: 'recurring',
      })

      await request('POST', `/api/derived/tasks/${task.id}/run`, { priority: 10 })

      const jobs = await jobRepo.findByTask(task.id, 1)
      expect(jobs[0].priority).toBe(10)
    })

    it('respects metadata parameter', async () => {
      const taskRepo = createDerivedTaskRepository({ sql: db.sql })
      const jobRepo = createDerivedJobRepository({ sql: db.sql })

      const task = await taskRepo.create({
        name: 'test-metadata',
        scriptPath: testScriptPath,
        mode: 'recurring',
      })

      const customMetadata = { foo: 'bar', test: 123 }
      await request('POST', `/api/derived/tasks/${task.id}/run`, { metadata: customMetadata })

      const jobs = await jobRepo.findByTask(task.id, 1)
      expect(jobs[0].metadata).toEqual(customMetadata)
    })

    it('force flag bypasses policy blocks', async () => {
      const taskRepo = createDerivedTaskRepository({ sql: db.sql })

      const task = await taskRepo.create({
        name: 'test-force',
        scriptPath: testScriptPath,
        mode: 'once',
        replayPolicy: 'once',
      })

      // First run
      await request('POST', `/api/derived/tasks/${task.id}/run`)

      // Second run with force flag
      const response = await request('POST', `/api/derived/tasks/${task.id}/run`, { force: true })
      expect(response.status).toBe(201)
    })
  })
})
