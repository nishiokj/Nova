/**
 * Browser-side Event Bus hook for live session updates.
 *
 * Connects to the WebSocket bridge server (port 9556 by default)
 * and subscribes to session/run channels for real-time updates.
 */

import { useEffect, useRef, useCallback, useState } from 'react';

export type EventType = 'ready' | 'status' | 'progress' | 'stream' | 'response' | 'error';

export interface StatusData {
  state?: 'idle' | 'sending' | 'streaming' | 'error';
  message?: string;
  level?: 'info' | 'success' | 'warning' | 'error';
  kind?: 'work' | 'tool' | 'planning' | 'system';
}

export interface ProgressData {
  request_id?: string;
  message?: string;
  tool_name?: string;
  step_number?: number;
  duration_ms?: number;
  tokens?: {
    input: number;
    output: number;
  };
}

export interface StreamData {
  request_id: string;
  chunk: string;
  is_final?: boolean;
}

export interface BusEvent {
  type: EventType;
  data?: StatusData | ProgressData | StreamData | unknown;
  channel?: string;
}

type BusClientMessage =
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'publish'; channel: string; payload: unknown };

type BusServerMessage =
  | { type: 'event'; channel: string; payload: unknown }
  | { type: 'error'; message: string; detail?: unknown };

export interface UseEventBusOptions {
  /** WebSocket URL (default: ws://127.0.0.1:9556) */
  url?: string;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnect delay in ms (default: 2000) */
  reconnectDelay?: number;
}

export interface UseEventBusResult {
  /** Whether connected to the event bus */
  connected: boolean;
  /** Last error message */
  error: string | null;
  /** Subscribe to a channel */
  subscribe: (channel: string, handler: (event: BusEvent) => void) => () => void;
  /** Manually reconnect */
  reconnect: () => void;
}

const DEFAULT_WS_URL = 'ws://127.0.0.1:9556';

export function useEventBus(options: UseEventBusOptions = {}): UseEventBusResult {
  const {
    url = DEFAULT_WS_URL,
    autoReconnect = true,
    reconnectDelay = 2000,
  } = options;

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<(event: BusEvent) => void>>>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return;

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close();
          return;
        }
        setConnected(true);
        setError(null);

        // Re-subscribe to all channels on reconnect
        for (const channel of handlersRef.current.keys()) {
          const msg: BusClientMessage = { type: 'subscribe', channel };
          ws.send(JSON.stringify(msg));
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnected(false);

        // Schedule reconnect
        if (autoReconnect) {
          reconnectTimeoutRef.current = setTimeout(() => {
            if (mountedRef.current) {
              connect();
            }
          }, reconnectDelay);
        }
      };

      ws.onerror = () => {
        if (!mountedRef.current) return;
        setError('Connection failed');
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;

        let message: BusServerMessage;
        try {
          message = JSON.parse(event.data as string);
        } catch {
          return;
        }

        if (message.type === 'event') {
          const handlers = handlersRef.current.get(message.channel);
          if (handlers) {
            const busEvent: BusEvent = message.payload as BusEvent;
            for (const handler of handlers) {
              try {
                handler(busEvent);
              } catch {
                // Ignore handler errors
              }
            }
          }
        } else if (message.type === 'error') {
          setError(message.message);
        }
      };

      wsRef.current = ws;
    } catch {
      setError('Failed to create WebSocket');
    }
  }, [url, autoReconnect, reconnectDelay]);

  const subscribe = useCallback(
    (channel: string, handler: (event: BusEvent) => void): (() => void) => {
      // Add to local handlers
      if (!handlersRef.current.has(channel)) {
        handlersRef.current.set(channel, new Set());
      }
      handlersRef.current.get(channel)!.add(handler);

      // Send subscribe message if connected
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const msg: BusClientMessage = { type: 'subscribe', channel };
        wsRef.current.send(JSON.stringify(msg));
      }

      // Return unsubscribe function
      return () => {
        const handlers = handlersRef.current.get(channel);
        if (handlers) {
          handlers.delete(handler);
          if (handlers.size === 0) {
            handlersRef.current.delete(channel);
            // Send unsubscribe message if connected
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              const msg: BusClientMessage = { type: 'unsubscribe', channel };
              wsRef.current.send(JSON.stringify(msg));
            }
          }
        }
      };
    },
    []
  );

  const reconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    connect();
  }, [connect]);

  // Connect on mount
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { connected, error, subscribe, reconnect };
}

/**
 * Helper to create a session channel name.
 */
export function sessionChannel(sessionKey: string): string {
  return `session:${sessionKey}`;
}

/**
 * Helper to create a run channel name.
 */
export function runChannel(requestId: string): string {
  return `run:${requestId}`;
}
