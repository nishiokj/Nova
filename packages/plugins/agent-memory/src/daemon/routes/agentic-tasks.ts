/**
 * Agentic Task API Routes
 *
 * Storage and lifecycle management for agentic tasks.
 * Compilation happens in the agentic-tasks skill (conversation layer),
 * not server-side. The route accepts pre-compiled prompt + VP artifacts.
 */

import { createHash } from 'crypto'
import { join } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'
import type { AgenticTaskCreateInput, AgenticTaskUpdateInput } from 'types'

function taskDataDir(taskId: string): string {
  return join('data', 'agentic-tasks', taskId)
}

async function writeArtifacts(
  taskId: string,
  compiledPrompt: string,
  compiledVp: unknown,
): Promise<{ promptPath: string; vpPath: string; vpHash: string }> {
  const dir = taskDataDir(taskId)
  await mkdir(dir, { recursive: true })

  const promptPath = join(dir, 'prompt.md')
  await writeFile(promptPath, compiledPrompt, 'utf8')

  const vpJson = JSON.stringify(compiledVp, null, 2)
  const vpPath = join(dir, 'vp.json')
  await writeFile(vpPath, vpJson, 'utf8')

  const vpHash = createHash('sha256').update(vpJson).digest('hex')

  return { promptPath, vpPath, vpHash }
}

export function registerAgenticTaskRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const taskRepo = daemon.agenticTaskRepo
  const runRepo = daemon.agenticRunRepo
  const integration = daemon.agenticIntegration

  // POST /agentic-tasks — Create task
  // If compiledPrompt + compiledVp are provided, creates as active.
  // Otherwise creates as draft (awaiting skill compilation).
  server.post('/agentic-tasks', async (req) => {
    const body = req.body as Record<string, unknown> | undefined

    if (!body?.name || typeof body.name !== 'string') throw badRequest('name is required')
    if (!body?.intent || typeof body.intent !== 'string') throw badRequest('intent is required')
    if (!body?.mode || typeof body.mode !== 'string') throw badRequest('mode is required')
    if (!Array.isArray(body?.invariants)) throw badRequest('invariants must be an array')
    if (!body?.systemSurface || typeof body.systemSurface !== 'object') throw badRequest('systemSurface is required')

    const input: AgenticTaskCreateInput = {
      name: body.name,
      intent: body.intent,
      successCriteria: typeof body.successCriteria === 'string' ? body.successCriteria : undefined,
      invariants: body.invariants as AgenticTaskCreateInput['invariants'],
      systemSurface: body.systemSurface as AgenticTaskCreateInput['systemSurface'],
      capabilityScope: body.capabilityScope as AgenticTaskCreateInput['capabilityScope'],
      mutationBudget: body.mutationBudget as AgenticTaskCreateInput['mutationBudget'],
      mode: body.mode as AgenticTaskCreateInput['mode'],
      intervalMs: typeof body.intervalMs === 'number' ? body.intervalMs : undefined,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      idempotent: typeof body.idempotent === 'boolean' ? body.idempotent : undefined,
      cooldownMs: typeof body.cooldownMs === 'number' ? body.cooldownMs : undefined,
      maxFailures: typeof body.maxFailures === 'number' ? body.maxFailures : undefined,
      metadata: body.metadata as Record<string, unknown> | undefined,
    }

    const task = await taskRepo.create(input)

    // If pre-compiled artifacts provided, activate immediately
    const hasPrompt = typeof body.compiledPrompt === 'string' && body.compiledPrompt.length > 0
    const hasVp = body.compiledVp && typeof body.compiledVp === 'object'

    if (hasPrompt && hasVp) {
      const { promptPath, vpPath, vpHash } = await writeArtifacts(
        task.id,
        body.compiledPrompt as string,
        body.compiledVp,
      )
      const activated = await taskRepo.activate(task.id, promptPath, vpPath, vpHash)
      return { status: 201, body: { task: activated } }
    }

    return { status: 201, body: { task } }
  })

  // GET /agentic-tasks — List tasks
  server.get('/agentic-tasks', async (req) => {
    const { status, mode, limit = '50' } = req.query
    const filters: { status?: any; mode?: string } = {}
    if (status) filters.status = status
    if (mode) filters.mode = mode

    const tasks = await taskRepo.findAll(
      Object.keys(filters).length > 0 ? filters : undefined,
      parseInt(limit, 10),
    )
    return { body: { tasks, total: tasks.length } }
  })

  // GET /agentic-tasks/:id — Get task
  server.get('/agentic-tasks/:id', async (req) => {
    const task = await taskRepo.findById(req.params.id)
    if (!task) throw notFound('Task not found')
    return { body: { task } }
  })

  // PATCH /agentic-tasks/:id — Update task
  // If compiledPrompt + compiledVp provided, updates artifacts on disk.
  server.patch('/agentic-tasks/:id', async (req) => {
    const { id } = req.params
    const body = req.body as Record<string, unknown> | undefined
    if (!body) throw badRequest('Request body is required')

    const task = await taskRepo.findById(id)
    if (!task) throw notFound('Task not found')

    const updates: AgenticTaskUpdateInput = {}
    if (typeof body.intent === 'string') updates.intent = body.intent
    if (body.successCriteria !== undefined) updates.successCriteria = body.successCriteria as string | null
    if (Array.isArray(body.invariants)) updates.invariants = body.invariants as any
    if (body.systemSurface && typeof body.systemSurface === 'object') updates.systemSurface = body.systemSurface as any
    if (body.capabilityScope && typeof body.capabilityScope === 'object') updates.capabilityScope = body.capabilityScope as any
    if (body.mutationBudget && typeof body.mutationBudget === 'object') updates.mutationBudget = body.mutationBudget as any
    if (typeof body.intervalMs === 'number') updates.intervalMs = body.intervalMs
    if (typeof body.timeoutMs === 'number') updates.timeoutMs = body.timeoutMs
    if (typeof body.idempotent === 'boolean') updates.idempotent = body.idempotent
    if (typeof body.cooldownMs === 'number') updates.cooldownMs = body.cooldownMs
    if (typeof body.maxFailures === 'number') updates.maxFailures = body.maxFailures
    if (body.metadata && typeof body.metadata === 'object') updates.metadata = body.metadata as Record<string, unknown>

    // Update compiled artifacts if provided
    const hasPrompt = typeof body.compiledPrompt === 'string' && (body.compiledPrompt as string).length > 0
    const hasVp = body.compiledVp && typeof body.compiledVp === 'object'

    if (hasPrompt && hasVp) {
      const { promptPath, vpPath, vpHash } = await writeArtifacts(
        id,
        body.compiledPrompt as string,
        body.compiledVp,
      )
      await taskRepo.updateCompiled(id, promptPath, vpPath, vpHash)
    }

    const updated = await taskRepo.update(id, updates)
    return { body: { task: updated } }
  })

  // DELETE /agentic-tasks/:id — Delete task + orphan runs
  server.delete('/agentic-tasks/:id', async (req) => {
    const deleted = await taskRepo.delete(req.params.id)
    if (!deleted) throw notFound('Task not found')
    return { body: { deleted: true } }
  })

  // POST /agentic-tasks/:id/trigger — Manual execution (must be active)
  server.post('/agentic-tasks/:id/trigger', async (req) => {
    const { id } = req.params

    const task = await taskRepo.findById(id)
    if (!task) throw notFound('Task not found')
    if (task.status !== 'active') throw badRequest('Task must be active to trigger')
    if (!task.compiledPromptPath) throw badRequest('Task has no compiled prompt')

    const run = await integration.scheduleTask(daemon.engine, task)
    if (!run) throw badRequest('Task already has an active run')

    await taskRepo.markExecuted(task.id, run.id)

    return { status: 201, body: { run } }
  })

  // POST /agentic-tasks/:id/pause — active -> paused
  server.post('/agentic-tasks/:id/pause', async (req) => {
    const { id } = req.params
    const body = req.body as Record<string, unknown> | undefined
    const reason = typeof body?.reason === 'string' ? body.reason : 'Manually paused'

    const task = await taskRepo.pause(id, reason)
    if (!task) throw badRequest('Task not found or not active')
    return { body: { task } }
  })

  // POST /agentic-tasks/:id/resume — paused -> active
  server.post('/agentic-tasks/:id/resume', async (req) => {
    const task = await taskRepo.resume(req.params.id)
    if (!task) throw badRequest('Task not found or not paused')
    return { body: { task } }
  })

  // POST /agentic-tasks/:id/reset-circuit — Reset circuit breaker
  server.post('/agentic-tasks/:id/reset-circuit', async (req) => {
    const task = await taskRepo.resetCircuit(req.params.id)
    if (!task) throw notFound('Task not found')
    return { body: { task } }
  })

  // GET /agentic-tasks/:id/runs — List runs for task
  server.get('/agentic-tasks/:id/runs', async (req) => {
    const { limit = '50' } = req.query
    const runs = await runRepo.findByTask(req.params.id, parseInt(limit, 10))
    return { body: { runs, total: runs.length } }
  })

  // GET /agentic-runs/:id — Get run
  server.get('/agentic-runs/:id', async (req) => {
    const run = await runRepo.findById(req.params.id)
    if (!run) throw notFound('Run not found')
    return { body: { run } }
  })
}
