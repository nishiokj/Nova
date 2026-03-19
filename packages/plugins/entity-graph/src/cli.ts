#!/usr/bin/env node
/**
 * test-health CLI
 *
 * Standalone CLI that connects to entity-graph Postgres and reads test-health.yaml.
 * Commands: boundaries, deps, tree, env, gaps, init
 */

import postgres from 'postgres'
import path from 'path'
import { execSync } from 'child_process'
import { SCHEMA_DDL } from './schema.js'
import { TestHealthModule } from './test-health.js'
import { boundaries, callTreeFrom, depsOf, envVarsInTree, entitiesByNamePattern } from './queries.js'
import type { BoundaryInfo, DependencyInfo, EnvVarInfo, GapReport, ReadinessVerdict } from './test-health.js'
import type { Entity } from './types.js'
import type { Sql } from 'postgres'
import type { BoundaryCandidate, BoundaryDossier } from './skeptic/types.js'
import { ContractModule } from './contracts/module.js'
import type { ContractSummary, Contract, ContractStatus, ContractType } from './contracts/types.js'
import { contractsWithEntityDetails } from './contracts/queries.js'

// --- Arg Parsing ---

interface ParsedArgs {
  command: string | null
  positional: string[]
  flags: Record<string, string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2)
  const command = args[0] && !args[0].startsWith('--') ? args[0] : null
  const rest = command ? args.slice(1) : args
  const positional: string[] = []
  const flags: Record<string, string> = {}

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = rest[i + 1]
      if (!value || value.startsWith('--')) {
        flags[key] = 'true'
      } else {
        flags[key] = value
        i++
      }
    } else {
      positional.push(arg)
    }
  }

  return { command, positional, flags }
}

// --- Output Formatting ---

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length)
}

function formatBoundariesTable(infos: BoundaryInfo[]): string {
  const lines: string[] = []
  const header = `${padRight('BOUNDARY', 55)} ${padRight('FAN-IN', 8)} ${padRight('TESTS', 7)} STATUS`
  lines.push(header)

  for (const b of infos) {
    const id = b.entity.id.length > 53 ? b.entity.id.slice(0, 50) + '...' : b.entity.id
    lines.push(
      `${padRight(id, 55)} ${padRight(String(b.fanIn), 8)} ${padRight(b.hasTests ? 'yes' : 'no', 7)} ${b.readiness}`
    )
  }

  const ready = infos.filter(b => b.readiness === 'ready').length
  const blocked = infos.filter(b => b.readiness === 'blocked').length
  const unknown = infos.filter(b => b.readiness === 'unknown').length
  const tested = infos.filter(b => b.hasTests).length
  lines.push('')
  lines.push(`Totals: ${infos.length} boundaries, ${tested} tested, ${ready} ready, ${blocked} blocked, ${unknown} unknown`)

  return lines.join('\n')
}

function formatDeps(verdict: ReadinessVerdict): string {
  const lines: string[] = []
  const b = verdict.boundary
  const sig = b.paramsText ? `${b.name}${b.paramsText}` : b.name
  lines.push(`BOUNDARY: ${sig}`)
  lines.push('')

  if (verdict.deps.length > 0) {
    lines.push('DEPENDENCIES:')
    for (const dep of verdict.deps) {
      lines.push(`  ${dep.paramName}: ${dep.paramType ?? 'unknown'}`)
      if (dep.status === 'wirable' && dep.substitution) {
        lines.push(`    test: ${dep.substitution.testType} (${dep.substitution.testModule})   [wirable]`)
      } else if (dep.status === 'blocked' && dep.blocker) {
        lines.push(`    BLOCKED: ${dep.blocker.reason}`)
      } else {
        lines.push(`    [unknown — no registry entry]`)
      }
    }
    lines.push('')
  }

  if (verdict.envVars.length > 0) {
    lines.push('ENV VARS IN CALL TREE:')
    for (const env of verdict.envVars) {
      if (env.status === 'covered') {
        lines.push(`  ${padRight(env.varName, 20)} → covered by ${env.coveredBy}`)
      } else if (env.status === 'defaulted') {
        lines.push(`  ${padRight(env.varName, 20)} → defaulted to "${env.default}"`)
      } else {
        lines.push(`  ${padRight(env.varName, 20)} → UNMAPPED`)
      }
    }
    lines.push('')
  }

  lines.push(`VERDICT: ${verdict.ready ? 'ready' : 'blocked'}`)
  if (verdict.blockers.length > 0) {
    for (const blocker of verdict.blockers) {
      lines.push(`  - ${blocker}`)
    }
  }

  return lines.join('\n')
}

function formatTree(entityId: string, nodes: Array<{ entity: Entity; depth: number; sameModule: boolean; injected: boolean }>): string {
  const lines: string[] = []

  for (const node of nodes) {
    const indent = '  '.repeat(node.depth)
    const prefix = node.depth > 0 ? `${indent}├─ ` : ''
    const annotations: string[] = [`depth=${node.depth}`]
    if (node.sameModule) annotations.push('same_module')
    if (node.injected) annotations.push('injected')
    lines.push(`${prefix}${node.entity.name}    ${annotations.join('  ')}`)
  }

  return lines.join('\n')
}

function formatGaps(report: GapReport): string {
  const lines: string[] = []

  const untested = report.boundaries.filter(b => !b.hasTests)
  if (untested.length > 0) {
    lines.push('UNTESTED BOUNDARIES (by priority):')
    for (const b of untested) {
      const marker = b.readiness === 'ready' ? ' ← START HERE' : ''
      lines.push(`  ${padRight(b.entity.id, 55)} fan-in=${padRight(String(b.fanIn), 4)} ${b.readiness}${marker}`)
    }
    lines.push('')
  }

  const testedBlocked = report.boundaries.filter(b => b.hasTests && b.readiness === 'blocked')
  if (testedBlocked.length > 0) {
    lines.push('TESTED BUT BLOCKED:')
    for (const b of testedBlocked) {
      lines.push(`  ${b.entity.id}    fan-in=${b.fanIn}`)
    }
    lines.push('')
  }

  lines.push(`Totals: ${report.totalBoundaries} boundaries, ${report.tested} tested, ${report.ready} ready, ${report.blocked} blocked, ${report.unknown} unknown`)

  return lines.join('\n')
}

function formatSkepticTargets(candidates: BoundaryCandidate[]): string {
  const lines: string[] = []
  const header =
    `${padRight('SCORE', 7)} ${padRight('READY', 8)} ${padRight('RECENT', 7)} `
    + `${padRight('TESTS', 7)} ${padRight('FAN-IN', 7)} BOUNDARY`
  lines.push(header)

  for (const candidate of candidates) {
    lines.push(
      `${padRight(String(candidate.riskScore), 7)} ${padRight(candidate.readiness, 8)} `
      + `${padRight(candidate.recent ? 'yes' : 'no', 7)} ${padRight(String(candidate.testFileCount), 7)} `
      + `${padRight(String(candidate.fanIn), 7)} ${candidate.boundaryId}`
    )

    if (candidate.reasons.length > 0) {
      lines.push(`  reasons: ${candidate.reasons.join(', ')}`)
    }
  }

  if (candidates.length === 0) {
    lines.push('No boundary candidates found.')
  }

  return lines.join('\n')
}

function formatSkepticDossier(dossier: BoundaryDossier): string {
  const lines: string[] = []
  lines.push(`BOUNDARY: ${dossier.boundary.boundaryId}`)
  lines.push(`score=${dossier.boundary.riskScore} readiness=${dossier.boundary.readiness} tests=${dossier.testFiles.length} fan-in=${dossier.boundary.fanIn}`)
  lines.push('')
  lines.push(`Call tree nodes: ${dossier.callTree.totalNodes}`)
  lines.push(`Reachable seams: ${dossier.seamCoverage.reachableSeams}  overridden: ${dossier.seamCoverage.overriddenSeams}`)
  lines.push(`Semantic assertions: ${dossier.seamCoverage.semanticAssertions}  mock assertions: ${dossier.seamCoverage.mockInteractionAssertions}`)
  lines.push('')

  if (dossier.testCases.length > 0) {
    lines.push('TEST CASES:')
    for (const testCase of dossier.testCases) {
      const kinds = testCase.assertionKinds.join(', ') || 'none'
      const direct = testCase.touchesBoundaryDirectly ? 'direct' : testCase.touchesBoundaryModule ? 'module-only' : 'indirect'
      lines.push(`  ${testCase.file}:${testCase.lineStart} ${testCase.name} [${testCase.confidence}/${direct}]`)
      lines.push(`    assertions: ${kinds}`)
    }
    lines.push('')
  }

  if (dossier.assertionGaps.length > 0) {
    lines.push('GAPS:')
    for (const gap of dossier.assertionGaps) {
      lines.push(`  - ${gap}`)
    }
  } else {
    lines.push('GAPS:')
    lines.push('  - No concrete dossier gaps detected.')
  }

  return lines.join('\n')
}

function formatInit(report: GapReport, deps: Map<string, DependencyInfo[]>, envVars: Map<string, EnvVarInfo[]>): string {
  const lines: string[] = []

  lines.push(`Scanned ${report.totalBoundaries} boundaries.`)

  // Collect unique injectable types
  const types = new Set<string>()
  for (const depList of deps.values()) {
    for (const d of depList) {
      if (d.paramType) types.add(d.paramType)
    }
  }

  // Collect unique env vars
  const vars = new Set<string>()
  for (const envList of envVars.values()) {
    for (const e of envList) {
      vars.add(e.varName)
    }
  }

  lines.push(`Found ${types.size} unique injectable types: ${[...types].slice(0, 8).join(', ')}${types.size > 8 ? ', ...' : ''}`)
  lines.push(`Found ${vars.size} env var reads: ${[...vars].slice(0, 8).join(', ')}${vars.size > 8 ? ', ...' : ''}`)
  lines.push('')

  // Generate skeleton YAML
  lines.push('# test-health.yaml (skeleton — fill in test alternatives)')
  lines.push('version: 1')
  lines.push('')
  lines.push('substitutions:')
  for (const type of types) {
    lines.push(`  ${type}:`)
    lines.push(`    prod:`)
    lines.push(`      type: ${type}`)
    lines.push(`      module: # fill in`)
    lines.push(`      env: []`)
    lines.push(`    test:`)
    lines.push(`      type: # fill in test substitute`)
    lines.push(`      module: # fill in`)
    lines.push(`      env: []`)
  }
  lines.push('')
  lines.push('env_defaults:')
  lines.push('  NODE_ENV: test')
  for (const v of vars) {
    if (v !== 'NODE_ENV') lines.push(`  ${v}: # fill in default`)
  }
  lines.push('')
  lines.push('test_patterns:')
  lines.push('  - "**/*.test.ts"')
  lines.push('  - "**/*.spec.ts"')
  lines.push('  - "**/__tests__/**/*.ts"')
  lines.push('')
  lines.push('skeptic:')
  lines.push('  runner:')
  lines.push('    command: ["bunx", "vitest", "run"]')
  lines.push('    test_name_flag: "-t"')
  lines.push('    timeout_sec: 60')
  lines.push('    env: {}')
  lines.push('  mutation:')
  lines.push('    worktree_dir: ".tmp/test-red-team"')
  lines.push('    proposal_dir: ".tmp/test-red-team/proposals"')
  lines.push('    max_mutants_per_boundary: 2')
  lines.push('    max_boundaries_per_run: 5')
  lines.push('  selection:')
  lines.push('    prefer_recent: true')
  lines.push('    min_fan_in: 1')

  return lines.join('\n')
}

// --- Contract Formatting ---

function formatContractsList(contracts: Contract[]): string {
  if (contracts.length === 0) return 'No contracts found.'
  const lines: string[] = []
  const header = `${padRight('TYPE', 14)} ${padRight('SOURCE', 15)} ${padRight('STATUS', 12)} ${padRight('DEFENDED', 9)} ${padRight('CONF', 6)} STATEMENT`
  lines.push(header)
  for (const c of contracts) {
    const defended = c.testFilePath ? 'yes' : 'no'
    const stmt = c.statement.length > 50 ? c.statement.slice(0, 47) + '...' : c.statement
    lines.push(
      `${padRight(c.type, 14)} ${padRight(c.source, 15)} ${padRight(c.status, 12)} ${padRight(defended, 9)} ${padRight(c.confidence.toFixed(2), 6)} ${stmt}`
    )
  }
  return lines.join('\n')
}

function formatContractSummary(summary: ContractSummary): string {
  const lines: string[] = []
  lines.push(`Total contracts: ${summary.total}`)
  lines.push('')
  lines.push('By status:')
  for (const [status, count] of Object.entries(summary.byStatus)) {
    lines.push(`  ${padRight(status, 14)} ${count}`)
  }
  lines.push('')
  lines.push('By type:')
  for (const [type, count] of Object.entries(summary.byType)) {
    if (count > 0) lines.push(`  ${padRight(type, 14)} ${count}`)
  }
  lines.push('')
  lines.push('By source:')
  for (const [source, count] of Object.entries(summary.bySource)) {
    lines.push(`  ${padRight(source, 15)} ${count}`)
  }
  return lines.join('\n')
}

// --- Contract Commands ---

async function runContractsList(contracts: ContractModule, filepath?: string, status?: ContractStatus, type?: ContractType, json?: boolean): Promise<void> {
  let results: Contract[]
  if (filepath) results = await contracts.forFile(filepath)
  else if (status) results = await contracts.byStatus(status)
  else if (type) results = await contracts.byType(type)
  else results = (await contracts.withEntityDetails()).map(c => c as Contract)

  if (json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n')
  } else {
    process.stdout.write(formatContractsList(results) + '\n')
  }
}

async function runContractsSummary(contracts: ContractModule, json?: boolean): Promise<void> {
  const summary = await contracts.summary()
  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  } else {
    process.stdout.write(formatContractSummary(summary) + '\n')
  }
}

async function runContractsForEntity(contracts: ContractModule, entityId: string, json?: boolean): Promise<void> {
  const results = await contracts.forEntity(entityId)
  if (json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n')
  } else {
    process.stdout.write(formatContractsList(results) + '\n')
  }
}

async function runContractsCheck(contracts: ContractModule, sql: Sql, json?: boolean): Promise<void> {
  const summary = await contracts.summary()
  const dirty = await contracts.byStatus('dirty')
  const failing = await contracts.byStatus('failing')
  const insufficient = await contracts.byStatus('insufficient')

  // Coverage: % of boundaries with at least one contract
  const allContracts = await contractsWithEntityDetails(sql)
  const entitiesWithContracts = new Set<string>()
  for (const c of allContracts) {
    for (const link of c.entityLinks) {
      entitiesWithContracts.add(link.entityId)
    }
  }
  const boundaryRows = await boundaries(sql)
  const boundariesWithContracts = boundaryRows.filter(b => entitiesWithContracts.has(b.entity.id))
  const coverage = boundaryRows.length > 0
    ? ((boundariesWithContracts.length / boundaryRows.length) * 100).toFixed(1)
    : '0.0'

  if (json) {
    process.stdout.write(JSON.stringify({
      summary,
      dirtyCount: dirty.length,
      failingCount: failing.length,
      insufficientCount: insufficient.length,
      coverage: parseFloat(coverage),
      totalBoundaries: boundaryRows.length,
      boundariesWithContracts: boundariesWithContracts.length,
    }, null, 2) + '\n')
  } else {
    const lines: string[] = []
    lines.push(`Contract Check Report`)
    lines.push(``)
    lines.push(`Total contracts: ${summary.total}`)
    lines.push(`  Dirty:        ${dirty.length}`)
    lines.push(`  Failing:      ${failing.length}`)
    lines.push(`  Insufficient: ${insufficient.length}`)
    lines.push(`  Passing:      ${summary.byStatus.passing}`)
    lines.push(``)
    lines.push(`Coverage: ${coverage}% of boundaries have contracts (${boundariesWithContracts.length}/${boundaryRows.length})`)

    if (dirty.length > 0) {
      lines.push(``)
      lines.push(`Dirty contracts:`)
      for (const c of dirty.slice(0, 10)) {
        lines.push(`  - ${c.statement}`)
      }
      if (dirty.length > 10) lines.push(`  ... and ${dirty.length - 10} more`)
    }

    if (failing.length > 0) {
      lines.push(``)
      lines.push(`Failing contracts:`)
      for (const c of failing.slice(0, 10)) {
        lines.push(`  - ${c.statement}`)
      }
    }

    process.stdout.write(lines.join('\n') + '\n')
  }
}

// --- Commands ---

async function runBoundaries(module: TestHealthModule, filepath?: string, json?: boolean): Promise<void> {
  const infos = await module.boundaries(filepath)
  if (json) {
    process.stdout.write(JSON.stringify(infos, null, 2) + '\n')
  } else {
    process.stdout.write(formatBoundariesTable(infos) + '\n')
  }
}

async function runDeps(module: TestHealthModule, entityId: string, json?: boolean): Promise<void> {
  const verdict = await module.readiness(entityId)
  if (json) {
    process.stdout.write(JSON.stringify(verdict, null, 2) + '\n')
  } else {
    process.stdout.write(formatDeps(verdict) + '\n')
  }
}

async function runTree(module: TestHealthModule, entityId: string, maxDepth?: number, json?: boolean): Promise<void> {
  const nodes = await module.callTree(entityId, maxDepth)
  if (json) {
    process.stdout.write(JSON.stringify(nodes, null, 2) + '\n')
  } else {
    process.stdout.write(formatTree(entityId, nodes) + '\n')
  }
}

async function runEnv(module: TestHealthModule, entityId: string, json?: boolean): Promise<void> {
  const verdict = await module.readiness(entityId)
  if (json) {
    process.stdout.write(JSON.stringify({ envVars: verdict.envVars, blockers: verdict.blockers, ready: verdict.ready }, null, 2) + '\n')
  } else {
    process.stdout.write(formatDeps(verdict) + '\n')
  }
}

async function runGaps(module: TestHealthModule, filepath?: string, json?: boolean): Promise<void> {
  const report = await module.gaps(filepath)
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(formatGaps(report) + '\n')
  }
}

async function runIndex(module: TestHealthModule, opts: {
  repoRoot: string
  filepath?: string
  maxDepth?: number
}): Promise<void> {
  let commit = ''
  try {
    commit = execSync('git rev-parse HEAD', { cwd: opts.repoRoot, encoding: 'utf-8' }).trim()
  } catch { /* not a git repo */ }

  const index = await module.buildIndex({
    repoRoot: opts.repoRoot,
    commit,
    filepath: opts.filepath,
    maxDepth: opts.maxDepth,
  })

  process.stdout.write(JSON.stringify(index, null, 2) + '\n')
}

async function runInit(module: TestHealthModule, json?: boolean): Promise<void> {
  const report = await module.gaps()
  const deps = new Map<string, DependencyInfo[]>()
  const envVars = new Map<string, EnvVarInfo[]>()

  for (const b of report.boundaries) {
    const d = await module.depsFor(b.entity.id)
    const e = await module.envVarsFor(b.entity.id)
    deps.set(b.entity.id, d)
    envVars.set(b.entity.id, e)
  }

  if (json) {
    const types = new Set<string>()
    for (const depList of deps.values()) for (const d of depList) if (d.paramType) types.add(d.paramType)
    const vars = new Set<string>()
    for (const envList of envVars.values()) for (const e of envList) vars.add(e.varName)
    process.stdout.write(JSON.stringify({ boundaries: report.totalBoundaries, types: [...types], envVars: [...vars] }, null, 2) + '\n')
  } else {
    process.stdout.write(formatInit(report, deps, envVars) + '\n')
  }
}

async function runSkepticTargets(
  module: TestHealthModule,
  selector?: string,
  maxDepth?: number,
  json?: boolean,
): Promise<void> {
  const targets = await module.skepticTargets(selector, { maxDepth })
  if (json) {
    process.stdout.write(JSON.stringify(targets, null, 2) + '\n')
  } else {
    process.stdout.write(formatSkepticTargets(targets) + '\n')
  }
}

async function runSkepticDossier(
  module: TestHealthModule,
  boundaryId: string,
  maxDepth?: number,
  json?: boolean,
): Promise<void> {
  const dossier = await module.skepticDossier(boundaryId, { maxDepth })
  if (json) {
    process.stdout.write(JSON.stringify(dossier, null, 2) + '\n')
  } else {
    process.stdout.write(formatSkepticDossier(dossier) + '\n')
  }
}

// --- Usage ---

function usage(): string {
  return [
    'test-health — Test readiness analysis from the entity graph',
    '',
    'Commands:',
    '  test-health boundaries [filepath]        List boundaries with fan-in and readiness',
    '  test-health deps <entity-id>             Show dependency wiring for a boundary',
    '  test-health tree <entity-id>             Show call tree from a boundary',
    '  test-health env <entity-id>              Check environment readiness',
    '  test-health gaps [filepath]              Show untested/blocked boundaries',
    '  test-health index [filepath]             Build project index (JSON)',
    '  test-health init                         Generate test-health.yaml skeleton',
    '  test-health skeptic-targets [selector]   Rank skeptic boundary candidates',
    '  test-health skeptic-dossier <entity-id>  Build a skeptic dossier for one boundary',
    '',
    '  test-health entities search <pattern>   Find entities by name pattern',
    '',
    '  test-health contracts list [filepath]   List contracts (--status, --type filters)',
    '  test-health contracts summary           Contract status/type/source breakdown',
    '  test-health contracts for <entity-id>   Contracts linked to an entity',
    '  test-health contracts compile [id]       Compile contracts into verification plans',
    '  test-health contracts check             Report dirty/failing/insufficient + coverage',
    '  test-health contracts dirty             List dirty contracts (alias: stale)',
    '  test-health contracts verify            Run tests for dirty/failing contracts',
    '',
    'Options:',
    '  --json                    Output as JSON',
    '  --db <url>                Postgres connection URL (default: DATABASE_URL env)',
    '  --source-root <path>      Source root directory (default: cwd)',
    '  --registry <path>         Path to test-health.yaml (default: <source-root>/test-health.yaml)',
    '  --max-depth <n>           Max call tree depth (default: 10)',
    '',
    'Examples:',
    '  test-health boundaries src/orders/',
    '  test-health deps function:src/orders/process.ts:processOrder',
    '  test-health tree function:src/orders/process.ts:processOrder --max-depth 5',
    '  test-health gaps --json',
    '  test-health init',
    '  test-health skeptic-targets recent --json',
    '  test-health skeptic-dossier function:src/orders/process.ts:processOrder --json',
  ].join('\n')
}

// --- Main ---

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv)

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage() + '\n')
    return
  }

  const dbUrl = flags.db ?? process.env.DATABASE_URL
  if (!dbUrl) {
    process.stderr.write('Error: No database URL. Set DATABASE_URL or pass --db <url>\n')
    process.exit(1)
  }

  const sourceRoot = flags['source-root'] ?? process.cwd()
  const registryPath = flags.registry
  const json = flags.json === 'true'
  const maxDepth = flags['max-depth'] ? parseInt(flags['max-depth'], 10) : undefined

  const sql = postgres(dbUrl, { max: 2, onnotice: () => {} })

  try {
    // Ensure schema exists
    await sql.unsafe(SCHEMA_DDL)

    const module = new TestHealthModule(sql, sourceRoot, registryPath)

    switch (command) {
      case 'boundaries':
        await runBoundaries(module, positional[0], json)
        break
      case 'deps':
        if (!positional[0]) { process.stderr.write('Error: deps requires an entity ID\n'); process.exit(1) }
        await runDeps(module, positional[0], json)
        break
      case 'tree':
        if (!positional[0]) { process.stderr.write('Error: tree requires an entity ID\n'); process.exit(1) }
        await runTree(module, positional[0], maxDepth, json)
        break
      case 'env':
        if (!positional[0]) { process.stderr.write('Error: env requires an entity ID\n'); process.exit(1) }
        await runEnv(module, positional[0], json)
        break
      case 'gaps':
        await runGaps(module, positional[0], json)
        break
      case 'index':
        await runIndex(module, { repoRoot: sourceRoot, filepath: positional[0], maxDepth })
        break
      case 'init':
        await runInit(module, json)
        break
      case 'skeptic-targets':
        await runSkepticTargets(module, positional[0], maxDepth, json)
        break
      case 'skeptic-dossier':
        if (!positional[0]) { process.stderr.write('Error: skeptic-dossier requires an entity ID\n'); process.exit(1) }
        await runSkepticDossier(module, positional[0], maxDepth, json)
        break
      case 'contracts': {
        const contractModule = new ContractModule(sql, sourceRoot)
        const subcommand = positional[0]
        if (!subcommand || subcommand === 'list') {
          await runContractsList(
            contractModule,
            positional[1],
            flags.status as ContractStatus | undefined,
            flags.type as ContractType | undefined,
            json,
          )
        } else if (subcommand === 'summary') {
          await runContractsSummary(contractModule, json)
        } else if (subcommand === 'for') {
          if (!positional[1]) { process.stderr.write('Error: contracts for requires an entity ID\n'); process.exit(1) }
          await runContractsForEntity(contractModule, positional[1], json)
        } else if (subcommand === 'compile') {
          process.stdout.write('Contract compilation is now handled by /capture and /test-blue-team skills.\n')
        } else if (subcommand === 'check') {
          await runContractsCheck(contractModule, sql, json)
        } else if (subcommand === 'stale' || subcommand === 'dirty') {
          const dirty = await contractModule.byStatus('dirty')
          if (json) {
            process.stdout.write(JSON.stringify(dirty, null, 2) + '\n')
          } else {
            process.stdout.write(formatContractsList(dirty) + '\n')
          }
        } else if (subcommand === 'verify') {
          const { execSync: exec } = await import('child_process')
          const result = await contractModule.verify(async (testFilePath: string) => {
            try {
              const output = exec(`bun test ${testFilePath}`, {
                encoding: 'utf-8',
                timeout: 60_000,
                stdio: ['pipe', 'pipe', 'pipe'],
              })
              return { passed: true, output }
            } catch (err: unknown) {
              const e = err as { stdout?: string; stderr?: string }
              return { passed: false, output: (e.stdout ?? '') + (e.stderr ?? '') }
            }
          })
          if (json) {
            process.stdout.write(JSON.stringify(result, null, 2) + '\n')
          } else {
            const lines: string[] = []
            lines.push(`Verified ${result.total} contract(s): ${result.passed} passed, ${result.failed} failed`)
            const failures = result.results.filter(r => r.newStatus !== 'passing')
            if (failures.length > 0) {
              lines.push('')
              lines.push('Failures:')
              for (const r of failures) {
                lines.push(`  - [${r.contractId.slice(0, 8)}] ${r.statement}`)
                lines.push(`    status: ${r.previousStatus} → ${r.newStatus}`)
                if (r.acknowledgementInvalidated) lines.push(`    ack invalidated`)
                if (r.openChallenges > 0) lines.push(`    open challenges: ${r.openChallenges}`)
              }
            }
            process.stdout.write(lines.join('\n') + '\n')
          }
        } else {
          process.stderr.write(`Unknown contracts subcommand: ${subcommand}\n`)
          process.exit(1)
        }
        break
      }
      case 'entities': {
        const subcommand = positional[0]
        if (subcommand === 'search') {
          if (!positional[1]) { process.stderr.write('Error: entities search requires a pattern\n'); process.exit(1) }
          const results = await entitiesByNamePattern(sql, positional[1])
          if (json) {
            process.stdout.write(JSON.stringify(results, null, 2) + '\n')
          } else {
            if (results.length === 0) {
              process.stdout.write('No entities found.\n')
            } else {
              const lines: string[] = []
              lines.push(`${padRight('KIND', 10)} ${padRight('NAME', 30)} ${padRight('EXPORTED', 9)} ID`)
              for (const e of results) {
                lines.push(`${padRight(e.kind, 10)} ${padRight(e.name, 30)} ${padRight(e.exported ? 'yes' : 'no', 9)} ${e.id}`)
              }
              lines.push('')
              lines.push(`${results.length} entities found.`)
              process.stdout.write(lines.join('\n') + '\n')
            }
          }
        } else {
          process.stderr.write(`Unknown entities subcommand: ${subcommand}\n`)
          process.exit(1)
        }
        break
      }
      default:
        process.stderr.write(`Unknown command: ${command}\n`)
        process.stderr.write(usage() + '\n')
        process.exit(1)
    }
  } finally {
    await sql.end()
  }
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`test-health error: ${message}\n`)
  process.exit(1)
})
