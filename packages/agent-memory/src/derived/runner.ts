/**
 * Derived Script Runner
 *
 * Loads and executes derived processing scripts.
 */

import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { Sql } from 'postgres'
import type { DerivedTask } from '../db/repositories/derived-task.js'
import type { DerivedJob } from '../db/repositories/derived-job.js'
import { createDerivedProcessingLogRepository } from '../db/repositories/derived-processing-log.js'
import { ensureDerivedLogStream, formatDerivedLogLine } from './logging.js'

export interface ProcessingLog {
  findProcessedEntityIds(
    configHash: string,
    entityType: string
  ): Promise<Map<string, { entity_updated_at?: string }>>
  markProcessed(
    entityId: string,
    entityType: string,
    configHash: string,
    status: 'success' | 'failed',
    opts?: { error?: string; entityUpdatedAt?: Date }
  ): Promise<void>
  markBatch(
    entries: Array<{
      entityId: string
      entityType: string
      configHash: string
      status: 'success' | 'failed'
      error?: string
      entityUpdatedAt?: Date
    }>
  ): Promise<void>
  getStats(configHash: string): Promise<{ total: number; success: number; failed: number }>
}

export interface DerivedRunContext {
  sql: Sql
  task: DerivedTask
  job: DerivedJob
  processingLog: ProcessingLog
  logPath: string
  /**
   * Persist intermediate state to the job's metadata under `_checkpoint`.
   * Survives process crashes — on resume, read from `job.metadata._checkpoint`.
   * Use this for external handles (batch job names, cursor tokens, etc.)
   * that are needed to resume work after a crash.
   */
  checkpoint: (data: Record<string, unknown>) => Promise<void>
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
    debug: (...args: unknown[]) => void
  }
}

export interface DerivedRunResult {
  outputRef?: string
  metadata?: Record<string, unknown>
}

export interface MetadataFieldDef {
  type: 'string' | 'number' | 'boolean'
  required?: boolean
  default?: unknown
  description: string
}

export interface DerivedMetadataSchema {
  fields: Record<string, MetadataFieldDef>
}

export type DerivedScriptModule = {
  run?: (ctx: DerivedRunContext) => Promise<DerivedRunResult | void> | DerivedRunResult | void
  default?: (ctx: DerivedRunContext) => Promise<DerivedRunResult | void> | DerivedRunResult | void
  metadata?: DerivedMetadataSchema
}

/** packages/agent-memory root, derived from this file's location */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function resolveScriptPath(scriptPath: string): string {
  if (path.isAbsolute(scriptPath)) return scriptPath
  // Strip redundant package prefix — the path is already resolved relative to pkg root
  const cleaned = scriptPath.replace(/^packages\/agent-memory\//, '')
  return path.resolve(PKG_ROOT, cleaned)
}

export async function loadScriptMetadata(scriptPath: string): Promise<DerivedMetadataSchema | null> {
  const resolvedPath = resolveScriptPath(scriptPath)
  const moduleUrl = pathToFileURL(resolvedPath).href

  let mod: DerivedScriptModule
  try {
    mod = (await import(moduleUrl)) as DerivedScriptModule
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load derived script at ${resolvedPath}: ${message}`)
  }

  return mod.metadata ?? null
}

export async function runDerivedScript(
  sql: Sql,
  task: DerivedTask,
  job: DerivedJob
): Promise<DerivedRunResult | void> {
  const resolvedPath = resolveScriptPath(task.script_path)
  const moduleUrl = pathToFileURL(resolvedPath).href

  const loggerPrefix = `[derived:${task.id}:${job.id}]`
  const { path: logPath, stream } = await ensureDerivedLogStream(job.id)
  const ensureLogPath = async () => {
    if (job.metadata && typeof job.metadata._logPath === 'string') return
    await sql`
      UPDATE derived_jobs
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{_logPath}',
        ${JSON.stringify(logPath)}::jsonb
      )
      WHERE id = ${job.id}
    `
  }
  await ensureLogPath().catch(() => {})

  const writeLog = (level: 'info' | 'warn' | 'error' | 'debug', args: unknown[]) => {
    stream.write(formatDerivedLogLine(loggerPrefix, level, args))
  }

  const logger = {
    info: (...args: unknown[]) => {
      console.log(loggerPrefix, ...args)
      writeLog('info', args)
    },
    warn: (...args: unknown[]) => {
      console.warn(loggerPrefix, ...args)
      writeLog('warn', args)
    },
    error: (...args: unknown[]) => {
      console.error(loggerPrefix, ...args)
      writeLog('error', args)
    },
    debug: (...args: unknown[]) => {
      console.debug(loggerPrefix, ...args)
      writeLog('debug', args)
    },
  }

  try {
    let mod: DerivedScriptModule
    try {
      mod = (await import(moduleUrl)) as DerivedScriptModule
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Failed to load derived script at ${resolvedPath}: ${message}`)
      throw new Error(`Failed to load derived script at ${resolvedPath}: ${message}`)
    }

    const runner = mod.run ?? mod.default
    if (!runner) {
      logger.error(`Derived script must export run() or default() at ${resolvedPath}`)
      throw new Error(`Derived script must export run() or default() at ${resolvedPath}`)
    }

    const repo = createDerivedProcessingLogRepository({ sql })
    const processingLog: ProcessingLog = {
      findProcessedEntityIds: (configHash, entityType) =>
        repo.findProcessedEntityIds(task.id, configHash, entityType),
      markProcessed: async (entityId, entityType, configHash, status, opts) => {
        await repo.markProcessed({
          taskId: task.id,
          jobId: job.id,
          entityId,
          entityType,
          configHash,
          status,
          error: opts?.error,
          entityUpdatedAt: opts?.entityUpdatedAt,
        })
      },
      markBatch: (entries) =>
        repo.markBatch(
          entries.map((e) => ({
            taskId: task.id,
            jobId: job.id,
            ...e,
          }))
        ),
      getStats: (configHash) => repo.getStats(task.id, configHash),
    }

    const checkpoint = async (data: Record<string, unknown>) => {
      await sql`
        UPDATE derived_jobs
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{_checkpoint}',
          ${JSON.stringify(data)}::jsonb
        )
        WHERE id = ${job.id}
      `
      logger.debug('Checkpoint saved')
    }

    return await runner({ sql, task, job, processingLog, logPath, checkpoint, logger })
  } finally {
    await new Promise<void>((resolve) => {
      stream.end(() => resolve())
    })
  }
}
