"""
EventBus Protocol - Interface that all event buses must implement.

This allows services to be runtime-agnostic - they work with any EventBus implementation.
"""

from typing import Protocol, Callable, Optional
from .events import Event, EventType


class EventBusProtocol(Protocol):
    """
    Protocol that all EventBus implementations must follow.

    This enables dependency injection and makes services runtime-agnostic.
    Services work with EventBusProtocol, not a specific implementation.
    """

    def publish(self, event: Event) -> None:
        """
        Publish an event to the bus.

        Args:
            event: Event to publish
        """
        ...

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
        ...

    def get_event(self, timeout: float = 0.1) -> Optional[Event]:
        """
        Get next event from the bus (polling interface).

        Args:
            timeout: Maximum time to wait for event

        Returns:
            Event if available, None if timeout
        """
        ...

    def shutdown(self) -> None:
        """Signal shutdown to all subscribers"""
        ...

    def is_shutdown(self) -> bool:
        """Check if shutdown has been signaled"""
        ...
