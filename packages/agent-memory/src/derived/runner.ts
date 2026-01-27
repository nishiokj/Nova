/**
 * Derived Script Runner
 *
 * Loads and executes derived processing scripts.
 */

import path from 'path'
import { pathToFileURL } from 'url'
import type { Sql } from 'postgres'
import type { DerivedTask } from '../db/repositories/derived-task.js'
import type { DerivedJob } from '../db/repositories/derived-job.js'

export interface DerivedRunContext {
  sql: Sql
  task: DerivedTask
  job: DerivedJob
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

export type DerivedScriptModule = {
  run?: (ctx: DerivedRunContext) => Promise<DerivedRunResult | void> | DerivedRunResult | void
  default?: (ctx: DerivedRunContext) => Promise<DerivedRunResult | void> | DerivedRunResult | void
}

function resolveScriptPath(scriptPath: string): string {
  if (path.isAbsolute(scriptPath)) return scriptPath
  return path.resolve(process.cwd(), scriptPath)
}

export async function runDerivedScript(
  sql: Sql,
  task: DerivedTask,
  job: DerivedJob
): Promise<DerivedRunResult | void> {
  const resolvedPath = resolveScriptPath(task.script_path)
  const moduleUrl = pathToFileURL(resolvedPath).href

  let mod: DerivedScriptModule
  try {
    mod = (await import(moduleUrl)) as DerivedScriptModule
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load derived script at ${resolvedPath}: ${message}`)
  }

  const runner = mod.run ?? mod.default
  if (!runner) {
    throw new Error(`Derived script must export run() or default() at ${resolvedPath}`)
  }

  const loggerPrefix = `[derived:${task.id}:${job.id}]`
  const logger = {
    info: (...args: unknown[]) => console.log(loggerPrefix, ...args),
    warn: (...args: unknown[]) => console.warn(loggerPrefix, ...args),
    error: (...args: unknown[]) => console.error(loggerPrefix, ...args),
    debug: (...args: unknown[]) => console.debug(loggerPrefix, ...args),
  }

  return runner({ sql, task, job, logger })
}
