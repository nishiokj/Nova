/**
 * Event translator for converting WizardEvents to BridgeEvents.
 *
 * Translates the agent's internal event format to the TUI-compatible format.
 */

import type { WizardEvent, WizardEventType } from '../types/events.js';
import type {
  BridgeEvent,
  ProgressEventData,
  StatusEventData,
  UserPromptEventData,
} from './types.js';

/**
 * Translate a WizardEvent to a BridgeEvent for the TUI.
 *
 * Returns null if the event should not be forwarded to the TUI.
 */
export function translateWizardEvent(
  event: WizardEvent,
  requestId: string
): BridgeEvent | null {
  const { type, data, stepNum } = event;

  switch (type as WizardEventType) {
    case 'goal_started': {
      const goalData = data as { goal?: string; userInput?: string };
      return {
        type: 'status',
        data: {
          state: 'sending',
          message: `Processing: ${goalData.goal?.slice(0, 50) || 'request'}...`,
        } satisfies StatusEventData,
      };
    }

    case 'step_started': {
      const stepData = data as { objective?: string; phase?: string; toolHint?: string };
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: stepData.objective || 'Executing step...',
          step_number: stepNum,
        } satisfies ProgressEventData,
      };
    }

    case 'step_completed': {
      const stepData = data as { objective?: string; outcomeSummary?: string; stepNum?: number };
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: `Completed: ${stepData.outcomeSummary?.slice(0, 100) || stepData.objective || 'step'}`,
          step_number: stepData.stepNum ?? stepNum,
        } satisfies ProgressEventData,
      };
    }

    case 'step_failed': {
      const stepData = data as { objective?: string; error?: string };
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: `Failed: ${stepData.error || stepData.objective || 'step failed'}`,
          step_number: stepNum,
        } satisfies ProgressEventData,
      };
    }

    case 'step_skipped': {
      const stepData = data as { objective?: string; reason?: string };
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: `Skipped: ${stepData.reason || stepData.objective || 'step skipped'}`,
          step_number: stepNum,
        } satisfies ProgressEventData,
      };
    }

    case 'tool_call': {
      const toolData = data as { toolName?: string; arguments?: Record<string, unknown>; success?: boolean };
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: `Using ${toolData.toolName || 'tool'}...`,
          tool_name: toolData.toolName,
          step_number: stepNum,
        } satisfies ProgressEventData,
      };
    }

    case 'user_input_requested': {
      const promptData = data as {
        question?: string;
        options?: string[];
        context?: string;
        requestId?: string;
      };
      return {
        type: 'user_prompt',
        data: {
          request_id: promptData.requestId || requestId,
          question: promptData.question || 'Please provide input:',
          options: promptData.options,
          context: promptData.context,
          multi_select: false,
        } satisfies UserPromptEventData,
      };
    }

    case 'reflection_started':
    case 'reflection_completed':
      // These are internal events, don't forward to TUI
      return null;

    case 'llm_call':
    case 'plan_snapshot':
    case 'plan_patched':
    case 'context_window_update':
      // Dashboard-specific events, don't forward to TUI
      return null;

    case 'llm_error': {
      const errorData = data as {
        provider?: string;
        model?: string;
        error?: string;
        errorType?: string;
        statusCode?: number;
        willRetry?: boolean;
        attemptNumber?: number;
      };
      const retryInfo = errorData.willRetry
        ? ` (retry ${errorData.attemptNumber ?? 1})`
        : '';
      return {
        type: 'error',
        data: {
          message: `LLM error (${errorData.provider}/${errorData.model}): ${errorData.error}${retryInfo}`,
          fatal: !errorData.willRetry,
          detail: {
            provider: errorData.provider,
            model: errorData.model,
            errorType: errorData.errorType,
            statusCode: errorData.statusCode,
          },
        },
      };
    }

    case 'quality_issue_detected':
    case 'error_detected': {
      const errorData = data as { errors?: string[]; context?: string };
      return {
        type: 'progress',
        data: {
          request_id: requestId,
          message: `Issue: ${errorData.errors?.[0] || 'quality issue detected'}`,
          step_number: stepNum,
        } satisfies ProgressEventData,
      };
    }

    case 'goal_achieved':
    case 'goal_aborted':
      // These are handled by the final result, not as events
      return null;

    case 'steps_scaffolded':
    case 'user_input_received':
      // Internal events, don't forward to TUI
      return null;

    default:
      // Unknown event type, skip
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
    data: { state, message } satisfies StatusEventData,
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
export function createErrorEvent(
  message: string,
  fatal = false,
  detail?: unknown
): BridgeEvent {
  return {
    type: 'error',
    data: { message, fatal, detail },
  };
}

/**
 * Create a ready event for the TUI.
 */
export function createReadyEvent(
  sessionKey: string,
  configSummary?: string
): BridgeEvent {
  return {
    type: 'ready',
    data: {
      session_key: sessionKey,
      capabilities: {
        voice_available: false, // Voice deferred
        streaming_supported: true,
      },
      config_summary: configSummary,
    },
  };
}
