"""
MultiProcess EventBus - For multi-process runtime.

Uses multiprocessing.Queue for IPC between processes.
Wraps the existing harness/event_bus.EventBus for compatibility.
"""

import logging
from typing import Callable, Optional
from multiprocessing import Queue

from .events import (
    Event,
    EventType,
    AudioCapturedEvent,
    TranscriptionCompleteEvent,
    AgentRequestSubmittedEvent,
    AgentResponseCompleteEvent,
    TTSRequestedEvent,
    TTSCompleteEvent,
    ShutdownEvent,
)
from .event_bus_protocol import EventBusProtocol

# Import existing EventBus from harness
from harness.event_bus import EventBus as HarnessEventBus, AgentRequest, AgentResult, TTSRequest


class MultiProcessEventBus(EventBusProtocol):
    """
    Multi-process event bus - wrapper around harness.EventBus.

    This adapter makes the existing EventBus conform to the EventBusProtocol,
    allowing it to be used interchangeably with InMemoryEventBus.

    Features:
    - IPC: Uses multiprocessing.Queue for cross-process communication
    - Backpressure: Latest request wins (for agent requests)
    - Health monitoring: Heartbeat tracking
    """

    def __init__(self, max_agent_pending: int = 1):
        """
        Initialize multi-process event bus.

        Args:
            max_agent_pending: Maximum pending agent requests
        """
        self.logger = logging.getLogger(__name__)
        self._harness_bus = HarnessEventBus(max_agent_pending=max_agent_pending)

    def publish(self, event: Event) -> None:
        """
        Publish an event to the bus.

        Maps generic Event to harness-specific message types.

        Args:
            event: Event to publish
        """
        if isinstance(event, AgentRequestSubmittedEvent):
            self._publish_agent_request(event)
        elif isinstance(event, AgentResponseCompleteEvent):
            self._publish_agent_response(event)
        elif isinstance(event, TTSRequestedEvent):
            self._publish_tts_request(event)
        elif isinstance(event, ShutdownEvent):
            self._harness_bus.shutdown()
        else:
            self.logger.warning(f"Unsupported event type for multiprocess bus: {event.event_type}")

    def subscribe(
        self,
        event_type: EventType,
        handler: Callable[[Event], None],
        filter_func: Optional[Callable[[Event], bool]] = None
    ) -> None:
        """
        Subscribe to events of a specific type.

        Note: Multiprocess bus uses polling, not push-based subscriptions.
        This method is a no-op for compatibility.

        Args:
            event_type: Type of events to subscribe to
            handler: Function to call when event occurs
            filter_func: Optional filter to apply before calling handler
        """
        self.logger.warning(
            "MultiProcessEventBus does not support push-based subscriptions. "
            "Use get_event() polling instead."
        )

    def get_event(self, timeout: float = 0.1) -> Optional[Event]:
        """
        Get next event from the bus (polling interface).

        This polls the agent response queue.

        Args:
            timeout: Maximum time to wait for event

        Returns:
            Event if available, None if timeout
        """
        # Poll agent responses
        result = self._harness_bus.get_agent_response(timeout=timeout)
        if result:
            return self._convert_agent_result(result)

        return None

    def shutdown(self) -> None:
        """Signal shutdown to all workers"""
        self._harness_bus.shutdown()

    def is_shutdown(self) -> bool:
        """Check if shutdown has been signaled"""
        return self._harness_bus.is_shutdown()

    # -------------------------------------------------------------------------
    # Harness EventBus specific methods (for compatibility)
    # -------------------------------------------------------------------------

    def get_agent_request(self, timeout: float = 0.5) -> Optional[AgentRequestSubmittedEvent]:
        """
        Get next agent request (for Agent worker process).

        Args:
            timeout: Maximum time to wait

        Returns:
            AgentRequestSubmittedEvent if available, None otherwise
        """
        request = self._harness_bus.get_agent_request(timeout=timeout)
        if request:
            return AgentRequestSubmittedEvent(
                request_id=request.request_id,
                speech_text=request.speech_text,
                tier=request.tier,
                context=request.context,
                conversation_history=request.conversation_history
            )
        return None

    def get_tts_request(self, timeout: float = 0.5) -> Optional[TTSRequestedEvent]:
        """
        Get next TTS request (for TTS worker process).

        Args:
            timeout: Maximum time to wait

        Returns:
            TTSRequestedEvent if available, None otherwise
        """
        request = self._harness_bus.get_tts_request(timeout=timeout)
        if request:
            return TTSRequestedEvent(
                request_id=request.request_id,
                text=request.text,
                priority=request.priority,
                response_type=request.response_type
            )
        return None

    def set_agent_busy(self, busy: bool):
        """Mark agent as busy/idle"""
        self._harness_bus.set_agent_busy(busy)

    def is_cancelled(self) -> bool:
        """Check if current work should be cancelled"""
        return self._harness_bus.is_cancelled()

    def agent_heartbeat(self):
        """Signal agent is alive"""
        self._harness_bus.agent_heartbeat()

    def tts_heartbeat(self):
        """Signal TTS is alive"""
        self._harness_bus.tts_heartbeat()

    def clear_tts_queue(self):
        """Clear pending TTS requests"""
        self._harness_bus.clear_tts_queue()

    @property
    def tts_speaking_event(self):
        """Event that is set while TTS is speaking"""
        return self._harness_bus.tts_speaking_event

    @property
    def cancel_event(self):
        """Event for cancellation signaling"""
        return self._harness_bus.cancel_event

    # -------------------------------------------------------------------------
    # Internal conversion methods
    # -------------------------------------------------------------------------

    def _publish_agent_request(self, event: AgentRequestSubmittedEvent):
        """Convert and publish agent request"""
        request = AgentRequest(
            request_id=event.request_id,
            speech_text=event.speech_text,
            tier=event.tier,
            context=event.context,
            conversation_history=event.conversation_history
        )
        self._harness_bus.submit_agent_request(request)

    def _publish_agent_response(self, event: AgentResponseCompleteEvent):
        """Convert and publish agent response"""
        result = AgentResult(
            request_id=event.request_id,
            success=event.success,
            content=event.content,
            spoken_response=event.spoken_response,
            tools_used=event.tools_used,
            duration_ms=event.duration_ms,
            error=event.error,
            metadata=event.metadata
        )
        self._harness_bus.submit_agent_response(result)

    def _publish_tts_request(self, event: TTSRequestedEvent):
        """Convert and publish TTS request"""
        request = TTSRequest(
            request_id=event.request_id,
            text=event.text,
            priority=event.priority,
            response_type=event.response_type
        )
        self._harness_bus.submit_tts_request(request)

    def _convert_agent_result(self, result: AgentResult) -> AgentResponseCompleteEvent:
        """Convert harness AgentResult to Event"""
        return AgentResponseCompleteEvent(
            request_id=result.request_id,
            success=result.success,
            content=result.content,
            spoken_response=result.spoken_response,
            tools_used=result.tools_used,
            duration_ms=result.duration_ms,
            error=result.error,
            metadata=result.metadata
        )
