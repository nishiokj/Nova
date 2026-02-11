/**
 * Agentic Task Runner
 *
 * Spawns an agent session with the compiled prompt (mission briefing).
 * The VP is embedded in the prompt as the definition of done —
 * the agent uses it to self-validate before reporting completion.
 *
 * At runtime: load prompt from disk → dispatch async session → collect result.
 */

import { readFile } from 'fs/promises'
import type { AgenticTask, AgenticRun, AgenticRunVerdict, MutationObservation } from 'types'
import type { VerdictReport } from 'semantic-compiler'
import { NotImplementedError } from '../errors/index.js'

// ── Interfaces ──

export interface AgenticRunContext {
  task: AgenticTask
  run: AgenticRun
  outputDir: string
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

export interface AgenticRunResult {
  verdict: AgenticRunVerdict
  verdictReport: VerdictReport | null
  agentOutput: string
  agentSummary: string | null
  mutations: MutationObservation
  budgetExceeded: boolean
}

// ── Execution ──

/**
 * Execute an agentic task run.
 *
 * 1. Load the compiled prompt from disk
 * 2. Dispatch an async agent session with the prompt as the goal
 * 3. The agent executes autonomously, using the VP to self-validate
 * 4. Collect the session result
 *
 * The control-plane's dispatchSessionAsync(sessionKey, goal) is the
 * spawn mechanism — it creates a watcher-enabled autonomous session.
 */
export async function executeAgenticRun(ctx: AgenticRunContext): Promise<AgenticRunResult> {
  const { task, run, logger } = ctx

  if (!task.compiledPromptPath) {
    throw new Error(`Task ${task.id} has no compiled prompt`)
  }

  const prompt = await loadPrompt(task.compiledPromptPath)
  logger.info(`[agentic:${task.name}] Loaded prompt (${prompt.length} chars)`)

  // Dispatch the agent session with the compiled prompt
  const result = await dispatchAgentSession(task, run, prompt, logger)

  return result
}

// ── Agent Session Dispatch ──

/**
 * Dispatch an autonomous agent session with the compiled prompt.
 *
 * Integration point: calls control-plane dispatchSessionAsync().
 * The prompt IS the goal — a comprehensive markdown document with
 * everything the agent needs: intent, skills, tools, constraints,
 * and the VP as definition of done.
 */
async function dispatchAgentSession(
  _task: AgenticTask,
  _run: AgenticRun,
  _prompt: string,
  _logger: AgenticRunContext['logger'],
): Promise<AgenticRunResult> {
  // TODO: Wire to control-plane dispatchSessionAsync
  //
  // const sessionKey = `agentic:${task.name}:${run.id}`
  // const result = await controlPlane.dispatchSessionAsync(sessionKey, prompt)
  // ... await session completion, collect output/mutations/verdict
  //
  throw new NotImplementedError(
    'dispatchAgentSession: control-plane integration not yet wired. ' +
    'Requires dispatchSessionAsync(sessionKey, goal) from the control-plane API.'
  )
}

// ── Utilities ──

export async function loadPrompt(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
