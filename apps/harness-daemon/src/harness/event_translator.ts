/**
 * Event translator for converting AgentEvents to BridgeEvents.
 *
 * Translates the agent's internal event format to the TUI-compatible format.
 */

import type { AgentEvent, AgentEventType } from '../../../../packages/agent-core/src/types/events.js';
import type {
  BridgeEvent,
  ProgressEventData,
  StatusEventData,
  UserPromptEventData,
  EventLevel,
  EventKind,
} from './types.js';

/**
 * Translate an AgentEvent to a BridgeEvent for the TUI.
 *
 * Returns null if the event should not be forwarded to the TUI.
 */
export function translateAgentEvent(event: AgentEvent): BridgeEvent | null {
  const { type, data, requestId } = event;

  switch (type as AgentEventType) {
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

    case 'workitem_started': {
      const itemData = data as { objective?: string };
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: itemData.objective ? `Starting: ${itemData.objective}` : 'Starting work item...',
          level: 'info',
          kind: 'work',
        } satisfies ProgressEventData,
      };
    }

    case 'workitem_completed': {
      const itemData = data as { objective?: string; durationMs?: number };
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: itemData.objective
            ? `Completed: ${itemData.objective}`
            : 'Work item completed',
          level: 'success',
          kind: 'work',
          duration_ms: itemData.durationMs,
        } satisfies ProgressEventData,
      };
    }

    case 'workitem_failed': {
      const itemData = data as { objective?: string; error?: string };
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: `Failed: ${itemData.error || itemData.objective || 'work item failed'}`,
          level: 'error',
          kind: 'work',
        } satisfies ProgressEventData,
      };
    }

    case 'workitem_skipped': {
      const itemData = data as { objective?: string; reason?: string };
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: `Skipped: ${itemData.reason || itemData.objective || 'work item skipped'}`,
          level: 'warning',
          kind: 'work',
        } satisfies ProgressEventData,
      };
    }

    case 'tool_call': {
      const toolData = data as {
        toolName?: string;
        arguments?: Record<string, unknown>;
        phase?: 'starting' | 'completed';
        success?: boolean;
        durationMs?: number;
      };
      const phase = toolData.phase ?? 'starting';
      const isCompleted = phase === 'completed';
      const level: EventLevel = !isCompleted ? 'info' : toolData.success ? 'success' : 'error';
      let message: string;
      if (!isCompleted) {
        message = `Using ${toolData.toolName || 'tool'}...`;
      } else {
        const status = toolData.success ? '✓' : '✗';
        const duration = toolData.durationMs !== undefined ? ` (${toolData.durationMs}ms)` : '';
        message = `${status} ${toolData.toolName || 'tool'}${duration}`;
      }
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message,
          level,
          kind: 'tool',
          tool_name: toolData.toolName,
          duration_ms: isCompleted ? toolData.durationMs : undefined,
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

    case 'llm_call':
      return null;

    default:
      return null;
  }
}

/**
 * Create a stream event for the TUI.
 */
export function createStreamEvent(
  requestId: string,
  chunk: string,
  chunkIndex: number,
  isFinal: boolean
): BridgeEvent {
  return {
    type: 'stream',
    data: {
      request_id: requestId,
      chunk,
      chunk_index: chunkIndex,
      is_final: isFinal,
    },
  };
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
export function createReadyEvent(sessionKey: string, configSummary?: string): BridgeEvent {
  return {
    type: 'ready',
    data: {
      session_key: sessionKey,
      capabilities: {
        voice_available: false,
        streaming_supported: true,
      },
      config_summary: configSummary,
    },
  };
}

/**
 * Create a user prompt event for the TUI.
 */
export function createUserPromptEvent(
  requestId: string,
  question: string,
  options?: Array<string | { label: string; description?: string }>,
  context?: string,
  multiSelect?: boolean
): BridgeEvent {
  return {
    type: 'user_prompt',
    data: {
      request_id: requestId,
      question,
      options,
      context,
      multi_select: multiSelect,
    } satisfies UserPromptEventData,
  };
}
