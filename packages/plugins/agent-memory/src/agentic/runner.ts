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
import { HarnessClient, type BridgeEvent, type ResponseData } from 'harness-client'

// ── Configuration ──

export interface HarnessConnectionConfig {
  host: string
  port: number
  /** Request timeout in ms (default: 600000 = 10 min) */
  requestTimeout?: number
}

const DEFAULT_HARNESS_CONFIG: HarnessConnectionConfig = {
  host: '127.0.0.1',
  port: 9555,
  requestTimeout: 600000,
}

// ── Interfaces ──

export interface AgenticRunContext {
  task: AgenticTask
  run: AgenticRun
  outputDir: string
  harnessConfig?: HarnessConnectionConfig
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
 */
export async function executeAgenticRun(ctx: AgenticRunContext): Promise<AgenticRunResult> {
  const { task, run, logger } = ctx

  if (!task.compiledPromptPath) {
    throw new Error(`Task ${task.id} has no compiled prompt`)
  }

  const prompt = await loadPrompt(task.compiledPromptPath)
  logger.info(`[agentic:${task.name}] Loaded prompt (${prompt.length} chars)`)

  const result = await dispatchAgentSession(task, run, prompt, ctx.harnessConfig, logger)
  return result
}

// ── Agent Session Dispatch ──

/**
 * Dispatch an autonomous agent session via the harness bridge bus.
 *
 * 1. Connect to harness daemon via HarnessClient (TCP JSONL bus)
 * 2. Call asyncStart(goal) to spawn the session
 * 3. Subscribe to the run channel and await the response event
 * 4. Collect and return the result
 */
async function dispatchAgentSession(
  task: AgenticTask,
  run: AgenticRun,
  prompt: string,
  harnessConfig: HarnessConnectionConfig | undefined,
  logger: AgenticRunContext['logger'],
): Promise<AgenticRunResult> {
  const config = { ...DEFAULT_HARNESS_CONFIG, ...harnessConfig }

  const client = new HarnessClient({
    host: config.host,
    port: config.port,
    requestTimeout: config.requestTimeout,
    maxReconnectAttempts: 3,
  })

  try {
    await client.connect()
    logger.info(`[agentic:${task.name}] Connected to harness at ${config.host}:${config.port}`)

    // Dispatch the async session
    const startResult = await client.asyncStart(prompt)

    if (!startResult.success) {
      throw new Error(`async_start failed: ${startResult.error ?? 'unknown error'}`)
    }

    const requestId = startResult.requestId
    const sessionKey = startResult.sessionKey
    logger.info(`[agentic:${task.name}] Session dispatched — requestId=${requestId}, sessionKey=${sessionKey}`)

    if (!requestId) {
      throw new Error('async_start returned no requestId')
    }

    // Subscribe and wait for completion
    client.subscribeRun(requestId)

    const response = await waitForResponse(client, requestId, config.requestTimeout ?? 600000)

    logger.info(`[agentic:${task.name}] Session completed — success=${response.success}`)

    // Parse the response into our result format
    const content = response.content ?? ''
    const verdict: AgenticRunVerdict = response.success ? 'pass' : 'fail'

    return {
      verdict,
      verdictReport: null,
      agentOutput: content,
      agentSummary: content.length > 500 ? content.slice(0, 500) + '...' : content,
      mutations: { toolCalls: 0, fileWrites: 0, recordMutations: 0, costCents: 0 },
      budgetExceeded: false,
    }
  } finally {
    client.close()
  }
}

/**
 * Wait for a response event on the run channel.
 * Resolves when the response event arrives or rejects on timeout.
 */
function waitForResponse(
  client: HarnessClient,
  requestId: string,
  timeoutMs: number,
): Promise<ResponseData> {
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const handler = (event: BridgeEvent) => {
      if (event.type !== 'response') return

      const data = (event.data ?? {}) as ResponseData
      if (data.request_id !== requestId) return

      if (timeoutId) clearTimeout(timeoutId)
      client.off('event', handler)
      resolve(data)
    }

    client.on('event', handler)

    timeoutId = setTimeout(() => {
      client.off('event', handler)
      reject(new Error(`Timed out waiting for session response after ${timeoutMs}ms`))
    }, timeoutMs)
  })
}

// ── Utilities ──

export async function loadPrompt(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
