/**
 * Entity Graph — Main Entry Point
 *
 * EntityGraph class provides a facade over parsing, persistence, querying,
 * leasing, and hook integration. Accepts a Sql instance via DI to share
 * agent-memory's connection pool.
 */

import type { Sql } from 'postgres'
import type {
  EntityGraphConfig,
  EntityGraphHooks,
  Entity,
  EntityKind,
  GraphStats,
} from './types.js'
import { SCHEMA_DDL } from './schema.js'
import { buildFullGraph, parseFile, persistParseResult } from './pipeline.js'
import {
  entitiesInFile,
  entityById,
  importersOfFile,
  callersOf,
  usersOf,
  blastRadius,
  entitiesAtLines,
  entityBlastRadius,
  dependentsOf,
  unusedExports,
  graphStats,
  callTreeFrom,
  boundaries as queryBoundaries,
  envVarsInTree,
  depsOf,
  indexedTestFactsForFiles,
  testFilesFor,
} from './queries.js'
import type { BlastRadiusEntry, CallTreeRow, BoundaryRow, EnvVarRow, DepRow, IndexedTestFactsBundle } from './queries.js'
import { reviewDiff } from './pr-review/review.js'
import type { PRReview } from './pr-review/types.js'
import { cleanExpiredLeases } from './leasing.js'
import { createEntityGraphHooks } from './hooks.js'
import { TestHealthModule } from './test-health.js'
import type { BoundaryInfo, ReadinessVerdict, GapReport } from './test-health.js'
import type { BoundaryCandidate, BoundaryDossier, SkepticConfig } from './skeptic/types.js'
import { ContractModule } from './contracts/module.js'
import type { Contract, ContractStatus, ContractSummary } from './contracts/types.js'

export class EntityGraph {
  private sql: Sql
  private config: EntityGraphConfig
  private hooks: EntityGraphHooks | null = null
  private scanPromise: Promise<{ files: number; entities: number; edges: number; durationMs: number } | null> | null = null
  private _testHealth: TestHealthModule | null = null
  private _contracts: ContractModule | null = null

  constructor(sql: Sql, config: EntityGraphConfig) {
    this.sql = sql
    this.config = config
  }

  /**
   * Get the TestHealthModule instance (lazy-created).
   */
  get testHealth(): TestHealthModule {
    if (!this._testHealth) {
      this._testHealth = new TestHealthModule(this.sql, this.config.sourceRoot)
    }
    return this._testHealth
  }

  /**
   * Get the ContractModule instance (lazy-created).
   */
  get contracts(): ContractModule {
    if (!this._contracts) {
      this._contracts = new ContractModule(this.sql, this.config.sourceRoot)
    }
    return this._contracts
  }

  /**
   * Initialize the entity graph:
   * 1. Run DDL to create schema + tables (idempotent)
   * 2. Clean expired leases
   * 3. Optionally kick off a full startup scan (non-blocking)
   */
  async initialize(): Promise<void> {
    // Create schema and tables
    await this.sql.unsafe(SCHEMA_DDL)

    // Clean stale leases from previous runs
    const cleaned = await cleanExpiredLeases(this.sql)
    if (cleaned > 0) {
      console.log(`[entity-graph] Cleaned ${cleaned} expired leases`)
    }

    // Run startup scan in background if configured (default: true)
    if (this.config.startupScan !== false) {
      this.scanPromise = buildFullGraph(this.sql, this.config)
        .then(stats => {
          console.log(
            `[entity-graph] Startup scan complete: ${stats.files} files, ${stats.entities} entities, ${stats.edges} edges (${stats.durationMs}ms)`
          )
          return stats
        })
        .catch(err => {
          console.error(`[entity-graph] Startup scan failed:`, err)
          return null
        })
    }
  }

  /**
   * Wait for the background startup scan to finish (if running).
   * Returns scan stats, or null if scan was skipped or failed.
   */
  async waitForScan(): Promise<{ files: number; entities: number; edges: number; durationMs: number } | null> {
    return this.scanPromise ?? null
  }

  /**
   * Get hook handlers for composing with AgentHooks.
   * Lazily created on first access.
   */
  getHooks(): EntityGraphHooks {
    if (!this.hooks) {
      this.hooks = createEntityGraphHooks(this.sql, this.config)
    }
    return this.hooks
  }

  // --- Query Delegation ---

  async entitiesInFile(filepath: string): Promise<Entity[]> {
    return entitiesInFile(this.sql, filepath)
  }

  async entityById(id: string): Promise<Entity | null> {
    return entityById(this.sql, id)
  }

  async importersOfFile(filepath: string): Promise<Entity[]> {
    return importersOfFile(this.sql, filepath)
  }

  async callersOf(entityId: string): Promise<Entity[]> {
    return callersOf(this.sql, entityId)
  }

  async usersOf(entityId: string): Promise<Entity[]> {
    return usersOf(this.sql, entityId)
  }

  async blastRadius(filepath: string): Promise<string[]> {
    return blastRadius(this.sql, filepath)
  }

  async dependentsOf(entityId: string, entityKind: EntityKind): Promise<Entity[]> {
    return dependentsOf(this.sql, entityId, entityKind)
  }

  async unusedExports(filepath?: string): Promise<Entity[]> {
    return unusedExports(this.sql, filepath)
  }

  async entitiesAtLines(
    filepath: string,
    ranges: Array<{ startLine: number; endLine: number }>,
  ): Promise<Entity[]> {
    return entitiesAtLines(this.sql, filepath, ranges)
  }

  async entityBlastRadius(entityIds: string[], maxDepth?: number): Promise<BlastRadiusEntry[]> {
    return entityBlastRadius(this.sql, entityIds, maxDepth)
  }

  async graphStats(): Promise<GraphStats> {
    return graphStats(this.sql)
  }

  // --- Test Health Query Delegation ---

  async callTreeFrom(entityId: string, maxDepth?: number): Promise<CallTreeRow[]> {
    return callTreeFrom(this.sql, entityId, maxDepth)
  }

  async boundaries(filepath?: string): Promise<BoundaryRow[]> {
    return queryBoundaries(this.sql, filepath)
  }

  async envVarsInTree(entityId: string, maxDepth?: number): Promise<EnvVarRow[]> {
    return envVarsInTree(this.sql, entityId, maxDepth)
  }

  async depsOf(entityId: string): Promise<DepRow[]> {
    return depsOf(this.sql, entityId)
  }

  async testFilesFor(entityId: string): Promise<Entity[]> {
    return testFilesFor(this.sql, entityId)
  }

  async indexedTestFactsForFiles(filepaths: string[]): Promise<IndexedTestFactsBundle> {
    return indexedTestFactsForFiles(this.sql, filepaths)
  }

  async skepticTargets(
    selector?: string,
    opts?: {
      maxDepth?: number
      recentPaths?: string[]
    },
  ): Promise<BoundaryCandidate[]> {
    return this.testHealth.skepticTargets(selector, opts)
  }

  async skepticDossier(
    boundaryId: string,
    opts?: {
      maxDepth?: number
    },
  ): Promise<BoundaryDossier> {
    return this.testHealth.skepticDossier(boundaryId, opts)
  }

  // --- Contract Delegation ---

  async contractsForEntity(entityId: string): Promise<Contract[]> {
    return this.contracts.forEntity(entityId)
  }

  async contractsForFile(filepath: string): Promise<Contract[]> {
    return this.contracts.forFile(filepath)
  }

  async contractsByStatus(status: ContractStatus): Promise<Contract[]> {
    return this.contracts.byStatus(status)
  }

  async contractSummary(): Promise<ContractSummary> {
    return this.contracts.summary()
  }

  /**
   * Run the full PR review pipeline from a unified diff string.
   */
  async reviewDiff(diffText: string, maxDepth?: number): Promise<PRReview> {
    return reviewDiff(this.sql, diffText, maxDepth)
  }

  /**
   * Re-parse a single file on demand.
   */
  async reparse(filepath: string): Promise<void> {
    const result = await parseFile(filepath, this.config.sourceRoot)
    if (result) {
      await persistParseResult(this.sql, result)
    }
  }
}

// --- Barrel Exports ---

export type {
  Entity,
  Edge,
  ParseResult,
  EntityKind,
  EdgeType,
  EntityGraphConfig,
  EntityGraphHooks,
  EntityGraphHookResult,
  FileLease,
  BlastRadiusResult,
  GraphStats,
  EnvRead,
  ConstructorDep,
  FunctionDep,
  TestAssertionKind,
  TestMockKind,
  TestSeamOverrideKind,
  TestCaseCallKind,
  IndexedTestCase,
  IndexedTestCaseImport,
  IndexedTestCaseCall,
  IndexedTestCaseAssertion,
  IndexedTestCaseMock,
  IndexedTestCaseSeamOverride,
  Sql,
} from './types.js'

export { SCHEMA_DDL } from './schema.js'
export { parseFile, persistParseResult, buildFullGraph, deleteFileContribution } from './pipeline.js'
export {
  entitiesInFile,
  entityById,
  entitiesByNamePattern,
  importersOfFile,
  callersOf,
  usersOf,
  blastRadius,
  entitiesAtLines,
  entityBlastRadius,
  dependentsOf,
  unusedExports,
  graphStats,
  callTreeFrom,
  boundaries,
  envVarsInTree,
  depsOf,
  indexedTestFactsForFiles,
  testFilesFor,
} from './queries.js'
export type { BlastRadiusEntry, CallTreeRow, BoundaryRow, EnvVarRow, DepRow, IndexedTestFactsBundle } from './queries.js'

// --- PR Review ---
export { parseDiff, parseHunkHeader } from './pr-review/diff.js'
export { classifyChanges } from './pr-review/classifier.js'
export { scoreRisks } from './pr-review/scorer.js'
export { reviewDiff } from './pr-review/review.js'
export type {
  FileChange,
  Hunk,
  ChangeKind,
  EntityChange,
  RiskSignal,
  PRReview,
} from './pr-review/types.js'
export { acquireLease, releaseLease, cleanExpiredLeases } from './leasing.js'
export { createEntityGraphHooks } from './hooks.js'
export { entityId } from './parser/extractor.js'
export { initParser, isParserInitialized, languageForFile, createParser, parseSource } from './parser/parser.js'
export type { SupportedLanguage } from './parser/parser.js'

// --- Test Health ---
export { TestHealthModule, loadRegistry, parseRegistryYaml } from './test-health.js'
export type {
  SubstitutionEntry,
  SubstitutionRegistry,
  BoundaryInfo,
  CallTreeNode,
  DependencyInfo,
  EnvVarInfo,
  ReadinessVerdict,
  GapReport,
  ProjectIndex,
  IndexBoundary,
  IndexDep,
  IndexEnvVar,
  IndexCallTree,
  IndexCallTreeNode,
} from './test-health.js'
export { selectBoundaryCandidates, hydrateBoundaryCandidate } from './skeptic/selection.js'
export { buildBoundaryDossier } from './skeptic/boundary_dossier.js'
export type { BoundaryCandidate, BoundaryDossier, SkepticConfig } from './skeptic/types.js'

// --- Contracts ---
export { ContractModule, parseDomainYaml, serializeDomainYaml } from './contracts/module.js'
export type {
  Contract,
  ContractType,
  ContractSource,
  ContractStatus,
  ContractEntityLink,
  ContractEntityRole,
  ContractDependency,
  ContractDependencyRelationship,
  ContractSummary,
  DomainModel,
  DomainEntity,
  ValidationCondition,
  ValidationSpec,
  ConditionEvidence,
  ContractProof,
  ContractChallenge,
  ContractAcknowledgement,
} from './contracts/types.js'
export {
  contractById,
  contractsForEntity,
  contractsForFile,
  contractsByStatus,
  contractsByType,
  contractSummary,
  contractsWithEntityDetails,
  upsertContract,
  updateContractStatus,
  updateContractCompilation,
  deleteContract,
  entityLinksForContract,
  contractDependencies,
} from './contracts/queries.js'
export type { ContractWithEntities } from './contracts/queries.js'
export { computeDirtyContracts, markDirtyContracts } from './contracts/staleness.js'
export { recordVerdicts } from './contracts/compilation.js'
export type { VerdictInput } from './contracts/compilation.js'
export { verifyContracts } from './contracts/verify.js'
export type { TestRunner, VerifyResult, ContractVerifyResult, ConditionVerifyStatus } from './contracts/verify.js'
export {
  createViolation,
  resolveViolations,
  openViolations,
  violationsForContract,
} from './contracts/queries.js'
export type { ContractViolation } from './contracts/queries.js'
export {
  submitConditionEvidence,
  evidenceForContract,
  deleteEvidenceForContract,
} from './contracts/queries.js'
export {
  parseValidationSpec,
  serializeValidationSpec,
  buildValidationSpec,
  conditionIds,
  makeConditionId,
} from './contracts/validation-spec.js'
export {
  createChallenge,
  challengesForContract,
  openChallengesForContract,
  resolveChallenge,
  createAcknowledgement,
  activeAcknowledgement,
  invalidateAcknowledgement,
  acknowledgementHistory,
} from './contracts/challenge.js'
export {
  buildDomainModel,
  seedContractsFromDomain,
  INTERVIEW_QUESTIONS,
} from './contracts/interview.js'
export type { InterviewResponses, InterviewQuestion } from './contracts/interview.js'
