import { useEffect, useRef } from 'react';

export function usePolling(callback: () => void | Promise<void>, intervalMs: number) {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        await savedCallback.current();
      } finally {
        if (!cancelled) {
          timer = setTimeout(tick, intervalMs);
        }
      }
    };

    // First tick immediately, then schedule next only after completion.
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [intervalMs]);
}

/**
 * SSE event stream from the control plane.
 * Calls `onEvent` for each server-sent event. Reconnects automatically via EventSource.
 */
export interface CockpitEventStreamEvent {
  type?: string;
  sessionKey?: string;
  [key: string]: unknown;
}

export function useEventStream(onEvent: (event: CockpitEventStreamEvent | null) => void | Promise<void>) {
  const savedOnEvent = useRef(onEvent);
  savedOnEvent.current = onEvent;

  useEffect(() => {
    const es = new EventSource('/control-plane/cockpit/events/stream');

    es.onmessage = (evt) => {
      let event: CockpitEventStreamEvent | null = null;
      try {
        const parsed = JSON.parse(evt.data) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          event = parsed as CockpitEventStreamEvent;
        }
      } catch {
        event = null;
      }

      // Fire immediately — handleSseRefresh has its own back-pressure system
      // for REST re-fetches, and stream chunks are injected synchronously.
      void savedOnEvent.current(event);
    };

    return () => {
      es.close();
    };
  }, []);
}
