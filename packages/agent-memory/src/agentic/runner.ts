/**
 * Agentic Task Runner
 *
 * Two-phase execution: agent subprocess + semantic verification.
 * The VP is pre-compiled at task setup time — no compilation at runtime.
 */

import { readFile } from 'fs/promises'
import type { AgenticTask, AgenticRun, AgenticRunVerdict, MutationObservation } from 'types'
import type {
  VerificationProgram,
  VerdictReport,
  InvariantVerdict,
  EvidenceLayoutResult,
} from 'semantic-compiler'
import { prepareEvidenceLayout, emitVerdictArtifacts } from 'semantic-compiler'
import { NotImplementedError } from '../errors/index.js'

// ── Interfaces ──

export interface AgenticRunContext {
  task: AgenticTask
  run: AgenticRun
  vp: VerificationProgram
  outputDir: string
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

export interface AgenticRunResult {
  verdict: AgenticRunVerdict
  verdictReport: VerdictReport
  evidencePath: string
  agentOutput: string
  agentSummary: string | null
  mutations: MutationObservation
  budgetExceeded: boolean
}

interface AgentResult {
  output: string
  summary: string | null
  mutations: MutationObservation
  budgetExceeded: boolean
  exitCode: number
}

// ── Execution ──

export async function executeAgenticRun(ctx: AgenticRunContext): Promise<AgenticRunResult> {
  const { task, run, vp, outputDir, logger } = ctx

  // ═══ Phase 1: Agent Execution ═══
  const agentResult = await spawnAgent(task, run, logger)

  // Budget enforcement: if exceeded, agent was already killed
  if (agentResult.budgetExceeded) {
    return {
      verdict: 'fail',
      verdictReport: { uow_id: run.id, generated_at: new Date().toISOString(), invariant_results: [] },
      evidencePath: '',
      agentOutput: agentResult.output,
      agentSummary: null,
      mutations: agentResult.mutations,
      budgetExceeded: true,
    }
  }

  // ═══ Phase 2: Verification ═══
  const seed = Date.now()
  const evidence = await prepareEvidenceLayout(vp, {
    output_dir: outputDir,
    run_id: run.id,
    seed,
  })

  const invariantVerdicts = await executeHarness(vp, evidence, logger)

  const emitResult = await emitVerdictArtifacts(vp, invariantVerdicts, {
    output_dir: outputDir,
  })

  // Construct VerdictReport from the verdicts array
  const verdictReport: VerdictReport = {
    uow_id: run.id,
    generated_at: new Date().toISOString(),
    invariant_results: invariantVerdicts,
  }

  const verdict = deriveRunVerdict(invariantVerdicts)

  return {
    verdict,
    verdictReport,
    evidencePath: evidence.run_manifest_path,
    agentOutput: agentResult.output,
    agentSummary: agentResult.summary,
    mutations: agentResult.mutations,
    budgetExceeded: false,
  }
}

/**
 * Map individual invariant verdicts to an overall run verdict.
 *
 * - All pass -> 'pass'
 * - Any fail -> 'fail'
 * - Otherwise (error/skipped mix) -> 'partial'
 */
export function deriveRunVerdict(verdicts: InvariantVerdict[]): AgenticRunVerdict {
  if (verdicts.length === 0) return 'pass'

  const hasFail = verdicts.some(v => v.verdict === 'fail')
  if (hasFail) return 'fail'

  const allPass = verdicts.every(v => v.verdict === 'pass')
  if (allPass) return 'pass'

  return 'partial'
}

// ── Agent Subprocess (Not Implemented) ──

/**
 * Spawn the agent CLI as a subprocess.
 *
 * Integration point: requires agent subprocess mechanism (rex CLI).
 * The agent receives intent + capability scope + budget via CLI flags,
 * streams output, and emits structured events for mutation counting.
 */
async function spawnAgent(
  _task: AgenticTask,
  _run: AgenticRun,
  _logger: AgenticRunContext['logger'],
): Promise<AgentResult> {
  throw new NotImplementedError(
    'spawnAgent: agent subprocess execution is not yet implemented. ' +
    'This is the integration point for the rex CLI agent runner.'
  )
}

// ── Harness Execution (Not Implemented) ──

/**
 * Execute the pre-generated harness artifacts against current system state.
 *
 * Integration point: requires Playwright/Docker infrastructure.
 * For each invariant in the VP, executes the harness artifact,
 * collects evidence, and returns per-invariant verdicts.
 */
async function executeHarness(
  _vp: VerificationProgram,
  _evidence: EvidenceLayoutResult,
  _logger: AgenticRunContext['logger'],
): Promise<InvariantVerdict[]> {
  throw new NotImplementedError(
    'executeHarness: harness execution is not yet implemented. ' +
    'This requires Playwright/Docker infrastructure for running verification harnesses.'
  )
}

// ── Utilities ──

export async function loadVp(path: string): Promise<VerificationProgram> {
  const content = await readFile(path, 'utf8')
  return JSON.parse(content) as VerificationProgram
}
