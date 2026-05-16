import type { ServiceConfig } from './types.js'

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing ${name}`)
  }
  return value
}

export function loadConfigFromEnv(): ServiceConfig {
  return {
    port: parsePositiveInt(process.env.PORT, 8080),
    host: process.env.HOST?.trim() || '127.0.0.1',
    databaseUrl: requireEnv('METAREPO_DATABASE_URL'),
    workdir: requireEnv('METAREPO_WORKDIR'),
    gitBin: process.env.GIT_BIN ?? 'git',
    requestTimeoutMs: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS, 15 * 60 * 1000),
    secretMasterKey: requireEnv('METAREPO_SECRET_MASTER_KEY'),
  }
}
