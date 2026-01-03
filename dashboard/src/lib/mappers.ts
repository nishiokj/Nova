import type {
  Session,
  LegacyHttpRequest,
  SessionState,
  Environment,
  AgentRequest,
  AgentRequestState,
  PlanStep,
  ToolCall,
  Reflection,
  AgentType,
  LLMCall,
  PlanSnapshot,
  UserPrompt,
  ContextWindowMetrics,
} from '../domain/models'
import { computeSessionInsights, computeLegacyRequestInsights } from '../domain/models'
import type { GraphDSession, GraphDMessage } from './api'

function unixToIso(ts: number): string {
  return new Date(ts * 1000).toISOString()
}

function toISOTimestamp(ts: unknown, fallback: string): string {
  if (typeof ts === 'number') return unixToIso(ts)
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  return fallback
}

function mapStatus(status: string, lastAccessedAt: number): SessionState {
  // If explicitly closed/expired, it's ended
  if (status === 'closed' || status === 'expired') {
    return 'ended'
  }

  // Check if session is stale (no activity in last 5 minutes)
  const now = Date.now() / 1000
  const staleThresholdSeconds = 5 * 60 // 5 minutes
  if (now - lastAccessedAt > staleThresholdSeconds) {
    return 'idle'
  }

  // Active session with recent activity
  if (status === 'active') {
    return 'active'
  }

  return 'idle'
}

function mapClientTypeToEnv(clientType: string): Environment {
  if (clientType === 'api') return 'prod'
  if (clientType === 'voice') return 'prod'
  return 'dev'
}

// Parse wizard/agent metadata to extract request information
function parseRequestsFromMetadata(meta: Record<string, unknown>, sessionKey: string, createdAt: string): AgentRequest[] {
  const requests: AgentRequest[] = []
  const wizardEvents = meta.wizard_events as unknown[] | undefined

  if (!wizardEvents || !Array.isArray(wizardEvents) || wizardEvents.length === 0) {
    return requests
  }

  // Split events into requests by goal boundaries (goal_started -> goal_achieved/goal_aborted)
  const requestEventGroups: unknown[][] = []
  let currentGroup: unknown[] = []

  for (const event of wizardEvents) {
    const e = event as Record<string, unknown>
    const eventType = e.type as string

    if (eventType === 'goal_started') {
      if (currentGroup.length > 0) {
        requestEventGroups.push(currentGroup)
      }
      currentGroup = [event]
    } else {
      currentGroup.push(event)

      if (eventType === 'goal_achieved' || eventType === 'goal_aborted') {
        requestEventGroups.push(currentGroup)
        currentGroup = []
      }
    }
  }

  if (currentGroup.length > 0) {
    requestEventGroups.push(currentGroup)
  }

  for (let i = 0; i < requestEventGroups.length; i++) {
    const request = createRequestFromEvents(sessionKey, `goal-${i}`, requestEventGroups[i], i, createdAt)
    requests.push(request)
  }

  return requests
}

function createRequestFromEvents(
  sessionKey: string,
  _goalId: string,
  events: unknown[],
  index: number,
  fallbackTime: string
): AgentRequest {
  const toolCalls: ToolCall[] = []
  const llmCalls: LLMCall[] = []
  const planSnapshots: PlanSnapshot[] = []
  const userPrompts: UserPrompt[] = []
  let contextWindow: ContextWindowMetrics | undefined
  let reflection: Reflection | undefined
  let userInput = `Request ${index + 1}`
  let goalText = ''
  let state: AgentRequestState = 'queued'
  let errorMessage: string | undefined
  let createdAt = fallbackTime
  let startedAt: string | undefined
  let endedAt: string | undefined

  // Track step objectives by step_num for updates
  const stepMap = new Map<number, PlanStep>()

  // Track tool calls by step_num for nesting
  const toolCallsByStep = new Map<number, ToolCall[]>()
  // Track LLM calls by step_num for nesting (planner calls have no step_num)
  const llmCallsByStep = new Map<number | undefined, LLMCall[]>()

  for (const event of events) {
    const e = event as Record<string, unknown>
    const eventType = e.type as string
    const data = (e.data ?? {}) as Record<string, unknown>
    const stepNum = e.step_num as number | undefined
    const eventTimestamp = toISOTimestamp(e.timestamp, fallbackTime)

    // Extract timing - convert unix timestamp to ISO if needed
    if (e.timestamp && !startedAt) {
      startedAt = eventTimestamp
      createdAt = eventTimestamp
    }

    switch (eventType) {
      case 'llm_call': {
        const callData = e.data as Record<string, unknown>
        const llmCall: LLMCall = {
          id: `${sessionKey}-llm-${llmCalls.length}`,
          agentType: (callData.agent_type as AgentType) ?? 'worker',
          stepNum: stepNum ?? undefined,
          promptPreview: (callData.prompt_preview as string) ?? '',
          responsePreview: (callData.response_preview as string) ?? '',
          totalTokens: (callData.total_tokens as number) ?? 0,
          promptTokens: (callData.prompt_tokens as number) ?? 0,
          completionTokens: (callData.completion_tokens as number) ?? 0,
          durationMs: (callData.duration_ms as number) ?? 0,
          model: (callData.model as string) ?? 'unknown',
          toolCallsCount: (callData.tool_calls_count as number) ?? 0,
          timestamp: eventTimestamp,
        }
        llmCalls.push(llmCall)
        // Group by step_num for nesting
        if (!llmCallsByStep.has(stepNum)) {
          llmCallsByStep.set(stepNum, [])
        }
        llmCallsByStep.get(stepNum)!.push(llmCall)
        break
      }

      case 'plan_snapshot': {
        const snapData = e.data as Record<string, unknown>
        const rawSteps = (snapData.steps as Array<Record<string, unknown>>) ?? []
        const steps = rawSteps.map((s) => ({
          stepNum: (s.step_num as number) ?? 0,
          objective: (s.objective as string) ?? '',
          status: mapLedgerStatus(s.status as string),
          phase: mapPhase(s.phase),
          toolHint: s.tool_hint as string | undefined,
          required: (s.required as boolean) ?? true,
        }))

        planSnapshots.push({
          version: (snapData.version as number) ?? 0,
          snapshotType: (snapData.snapshot_type as 'initial' | 'pre_patch' | 'post_patch') ?? 'initial',
          steps,
          goal: (snapData.goal as string) ?? '',
          trigger: (snapData.trigger as string) ?? '',
          timestamp: eventTimestamp,
        })

        for (const step of steps) {
          stepMap.set(step.stepNum, { ...step })
        }
        if (!goalText && snapData.goal) {
          goalText = snapData.goal as string
        }
        break
      }

      case 'user_input_requested': {
        const promptData = e.data as Record<string, unknown>
        userPrompts.push({
          requestId: (promptData.request_id as string) ?? `prompt-${userPrompts.length}`,
          stepNum: stepNum ?? 0,
          question: (promptData.question as string) ?? '',
          options: (promptData.options as string[]) ?? [],
          context: (promptData.context as string) ?? '',
          timestamp: eventTimestamp,
          answered: false,
        })
        break
      }

      case 'user_input_received': {
        const promptData = e.data as Record<string, unknown>
        const requestId = promptData.request_id as string | undefined
        const prompt = requestId
          ? userPrompts.find((p) => p.requestId === requestId)
          : userPrompts[userPrompts.length - 1]
        if (prompt) {
          prompt.answered = true
          prompt.answer = (promptData.answer as string) ?? ''
        }
        break
      }

      case 'context_window_update': {
        const ctxData = e.data as Record<string, unknown>
        contextWindow = {
          contextTokens: (ctxData.context_tokens as number) ?? 0,
          outputTokens: (ctxData.output_tokens as number) ?? 0,
          maxTokens: (ctxData.max_tokens as number) ?? 200000,
          percentageUsed: (ctxData.percentage_used as number) ?? 0,
          messageCount: (ctxData.message_count as number) ?? 0,
          totalTokens: (ctxData.total_tokens as number) ?? 0,
          timestamp: eventTimestamp,
        }
        break
      }

      case 'goal_started':
        // Extract user input and goal from goal_started event
        userInput = (data.user_input as string) ?? (data.goal as string) ?? userInput
        goalText = (data.goal as string) ?? ''
        state = 'running'
        // Pre-populate steps from the initial plan if available
        const initialSteps = data.steps as Array<Record<string, unknown>> | undefined
        if (initialSteps) {
          for (const s of initialSteps) {
            const sNum = s.step_num as number
            const step: PlanStep = {
              stepNum: sNum,
              objective: (s.objective as string) ?? `Step ${sNum}`,
              status: 'pending',
              phase: mapPhase(s.phase),
              toolHint: s.tool_hint as string | undefined,
              required: true,
            }
            stepMap.set(sNum, step)
          }
        }
        break

      case 'step_started':
        // Update or create step from step_started event
        if (stepNum !== undefined) {
          const existing = stepMap.get(stepNum)
          if (existing) {
            existing.status = 'in_progress'
            existing.objective = (data.objective as string) ?? existing.objective
          } else {
            stepMap.set(stepNum, {
              stepNum,
              objective: (data.objective as string) ?? `Step ${stepNum}`,
              status: 'in_progress',
              phase: mapPhase(data.phase),
              toolHint: data.tool_hint as string | undefined,
              required: true,
            })
          }
        }
        break

      case 'step_completed':
        if (stepNum !== undefined && stepMap.has(stepNum)) {
          const step = stepMap.get(stepNum)!
          step.status = 'completed'
          step.durationMs = data.duration_ms as number | undefined
          // StepCompletedData has objective, outcome_summary, quality_score
          if (data.objective) step.objective = data.objective as string
        }
        break

      case 'step_failed':
        if (stepNum !== undefined && stepMap.has(stepNum)) {
          const step = stepMap.get(stepNum)!
          step.status = 'failed'
          step.error = (data.error as string) ?? (data.reason as string)
        }
        state = 'error'
        errorMessage = (data.error as string) ?? (data.reason as string)
        break

      case 'step_skipped':
        if (stepNum !== undefined && stepMap.has(stepNum)) {
          const step = stepMap.get(stepNum)!
          step.status = 'skipped'
          // Extract error from enhanced skip event data
          step.error = (data.message as string) ?? (data.error as string) ?? (data.reason as string)
        }
        // If this skip was due to retries/stagnation, mark request as having issues
        if (data.reason === 'max_retries_exceeded' || data.reason === 'stagnation') {
          // Don't override error state, but capture the skip reason
          if (!errorMessage) {
            errorMessage = (data.message as string) ?? (data.error as string)
          }
        }
        break

      case 'tool_call': {
        const toolCall: ToolCall = {
          id: `${sessionKey}-tool-${toolCalls.length}`,
          toolName: (data.tool_name as string) ?? 'unknown',
          arguments: (data.arguments as Record<string, unknown>) ?? {},
          result: data.result as string | undefined,
          success: (data.success as boolean) ?? true,
          durationMs: (data.duration_ms as number) ?? 0,
          timestamp: eventTimestamp,
        }
        toolCalls.push(toolCall)
        // Group by step_num for nesting
        if (stepNum !== undefined) {
          if (!toolCallsByStep.has(stepNum)) {
            toolCallsByStep.set(stepNum, [])
          }
          toolCallsByStep.get(stepNum)!.push(toolCall)
        }
        break
      }

      case 'reflection':
      case 'reflection_completed':
        reflection = {
          verdict: (data.verdict as Reflection['verdict']) ?? 'accept',
          confidence: (data.confidence as number) ?? 0.5,
          qualityScore: (data.quality_score as number) ?? 0.5,
          reasoning: data.reasoning as string | undefined,
          issues: (data.issues as string[]) ?? [],
        }
        break

      case 'goal_achieved':
        state = 'success'
        if (e.timestamp) {
          endedAt = eventTimestamp
        }
        // Can also extract goal from here if not set
        if (!goalText && data.goal) {
          goalText = data.goal as string
        }
        break

      case 'goal_aborted':
        state = 'error'
        if (e.timestamp) {
          endedAt = eventTimestamp
        }
        errorMessage = (data.reason as string) ?? 'Aborted'
        break

      case 'error_detected':
      case 'quality_issue_detected':
        // Extract issues for display
        if (data.errors && Array.isArray(data.errors) && data.errors.length > 0) {
          errorMessage = (data.errors as string[]).join('; ')
        }
        break
    }
  }

  // Convert stepMap to sorted array and attach nested calls
  const stepsArray = Array.from(stepMap.values()).sort((a, b) => a.stepNum - b.stepNum)
  for (const step of stepsArray) {
    step.toolCalls = toolCallsByStep.get(step.stepNum) ?? []
    step.llmCalls = llmCallsByStep.get(step.stepNum) ?? []
  }
  const stepsCompleted = stepsArray.filter(s => s.status === 'completed').length
  const stepsTotal = stepsArray.length

  return {
    id: `${sessionKey}-request-${index}`,
    sessionId: sessionKey,
    state,
    userInput,
    createdAt,
    startedAt,
    endedAt,
    plan: stepsArray.length > 0 ? { goal: goalText || userInput, steps: stepsArray } : undefined,
    toolCalls,
    reflection,
    llmCalls,
    planSnapshots,
    userPrompts,
    contextWindow,
    stepsCompleted,
    stepsTotal,
    totalToolCalls: toolCalls.length,
    durationMs: startedAt && endedAt
      ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
      : undefined,
    errorMessage,
  }
}

function mapLedgerStatus(status: string | undefined): PlanStep['status'] {
  switch (status) {
    case 'done':
    case 'completed':
      return 'completed'
    case 'awaiting_user':
      return 'in_progress'
    case 'running':
    case 'in_progress':
      return 'in_progress'
    case 'failed':
    case 'error':
      return 'failed'
    case 'skipped':
      return 'skipped'
    default:
      return 'pending'
  }
}

function mapPhase(phase: unknown): PlanStep['phase'] {
  return phase === 'discovery' ? 'discovery' : 'execution'
}

export function mapGraphDSession(raw: GraphDSession, messages: GraphDMessage[] = []): Session {
  const meta = raw.metadata_json ? JSON.parse(raw.metadata_json) : {}
  const createdAt = unixToIso(raw.created_at)

  // Map messages to legacy HTTP requests (for backwards compatibility)
  const legacyRequests: LegacyHttpRequest[] = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const partial = {
        id: `${raw.session_key}-${m.message_index}`,
        sessionId: raw.session_key,
        state: 'success' as const,
        method: 'POST' as const,
        path: m.role === 'user' ? '/chat/user' : '/chat/assistant',
        createdAt: unixToIso(m.created_at),
        startedAt: unixToIso(m.created_at),
        endedAt: unixToIso(m.created_at),
        meta: m.metadata_json ? JSON.parse(m.metadata_json) : {},
      }
      return {
        ...partial,
        insights: computeLegacyRequestInsights(partial),
      }
    })

  // Parse agent requests from wizard metadata
  const requests: AgentRequest[] = parseRequestsFromMetadata(meta, raw.session_key, createdAt)

  // Infer session state from requests if we have them
  const hasRunningRequests = requests.some(r => r.state === 'running')
  const hasErrorRequests = requests.some(r => r.state === 'error')
  const inferredState = hasRunningRequests
    ? 'active'
    : hasErrorRequests
      ? 'error'
      : mapStatus(raw.status, raw.last_accessed_at)

  const partialSession = {
    id: raw.session_key,
    userId: meta.user_id ?? 'anonymous',
    state: inferredState,
    env: mapClientTypeToEnv(raw.client_type),
    createdAt,
    startedAt: unixToIso(raw.last_accessed_at),
    endedAt: raw.status === 'closed' ? unixToIso(raw.last_accessed_at) : undefined,
    tags: [raw.client_type, raw.working_dir?.split('/').pop() ?? 'unknown'].filter(Boolean) as string[],
    meta: {
      clientType: raw.client_type,
      workingDir: raw.working_dir ?? undefined,
      ...meta,
    },
    legacyRequests,
    requests,
  }

  return {
    ...partialSession,
    insights: computeSessionInsights(partialSession),
  }
}

export function parseJSONL<T>(data: string): T[] {
  return data
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}
