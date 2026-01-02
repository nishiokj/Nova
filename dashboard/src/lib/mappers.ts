import type { Session, Request, SessionState, Environment, AgentTask, TaskState, PlanStep, ToolCall, Reflection } from '../domain/models'
import { computeSessionInsights, computeRequestInsights } from '../domain/models'
import type { GraphDSession, GraphDMessage } from './api'

function unixToIso(ts: number): string {
  return new Date(ts * 1000).toISOString()
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

// Parse tasks from messages - each user message is a task request
// This is the FALLBACK when wizard_events are not available
function parseTasksFromMessages(messages: GraphDMessage[], sessionKey: string): AgentTask[] {
  const tasks: AgentTask[] = []

  // Group messages by user message (each user message starts a new task)
  let currentTask: { userMessage: GraphDMessage; assistantMessages: GraphDMessage[] } | null = null
  const taskGroups: { userMessage: GraphDMessage; assistantMessages: GraphDMessage[] }[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      // Start a new task
      if (currentTask) {
        taskGroups.push(currentTask)
      }
      currentTask = { userMessage: msg, assistantMessages: [] }
    } else if (msg.role === 'assistant' && currentTask) {
      currentTask.assistantMessages.push(msg)
    }
  }
  if (currentTask) {
    taskGroups.push(currentTask)
  }

  // Convert each group to an AgentTask
  for (let i = 0; i < taskGroups.length; i++) {
    const group = taskGroups[i]
    const userMsg = group.userMessage
    const assistantMsgs = group.assistantMessages

    // Keep full user input - truncation is display's job
    const userInput = userMsg.content

    // Determine task state based on assistant responses
    let state: TaskState = 'queued'
    let errorMessage: string | undefined

    if (assistantMsgs.length > 0) {
      const lastResponse = assistantMsgs[assistantMsgs.length - 1].content

      // Only mark as error for explicit failure markers, not just the word "error"
      if (lastResponse.includes('BUDGET_EXCEEDED')) {
        state = 'error'
        errorMessage = 'Budget exceeded - task could not complete'
      } else if (lastResponse.startsWith('Unable to complete')) {
        state = 'error'
        // Extract the actual error message
        errorMessage = lastResponse.slice(0, 200)
      } else if (lastResponse.startsWith('ERROR:')) {
        state = 'error'
        errorMessage = lastResponse.slice(6).trim().slice(0, 200)
      } else {
        // Don't assume error just because the word "error" appears
        state = 'success'
      }
    }

    // Calculate duration if we have both timestamps
    const startedAt = unixToIso(userMsg.created_at)
    const endedAt = assistantMsgs.length > 0
      ? unixToIso(assistantMsgs[assistantMsgs.length - 1].created_at)
      : undefined
    const durationMs = endedAt
      ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
      : undefined

    tasks.push({
      id: `${sessionKey}-task-${i}`,
      sessionId: sessionKey,
      state,
      userInput,
      createdAt: startedAt,
      startedAt,
      endedAt,
      toolCalls: [],
      stepsCompleted: assistantMsgs.length > 0 ? 1 : 0,
      stepsTotal: 1,
      totalToolCalls: 0,
      durationMs,
      errorMessage,
    })
  }

  return tasks
}

// Parse wizard/agent metadata to extract task information
function parseTasksFromMetadata(meta: Record<string, unknown>, sessionKey: string, createdAt: string): AgentTask[] {
  const tasks: AgentTask[] = []

  // Check for wizard_events in metadata
  const wizardEvents = meta.wizard_events as unknown[] | undefined
  const workLedger = meta.work_ledger as Record<string, unknown> | undefined

  if (wizardEvents && Array.isArray(wizardEvents) && wizardEvents.length > 0) {
    // Split events into tasks by goal boundaries (goal_started -> goal_achieved/goal_aborted)
    const taskEventGroups: unknown[][] = []
    let currentGroup: unknown[] = []

    for (const event of wizardEvents) {
      const e = event as Record<string, unknown>
      const eventType = e.type as string

      if (eventType === 'goal_started') {
        // Start a new task group
        if (currentGroup.length > 0) {
          taskEventGroups.push(currentGroup)
        }
        currentGroup = [event]
      } else {
        currentGroup.push(event)

        // End of task
        if (eventType === 'goal_achieved' || eventType === 'goal_aborted') {
          taskEventGroups.push(currentGroup)
          currentGroup = []
        }
      }
    }

    // Don't forget any remaining events (running task)
    if (currentGroup.length > 0) {
      taskEventGroups.push(currentGroup)
    }

    // Create tasks from each group
    for (let i = 0; i < taskEventGroups.length; i++) {
      const task = createTaskFromEvents(sessionKey, `goal-${i}`, taskEventGroups[i], i, createdAt)
      tasks.push(task)
    }
  }

  // If no wizard events but we have work_ledger, create task from that
  if (tasks.length === 0 && workLedger) {
    const entries = workLedger.entries as unknown[] | undefined
    if (entries && entries.length > 0) {
      const task = createTaskFromLedger(sessionKey, workLedger, createdAt)
      tasks.push(task)
    }
  }

  return tasks
}

function createTaskFromEvents(
  sessionKey: string,
  _goalId: string,
  events: unknown[],
  index: number,
  fallbackTime: string
): AgentTask {
  const toolCalls: ToolCall[] = []
  let reflection: Reflection | undefined
  let userInput = `Task ${index + 1}`
  let goalText = ''
  let state: TaskState = 'queued'
  let errorMessage: string | undefined
  let createdAt = fallbackTime
  let startedAt: string | undefined
  let endedAt: string | undefined

  // Track step objectives by step_num for updates
  const stepMap = new Map<number, PlanStep>()

  for (const event of events) {
    const e = event as Record<string, unknown>
    const eventType = e.type as string
    const data = (e.data ?? {}) as Record<string, unknown>
    const stepNum = e.step_num as number | undefined

    // Extract timing - convert unix timestamp to ISO if needed
    if (e.timestamp && !startedAt) {
      const ts = e.timestamp as number | string
      startedAt = typeof ts === 'number' ? new Date(ts * 1000).toISOString() : ts
      createdAt = startedAt
    }

    switch (eventType) {
      case 'goal_started':
        // NEW: Extract user input and goal from goal_started event
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
              phase: (s.phase as 'discovery' | 'execution') ?? 'execution',
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
              phase: (data.phase as 'discovery' | 'execution') ?? 'execution',
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
        }
        break

      case 'tool_call':
        toolCalls.push({
          id: `${sessionKey}-tool-${toolCalls.length}`,
          toolName: (data.tool_name as string) ?? 'unknown',
          arguments: (data.arguments as Record<string, unknown>) ?? {},
          result: data.result as string | undefined,
          success: (data.success as boolean) ?? true,
          durationMs: (data.duration_ms as number) ?? 0,
          timestamp: typeof e.timestamp === 'number'
            ? new Date((e.timestamp as number) * 1000).toISOString()
            : (e.timestamp as string) ?? fallbackTime,
        })
        break

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
          endedAt = typeof e.timestamp === 'number'
            ? new Date((e.timestamp as number) * 1000).toISOString()
            : e.timestamp as string
        }
        // Can also extract goal from here if not set
        if (!goalText && data.goal) {
          goalText = data.goal as string
        }
        break

      case 'goal_aborted':
        state = 'error'
        if (e.timestamp) {
          endedAt = typeof e.timestamp === 'number'
            ? new Date((e.timestamp as number) * 1000).toISOString()
            : e.timestamp as string
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

  // Convert stepMap to sorted array
  const stepsArray = Array.from(stepMap.values()).sort((a, b) => a.stepNum - b.stepNum)
  const stepsCompleted = stepsArray.filter(s => s.status === 'completed').length
  const stepsTotal = stepsArray.length

  return {
    id: `${sessionKey}-task-${index}`,
    sessionId: sessionKey,
    state,
    userInput,
    createdAt,
    startedAt,
    endedAt,
    plan: stepsArray.length > 0 ? { goal: goalText || userInput, steps: stepsArray } : undefined,
    toolCalls,
    reflection,
    stepsCompleted,
    stepsTotal,
    totalToolCalls: toolCalls.length,
    durationMs: startedAt && endedAt
      ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
      : undefined,
    errorMessage,
  }
}

function createTaskFromLedger(
  sessionKey: string,
  ledger: Record<string, unknown>,
  fallbackTime: string
): AgentTask {
  const entries = ledger.entries as unknown[] ?? []
  const goal = (ledger.current_goal as string) ?? 'Agent task'

  const steps: PlanStep[] = entries.map((entry, i) => {
    const e = entry as Record<string, unknown>
    return {
      stepNum: i + 1,
      objective: (e.description as string) ?? `Step ${i + 1}`,
      status: mapLedgerStatus(e.status as string),
      phase: 'execution' as const,
      toolHint: e.tool_hint as string | undefined,
      required: true,
      durationMs: e.duration_ms as number | undefined,
      error: e.error as string | undefined,
    }
  })

  const stepsCompleted = steps.filter(s => s.status === 'completed').length
  const hasErrors = steps.some(s => s.status === 'failed')
  const allDone = steps.length > 0 && steps.every(s => s.status === 'completed' || s.status === 'skipped')

  return {
    id: `${sessionKey}-task-0`,
    sessionId: sessionKey,
    state: hasErrors ? 'error' : allDone ? 'success' : steps.some(s => s.status === 'in_progress') ? 'running' : 'queued',
    userInput: goal,
    createdAt: fallbackTime,
    plan: { goal, steps },
    toolCalls: [],
    stepsCompleted,
    stepsTotal: steps.length,
    totalToolCalls: 0,
    errorMessage: hasErrors ? steps.find(s => s.error)?.error : undefined,
  }
}

function mapLedgerStatus(status: string | undefined): PlanStep['status'] {
  switch (status) {
    case 'done':
    case 'completed':
      return 'completed'
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

export function mapGraphDSession(raw: GraphDSession, messages: GraphDMessage[] = []): Session {
  const meta = raw.metadata_json ? JSON.parse(raw.metadata_json) : {}
  const createdAt = unixToIso(raw.created_at)

  // Map messages to requests (each message can be a "request")
  const requests: Request[] = messages
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
        insights: computeRequestInsights(partial),
      }
    })

  // Parse tasks: prefer wizard metadata, fallback to message-based tasks
  let tasks: AgentTask[] = parseTasksFromMetadata(meta, raw.session_key, createdAt)

  // If no tasks from metadata, create tasks from messages
  if (tasks.length === 0 && messages.length > 0) {
    tasks = parseTasksFromMessages(messages, raw.session_key)
  }

  // Infer session state from tasks if we have them
  const hasRunningTasks = tasks.some(t => t.state === 'running')
  const hasErrorTasks = tasks.some(t => t.state === 'error')
  const inferredState = hasRunningTasks
    ? 'active'
    : hasErrorTasks
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
    tasks,
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
