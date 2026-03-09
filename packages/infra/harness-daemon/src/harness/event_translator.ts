/**
 * Event translator for converting AgentEvents to BridgeEvents.
 *
 * Translates the agent's internal event format to the TUI-compatible format.
 */

import type { AgentEvent } from 'types';
import type {
  BridgeEvent,
  ProgressEventData,
  StatusEventData,
  EventLevel,
} from './types.js';

/**
 * Translate an AgentEvent to a BridgeEvent for the TUI / dashboard.
 *
 * Propagates sessionKey from the raw event into the translated data so that
 * downstream consumers (SSE event stream → dashboard) can route by session.
 *
 * Returns null if the event should not be forwarded.
 */
export function translateAgentEvent(event: AgentEvent): BridgeEvent | null {
  const result = translateAgentEventCore(event);
  if (result) {
    // Propagate sessionKey for event routing (SSE → dashboard)
    const sessionKey = (event as unknown as Record<string, unknown>).sessionKey;
    if (typeof sessionKey === 'string') {
      (result.data!).session_key = sessionKey;
    }
  }
  return result;
}

function translateAgentEventCore(event: AgentEvent): BridgeEvent | null {
  const { type, data, requestId } = event;

  switch (type) {
    case 'runtime_script_created': {
      const goalData = data as { goal?: string };
      return {
        type: 'status',
        data: {
          state: 'sending',
          message: `Planning: ${goalData.goal?.slice(0, 50) || 'request'}...`,
          level: 'info',
          kind: 'planning',
        } satisfies StatusEventData,
      };
    }

    case 'workitem_status': {
      const itemData = data as {
        objective?: string;
        status: 'started' | 'completed' | 'failed' | 'skipped';
        error?: string;
        reason?: string;
        metrics?: { durationMs?: number };
      };
      const { status, objective } = itemData;

      switch (status) {
        case 'started':
          return {
            type: 'progress',
            data: {
              request_id: requestId,
              message: objective ? `Starting: ${objective}` : 'Starting work item...',
              level: 'info',
              kind: 'work',
            } satisfies ProgressEventData,
          };
        case 'completed':
          return {
            type: 'progress',
            data: {
              request_id: requestId,
              message: objective ? `Completed: ${objective}` : 'Work item completed',
              level: 'success',
              kind: 'work',
              duration_ms: itemData.metrics?.durationMs,
            } satisfies ProgressEventData,
          };
        case 'failed':
          return {
            type: 'progress',
            data: {
              request_id: requestId,
              message: `Failed: ${itemData.error || objective || 'work item failed'}`,
              level: 'error',
              kind: 'work',
            } satisfies ProgressEventData,
          };
        case 'skipped':
          return {
            type: 'progress',
            data: {
              request_id: requestId,
              message: `Skipped: ${itemData.reason || objective || 'work item skipped'}`,
              level: 'warning',
              kind: 'work',
            } satisfies ProgressEventData,
          };
      }
      return null;
    }

    case 'tool_call': {
      const toolData = data as {
        toolName?: string;
        arguments?: Record<string, unknown>;
        phase?: 'starting' | 'completed';
        success?: boolean;
        result?: string;
        durationMs?: number;
      };
      const phase = toolData.phase ?? 'starting';
      const isCompleted = phase === 'completed';
      const level: EventLevel = !isCompleted ? 'info' : toolData.success ? 'success' : 'error';
      let message: string;
      if (!isCompleted) {
        message = `Using ${toolData.toolName || 'tool'}...`;
      } else {
        const status = toolData.success ? 'OK' : 'ERR';
        const duration = toolData.durationMs !== undefined ? ` (${toolData.durationMs}ms)` : '';
        message = `${status} ${toolData.toolName || 'tool'}${duration}`;
      }

      // Include tool arguments for structured display (Edit tool gets full args for diff rendering)
      const includeArgs = isCompleted && toolData.toolName === 'Edit';

      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message,
          level,
          kind: 'tool',
          tool_name: toolData.toolName,
          duration_ms: isCompleted ? toolData.durationMs : undefined,
          tool_args: includeArgs ? toolData.arguments : undefined,
          tool_success: isCompleted ? toolData.success : undefined,
          tool_result: isCompleted ? toolData.result : undefined,
        } satisfies ProgressEventData,
      };
    }

    case 'llm_error': {
      const errorData = data as {
        provider?: string;
        model?: string;
        error?: string;
        errorType?: string;
      };
      return {
        type: 'error',
        data: {
          message: `LLM error (${errorData.provider}/${errorData.model}): ${errorData.error}`,
          fatal: true,
          detail: {
            provider: errorData.provider,
            model: errorData.model,
            errorType: errorData.errorType,
          },
        },
      };
    }

    case 'goal_achieved': {
      const goalData = data as { goal?: string; completed?: number; skipped?: number };
      return {
        type: 'status',
        data: {
          state: 'idle',
          message: goalData.goal ? `Goal achieved: ${goalData.goal.slice(0, 50)}` : 'Goal achieved',
          level: 'success',
          kind: 'system',
        } satisfies StatusEventData,
      };
    }

    case 'goal_not_achieved': {
      const goalData = data as { goal?: string; reason?: string; failed?: number };
      const reason = goalData.reason || 'unknown';
      return {
        type: 'status',
        data: {
          state: 'error',
          message: `Goal not achieved: ${reason}`,
          level: 'error',
          kind: 'system',
        } satisfies StatusEventData,
      };
    }

    case 'llm_call': {
      const llmData = data as {
        agentType?: string;
        provider?: string;
        model?: string;
        promptTokens?: number;
        completionTokens?: number;
        reasoningTokens?: number;
        totalTokens?: number;
        cachedTokens?: number;
        maxWindowSize?: number;
      };
      // Forward llm_call event to TUI for context window tracking
      return {
        type: 'llm_call',
        data: {
          agentType: llmData.agentType,
          provider: llmData.provider ?? 'unknown',
          model: llmData.model ?? 'unknown',
          promptTokens: llmData.promptTokens ?? 0,
          completionTokens: llmData.completionTokens ?? 0,
          reasoningTokens: llmData.reasoningTokens ?? 0,
          totalTokens: llmData.totalTokens ?? 0,
          cachedTokens: llmData.cachedTokens,
          maxWindowSize: llmData.maxWindowSize,
        },
      };
    }

    case 'agent_message': {
      const msgData = data as { agentType?: string; message?: string };
      if (!msgData.message) return null;
      return {
        type: 'stream',
        data: {
          request_id: requestId,
          chunk: msgData.message,
          chunk_index: -1,  // intermediate, not part of final response indexing
          is_final: false,
        },
      };
    }

    case 'agent_reasoning': {
      const reasoningData = data as { content?: string; agentType?: string; isFinal?: boolean };
      // Handle both content chunks and final marker (empty content with isFinal=true)
      if (!reasoningData.content && !reasoningData.isFinal) return null;
      return {
        type: 'stream',
        data: {
          request_id: requestId,
          chunk: reasoningData.content ?? '',
          chunk_index: -1,
          is_final: reasoningData.isFinal ?? false,
          is_reasoning: true,  // Flag for TUI to render distinctly
        },
      };
    }

    case 'artifact_discovered': {
      const artData = data as {
        artifact: { name?: string; kind?: string };
        agentType?: string;
        artifactCount?: number;
      };
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: `Found: ${artData.artifact?.name || 'artifact'} (${artData.artifact?.kind || 'unknown'})`,
          level: 'info',
          kind: 'thinking',
        } satisfies ProgressEventData,
      };
    }

    case 'agent_progress': {
      const progressData = data as {
        message?: string;
        agentType?: string;
        category?: string;
        count?: { current: number; total?: number; label: string };
      };
      let message = progressData.message || 'Processing...';
      if (progressData.count) {
        const { current, total, label } = progressData.count;
        message = total
          ? `${message} (${current}/${total} ${label})`
          : `${message} (${current} ${label})`;
      }
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message,
          level: 'info',
          kind: 'thinking',
        } satisfies ProgressEventData,
      };
    }

    case 'permission_request': {
      const permData = data as {
        requestId?: string;
        tool?: 'Bash' | 'Write' | 'Edit';
        target?: string;
        suggestedPattern?: string;
        workingDirectory?: string;
        description?: string;
      };
      return {
        type: 'permission_request',
        data: {
          request_id: permData.requestId || requestId,
          tool: permData.tool || 'Bash',
          target: permData.target || '',
          suggested_pattern: permData.suggestedPattern || '',
          working_directory: permData.workingDirectory || '',
          description: permData.description || '',
        },
      };
    }

    // ── Harness-level events (also pushed to eventQueue for TUI bridge) ──

    case 'harness_response': {
      const respData = data as {
        success?: boolean;
        content?: string;
        toolsUsed?: string[];
        durationMs?: number;
        error?: string;
        metadata?: Record<string, unknown>;
      };
      return {
        type: 'response',
        data: {
          request_id: requestId,
          success: respData.success ?? false,
          content: respData.content ?? '',
          tools_used: respData.toolsUsed ?? [],
          duration_ms: respData.durationMs ?? 0,
          error: respData.error,
          metadata: respData.metadata,
        },
      };
    }

    case 'harness_status': {
      const statusData = data as {
        state?: 'idle' | 'sending' | 'streaming' | 'error';
        message?: string;
      };
      return {
        type: 'status',
        data: {
          state: statusData.state ?? 'idle',
          message: statusData.message,
        } satisfies StatusEventData,
      };
    }

    case 'harness_error': {
      const errData = data as {
        message?: string;
        fatal?: boolean;
      };
      return {
        type: 'error',
        data: {
          message: errData.message ?? 'Unknown error',
          fatal: errData.fatal ?? false,
        },
      };
    }

    case 'harness_user_prompt': {
      const promptData = data as {
        questions: {
          question: string;
          options?: (string | { label: string; description?: string })[];
          context?: string;
          multiSelect?: boolean;
          questionType?: string;
        }[];
      };
      const wireData: Record<string, unknown> = {
        request_id: requestId,
        questions: promptData.questions.map((q) => ({
          question: q.question,
          options: q.options,
          context: q.context,
          multi_select: q.multiSelect,
          question_type: q.questionType,
        })),
      };
      return {
        type: 'user_prompt',
        data: wireData,
      };
    }

    default:
      return null;
  }
}

/**
 * Create a status event for the TUI.
 */
export function createStatusEvent(
  state: 'idle' | 'sending' | 'streaming' | 'error',
  message?: string
): BridgeEvent {
  return {
    type: 'status',
    data: {
      state,
      message,
    } satisfies StatusEventData,
  };
}

/**
 * Create a response event for the TUI.
 */
export function createResponseEvent(
  requestId: string,
  success: boolean,
  content: string,
  toolsUsed: string[],
  durationMs: number,
  error?: string,
  metadata?: Record<string, unknown>
): BridgeEvent {
  return {
    type: 'response',
    data: {
      request_id: requestId,
      success,
      content,
      tools_used: toolsUsed,
      duration_ms: durationMs,
      error,
      metadata,
    },
  };
}

/**
 * Create an error event for the TUI.
 */
export function createErrorEvent(message: string, fatal = false): BridgeEvent {
  return {
    type: 'error',
    data: {
      message,
      fatal,
    },
  };
}

/**
 * Create a ready event for initialization.
 */
export function createReadyEvent(
  sessionKey: string,
  history?: { role: 'user' | 'agent' | 'system'; content: string; timestamp: number; requestId?: string }[],
  configSummary?: string
): BridgeEvent {
  return {
    type: 'ready',
    data: {
      session_key: sessionKey,
      capabilities: {
        voice_available: false,
        streaming_supported: true,
      },
      config_summary: configSummary,
      history,
    },
  };
}
