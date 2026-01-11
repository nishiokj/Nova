import type {
  Session,
  SessionState,
  Environment,
  AgentRequest,
  AgentRequestState,
  WorkItem,
  ToolCall,
  AgentType,
  LLMCall,
  SystemContext,
  UserPrompt,
  ContextWindowMetrics,
} from '../domain/models'
import { computeSessionInsights } from '../domain/models'
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

function eventTimestampSeconds(event: Record<string, unknown>, fallbackIso: string): number {
  const ts = event.timestamp
  if (typeof ts === 'number') {
    return ts > 1e12 ? Math.floor(ts / 1000) : ts
  }
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts)
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000)
  }
  const fallback = Date.parse(fallbackIso)
  return Number.isNaN(fallback) ? 0 : Math.floor(fallback / 1000)
}

function normalizeRequestId(event: Record<string, unknown>): string | undefined {
  return (event.request_id as string)
    ?? (event.requestId as string)
    ?? (event.run_id as string)
    ?? (event.runId as string)
}

function buildUserInputIndex(messages: GraphDMessage[]): Map<string, string> {
  const byRequest = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (!message.request_id) continue
    if (!byRequest.has(message.request_id)) {
      byRequest.set(message.request_id, message.content)
    }
  }
  return byRequest
}

// Parse agent metadata to extract request information
function parseRequestsFromMetadata(
  meta: Record<string, unknown>,
  sessionKey: string,
  createdAt: string,
  messages: GraphDMessage[]
): AgentRequest[] {
  const agentEvents = meta.agent_events as unknown[] | undefined

  if (!agentEvents || !Array.isArray(agentEvents) || agentEvents.length === 0) {
    return []
  }

  const userInputs = buildUserInputIndex(messages)
  const grouped = new Map<string, Record<string, unknown>[]>()

  for (const event of agentEvents) {
    const e = event as Record<string, unknown>
    const requestId = normalizeRequestId(e)
    if (!requestId) continue
    const list = grouped.get(requestId) ?? []
    list.push(e)
    grouped.set(requestId, list)
  }

  const sortedGroups = Array.from(grouped.entries())
    .map(([requestId, events]) => {
      const sorted = events.slice().sort((a, b) =>
        eventTimestampSeconds(a, createdAt) - eventTimestampSeconds(b, createdAt)
      )
      const startedAt = sorted.length > 0
        ? eventTimestampSeconds(sorted[0], createdAt)
        : Number.POSITIVE_INFINITY
      return { requestId, events: sorted, startedAt }
    })
    .sort((a, b) => a.startedAt - b.startedAt)

  return sortedGroups.map((group, index) =>
    createRequestFromEvents(
      sessionKey,
      group.requestId,
      group.events,
      index,
      createdAt,
      userInputs.get(group.requestId)
    )
  )
}

function createRequestFromEvents(
  sessionKey: string,
  requestId: string,
  events: Record<string, unknown>[],
  index: number,
  fallbackTime: string,
  userInputHint?: string
): AgentRequest {
  const toolCalls: ToolCall[] = []
  const llmCalls: LLMCall[] = []
  const userPrompts: UserPrompt[] = []
  let contextWindow: ContextWindowMetrics | undefined
  let userInput = userInputHint ?? `Request ${index + 1}`
  let goalText = ''
  let state: AgentRequestState = 'queued'
  let errorMessage: string | undefined
  let createdAt = fallbackTime
  let startedAt: string | undefined
  let endedAt: string | undefined
  let systemContext: SystemContext | undefined
  let lastEventTime = fallbackTime

  // Track work items by workId
  const workItemMap = new Map<string, WorkItem>()

  // Track tool calls by workItemId for nesting
  const toolCallsByWorkItem = new Map<string, ToolCall[]>()
  // Track LLM calls by workItemId for nesting
  const llmCallsByWorkItem = new Map<string | undefined, LLMCall[]>()

  for (const event of events) {
    const e = event as Record<string, unknown>
    const eventType = e.type as string
    const data = (e.data ?? {}) as Record<string, unknown>
    const eventTimestamp = toISOTimestamp(e.timestamp, fallbackTime)
    lastEventTime = eventTimestamp

    // Extract timing - convert unix timestamp to ISO if needed
    if (e.timestamp && !startedAt) {
      startedAt = eventTimestamp
      createdAt = eventTimestamp
    }

    switch (eventType) {
      case 'llm_call': {
        const callData = e.data as Record<string, unknown>
        const llmWorkItemId = (e.work_item_id as string)
          ?? (e.workItemId as string)
          ?? (callData.work_item_id as string)
          ?? (callData.workItemId as string)
          ?? undefined
        const llmCall: LLMCall = {
          id: `${sessionKey}-${requestId}-llm-${llmCalls.length}`,
          agentType: (callData.agent_type as AgentType) ?? (callData.agentType as AgentType) ?? 'standard',
          workItemId: llmWorkItemId,
          promptPreview: (callData.prompt_preview as string) ?? (callData.promptPreview as string) ?? '',
          responsePreview: (callData.response_preview as string) ?? (callData.responsePreview as string) ?? '',
          totalTokens: (callData.total_tokens as number) ?? (callData.totalTokens as number) ?? 0,
          promptTokens: (callData.prompt_tokens as number) ?? (callData.promptTokens as number) ?? 0,
          completionTokens: (callData.completion_tokens as number) ?? (callData.completionTokens as number) ?? 0,
          durationMs: (callData.duration_ms as number) ?? (callData.durationMs as number) ?? 0,
          model: (callData.model as string) ?? 'unknown',
          toolCallsCount: (callData.tool_calls_count as number) ?? (callData.toolCallsCount as number) ?? 0,
          timestamp: eventTimestamp,
        }
        llmCalls.push(llmCall)
        // Group by workItemId for nesting
        if (!llmCallsByWorkItem.has(llmWorkItemId)) {
          llmCallsByWorkItem.set(llmWorkItemId, [])
        }
        llmCallsByWorkItem.get(llmWorkItemId)!.push(llmCall)
        if (state === 'queued') {
          state = 'running'
        }
        break
      }

      case 'runtime_script_created': {
        const scriptData = e.data as Record<string, unknown>
        goalText = (scriptData.goal as string) ?? goalText
        const rawWorkItems = (scriptData.work_items as Array<Record<string, unknown>>)
          ?? (scriptData.workItems as Array<Record<string, unknown>>)
          ?? []

        for (const w of rawWorkItems) {
          const workId = (w.work_id as string) ?? (w.workId as string)
          if (workId) {
            workItemMap.set(workId, {
              workId,
              goal: goalText || userInputHint || '',
              objective: (w.objective as string) ?? '',
              delta: (w.delta as string) ?? undefined,
              dependencies: (w.dependencies as string[]) ?? [],
              agent: (w.agent as AgentType) ?? 'standard',
              status: 'pending',
              toolHint: (w.tool_hint as string) ?? (w.toolHint as string) ?? undefined,
              targetPaths: (w.target_paths as string[]) ?? (w.targetPaths as string[]) ?? undefined,
            })
          }
        }

        const ctx = (scriptData.system_context as Record<string, unknown>)
          ?? (scriptData.systemContext as Record<string, unknown>)
        if (ctx) {
          systemContext = {
            packageManagers: (ctx.package_managers as string[]) ?? (ctx.packageManagers as string[]) ?? [],
            frameworks: (ctx.frameworks as string[]) ?? [],
            languages: (ctx.languages as string[]) ?? [],
            os: (ctx.os as string) ?? '',
            artifacts: (ctx.artifacts as Array<{ path: string; type: string; description?: string }>) ?? [],
            patterns: (ctx.patterns as string[]) ?? [],
          }
        }
        state = 'running'
        break
      }

      case 'workitem_started': {
        const workId = (data.work_id as string)
          ?? (data.workId as string)
          ?? (e.work_item_id as string)
          ?? (e.workItemId as string)
        if (workId) {
          const existing = workItemMap.get(workId)
          if (existing) {
            existing.status = 'in_progress'
            existing.objective = (data.objective as string) ?? existing.objective
            if (data.delta) existing.delta = data.delta as string
          } else {
            workItemMap.set(workId, {
              workId,
              goal: goalText || userInputHint || '',
              objective: (data.objective as string) ?? '',
              delta: (data.delta as string) ?? undefined,
              dependencies: (data.dependencies as string[]) ?? [],
              agent: (data.agent as AgentType) ?? 'standard',
              status: 'in_progress',
            })
          }
        }
        if (state === 'queued') {
          state = 'running'
        }
        break
      }

      case 'workitem_completed': {
        const workId = (data.work_id as string)
          ?? (data.workId as string)
          ?? (e.work_item_id as string)
          ?? (e.workItemId as string)
        if (workId && workItemMap.has(workId)) {
          const item = workItemMap.get(workId)!
          item.status = 'completed'
          const metrics = data.metrics as Record<string, unknown> | undefined
          item.durationMs = (metrics?.durationMs as number) ?? (metrics?.duration_ms as number) ?? (data.duration_ms as number)
        }
        if (state === 'queued') {
          state = 'running'
        }
        break
      }

      case 'workitem_failed': {
        const workId = (data.work_id as string)
          ?? (data.workId as string)
          ?? (e.work_item_id as string)
          ?? (e.workItemId as string)
        if (workId && workItemMap.has(workId)) {
          const item = workItemMap.get(workId)!
          item.status = 'failed'
          item.error = (data.error as string)
            ?? (data.termination_reason as string)
            ?? (data.terminationReason as string)
        }
        state = 'error'
        errorMessage = (data.error as string)
          ?? (data.termination_reason as string)
          ?? (data.terminationReason as string)
        break
      }

      case 'workitem_skipped': {
        const workId = (data.work_id as string)
          ?? (data.workId as string)
          ?? (e.work_item_id as string)
          ?? (e.workItemId as string)
        if (workId && workItemMap.has(workId)) {
          const item = workItemMap.get(workId)!
          item.status = 'skipped'
          item.error = (data.reason as string) ?? (data.error as string)
        }
        break
      }

      case 'tool_call': {
        const toolCall: ToolCall = {
          id: `${sessionKey}-${requestId}-tool-${toolCalls.length}`,
          toolName: (data.tool_name as string) ?? (data.toolName as string) ?? 'unknown',
          arguments: (data.arguments as Record<string, unknown>) ?? {},
          result: data.result as string | undefined,
          success: (data.success as boolean) ?? true,
          durationMs: (data.duration_ms as number) ?? (data.durationMs as number) ?? 0,
          timestamp: eventTimestamp,
        }
        toolCalls.push(toolCall)
        // Group by workItemId for nesting
        const toolWorkItemId = (e.work_item_id as string)
          ?? (e.workItemId as string)
          ?? (data.work_item_id as string)
          ?? (data.workItemId as string)
        if (toolWorkItemId) {
          if (!toolCallsByWorkItem.has(toolWorkItemId)) {
            toolCallsByWorkItem.set(toolWorkItemId, [])
          }
          toolCallsByWorkItem.get(toolWorkItemId)!.push(toolCall)
        }
        if (state === 'queued') {
          state = 'running'
        }
        break
      }

      case 'goal_achieved':
        state = 'success'
        endedAt = eventTimestamp
        if (!goalText && data.goal) {
          goalText = data.goal as string
        }
        break

      case 'goal_not_achieved':
        state = 'error'
        endedAt = eventTimestamp
        if (!goalText && data.goal) {
          goalText = data.goal as string
        }
        errorMessage = (data.reason as string) ?? errorMessage ?? 'Goal not achieved'
        break
    }
  }

  if (!startedAt && events.length > 0) {
    startedAt = toISOTimestamp(events[0]?.timestamp, fallbackTime)
    createdAt = startedAt
  }

  if (!endedAt && (state === 'success' || state === 'error')) {
    endedAt = lastEventTime
  }

  if (!userInputHint && goalText) {
    userInput = goalText
  }

  const resolvedGoal = goalText || userInput
  if (resolvedGoal) {
    for (const item of workItemMap.values()) {
      if (!item.goal) {
        item.goal = resolvedGoal
      }
    }
  }

  // Convert workItemMap to array and attach nested calls
  const workItemsArray = Array.from(workItemMap.values())
  for (const item of workItemsArray) {
    item.toolCalls = toolCallsByWorkItem.get(item.workId) ?? []
    item.llmCalls = llmCallsByWorkItem.get(item.workId) ?? []
  }
  const workItemsCompleted = workItemsArray.filter(w => w.status === 'completed').length
  const workItemsTotal = workItemsArray.length

  // Aggregate token metrics from LLM calls
  if (llmCalls.length > 0) {
    const lastCall = llmCalls[llmCalls.length - 1]
    const inputTokens = lastCall?.promptTokens ?? 0 // Current context size (from last call)
    const peakInputTokens = Math.max(...llmCalls.map(c => c.promptTokens), 0)
    const outputTokens = lastCall?.completionTokens ?? 0 // Last request output
    const totalOutputTokens = llmCalls.reduce((sum, c) => sum + c.completionTokens, 0)
    const maxTokens = 200000 // Default context window size
    contextWindow = {
      inputTokens,
      peakInputTokens,
      outputTokens,
      totalOutputTokens,
      maxTokens,
      percentageUsed: inputTokens / maxTokens,
      messageCount: llmCalls.length,
      timestamp: lastCall?.timestamp ?? lastEventTime,
    }
  }

  return {
    id: `${sessionKey}-${requestId}`,
    sessionId: sessionKey,
    state,
    userInput,
    createdAt,
    startedAt,
    endedAt,
    plan: workItemsArray.length > 0
      ? { goal: goalText || userInput, workItems: workItemsArray, systemContext }
      : undefined,
    toolCalls,
    reflection: undefined,
    llmCalls,
    userPrompts,
    contextWindow,
    workItemsCompleted,
    workItemsTotal,
    totalToolCalls: toolCalls.length,
    durationMs: startedAt && endedAt
      ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
      : undefined,
    errorMessage,
  }
}

export function mapGraphDSession(raw: GraphDSession, messages: GraphDMessage[] = []): Session {
  const meta = raw.metadata_json ? JSON.parse(raw.metadata_json) : {}
  const createdAt = unixToIso(raw.created_at)

  // Parse agent requests from event metadata
  const requests: AgentRequest[] = parseRequestsFromMetadata(meta, raw.session_key, createdAt, messages)

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
