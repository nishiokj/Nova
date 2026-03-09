/**
 * Test Health Module
 *
 * Sits between the entity graph and the CLI/skill. Orchestrates queries
 * and produces structured results for test readiness analysis.
 */

import { readFile } from 'fs/promises'
import path from 'path'
import type { Sql } from 'postgres'
import type { Entity } from './types.js'
import {
  boundaries as queryBoundaries,
  callTreeFrom,
  envVarsInTree,
  depsOf,
  testFilesFor,
} from './queries.js'
import type { CallTreeRow, BoundaryRow, DepRow, EnvVarRow } from './queries.js'

// --- Registry Types ---

export interface SubstitutionEntry {
  prod: {
    type: string
    module: string
    env: string[]
  }
  test?: {
    type: string
    module: string
    env: string[]
    setup?: string
    inspect?: string
    teardown?: string
  }
  blocker?: {
    reason: string
  }
}

export interface SubstitutionRegistry {
  version: number
  substitutions: Record<string, SubstitutionEntry>
  envDefaults: Record<string, string>
  testPatterns: string[]
}

// --- Test Health Result Types ---

export interface BoundaryInfo {
  entity: Entity
  fanIn: number
  hasTests: boolean
  readiness: 'ready' | 'blocked' | 'unknown'
}

export interface CallTreeNode {
  entity: Entity
  depth: number
  sameModule: boolean
  injected: boolean
  paramName?: string
  paramType?: string
}

export interface DependencyInfo {
  paramName: string
  paramType: string | null
  substitution?: {
    testType: string
    testModule: string
    setup: string
    inspect: string
    teardown?: string
  }
  blocker?: {
    reason: string
  }
  status: 'wirable' | 'blocked' | 'unknown'
}

export interface EnvVarInfo {
  varName: string
  accessor: string
  readBy: Entity
  coveredBy?: string
  default?: string
  status: 'covered' | 'defaulted' | 'unmapped'
}

export interface ReadinessVerdict {
  boundary: Entity
  ready: boolean
  deps: DependencyInfo[]
  envVars: EnvVarInfo[]
  blockers: string[]
  testFiles: Entity[]
}

export interface GapReport {
  totalBoundaries: number
  tested: number
  ready: number
  blocked: number
  unknown: number
  boundaries: BoundaryInfo[]
}

// --- Registry Loading ---

/**
 * Parse a test-health.yaml file into a SubstitutionRegistry.
 * Uses a simple YAML subset parser to avoid heavy dependencies.
 */
export async function loadRegistry(registryPath: string): Promise<SubstitutionRegistry> {
  let content: string
  try {
    content = await readFile(registryPath, 'utf-8')
  } catch {
    // No registry file → empty registry
    return { version: 1, substitutions: {}, envDefaults: {}, testPatterns: [] }
  }

  return parseRegistryYaml(content)
}

/**
 * Minimal YAML parser for the test-health.yaml format.
 * Handles the specific structure we need without a full YAML library.
 */
export function parseRegistryYaml(content: string): SubstitutionRegistry {
  const registry: SubstitutionRegistry = {
    version: 1,
    substitutions: {},
    envDefaults: {},
    testPatterns: [],
  }

  const lines = content.split('\n')
  let i = 0

  // State machine for parsing
  type Section = 'root' | 'substitutions' | 'sub_entry' | 'sub_prod' | 'sub_test' | 'env_defaults' | 'test_patterns'
  let section: Section = 'root'
  let currentSubName = ''
  let currentSub: Partial<SubstitutionEntry> = {}
  let currentProd: Partial<SubstitutionEntry['prod']> = {}
  let currentTest: Record<string, unknown> = {}
  let multilineKey = ''
  let multilineValue = ''
  let multilineIndent = 0

  function flushSub() {
    if (currentSubName) {
      if (currentProd.type) {
        currentSub.prod = {
          type: currentProd.type,
          module: (currentProd.module as string) ?? '',
          env: (currentProd.env as string[]) ?? [],
        }
      }
      if ((currentTest as Record<string, unknown>).type) {
        currentSub.test = {
          type: currentTest.type as string,
          module: (currentTest.module as string) ?? '',
          env: (currentTest.env as string[]) ?? [],
          setup: currentTest.setup as string | undefined,
          inspect: currentTest.inspect as string | undefined,
          teardown: currentTest.teardown as string | undefined,
        }
      }
      if (currentTest.blocker === true || currentTest.blocker === 'true') {
        currentSub.blocker = { reason: (currentTest.reason as string) ?? 'No test substitute available.' }
      }
      registry.substitutions[currentSubName] = currentSub as SubstitutionEntry
    }
    currentSubName = ''
    currentSub = {}
    currentProd = {}
    currentTest = {}
  }

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length

    // Handle multiline values (| syntax)
    if (multilineKey) {
      if (indent > multilineIndent && trimmed.length > 0) {
        multilineValue += (multilineValue ? '\n' : '') + trimmed
        i++
        continue
      } else {
        // End of multiline
        if (section === 'sub_prod') {
          (currentProd as Record<string, unknown>)[multilineKey] = multilineValue
        } else if (section === 'sub_test') {
          currentTest[multilineKey] = multilineValue
        }
        multilineKey = ''
        multilineValue = ''
      }
    }

    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed.length === 0) { i++; continue }

    // Parse key: value
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) {
      // List item: - "value"
      if (trimmed.startsWith('- ')) {
        const val = trimmed.slice(2).trim().replace(/^["']|["']$/g, '')
        if (section === 'test_patterns') {
          registry.testPatterns.push(val)
        } else if (section === 'sub_prod' && multilineKey === '') {
          // Array value for env
          if (!currentProd.env) (currentProd as Record<string, unknown>).env = []
          ;(currentProd.env as string[]).push(val)
        } else if (section === 'sub_test') {
          if (!currentTest.env) currentTest.env = []
          ;(currentTest.env as string[]).push(val)
        }
      }
      i++
      continue
    }

    const key = trimmed.slice(0, colonIdx).trim()
    let value = trimmed.slice(colonIdx + 1).trim()

    // Check for multiline indicator
    if (value === '|') {
      multilineKey = key
      multilineIndent = indent
      multilineValue = ''
      i++
      continue
    }

    // Strip inline comments
    const commentIdx = value.indexOf(' #')
    if (commentIdx > 0) value = value.slice(0, commentIdx).trim()

    // Remove quotes
    value = value.replace(/^["']|["']$/g, '')

    // Handle array value: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const arr = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      if (section === 'sub_prod') {
        (currentProd as Record<string, unknown>)[key] = arr
      } else if (section === 'sub_test') {
        currentTest[key] = arr
      }
      i++
      continue
    }

    // Root-level keys
    if (indent === 0) {
      if (key === 'version') registry.version = parseInt(value, 10)
      else if (key === 'substitutions') { flushSub(); section = 'substitutions' }
      else if (key === 'env_defaults') { flushSub(); section = 'env_defaults' }
      else if (key === 'test_patterns') { flushSub(); section = 'test_patterns' }
      i++
      continue
    }

    // Substitutions section
    if (section === 'substitutions' && indent === 2 && value === '') {
      flushSub()
      currentSubName = key
      section = 'sub_entry'
      i++
      continue
    }

    if (section === 'sub_entry') {
      if (key === 'prod' && value === '') { section = 'sub_prod'; i++; continue }
      if (key === 'test' && value === '') { section = 'sub_test'; i++; continue }
      // Single-line blocker-style test
      if (indent === 4) {
        if (key === 'blocker') currentTest.blocker = value === 'true'
        else if (key === 'reason') currentTest.reason = value
      }
      i++
      continue
    }

    if (section === 'sub_prod') {
      if (indent <= 4 && key === 'test') { section = 'sub_test'; i++; continue }
      if (indent <= 2 && key !== 'type' && key !== 'module' && key !== 'env') {
        // Exited prod section
        if (key === 'prod') { section = 'sub_prod'; i++; continue }
        if (value === '') { flushSub(); currentSubName = key; section = 'sub_entry'; i++; continue }
      }
      (currentProd as Record<string, unknown>)[key] = value
      i++
      continue
    }

    if (section === 'sub_test') {
      if (indent <= 2) {
        // Exited test section
        if (value === '') { flushSub(); currentSubName = key; section = 'sub_entry'; i++; continue }
        section = 'substitutions'
      } else {
        currentTest[key] = value === 'true' ? true : value === 'false' ? false : value
        i++
        continue
      }
    }

    if (section === 'env_defaults') {
      if (indent >= 2) {
        registry.envDefaults[key] = value
      }
    }

    i++
  }

  flushSub()

  return registry
}

// --- Test Health Module ---

export class TestHealthModule {
  constructor(
    private sql: Sql,
    private sourceRoot: string,
    private registryPath?: string,
  ) {}

  private _registry: SubstitutionRegistry | null = null

  async getRegistry(): Promise<SubstitutionRegistry> {
    if (!this._registry) {
      const regPath = this.registryPath ?? path.join(this.sourceRoot, 'test-health.yaml')
      this._registry = await loadRegistry(regPath)
    }
    return this._registry
  }

  /**
   * List all boundaries, optionally filtered to a file.
   */
  async boundaries(filepath?: string): Promise<BoundaryInfo[]> {
    const boundaryRows = await queryBoundaries(this.sql, filepath)
    const results: BoundaryInfo[] = []

    for (const b of boundaryRows) {
      const tests = await testFilesFor(this.sql, b.entity.id)
      const verdict = await this.readiness(b.entity.id)
      results.push({
        entity: b.entity,
        fanIn: b.fanIn,
        hasTests: tests.length > 0,
        readiness: verdict.ready ? 'ready' : verdict.blockers.length > 0 ? 'blocked' : 'unknown',
      })
    }

    return results
  }

  /**
   * Get the call tree from a boundary.
   */
  async callTree(entityId: string, maxDepth?: number): Promise<CallTreeNode[]> {
    const rows = await callTreeFrom(this.sql, entityId, maxDepth)
    return rows.map(r => ({
      entity: r.entity,
      depth: r.depth,
      sameModule: r.sameModule,
      injected: r.injected,
    }))
  }

  /**
   * Get the dependencies of a boundary with registry cross-reference.
   */
  async depsFor(entityId: string): Promise<DependencyInfo[]> {
    const deps = await depsOf(this.sql, entityId)
    const registry = await this.getRegistry()

    return deps.map(dep => resolveDep(dep, registry))
  }

  /**
   * Get env vars read in a boundary's call tree with registry cross-reference.
   */
  async envVarsFor(entityId: string): Promise<EnvVarInfo[]> {
    const vars = await envVarsInTree(this.sql, entityId)
    const registry = await this.getRegistry()
    const entityCache = new Map<string, Entity>()

    const results: EnvVarInfo[] = []
    for (const v of vars) {
      // Resolve the reading entity (for display)
      let readBy = entityCache.get(v.entityId)
      if (!readBy) {
        const [row] = await this.sql<[{ id: string; kind: string; name: string; filepath: string; start_line: number | null; end_line: number | null; exported: boolean; async: boolean; raw_text: string | null; params_text: string | null; return_text: string | null }?]>`
          SELECT * FROM entity_graph.entities WHERE id = ${v.entityId}
        `
        if (row) {
          readBy = {
            id: row.id,
            kind: row.kind as Entity['kind'],
            name: row.name,
            filepath: row.filepath,
            startLine: row.start_line,
            endLine: row.end_line,
            exported: row.exported,
            async: row.async,
            rawText: row.raw_text,
            paramsText: row.params_text,
            returnText: row.return_text,
          }
          entityCache.set(v.entityId, readBy)
        }
      }
      if (!readBy) continue

      const info = resolveEnvVar(v, registry, readBy)
      results.push(info)
    }

    return results
  }

  /**
   * Full readiness verdict for a boundary.
   */
  async readiness(entityId: string): Promise<ReadinessVerdict> {
    const [entity] = await this.sql<[{ id: string; kind: string; name: string; filepath: string; start_line: number | null; end_line: number | null; exported: boolean; async: boolean; raw_text: string | null; params_text: string | null; return_text: string | null }?]>`
      SELECT * FROM entity_graph.entities WHERE id = ${entityId}
    `
    if (!entity) {
      return {
        boundary: { id: entityId, kind: 'function', name: '', filepath: '', startLine: null, endLine: null, exported: false, async: false, rawText: null, paramsText: null, returnText: null },
        ready: false,
        deps: [],
        envVars: [],
        blockers: ['Entity not found'],
        testFiles: [],
      }
    }

    const boundaryEntity: Entity = {
      id: entity.id,
      kind: entity.kind as Entity['kind'],
      name: entity.name,
      filepath: entity.filepath,
      startLine: entity.start_line,
      endLine: entity.end_line,
      exported: entity.exported,
      async: entity.async,
      rawText: entity.raw_text,
      paramsText: entity.params_text,
      returnText: entity.return_text,
    }

    const deps = await this.depsFor(entityId)
    const envVars = await this.envVarsFor(entityId)
    const testFiles = await testFilesFor(this.sql, entityId)

    const blockers: string[] = []
    for (const dep of deps) {
      if (dep.status === 'blocked') {
        blockers.push(`${dep.paramName}: ${dep.paramType ?? 'unknown type'} — ${dep.blocker?.reason ?? 'blocked'}`)
      } else if (dep.status === 'unknown') {
        blockers.push(`${dep.paramName}: ${dep.paramType ?? 'unknown type'} — no registry entry`)
      }
    }
    for (const env of envVars) {
      if (env.status === 'unmapped') {
        blockers.push(`env var ${env.varName} — not mapped in registry`)
      }
    }

    return {
      boundary: boundaryEntity,
      ready: blockers.length === 0,
      deps,
      envVars,
      blockers,
      testFiles,
    }
  }

  /**
   * Gap report — boundaries without tests or with blockers.
   */
  async gaps(filepath?: string): Promise<GapReport> {
    const infos = await this.boundaries(filepath)

    let tested = 0
    let ready = 0
    let blocked = 0
    let unknown = 0

    for (const b of infos) {
      if (b.hasTests) tested++
      if (b.readiness === 'ready') ready++
      else if (b.readiness === 'blocked') blocked++
      else unknown++
    }

    return {
      totalBoundaries: infos.length,
      tested,
      ready,
      blocked,
      unknown,
      boundaries: infos,
    }
  }
}

// --- Helpers ---

function resolveDep(dep: DepRow, registry: SubstitutionRegistry): DependencyInfo {
  const info: DependencyInfo = {
    paramName: dep.paramName,
    paramType: dep.paramType,
    status: 'unknown',
  }

  if (!dep.paramType) return info

  // Look up by type name in registry
  const sub = findSubstitution(dep.paramType, registry)
  if (!sub) return info

  if (sub.blocker) {
    info.status = 'blocked'
    info.blocker = { reason: sub.blocker.reason }
  } else if (sub.test) {
    info.status = 'wirable'
    info.substitution = {
      testType: sub.test.type,
      testModule: sub.test.module,
      setup: sub.test.setup ?? '',
      inspect: sub.test.inspect ?? '',
      teardown: sub.test.teardown,
    }
  }

  return info
}

function resolveEnvVar(v: EnvVarRow, registry: SubstitutionRegistry, readBy: Entity): EnvVarInfo {
  // Check if covered by a substitution's prod.env
  for (const [name, sub] of Object.entries(registry.substitutions)) {
    if (sub.prod?.env?.includes(v.varName)) {
      return {
        varName: v.varName,
        accessor: v.accessor,
        readBy,
        coveredBy: name,
        status: 'covered',
      }
    }
  }

  // Check env_defaults
  if (v.varName in registry.envDefaults) {
    return {
      varName: v.varName,
      accessor: v.accessor,
      readBy,
      default: registry.envDefaults[v.varName],
      status: 'defaulted',
    }
  }

  return {
    varName: v.varName,
    accessor: v.accessor,
    readBy,
    status: 'unmapped',
  }
}

function findSubstitution(paramType: string, registry: SubstitutionRegistry): SubstitutionEntry | undefined {
  // Direct match on substitution key (the logical dependency name)
  if (registry.substitutions[paramType]) return registry.substitutions[paramType]

  // Match on prod.type
  for (const sub of Object.values(registry.substitutions)) {
    if (sub.prod?.type === paramType) return sub
  }

  return undefined
}
