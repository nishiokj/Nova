/**
 * Unified session state hook that merges HTTP polling with live events.
 *
 * - Initial data comes from HTTP polling (useSessions)
 * - Live updates come from Event Bus (useEventBus)
 * - Active sessions get real-time updates
 */

import { useEffect, useCallback, useMemo, useReducer, useRef } from 'react';
import type { Session, AgentRequest, LLMCall, ToolCall } from '@shared/domain/models';
import { useSessions } from './useSessions';
import { useEventBus, sessionChannel, runChannel, type BusEvent, type ProgressData } from './useEventBus';

interface SessionUpdate {
  sessionId: string;
  requestId?: string;
  type: 'status' | 'progress' | 'tool_call' | 'llm_call' | 'complete';
  data: unknown;
}

type SessionAction =
  | { type: 'SET_SESSIONS'; sessions: Session[] }
  | { type: 'UPDATE_SESSION'; update: SessionUpdate };

interface SessionState {
  sessions: Session[];
  updatedAt: number;
}

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'SET_SESSIONS':
      return { sessions: action.sessions, updatedAt: Date.now() };

    case 'UPDATE_SESSION': {
      const { sessionId, requestId, type, data } = action.update;
      const sessions = state.sessions.map((session) => {
        if (session.id !== sessionId) return session;

        // Handle different update types
        switch (type) {
          case 'status': {
            const statusData = data as { state?: string };
            return {
              ...session,
              state: (statusData.state as Session['state']) ?? session.state,
            };
          }

          case 'progress': {
            const progressData = data as ProgressData;
            if (!requestId || !progressData.tokens) return session;

            // Update token counts on the request
            const requests = session.requests.map((req) => {
              if (req.id !== requestId) return req;

              // Update context window metrics
              const contextWindow = req.contextWindow ?? {
                inputTokens: 0,
                peakInputTokens: 0,
                outputTokens: 0,
                totalOutputTokens: 0,
                maxTokens: 200000,
                percentageUsed: 0,
                messageCount: 0,
                timestamp: new Date().toISOString(),
              };

              return {
                ...req,
                contextWindow: {
                  ...contextWindow,
                  inputTokens: progressData.tokens!.input,
                  outputTokens: progressData.tokens!.output,
                  totalOutputTokens: contextWindow.totalOutputTokens + progressData.tokens!.output,
                  percentageUsed: progressData.tokens!.input / contextWindow.maxTokens,
                },
              };
            });

            return { ...session, requests };
          }

          case 'tool_call': {
            const toolData = data as {
              tool_name: string;
              arguments: Record<string, unknown>;
              result?: string;
              success: boolean;
              duration_ms: number;
            };
            if (!requestId) return session;

            const requests = session.requests.map((req) => {
              if (req.id !== requestId) return req;

              const newToolCall: ToolCall = {
                id: `${sessionId}-${requestId}-tool-${req.toolCalls.length}`,
                toolName: toolData.tool_name,
                arguments: toolData.arguments,
                result: toolData.result,
                success: toolData.success,
                durationMs: toolData.duration_ms,
                timestamp: new Date().toISOString(),
              };

              return {
                ...req,
                toolCalls: [...req.toolCalls, newToolCall],
                totalToolCalls: req.totalToolCalls + 1,
              };
            });

            return { ...session, requests };
          }

          case 'llm_call': {
            const llmData = data as {
              agent_type: string;
              model: string;
              provider: string;
              total_tokens: number;
              prompt_tokens: number;
              completion_tokens: number;
              duration_ms: number;
            };
            if (!requestId) return session;

            const requests = session.requests.map((req) => {
              if (req.id !== requestId) return req;

              const newLLMCall: LLMCall = {
                id: `${sessionId}-${requestId}-llm-${req.llmCalls.length}`,
                agentType: (llmData.agent_type ?? 'standard') as LLMCall['agentType'],
                model: llmData.model,
                provider: llmData.provider,
                totalTokens: llmData.total_tokens,
                promptTokens: llmData.prompt_tokens,
                completionTokens: llmData.completion_tokens,
                durationMs: llmData.duration_ms,
                promptPreview: '',
                responsePreview: '',
                toolCallsCount: 0,
                timestamp: new Date().toISOString(),
              };

              return {
                ...req,
                llmCalls: [...req.llmCalls, newLLMCall],
              };
            });

            return { ...session, requests };
          }

          case 'complete': {
            const requests = session.requests.map((req) => {
              if (req.id !== requestId) return req;
              return {
                ...req,
                state: 'success' as const,
                endedAt: new Date().toISOString(),
              };
            });

            // Check if all requests are done
            const allDone = requests.every(
              (r) => r.state === 'success' || r.state === 'error' || r.state === 'cancelled'
            );

            return {
              ...session,
              requests,
              state: allDone ? 'idle' : session.state,
            };
          }

          default:
            return session;
        }
      });

      return { sessions, updatedAt: Date.now() };
    }

    default:
      return state;
  }
}

export interface UseSessionStateResult {
  sessions: Session[];
  connected: boolean;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useSessionState(): UseSessionStateResult {
  // HTTP polling for initial/baseline data
  const { sessions: polledSessions, state: pollState, error: pollError, refetch } = useSessions(3000);

  // Event bus for live updates
  const { connected, error: busError, subscribe } = useEventBus();

  // Session state with reducer for efficient updates
  const [state, dispatch] = useReducer(sessionReducer, { sessions: [], updatedAt: 0 });

  // Track active subscriptions
  const subscriptionsRef = useRef<Map<string, () => void>>(new Map());

  // Update sessions from HTTP polling
  useEffect(() => {
    if (polledSessions.length > 0) {
      dispatch({ type: 'SET_SESSIONS', sessions: polledSessions });
    }
  }, [polledSessions]);

  // Subscribe to live events for active sessions
  useEffect(() => {
    if (!connected) return;

    const activeSessions = state.sessions.filter((s) => s.state === 'active');

    // Subscribe to session channels
    for (const session of activeSessions) {
      if (!subscriptionsRef.current.has(session.id)) {
        const unsubscribe = subscribe(sessionChannel(session.id), (event: BusEvent) => {
          handleSessionEvent(session.id, event);
        });
        subscriptionsRef.current.set(session.id, unsubscribe);
      }

      // Subscribe to active request channels
      for (const request of session.requests) {
        if (request.state === 'running') {
          const key = `${session.id}:${request.id}`;
          if (!subscriptionsRef.current.has(key)) {
            const unsubscribe = subscribe(runChannel(request.id), (event: BusEvent) => {
              handleRequestEvent(session.id, request.id, event);
            });
            subscriptionsRef.current.set(key, unsubscribe);
          }
        }
      }
    }

    // Cleanup: unsubscribe from inactive sessions
    for (const [key, unsubscribe] of subscriptionsRef.current) {
      const isActive = activeSessions.some((s) => {
        if (key === s.id) return true;
        if (key.startsWith(`${s.id}:`)) {
          const requestId = key.split(':')[1];
          return s.requests.some((r) => r.id === requestId && r.state === 'running');
        }
        return false;
      });

      if (!isActive) {
        unsubscribe();
        subscriptionsRef.current.delete(key);
      }
    }
  }, [connected, state.sessions, subscribe]);

  const handleSessionEvent = useCallback((sessionId: string, event: BusEvent) => {
    if (event.type === 'status') {
      dispatch({
        type: 'UPDATE_SESSION',
        update: { sessionId, type: 'status', data: event.data },
      });
    }
  }, []);

  const handleRequestEvent = useCallback((sessionId: string, requestId: string, event: BusEvent) => {
    switch (event.type) {
      case 'progress':
        dispatch({
          type: 'UPDATE_SESSION',
          update: { sessionId, requestId, type: 'progress', data: event.data },
        });
        break;
      case 'response':
        dispatch({
          type: 'UPDATE_SESSION',
          update: { sessionId, requestId, type: 'complete', data: event.data },
        });
        break;
    }
  }, []);

  // Cleanup subscriptions on unmount
  useEffect(() => {
    return () => {
      for (const unsubscribe of subscriptionsRef.current.values()) {
        unsubscribe();
      }
      subscriptionsRef.current.clear();
    };
  }, []);

  return {
    sessions: state.sessions,
    connected,
    loading: pollState === 'loading',
    error: pollError ?? busError,
    refetch,
  };
}
