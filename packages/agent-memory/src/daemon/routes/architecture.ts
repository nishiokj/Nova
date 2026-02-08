import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'
import { createArchitectureRepository, type ArchitectureAlertSeverity, type ArchitectureAlertStatus, type ArchitectureRunStatus } from '../../db/repositories/architecture.js'
import { DerivedTaskIntegration } from '../../derived/integration.js'

const ARCHITECTURE_TASK_NAME = 'derive-architecture-boundaries'
const ARCHITECTURE_SCRIPT_PATH = 'scripts/derive-architecture-boundaries.ts'

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseIntNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

async function ensureArchitectureTask(daemon: SyncDaemon) {
  const existing = await daemon.derivedTaskRepo.findByName(ARCHITECTURE_TASK_NAME)
  if (existing.length > 0) {
    return existing[0]
  }

  return daemon.derivedTaskRepo.create({
    name: ARCHITECTURE_TASK_NAME,
    scriptPath: ARCHITECTURE_SCRIPT_PATH,
    mode: 'recurring',
    intervalMs: 24 * 60 * 60 * 1000,
    replayPolicy: 'cooldown',
    cooldownMs: 6 * 60 * 60 * 1000,
    metadata: {
      lookbackDays: 30,
      minEdgeWeight: 0.12,
      strongEdgeWeight: 0.20,
      maxPairsPerFile: 128,
      maxFiles: 20000,
      emitAlerts: false,
    },
  })
}

export function registerArchitectureRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const architectureRepo = createArchitectureRepository({ sql: daemon.sql })

  async function resolveRunId(requestedRunId?: string): Promise<string | null> {
    if (requestedRunId) {
      const run = await architectureRepo.findRunById(requestedRunId)
      if (!run) throw notFound(`Architecture run not found: ${requestedRunId}`)
      return run.id
    }
    return architectureRepo.findLatestSuccessfulRunId()
  }

  server.get('/architecture/runs', async (req) => {
    const limit = parseIntNumber(req.query.limit, 20)
    const status = req.query.status as ArchitectureRunStatus | undefined
    const runs = await architectureRepo.listRuns(limit, status)
    return { body: { runs } }
  })

  server.get('/architecture/concerns', async (req) => {
    const runId = await resolveRunId(req.query.runId)
    if (!runId) return { body: { runId: null, concerns: [] } }

    const minConfidence = req.query.minConfidence !== undefined
      ? parseNumber(req.query.minConfidence, 0)
      : undefined
    const limit = parseIntNumber(req.query.limit, 200)
    const concerns = await architectureRepo.listConcerns({
      runId,
      minConfidence,
      limit,
    })
    return { body: { runId, concerns } }
  })

  server.get('/architecture/concerns/:id', async (req) => {
    const runId = await resolveRunId(req.query.runId)
    if (!runId) {
      throw notFound('No architecture run available')
    }
    const detail = await architectureRepo.getConcernDetail(runId, req.params.id)
    if (!detail) {
      throw notFound(`Concern not found: ${req.params.id}`)
    }
    return { body: { runId, concern: detail } }
  })

  server.get('/architecture/boundaries', async (req) => {
    const runId = await resolveRunId(req.query.runId)
    if (!runId) return { body: { runId: null, boundaries: [] } }

    const minPressure = req.query.minPressure !== undefined
      ? parseNumber(req.query.minPressure, 0)
      : undefined
    const maxHardness = req.query.maxHardness !== undefined
      ? parseNumber(req.query.maxHardness, 1)
      : undefined
    const limit = parseIntNumber(req.query.limit, 200)
    const boundaries = await architectureRepo.listBoundaries({
      runId,
      minPressure,
      maxHardness,
      limit,
    })
    return { body: { runId, boundaries } }
  })

  server.get('/architecture/alerts', async (req) => {
    const runId = req.query.runId ? await resolveRunId(req.query.runId) : undefined
    const status = req.query.status as ArchitectureAlertStatus | undefined
    const severity = req.query.severity as ArchitectureAlertSeverity | undefined
    const type = req.query.type
    const limit = parseIntNumber(req.query.limit, 200)
    const alerts = await architectureRepo.listAlerts({ runId: runId ?? undefined, status, severity, type, limit })
    return { body: { runId: runId ?? null, alerts } }
  })

  server.post('/architecture/recompute', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const force = body.force === true
    const lookbackDays = body.lookbackDays === undefined
      ? undefined
      : Number(body.lookbackDays)

    if (lookbackDays !== undefined && (!Number.isFinite(lookbackDays) || lookbackDays <= 0)) {
      throw badRequest('lookbackDays must be a positive number')
    }

    const task = await ensureArchitectureTask(daemon)
    const result = await daemon.derivedIntegration.scheduleTask(daemon.engine, task, {
      force,
      metadata: {
        ...(lookbackDays !== undefined ? { lookbackDays } : {}),
      },
    })

    if (DerivedTaskIntegration.isBlocked(result)) {
      return {
        status: 429,
        body: {
          error: 'policy_blocked',
          message: result.reason,
          retryAfter: result.retryAfter,
        },
      }
    }

    const job = result
    await daemon.derivedTaskRepo.markExecuted(task.id, job.id)
    if (task.mode === 'recurring' && task.interval_ms) {
      await daemon.derivedTaskRepo.updateNextRunAt(task.id, new Date(Date.now() + task.interval_ms))
    }

    return {
      status: 201,
      body: {
        taskId: task.id,
        taskName: task.name,
        jobId: job.id,
      },
    }
  })

  server.post('/architecture/alerts/:id/resolve', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const note = typeof body.note === 'string' ? body.note : undefined
    const alert = await architectureRepo.resolveAlert(req.params.id, note)
    if (!alert) {
      throw notFound(`Architecture alert not found or already resolved: ${req.params.id}`)
    }
    return { body: { alert } }
  })
}

