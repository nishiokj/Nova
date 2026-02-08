import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'
import { createArchitectureRepository, type ArchitectureAlertSeverity, type ArchitectureAlertStatus, type ArchitectureRunStatus } from '../../db/repositories/architecture.js'
import { DerivedTaskIntegration } from '../../derived/integration.js'
import { evaluateArchitecturePolicy } from '../../architecture/policy.js'

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
    const task = existing[0]
    const metadata = (task.metadata ?? {}) as Record<string, unknown>
    const nextMetadata = {
      ...metadata,
      ...(metadata.emitAlerts !== true ? { emitAlerts: true } : {}),
      ...((metadata.concernMode !== 'module' && metadata.concernMode !== 'graph_cluster')
        ? { concernMode: 'module' }
        : {}),
    }
    const changed = Object.keys(nextMetadata).length !== Object.keys(metadata).length
      || JSON.stringify(nextMetadata) !== JSON.stringify(metadata)
    if (changed) {
      await daemon.derivedTaskRepo.update(task.id, {
        metadata: nextMetadata,
      })
      const refreshed = await daemon.derivedTaskRepo.findById(task.id)
      if (refreshed) return refreshed
    }
    return task
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
      emitAlerts: true,
      concernMode: 'module',
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

  server.get('/architecture/policy', async (req) => {
    const runWindow = parseIntNumber(req.query.runWindow, 6)
    const warnAfter = parseIntNumber(req.query.warnAfter, 2)
    const blockAfter = parseIntNumber(req.query.blockAfter, 3)

    if (runWindow <= 0) {
      throw badRequest('runWindow must be a positive integer')
    }
    if (warnAfter <= 0 || blockAfter <= 0) {
      throw badRequest('warnAfter and blockAfter must be positive integers')
    }
    if (blockAfter < warnAfter) {
      throw badRequest('blockAfter must be greater than or equal to warnAfter')
    }

    const runs = await architectureRepo.listRuns(runWindow, 'success')
    const snapshots = await Promise.all(
      runs.map(async (run) => {
        const alerts = await architectureRepo.listAlerts({
          runId: run.id,
          status: 'open',
          severity: 'critical',
          limit: 2000,
        })
        return { runId: run.id, alerts }
      })
    )

    const policy = evaluateArchitecturePolicy(snapshots, { runWindow, warnAfter, blockAfter })
    return { body: policy }
  })

  server.post('/architecture/recompute', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const force = body.force === true
    const lookbackDays = body.lookbackDays === undefined
      ? undefined
      : Number(body.lookbackDays)
    const emitAlerts = body.emitAlerts === undefined
      ? undefined
      : body.emitAlerts === true
    const concernMode = body.concernMode === undefined
      ? undefined
      : String(body.concernMode)

    if (lookbackDays !== undefined && (!Number.isFinite(lookbackDays) || lookbackDays <= 0)) {
      throw badRequest('lookbackDays must be a positive number')
    }
    if (body.emitAlerts !== undefined && typeof body.emitAlerts !== 'boolean') {
      throw badRequest('emitAlerts must be a boolean')
    }
    if (body.concernMode !== undefined && concernMode !== 'module' && concernMode !== 'graph_cluster') {
      throw badRequest('concernMode must be "module" or "graph_cluster"')
    }

    const task = await ensureArchitectureTask(daemon)
    const result = await daemon.derivedIntegration.scheduleTask(daemon.engine, task, {
      force,
      metadata: {
        ...(lookbackDays !== undefined ? { lookbackDays } : {}),
        ...(emitAlerts !== undefined ? { emitAlerts } : {}),
        ...(concernMode !== undefined ? { concernMode } : {}),
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

  server.post('/architecture/policy/check', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const runWindow = body.runWindow === undefined ? 6 : Number(body.runWindow)
    const warnAfter = body.warnAfter === undefined ? 2 : Number(body.warnAfter)
    const blockAfter = body.blockAfter === undefined ? 3 : Number(body.blockAfter)

    if (!Number.isFinite(runWindow) || runWindow <= 0) {
      throw badRequest('runWindow must be a positive integer')
    }
    if (!Number.isFinite(warnAfter) || warnAfter <= 0 || !Number.isFinite(blockAfter) || blockAfter <= 0) {
      throw badRequest('warnAfter and blockAfter must be positive integers')
    }
    if (blockAfter < warnAfter) {
      throw badRequest('blockAfter must be greater than or equal to warnAfter')
    }

    const runs = await architectureRepo.listRuns(Math.floor(runWindow), 'success')
    const snapshots = await Promise.all(
      runs.map(async (run) => {
        const alerts = await architectureRepo.listAlerts({
          runId: run.id,
          status: 'open',
          severity: 'critical',
          limit: 2000,
        })
        return { runId: run.id, alerts }
      })
    )

    const policy = evaluateArchitecturePolicy(snapshots, {
      runWindow: Math.floor(runWindow),
      warnAfter: Math.floor(warnAfter),
      blockAfter: Math.floor(blockAfter),
    })

    if (policy.decision === 'block') {
      return {
        status: 409,
        body: {
          ok: false,
          ...policy,
        },
      }
    }

    return {
      body: {
        ok: true,
        ...policy,
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
