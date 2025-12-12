"""
In-Memory EventBus - For single-process runtime.

Uses threading.Queue for fast, low-overhead communication within a single process.
"""

import queue
import threading
import logging
from typing import Dict, List
from collections import defaultdict

from .events import Event, EventType, ShutdownEvent
from .event_bus_protocol import EventBusProtocol
from .mailbox import Mailbox


class InMemoryEventBus(EventBusProtocol):
    """
    In-memory event bus for single-process runtime.

    Features:
    - Fast: Uses threading.Queue (no IPC overhead)
    - Thread-safe: Safe for multi-threaded single-process apps
    - Mailbox pattern: Same interface as multi-process EventBus
    """

    def __init__(self):
        """Initialize in-memory event bus."""
        self.logger = logging.getLogger(__name__)
        self._subscriptions: Dict[EventType, List[Mailbox]] = defaultdict(list)
        self._shutdown_flag = threading.Event()

    def publish(self, event: Event) -> None:
        """
        Publish an event to all subscribed mailboxes.

        Args:
            event: Event to publish
        """
        if self._shutdown_flag.is_set():
            self.logger.warning(f"Cannot publish {event.event_type} - bus is shutdown")
            return

        # Route to all mailboxes subscribed to this event type
        mailboxes = self._subscriptions.get(event.event_type, [])

        for mailbox in mailboxes:
            mailbox.deliver(event)

    def subscribe(self, event_type: EventType, mailbox: Mailbox) -> None:
        """
        Subscribe a mailbox to an event type.

        Args:
            event_type: Type of events to receive
            mailbox: Mailbox to deliver events to
        """
        if mailbox not in self._subscriptions[event_type]:
            self._subscriptions[event_type].append(mailbox)
            self.logger.debug(f"Subscribed mailbox {mailbox.worker_id} to {event_type}")

    def shutdown(self) -> None:
        """Signal shutdown to all subscribers"""
        if self._shutdown_flag.is_set():
            return

        self.logger.info("InMemoryEventBus shutting down")
        self._shutdown_flag.set()

        # Publish shutdown event to all mailboxes
        shutdown_event = ShutdownEvent()
        for mailboxes in self._subscriptions.values():
            for mailbox in mailboxes:
                mailbox.deliver(shutdown_event)

    def is_shutdown(self) -> bool:
        """Check if shutdown has been signaled"""
        return self._shutdown_flag.is_set()
