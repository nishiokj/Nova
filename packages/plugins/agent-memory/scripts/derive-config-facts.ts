#!/usr/bin/env bun
/**
 * Derive config facts from .env files, config/*.json, and package.json.
 *
 * Usage:
 *   bun run scripts/derive-config-facts.ts --root /path/to/repo
 *
 * Environment:
 *   DATABASE_URL or PG* vars for agent-memory database
 */

import { readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { createDatabaseFromEnv, createRepositoryContext } from '../src/db/index.js'
import { createConfigFactsRepository, type ConfigFactInput, type ConfigType } from '../src/db/repositories/config-facts.js'
import { stableStringify } from '../src/stable-stringify.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(__dirname, '../../../')

const SENSITIVE_KEY_PATTERN = /(API_KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE|AUTH|COOKIE|CREDENTIAL|KEY)$/i
const SENSITIVE_VALUE_PATTERN = /(-----BEGIN|sk-|rk-|pk-|whsec_|ghp_|gho_|ya29\.)/i

interface CliOptions {
  root: string
  dryRun: boolean
  verbose: boolean
}

function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', short: 'r' },
      'dry-run': { type: 'boolean', short: 'n', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: false,
  })
  return {
    root: values.root ? resolve(values.root) : DEFAULT_ROOT,
    dryRun: values['dry-run'] ?? false,
    verbose: values.verbose ?? false,
  }
}

function toPosixPath(path: string): string {
  return path.split('\\').join('/')
}

function inferValueType(value: unknown): ValueType {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'object'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'object'
  }
}

function hashValue(value: unknown): string {
  const payload = stableStringify(value)
  return createHash('sha256').update(payload).digest('hex')
}

function isSensitiveKey(keyPath: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(keyPath)
}

function isSensitiveValue(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.length >= 20 && /^[A-Za-z0-9_\\-]+$/.test(value)) return true
  return SENSITIVE_VALUE_PATTERN.test(value)
}

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  return '[REDACTED]'
}

function parseEnvValue(raw: string): string | number | boolean {
  const trimmed = raw.trim()
  const unquoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed

  if (/^(true|false)$/i.test(unquoted)) {
    return unquoted.toLowerCase() === 'true'
  }
  if (/^-?\\d+(?:\\.\\d+)?$/.test(unquoted)) {
    const num = Number(unquoted)
    return Number.isFinite(num) ? num : unquoted
  }
  return unquoted
}

function stripJsonComments(content: string): string {
  return content
    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')
    .replace(/(^|[^:])\\/\\/.*$/gm, '$1')
}

function flattenObject(value: unknown, prefix = ''): Array<{ key: string; value: unknown }> {
  const items: Array<{ key: string; value: unknown }> = []
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const [key, child] of Object.entries(obj)) {
      const next = prefix ? `${prefix}.${key}` : key
      items.push(...flattenObject(child, next))
    }
    return items
  }
  items.push({ key: prefix, value })
  return items
}

async function globFiles(root: string, patterns: string[]): Promise<string[]> {
  const results = new Set<string>()
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern)
    for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
      const rel = toPosixPath(file)
      if (rel.includes('node_modules/') || rel.includes('dist/') || rel.includes('.git/')) continue
      results.add(rel)
    }
  }
  return [...results]
}

async function collectEnvFacts(root: string): Promise<ConfigFactInput[]> {
  const envFiles = await globFiles(root, ['.env', '.env.*'])
  const facts: ConfigFactInput[] = []

  for (const relPath of envFiles) {
    const absPath = join(root, relPath)
    const content = await readFile(absPath, 'utf-8')
    const lines = content.split('\\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line || line.startsWith('#')) continue
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (!match) continue
      const [, key, rawValue] = match
      const value = parseEnvValue(rawValue)
      const keyPath = key
      const sensitive = true // .env values are always sensitive
      const fact: ConfigFactInput = {
        key_path: keyPath,
        config_type: 'env_var',
        value_type: inferValueType(value),
        default_value: null,
        current_value: sensitive ? null : value,
        redacted_value: sensitive ? redactValue(value) : value,
        value_hash: hashValue(value),
        is_sensitive: sensitive,
        redaction_reason: sensitive ? 'env_file' : null,
        description: null,
        source_file: relPath,
        source_line: i + 1,
        affects_entity_ids: [],
        discovery_method: 'static_analysis',
      }
      facts.push(fact)
    }
  }

  return facts
}

async function collectJsonConfigFacts(root: string): Promise<ConfigFactInput[]> {
  const configFiles = await globFiles(root, ['config/**/*.json'])
  const facts: ConfigFactInput[] = []

  for (const relPath of configFiles) {
    const absPath = join(root, relPath)
    let content: string
    try {
      content = await readFile(absPath, 'utf-8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(stripJsonComments(content))
    } catch {
      continue
    }

    for (const { key, value } of flattenObject(parsed)) {
      if (!key) continue
      const keyPath = key
      const sensitive = isSensitiveKey(keyPath) || isSensitiveValue(value)
      const fact: ConfigFactInput = {
        key_path: keyPath,
        config_type: 'runtime_config',
        value_type: inferValueType(value),
        default_value: value,
        current_value: null,
        redacted_value: sensitive ? redactValue(value) : value,
        value_hash: hashValue(value),
        is_sensitive: sensitive,
        redaction_reason: sensitive ? 'key_or_value_pattern' : null,
        description: null,
        source_file: relPath,
        source_line: null,
        affects_entity_ids: [],
        discovery_method: 'static_analysis',
      }
      facts.push(fact)
    }
  }

  return facts
}

async function collectPackageJsonFacts(root: string): Promise<ConfigFactInput[]> {
  const packageFiles = await globFiles(root, ['**/package.json'])
  const facts: ConfigFactInput[] = []

  for (const relPath of packageFiles) {
    if (relPath.includes('node_modules/')) continue
    const absPath = join(root, relPath)
    let parsed: unknown
    try {
      const content = await readFile(absPath, 'utf-8')
      parsed = JSON.parse(content)
    } catch {
      continue
    }
    const pkg = parsed as Record<string, unknown>
    if (!pkg.config || typeof pkg.config !== 'object' || Array.isArray(pkg.config)) {
      continue
    }

    for (const { key, value } of flattenObject(pkg.config, 'config')) {
      if (!key) continue
      const keyPath = key
      const sensitive = isSensitiveKey(keyPath) || isSensitiveValue(value)
      const fact: ConfigFactInput = {
        key_path: keyPath,
        config_type: 'build_config',
        value_type: inferValueType(value),
        default_value: value,
        current_value: null,
        redacted_value: sensitive ? redactValue(value) : value,
        value_hash: hashValue(value),
        is_sensitive: sensitive,
        redaction_reason: sensitive ? 'key_or_value_pattern' : null,
        description: null,
        source_file: relPath,
        source_line: null,
        affects_entity_ids: [],
        discovery_method: 'static_analysis',
      }
      facts.push(fact)
    }
  }

  return facts
}

function withContext(configType: ConfigType, facts: ConfigFactInput[]): ConfigFactInput[] {
  return facts.map((fact) => ({
    ...fact,
    config_type: configType,
  }))
}

async function main() {
  const options = parseCliArgs()
  const db = createDatabaseFromEnv()
  const repo = createConfigFactsRepository(createRepositoryContext(db.sql))

  console.log(`[derive-config-facts] root=${options.root}`)

  const envFacts = await collectEnvFacts(options.root)
  const jsonFacts = await collectJsonConfigFacts(options.root)
  const pkgFacts = await collectPackageJsonFacts(options.root)

  const allFacts = [
    ...withContext('env_var', envFacts),
    ...withContext('runtime_config', jsonFacts),
    ...withContext('build_config', pkgFacts),
  ]

  if (options.verbose) {
    console.log(`[derive-config-facts] env=${envFacts.length} json=${jsonFacts.length} pkg=${pkgFacts.length}`)
  }

  let written = 0
  if (!options.dryRun) {
    for (const fact of allFacts) {
      await repo.upsert(fact)
      written++
    }
  }

  console.log(`[derive-config-facts] ${options.dryRun ? 'dry-run' : 'upserted'} ${options.dryRun ? allFacts.length : written} facts`)
  await db.close()
}

main().catch((err) => {
  console.error('[derive-config-facts] failed', err)
  process.exit(1)
})
