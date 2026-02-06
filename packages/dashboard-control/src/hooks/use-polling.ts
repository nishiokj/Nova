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
export function useEventStream(onEvent: () => void | Promise<void>) {
  const savedOnEvent = useRef(onEvent);
  savedOnEvent.current = onEvent;

  useEffect(() => {
    const es = new EventSource('/control-plane/cockpit/events/stream');
    let debounceTimer: ReturnType<typeof setTimeout>;

    es.onmessage = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void savedOnEvent.current();
      }, 250);
    };

    return () => {
      clearTimeout(debounceTimer);
      es.close();
    };
  }, []);
}
