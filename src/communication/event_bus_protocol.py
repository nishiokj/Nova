"""
EventBus Protocol - Interface that all event buses must implement.

This allows services to be runtime-agnostic - they work with any EventBus implementation.
"""

from typing import Protocol, TYPE_CHECKING
from .events import Event, EventType

if TYPE_CHECKING:
    from .mailbox import Mailbox


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

    def subscribe(self, event_type: EventType, mailbox: "Mailbox") -> None:
        """
        Subscribe a mailbox to an event type.

        Args:
            event_type: Type of events to receive
            mailbox: Mailbox to deliver events to
        """
        ...

    def shutdown(self) -> None:
        """Signal shutdown to all subscribers"""
        ...

    def is_shutdown(self) -> bool:
        """Check if shutdown has been signaled"""
        ...
