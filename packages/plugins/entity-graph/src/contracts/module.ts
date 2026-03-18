/**
 * Contract Module
 *
 * Sits between the contract queries and the CLI/facade.
 * Follows the TestHealthModule pattern: constructor(sql, sourceRoot).
 */

import { readFile } from 'fs/promises'
import path from 'path'
import type { Sql } from 'postgres'
import type {
  Contract,
  ContractSource,
  ContractStatus,
  ContractSummary,
  ContractType,
  DomainModel,
} from './types.js'
import {
  contractById,
  contractsForEntity,
  contractsForFile,
  contractsByStatus,
  contractsByType,
  contractSummary,
  contractsWithEntityDetails,
  upsertContract,
  updateContractStatus,
  deleteContract,
} from './queries.js'
import type { ContractWithEntities } from './queries.js'
import { recordVerdicts } from './compilation.js'
import type { VerdictInput } from './compilation.js'
import { verifyContracts } from './verify.js'
import type { TestRunner, VerifyResult } from './verify.js'
import { openViolations as queryOpenViolations } from './queries.js'
import type { ContractViolation } from './queries.js'

export class ContractModule {
  constructor(
    private sql: Sql,
    private sourceRoot: string,
  ) {}

  // --- Domain Model ---

  async loadDomain(domainPath?: string): Promise<DomainModel | null> {
    const fullPath = domainPath ?? path.join(this.sourceRoot, 'contracts', 'domain.yaml')
    try {
      const content = await readFile(fullPath, 'utf-8')
      return parseDomainYaml(content)
    } catch {
      return null
    }
  }

  // --- Query Delegation ---

  async byId(contractId: string): Promise<Contract | null> {
    return contractById(this.sql, contractId)
  }

  async forEntity(entityId: string): Promise<Contract[]> {
    return contractsForEntity(this.sql, entityId)
  }

  async forFile(filepath: string): Promise<Contract[]> {
    return contractsForFile(this.sql, filepath)
  }

  async byStatus(status: ContractStatus): Promise<Contract[]> {
    return contractsByStatus(this.sql, status)
  }

  async byType(type: ContractType): Promise<Contract[]> {
    return contractsByType(this.sql, type)
  }

  async summary(): Promise<ContractSummary> {
    return contractSummary(this.sql)
  }

  async withEntityDetails(
    filters?: { status?: ContractStatus; type?: ContractType; source?: ContractSource },
  ): Promise<ContractWithEntities[]> {
    return contractsWithEntityDetails(this.sql, filters)
  }

  // --- Mutations ---

  async upsert(
    contract: Omit<Contract, 'id' | 'createdAt' | 'updatedAt'>,
    entityIds: string[],
  ): Promise<Contract> {
    return upsertContract(this.sql, contract, entityIds)
  }

  async updateStatus(contractId: string, status: ContractStatus): Promise<void> {
    return updateContractStatus(this.sql, contractId, status)
  }

  async delete(contractId: string): Promise<void> {
    return deleteContract(this.sql, contractId)
  }

  // --- Verdicts ---

  async recordVerdicts(verdicts: VerdictInput[]): Promise<{ updated: number }> {
    return recordVerdicts(this.sql, verdicts)
  }

  // --- Verification ---

  async verify(runTest: TestRunner, opts?: { statuses?: ContractStatus[] }): Promise<VerifyResult> {
    return verifyContracts(this.sql, runTest, opts)
  }

  async openViolations(): Promise<ContractViolation[]> {
    return queryOpenViolations(this.sql)
  }
}

// --- Domain YAML Parsing ---
// Minimal parser matching the test-health.yaml pattern (no external YAML lib).

export function parseDomainYaml(content: string): DomainModel {
  const model: DomainModel = {
    version: 1,
    systemDescription: '',
    entities: [],
    criticalPath: '',
    hardRules: [],
    painPoints: [],
  }

  const lines = content.split('\n')
  let i = 0
  let section: 'root' | 'entities' | 'entity' | 'hard_rules' | 'pain_points' = 'root'
  let currentEntity: { name: string; description: string; aliases: string[] } | null = null

  function flushEntity() {
    if (currentEntity) {
      model.entities.push(currentEntity)
      currentEntity = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length

    if (trimmed.startsWith('#') || trimmed.length === 0) { i++; continue }

    const colonIdx = trimmed.indexOf(':')

    // List items
    if (trimmed.startsWith('- ')) {
      const val = trimmed.slice(2).trim().replace(/^["']|["']$/g, '')

      if (section === 'entities') {
        // New entity start
        flushEntity()
        // Could be "- name: Foo" inline style
        const m = val.match(/^name:\s*(.+)/)
        if (m) {
          currentEntity = { name: m[1].replace(/^["']|["']$/g, ''), description: '', aliases: [] }
          section = 'entity'
        }
        i++
        continue
      }

      if (section === 'entity' && currentEntity) {
        // Could be aliases list item
        currentEntity.aliases.push(val)
        i++
        continue
      }

      if (section === 'hard_rules') {
        model.hardRules.push(val)
        i++
        continue
      }

      if (section === 'pain_points') {
        model.painPoints.push(val)
        i++
        continue
      }

      i++
      continue
    }

    if (colonIdx === -1) { i++; continue }

    const key = trimmed.slice(0, colonIdx).trim()
    let value = trimmed.slice(colonIdx + 1).trim()
    value = value.replace(/^["']|["']$/g, '')

    // Handle array value: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const arr = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      if (section === 'entity' && currentEntity && key === 'aliases') {
        currentEntity.aliases = arr
      }
      i++
      continue
    }

    // Root-level keys
    if (indent === 0) {
      flushEntity()
      if (key === 'version') model.version = parseInt(value, 10)
      else if (key === 'system') model.systemDescription = value
      else if (key === 'entities') section = 'entities'
      else if (key === 'critical_path') model.criticalPath = value
      else if (key === 'hard_rules') section = 'hard_rules'
      else if (key === 'pain_points') section = 'pain_points'
      i++
      continue
    }

    // Entity fields
    if (section === 'entity' && currentEntity) {
      if (key === 'description') currentEntity.description = value
      else if (key === 'aliases' && value === '') { /* next lines are list items */ }
      else if (key === 'aliases') {
        currentEntity.aliases = value.startsWith('[')
          ? value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
          : [value]
      }
    }

    i++
  }

  flushEntity()
  return model
}

export function serializeDomainYaml(domain: DomainModel): string {
  const lines: string[] = []
  lines.push(`version: ${domain.version}`)
  lines.push(`system: "${domain.systemDescription}"`)

  if (domain.entities.length > 0) {
    lines.push('entities:')
    for (const entity of domain.entities) {
      lines.push(`  - name: ${entity.name}`)
      lines.push(`    description: "${entity.description}"`)
      if (entity.aliases.length > 0) {
        lines.push(`    aliases: [${entity.aliases.join(', ')}]`)
      }
    }
  }

  if (domain.criticalPath) {
    lines.push(`critical_path: "${domain.criticalPath}"`)
  }

  if (domain.hardRules.length > 0) {
    lines.push('hard_rules:')
    for (const rule of domain.hardRules) {
      lines.push(`  - "${rule}"`)
    }
  }

  if (domain.painPoints.length > 0) {
    lines.push('pain_points:')
    for (const point of domain.painPoints) {
      lines.push(`  - "${point}"`)
    }
  }

  return lines.join('\n') + '\n'
}
