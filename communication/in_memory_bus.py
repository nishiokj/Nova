"""
In-Memory EventBus - For single-process runtime.

Uses threading.Queue for fast, low-overhead communication within a single process.
"""

import queue
import threading
import logging
from typing import Callable, Optional, Dict, List
from collections import defaultdict

from .events import Event, EventType, ShutdownEvent
from .event_bus_protocol import EventBusProtocol


class InMemoryEventBus(EventBusProtocol):
    """
    In-memory event bus for single-process runtime.

    Features:
    - Fast: Uses threading.Queue (no IPC overhead)
    - Thread-safe: Safe for multi-threaded single-process apps
    - Pub/Sub: Multiple subscribers per event type
    - Filtering: Optional per-subscriber filters
    """

    def __init__(self, max_queue_size: int = 0):
        """
        Initialize in-memory event bus.

        Args:
            max_queue_size: Maximum queue size (0 = unlimited)
        """
        self.logger = logging.getLogger(__name__)
        self._queue: queue.Queue = queue.Queue(maxsize=max_queue_size)
        self._subscribers: Dict[EventType, List[tuple]] = defaultdict(list)
        self._shutdown_flag = threading.Event()
        self._lock = threading.Lock()

        # Start dispatch thread
        self._dispatch_thread = threading.Thread(
            target=self._dispatch_loop,
            daemon=True,
            name="EventBusDispatcher"
        )
        self._dispatch_thread.start()

    def publish(self, event: Event) -> None:
        """
        Publish an event to the bus.

        Args:
            event: Event to publish
        """
        if self._shutdown_flag.is_set():
            self.logger.warning(f"Cannot publish {event.event_type} - bus is shutdown")
            return

        try:
            self._queue.put_nowait(event)
        except queue.Full:
            self.logger.warning(f"Event queue full, dropping {event.event_type}")

    def subscribe(
        self,
        event_type: EventType,
        handler: Callable[[Event], None],
        filter_func: Optional[Callable[[Event], bool]] = None
    ) -> None:
        """
        Subscribe to events of a specific type.

        Args:
            event_type: Type of events to subscribe to
            handler: Function to call when event occurs
            filter_func: Optional filter to apply before calling handler
        """
        with self._lock:
            self._subscribers[event_type].append((handler, filter_func))
            self.logger.debug(f"Subscribed to {event_type}: {handler.__name__}")

    def get_event(self, timeout: float = 0.1) -> Optional[Event]:
        """
        Get next event from the bus (polling interface).

        This is for compatibility with polling-based consumers.
        Prefer subscribe() for better performance.

        Args:
            timeout: Maximum time to wait for event

        Returns:
            Event if available, None if timeout
        """
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def shutdown(self) -> None:
        """Signal shutdown to all subscribers"""
        if self._shutdown_flag.is_set():
            return

        self.logger.info("EventBus shutting down")
        self._shutdown_flag.set()

        # Publish shutdown event
        shutdown_event = ShutdownEvent()
        try:
            self._queue.put_nowait(shutdown_event)
        except queue.Full:
            pass

    def is_shutdown(self) -> bool:
        """Check if shutdown has been signaled"""
        return self._shutdown_flag.is_set()

    def _dispatch_loop(self):
        """Background thread that dispatches events to subscribers"""
        self.logger.info("EventBus dispatch loop started")

        while not self._shutdown_flag.is_set():
            try:
                # Get next event with timeout
                event = self._queue.get(timeout=0.5)

                # Dispatch to subscribers
                self._dispatch_event(event)

                # Stop on shutdown event
                if isinstance(event, ShutdownEvent):
                    break

            except queue.Empty:
                continue
            except Exception as e:
                self.logger.error(f"Error in dispatch loop: {e}", exc_info=True)

        self.logger.info("EventBus dispatch loop stopped")

    def _dispatch_event(self, event: Event):
        """Dispatch event to all matching subscribers"""
        with self._lock:
            subscribers = self._subscribers.get(event.event_type, [])

        for handler, filter_func in subscribers:
            try:
                # Apply filter if present
                if filter_func and not filter_func(event):
                    continue

                # Call handler
                handler(event)

            except Exception as e:
                self.logger.error(
                    f"Error in event handler {handler.__name__} for {event.event_type}: {e}",
                    exc_info=True
                )
