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


# class LegacyEventBus(EventBus):
#     """
#     Temporary wrapper for backward compatibility.
#     Provides old methods that route to new mailbox-based system.

#     DEPRECATED: Will be removed in Phase 8 after all workers migrate to new pattern.
#     """

#     def __init__(self, max_agent_pending: int = 1):
#         super().__init__()

#         # Create internal mailboxes for legacy polling interface
#         self._agent_request_mailbox = Mailbox("agent_legacy", Queue())
#         self._agent_response_mailbox = Mailbox("agent_response_legacy", Queue())
#         self._tts_mailbox = Mailbox("tts_legacy", Queue())

#         # Subscribe internal mailboxes
#         self.subscribe(EventType.AGENT_REQUEST_SUBMITTED, self._agent_request_mailbox)
#         self.subscribe(EventType.AGENT_RESPONSE_COMPLETE, self._agent_response_mailbox)
#         self.subscribe(EventType.TTS_REQUESTED, self._tts_mailbox)

#         # Legacy control events (shared with workers)
#         self.cancel_event = MPEvent()
#         self.agent_busy_event = MPEvent()
#         self.tts_speaking_event = MPEvent()

#         # Expose shutdown event for legacy workers
#         self.shutdown_event = self._shutdown_event

#         # Legacy heartbeat tracking
#         import multiprocessing as mp
#         self._agent_last_heartbeat = mp.Value('d', time.time())
#         self._tts_last_heartbeat = mp.Value('d', time.time())

#         # Legacy queues (expose for direct access by old workers)
#         self.agent_request_queue = self._agent_request_mailbox.queue
#         self.agent_response_queue = self._agent_response_mailbox.queue
#         self.tts_queue = self._tts_mailbox.queue

#         # RL events queue (unchanged)
#         self.rl_events_queue = Queue()

#     # -------------------------------------------------------------------------
#     # Legacy Agent Methods
#     # -------------------------------------------------------------------------

#     def submit_agent_request(self, request: AgentRequest) -> bool:
#         """Legacy method: Submit agent request"""
#         event = AgentRequestSubmittedEvent(
#             request_id=request.request_id,
#             speech_text=request.speech_text,
#             tier=request.tier,
#             context=request.context,
#             conversation_history=request.conversation_history
#         )
#         self.publish(event)
#         return True

#     def get_agent_request(self, timeout: float = 0.5) -> Optional[AgentRequest]:
#         """Legacy method: Get agent request (for worker)"""
#         event = self._agent_request_mailbox.receive(timeout)
#         if event and isinstance(event, AgentRequestSubmittedEvent):
#             return AgentRequest(
#                 request_id=event.request_id,
#                 speech_text=event.speech_text,
#                 tier=event.tier,
#                 context=event.context,
#                 conversation_history=event.conversation_history
#             )
#         elif event and isinstance(event, ShutdownEvent):
#             return None
#         return None

#     def submit_agent_response(self, result: AgentResult):
#         """Legacy method: Submit agent response"""
#         event = AgentResponseCompleteEvent(
#             request_id=result.request_id,
#             success=result.success,
#             content=result.content,
#             spoken_response=result.spoken_response,
#             tools_used=result.tools_used,
#             duration_ms=result.duration_ms,
#             error=result.error,
#             metadata=result.metadata
#         )
#         self.publish(event)

#     def get_agent_response(self, timeout: float = 0.1) -> Optional[AgentResult]:
#         """Legacy method: Get agent response (for main process)"""
#         event = self._agent_response_mailbox.receive(timeout)
#         if event and isinstance(event, AgentResponseCompleteEvent):
#             return AgentResult(
#                 request_id=event.request_id,
#                 success=event.success,
#                 content=event.content,
#                 spoken_response=event.spoken_response,
#                 tools_used=event.tools_used,
#                 duration_ms=event.duration_ms,
#                 error=event.error,
#                 metadata=event.metadata
#             )
#         return None

#     # -------------------------------------------------------------------------
#     # Legacy TTS Methods
#     # -------------------------------------------------------------------------

#     def submit_tts_request(self, request: TTSRequest):
#         """Legacy method: Submit TTS request"""
#         event = TTSRequestedEvent(
#             request_id=request.request_id,
#             text=request.text,
#             priority=request.priority,
#             response_type=request.response_type
#         )
#         self.publish(event)

#     def get_tts_request(self, timeout: float = 0.5) -> Optional[TTSRequest]:
#         """Legacy method: Get TTS request (for worker)"""
#         event = self._tts_mailbox.receive(timeout)
#         if event and isinstance(event, TTSRequestedEvent):
#             return TTSRequest(
#                 request_id=event.request_id,
#                 text=event.text,
#                 priority=event.priority,
#                 response_type=event.response_type
#             )
#         elif event and isinstance(event, ShutdownEvent):
#             return None
#         return None

#     def clear_tts_queue(self):
#         """Legacy method: Clear TTS queue"""
#         # Drain the mailbox queue
#         while self._tts_mailbox.receive(timeout=0.001):
#             pass

#     # -------------------------------------------------------------------------
#     # Legacy Control Methods
#     # -------------------------------------------------------------------------

#     def set_agent_busy(self, busy: bool):
#         """Legacy method: Mark agent as busy/idle"""
#         if busy:
#             self.agent_busy_event.set()
#         else:
#             self.agent_busy_event.clear()
#             self.cancel_event.clear()

#     def is_cancelled(self) -> bool:
#         """Legacy method: Check if current work should be cancelled"""
#         return self.cancel_event.is_set()

#     def agent_heartbeat(self):
#         """Legacy method: Agent heartbeat"""
#         with self._agent_last_heartbeat.get_lock():
#             self._agent_last_heartbeat.value = time.time()

#     def tts_heartbeat(self):
#         """Legacy method: TTS heartbeat"""
#         with self._tts_last_heartbeat.get_lock():
#             self._tts_last_heartbeat.value = time.time()

#     def get_agent_last_heartbeat(self) -> float:
#         """Legacy method: Get agent heartbeat timestamp"""
#         with self._agent_last_heartbeat.get_lock():
#             return self._agent_last_heartbeat.value

#     def get_tts_last_heartbeat(self) -> float:
#         """Legacy method: Get TTS heartbeat timestamp"""
#         with self._tts_last_heartbeat.get_lock():
#             return self._tts_last_heartbeat.value

#     def check_agent_health(self, timeout_s: float = 10.0) -> bool:
#         """Legacy method: Check if Agent worker is healthy"""
#         last = self.get_agent_last_heartbeat()
#         return (time.time() - last) < timeout_s

#     def check_tts_health(self, timeout_s: float = 10.0) -> bool:
#         """Legacy method: Check if TTS worker is healthy"""
#         last = self.get_tts_last_heartbeat()
#         return (time.time() - last) < timeout_s

#     # -------------------------------------------------------------------------
#     # Legacy RL Methods
#     # -------------------------------------------------------------------------

#     def emit_episode_complete(self, episode_data: Dict[str, Any]):
#         """Legacy method: Emit episode complete event"""
#         # For now, keep using the old queue-based approach
#         # TODO: Convert to event-based in future iteration
#         msg = BusMessage(
#             type=MessageType.EPISODE_COMPLETE,
#             payload=episode_data,
#             request_id=episode_data.get("req_id", "")
#         )
#         self.rl_events_queue.put(msg)

#     def get_episode_event(self, timeout: float = 0.5) -> Optional[Dict[str, Any]]:
#         """Legacy method: Get episode event"""
#         try:
#             import queue
#             msg = self.rl_events_queue.get(timeout=timeout)
#             if hasattr(msg, 'type') and msg.type.value == 'episode_complete':
#                 return msg.payload
#             return None
#         except:
#             return None
