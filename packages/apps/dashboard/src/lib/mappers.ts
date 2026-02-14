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
  WatcherDecision,
  MemoryInjection,
} from '../domain/models'
import { computeSessionInsights } from '../domain/models'
import type { GraphDSession, GraphDMessage } from './api'

function unixToIso(ts: number): string {
  return new Date(ts * 1000).toISOString()
}

function normalizeUnixSeconds(ts: unknown, fallback = 0): number {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    if (ts > 1e12) return Math.floor(ts / 1000)
    if (ts > 0) return Math.floor(ts)
  }

  if (typeof ts === 'string') {
    const asNumber = Number(ts)
    if (!Number.isNaN(asNumber)) {
      return normalizeUnixSeconds(asNumber, fallback)
    }
    const parsed = Date.parse(ts)
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000)
  }

  return fallback
}

function toISOTimestamp(ts: unknown, fallback: string): string {
  if (typeof ts === 'number' || typeof ts === 'string') {
    const normalized = normalizeUnixSeconds(ts)
    if (normalized > 0) return unixToIso(normalized)
  }
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

  if (!Number.isFinite(lastAccessedAt) || lastAccessedAt <= 0) {
    return 'idle'
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
  const memoryInjections: MemoryInjection[] = []
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
          provider: (callData.provider as string) ?? 'unknown',
          workItemId: llmWorkItemId,
          promptPreview: (callData.prompt_preview as string) ?? (callData.promptPreview as string) ?? '',
          responsePreview: (callData.response_preview as string) ?? (callData.responsePreview as string) ?? '',
          totalTokens: (callData.total_tokens as number) ?? (callData.totalTokens as number) ?? 0,
          promptTokens: (callData.prompt_tokens as number) ?? (callData.promptTokens as number) ?? 0,
          completionTokens: (callData.completion_tokens as number) ?? (callData.completionTokens as number) ?? 0,
          cachedTokens: (callData.cached_tokens as number) ?? (callData.cachedTokens as number) ?? undefined,
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

      case 'workitem_status': {
        const workId = (data.work_id as string)
          ?? (data.workId as string)
          ?? (e.work_item_id as string)
          ?? (e.workItemId as string)
        const status = data.status as 'started' | 'completed' | 'failed' | 'skipped'

        if (workId) {
          const existing = workItemMap.get(workId)
          if (existing) {
            // Map 'started' to 'in_progress' for domain model
            existing.status = status === 'started' ? 'in_progress' : status
            existing.objective = (data.objective as string) ?? existing.objective
            if (data.delta) existing.delta = data.delta as string

            // Update status-specific fields
            if (status === 'completed') {
              const metrics = data.metrics as Record<string, unknown> | undefined
              existing.durationMs = (metrics?.durationMs as number) ?? (metrics?.duration_ms as number)
            } else if (status === 'failed') {
              existing.error = (data.error as string)
                ?? (data.termination_reason as string)
                ?? (data.terminationReason as string)
            } else if (status === 'skipped') {
              existing.error = (data.reason as string) ?? (data.error as string)
            }
          } else {
            workItemMap.set(workId, {
              workId,
              goal: goalText || userInputHint || '',
              objective: (data.objective as string) ?? '',
              delta: (data.delta as string) ?? undefined,
              dependencies: (data.dependencies as string[]) ?? [],
              agent: (data.agent as AgentType) ?? 'standard',
              status: status === 'started' ? 'in_progress' : status,
            })
          }
        }

        if (state === 'queued' && status === 'started') {
          state = 'running'
        } else if (status === 'failed') {
          state = 'error'
          errorMessage = (data.error as string)
            ?? (data.termination_reason as string)
            ?? (data.terminationReason as string)
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

      case 'memory_injected': {
        const memData = e.data as Record<string, unknown>
        const memWorkItemId = (e.work_item_id as string)
          ?? (e.workItemId as string)
          ?? (memData.work_item_id as string)
          ?? (memData.workItemId as string)
          ?? undefined
        memoryInjections.push({
          id: `${sessionKey}-${requestId}-memory-${memoryInjections.length}`,
          workItemId: memWorkItemId,
          query: (memData.query as string) ?? '',
          resultPreview: (memData.result_preview as string) ?? (memData.resultPreview as string) ?? undefined,
          memoryContent: (memData.memory_content as string) ?? (memData.memoryContent as string) ?? undefined,
          contextWithMemory: (memData.context_with_memory as string) ?? (memData.contextWithMemory as string) ?? undefined,
          itemCount: (memData.item_count as number) ?? (memData.itemCount as number) ?? 0,
          success: (memData.success as boolean) ?? false,
          iteration: (memData.iteration as number) ?? 0,
          version: (memData.version as 'v1' | 'v2') ?? undefined,
          latencyMs: (memData.latency_ms as number) ?? (memData.latencyMs as number) ?? undefined,
          coverage: (memData.coverage as Record<string, number>) ?? undefined,
          discriminatorsIncluded: (memData.discriminators_included as number)
            ?? (memData.discriminatorsIncluded as number)
            ?? undefined,
          totalTokens: (memData.total_tokens as number) ?? (memData.totalTokens as number) ?? undefined,
          fallbackToV1: (memData.fallback_to_v1 as boolean) ?? (memData.fallbackToV1 as boolean) ?? undefined,
          timestamp: eventTimestamp,
        })
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
    const cachedTokens = lastCall?.cachedTokens // Cached tokens from last call
    const totalCachedTokens = llmCalls.reduce((sum, c) => sum + (c.cachedTokens ?? 0), 0)
    const maxTokens = 200000 // Default context window size
    contextWindow = {
      inputTokens,
      peakInputTokens,
      outputTokens,
      totalOutputTokens,
      maxTokens,
      percentageUsed: inputTokens / maxTokens,
      messageCount: llmCalls.length,
      cachedTokens,
      totalCachedTokens: totalCachedTokens > 0 ? totalCachedTokens : undefined,
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
    memoryInjections,
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

function extractWatcherDecisions(
  meta: Record<string, unknown>,
  createdAt: string
): WatcherDecision[] {
  const agentEvents = meta.agent_events as unknown[] | undefined
  if (!agentEvents || !Array.isArray(agentEvents)) return []

  return agentEvents
    .filter((e): e is Record<string, unknown> =>
      (e as Record<string, unknown>).type === 'watcher_decision'
    )
    .map((e) => {
      const data = (e.data ?? {}) as Record<string, unknown>
      return {
        timestamp: toISOTimestamp(e.timestamp, createdAt),
        trigger: (data.trigger as string) ?? 'unknown',
        action: (data.watcherAction as string) ?? (data.watcher_action as string) ?? 'unknown',
        question: data.question as string | undefined,
        answer: data.answer as string | undefined,
        rationale: (data.rationale as string) ?? '',
        workItemId: (e.work_item_id as string) ?? (e.workItemId as string) ?? undefined,
        qualityGate: (data.qualityGate ?? data.quality_gate) as { passed: boolean; issues?: string[] } | undefined,
      }
    })
}

export function mapGraphDSession(raw: GraphDSession, messages: GraphDMessage[] = []): Session {
  const meta = raw.metadata_json ? JSON.parse(raw.metadata_json) : {}
  const nowSeconds = Math.floor(Date.now() / 1000)
  const createdAtSeconds = normalizeUnixSeconds(raw.created_at, nowSeconds)
  const lastAccessedAtSeconds = normalizeUnixSeconds(raw.last_accessed_at, createdAtSeconds)
  const createdAt = unixToIso(createdAtSeconds)

  // Parse agent requests from event metadata
  const requests: AgentRequest[] = parseRequestsFromMetadata(meta, raw.session_key, createdAt, messages)
  const watcherDecisions: WatcherDecision[] = extractWatcherDecisions(meta, createdAt)

  // Staleness takes priority — a session with no recent activity is idle/ended
  // regardless of orphaned running requests in its metadata
  const baseStatus = mapStatus(raw.status, lastAccessedAtSeconds)
  let inferredState: SessionState = baseStatus
  if (baseStatus === 'active') {
    const hasRunningRequests = requests.some(r => r.state === 'running')
    const hasErrorRequests = requests.some(r => r.state === 'error')
    if (hasErrorRequests && !hasRunningRequests) {
      inferredState = 'error'
    }
  }

  // Extract description from metadata or first request
  const description = meta.description as string | undefined
    ?? (requests[0]?.userInput?.slice(0, 80) || undefined)

  const partialSession = {
    id: raw.session_key,
    userId: meta.user_id ?? 'anonymous',
    state: inferredState,
    env: mapClientTypeToEnv(raw.client_type),
    createdAt,
    startedAt: createdAt,
    endedAt: raw.status === 'closed' ? unixToIso(lastAccessedAtSeconds) : undefined,
    tags: [raw.client_type, raw.working_dir?.split('/').pop() ?? 'unknown'].filter(Boolean) as string[],
    meta: {
      clientType: raw.client_type,
      workingDir: raw.working_dir ?? undefined,
      description,
      ...meta,
    },
    requests,
    watcherDecisions,
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
