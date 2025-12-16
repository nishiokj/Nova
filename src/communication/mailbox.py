"""
Mailbox - Message queue abstraction for ProcessWorkers.

Each worker process has a mailbox that subscribes to specific event types.
EventBus delivers events to mailboxes via multiprocessing.Queue.
"""

import queue
from typing import Optional, List
from multiprocessing import Queue

from .events import Event, EventType


class Mailbox:
    """
    A worker's inbox for receiving events from EventBus.

    Backed by multiprocessing.Queue for cross-process delivery.
    """

    def __init__(self, worker_id: str, queue_impl: Queue = None):
        """
        Args:
            worker_id: Unique identifier for this worker
            queue_impl: Optional multiprocessing.Queue (will create if not provided)
        """
        self.worker_id = worker_id
        self._queue: Queue = queue_impl or Queue()
        self._subscriptions: List[EventType] = []

    def deliver(self, event: Event) -> None:
        """
        Called by EventBus to deliver an event.
        Thread-safe and process-safe.
        """
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            # Queue full - log warning but don't block publisher
            # Worker should increase queue size or process faster
            pass

    def receive(self, timeout: Optional[float] = None) -> Optional[Event]:
        """
        Receive next event from mailbox.
        Called by worker process.

        Args:
            timeout: Max seconds to wait for event (None = block indefinitely)

        Returns:
            Event if available, None if timeout
        """
        try:
            if timeout is None:
                return self._queue.get()
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def subscribe_to(self, event_bus, *event_types: EventType) -> None:
        """
        Subscribe this mailbox to event types on the bus.

        Args:
            event_bus: EventBus instance to subscribe to
            event_types: Event types to subscribe to
        """
        for event_type in event_types:
            event_bus.subscribe(event_type, self)
            self._subscriptions.append(event_type)

    @property
    def queue(self) -> Queue:
        """Access underlying queue (needed for passing to worker process)"""
        return self._queue

    def __repr__(self):
        return f"Mailbox(worker_id={self.worker_id}, subscriptions={self._subscriptions})"
