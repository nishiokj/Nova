/**
 * Derived Task Logging
 *
 * Helper utilities for per-job log files.
 */

import path from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createWriteStream, type WriteStream } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.join(__dirname, '../../../')
const DEFAULT_LOG_DIR = path.resolve(PROJECT_ROOT, 'logs', 'derived')

export function getDerivedLogDir(): string {
  return process.env.DERIVED_LOG_DIR || DEFAULT_LOG_DIR
}

export function getDerivedLogPath(jobId: string): string {
  return path.join(getDerivedLogDir(), `${jobId}.log`)
}

export async function ensureDerivedLogStream(jobId: string): Promise<{ path: string; stream: WriteStream }> {
  const logDir = getDerivedLogDir()
  await mkdir(logDir, { recursive: true })
  const logPath = getDerivedLogPath(jobId)
  const stream = createWriteStream(logPath, { flags: 'a' })
  return { path: logPath, stream }
}

export function formatDerivedLogLine(prefix: string, level: string, args: unknown[]): string {
  const timestamp = new Date().toISOString()
  const rendered = args.map(renderLogArg).join(' ')
  return `${timestamp} ${level.toUpperCase()} ${prefix} ${rendered}`.trimEnd() + '\n'
}

function renderLogArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
