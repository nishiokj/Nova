"""
EventBus - Pure pub/sub event routing with Mailbox pattern.

Routes events to mailboxes based on subscriptions.
No domain-specific logic - just routing.
"""

import time
from typing import Dict, List
from collections import defaultdict
from multiprocessing import Event as MPEvent, Queue
import logging

from .events import Event, EventType, ShutdownEvent, AgentRequestSubmittedEvent, AgentResponseCompleteEvent, TTSRequestedEvent
from .mailbox import Mailbox
from .event_bus_protocol import EventBusProtocol


class EventBus(EventBusProtocol):
    """
    Pure pub/sub event bus.

    Routes events to subscribed mailboxes.
    Thread-safe and process-safe for publishers.
    """

    def __init__(self):
        # Subscriptions: EventType → List[Mailbox]
        self._subscriptions: Dict[EventType, List[Mailbox]] = defaultdict(list)

        # Control
        self._shutdown_event = MPEvent()

        self.logger = logging.getLogger(__name__)

    def publish(self, event: Event) -> None:
        """
        Publish event to all subscribed mailboxes.

        Args:
            event: Event to publish
        """
        if self._shutdown_event.is_set():
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

    def shutdown(self) -> None:
        """Signal shutdown to all subscribers"""
        self._shutdown_event.set()

        # Publish shutdown event to all mailboxes
        shutdown_event = ShutdownEvent()
        for mailboxes in self._subscriptions.values():
            for mailbox in mailboxes:
                mailbox.deliver(shutdown_event)

    def is_shutdown(self) -> bool:
        """Check if shutdown has been signaled"""
        return self._shutdown_event.is_set()


# =============================================================================
# LEGACY COMPATIBILITY WRAPPER
# =============================================================================
# Keep for backward compatibility during migration
# TODO: Remove in Phase 8
# =============================================================================

# Import old types for compatibility
from dataclasses import dataclass, field
from typing import Any, Optional
from enum import Enum

@dataclass
class AgentRequest:
    """Legacy Agent Request - for backward compatibility"""
    request_id: str
    speech_text: str
    tier: str = "standard"
    context: Optional[str] = None
    conversation_history: List[Dict[str, str]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "request_id": self.request_id,
            "speech_text": self.speech_text,
            "tier": self.tier,
            "context": self.context,
            "conversation_history": self.conversation_history
        }


@dataclass
class AgentResult:
    """Legacy Agent Result - for backward compatibility"""
    request_id: str
    success: bool
    content: str
    spoken_response: str
    tools_used: List[str] = field(default_factory=list)
    duration_ms: float = 0
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TTSRequest:
    """Legacy TTS Request - for backward compatibility"""
    request_id: str
    text: str
    priority: int = 1
    response_type: str = "completion"


class MessageType(Enum):
    """Legacy Message Types - for backward compatibility with old harness_process"""
    AGENT_REQUEST = "agent_request"
    AGENT_RESPONSE = "agent_response"
    TTS_REQUEST = "tts_request"
    TTS_COMPLETE = "tts_complete"
    SHUTDOWN = "shutdown"
    EPISODE_COMPLETE = "episode_complete"


@dataclass
class BusMessage:
    """Legacy Bus Message - for backward compatibility with old harness_process"""
    type: MessageType
    payload: Dict[str, Any]
    request_id: str = ""
    timestamp: float = field(default_factory=time.time)

