/**
 * Agentic Task API Routes
 *
 * CRUD + lifecycle (compile, trigger, pause/resume, circuit reset)
 * Follows escalations.ts route pattern.
 */

import { createHash } from 'crypto'
import { join } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'
import type { AgenticTaskCreateInput, AgenticTaskUpdateInput } from 'types'
import {
  compileVerificationProgram,
  generateHarnessArtifacts,
  type InvariantInput,
  type SystemSurface,
} from 'semantic-compiler'
import { generateCanonicalId } from '../../ids.js'

function computeVpHash(invariants: InvariantInput[], systemSurface: SystemSurface): string {
  const content = JSON.stringify({ invariants, systemSurface })
  return createHash('sha256').update(content).digest('hex')
}

function taskDataDir(taskId: string): string {
  return join('data', 'agentic-tasks', taskId)
}

async function writeVpToDisk(vp: unknown, taskId: string): Promise<string> {
  const dir = taskDataDir(taskId)
  await mkdir(dir, { recursive: true })
  const vpPath = join(dir, 'vp.json')
  await writeFile(vpPath, JSON.stringify(vp, null, 2), 'utf8')
  return vpPath
}

function harnessDir(taskId: string): string {
  return join(taskDataDir(taskId), 'harness')
}

export function registerAgenticTaskRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const taskRepo = daemon.agenticTaskRepo
  const runRepo = daemon.agenticRunRepo
  const integration = daemon.agenticIntegration

  // POST /agentic-tasks — Create task (compiles VP, returns draft or active)
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

    // Compile invariants
    const vp = compileVerificationProgram({
      uow_id: generateCanonicalId(),
      invariants: input.invariants,
      system_surface: input.systemSurface,
    })

    const needsAnswers = vp.invariants.some(i => i.compile_status === 'needs_user_answer')
    const questions = vp.invariants.flatMap(i => i.questions ?? [])

    // Create task (starts as draft)
    const task = await taskRepo.create(input)

    if (needsAnswers) {
      await taskRepo.setDraft(task.id, questions)
      const updated = await taskRepo.findById(task.id)
      return { status: 201, body: { task: updated } }
    }

    // Active: cache VP, set schedule
    const vpHash = computeVpHash(input.invariants, input.systemSurface)
    const vpPath = await writeVpToDisk(vp, task.id)
    await taskRepo.activate(task.id, vpPath, vpHash)

    // Generate harness artifacts upfront
    const hDir = harnessDir(task.id)
    await mkdir(hDir, { recursive: true })
    await generateHarnessArtifacts(vp, { output_dir: hDir, write_files: true })

    const activated = await taskRepo.findById(task.id)
    return { status: 201, body: { task: activated } }
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

  // PATCH /agentic-tasks/:id — Update task (recompiles VP if invariants/surface changed)
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

    // Recompile if invariants or system_surface changed
    const invariantsChanged = updates.invariants !== undefined
    const surfaceChanged = updates.systemSurface !== undefined

    if (invariantsChanged || surfaceChanged) {
      const newInvariants = updates.invariants ?? task.invariants
      const newSurface = updates.systemSurface ?? task.systemSurface
      const newHash = computeVpHash(newInvariants, newSurface)

      if (newHash !== task.compiledVpHash) {
        const vp = compileVerificationProgram({
          uow_id: task.id,
          invariants: newInvariants,
          system_surface: newSurface,
        })

        const needsAnswers = vp.invariants.some(i => i.compile_status === 'needs_user_answer')

        if (needsAnswers) {
          const questions = vp.invariants.flatMap(i => i.questions ?? [])
          await taskRepo.setDraft(task.id, questions)
        } else {
          const vpPath = await writeVpToDisk(vp, task.id)
          await taskRepo.updateCompiledVp(task.id, vpPath, newHash)
          const hDir = harnessDir(task.id)
          await mkdir(hDir, { recursive: true })
          await generateHarnessArtifacts(vp, { output_dir: hDir, write_files: true })
        }
      }
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

  // POST /agentic-tasks/:id/answers — Resolve pending questions, recompile, activate
  server.post('/agentic-tasks/:id/answers', async (req) => {
    const { id } = req.params
    const body = req.body as Record<string, unknown> | undefined

    const task = await taskRepo.findById(id)
    if (!task) throw notFound('Task not found')
    if (task.status !== 'draft') throw badRequest('Task is not in draft status')
    if (!Array.isArray(body?.answers)) throw badRequest('answers array is required')

    // Recompile with answers applied to invariants
    // Answers are merged into invariant context for the compiler
    const enrichedInvariants = task.invariants.map(inv => ({
      ...inv,
      context: [inv.context, ...(body!.answers as string[])].filter(Boolean).join('\n'),
    }))

    const vp = compileVerificationProgram({
      uow_id: task.id,
      invariants: enrichedInvariants,
      system_surface: task.systemSurface,
    })

    const stillNeedsAnswers = vp.invariants.some(i => i.compile_status === 'needs_user_answer')

    if (stillNeedsAnswers) {
      const questions = vp.invariants.flatMap(i => i.questions ?? [])
      await taskRepo.setDraft(task.id, questions)
      const updated = await taskRepo.findById(task.id)
      return { body: { task: updated, resolved: false } }
    }

    const vpHash = computeVpHash(enrichedInvariants, task.systemSurface)
    const vpPath = await writeVpToDisk(vp, task.id)
    await taskRepo.activate(task.id, vpPath, vpHash)

    const hDir = harnessDir(task.id)
    await mkdir(hDir, { recursive: true })
    await generateHarnessArtifacts(vp, { output_dir: hDir, write_files: true })

    const activated = await taskRepo.findById(task.id)
    return { body: { task: activated, resolved: true } }
  })

  // POST /agentic-tasks/:id/trigger — Manual execution (must be active)
  server.post('/agentic-tasks/:id/trigger', async (req) => {
    const { id } = req.params

    const task = await taskRepo.findById(id)
    if (!task) throw notFound('Task not found')
    if (task.status !== 'active') throw badRequest('Task must be active to trigger')
    if (!task.compiledVpPath) throw badRequest('Task has no compiled verification program')

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
