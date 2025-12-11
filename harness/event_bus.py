"""
EventBus - Inter-process communication layer for the agentic system.

Provides:
- Request/Response queues between processes
- Cancellation signaling
- Health monitoring
- Backpressure handling (latest request wins)
"""

import time
import multiprocessing as mp
from multiprocessing import Queue, Event
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List
from enum import Enum
import queue
import logging
import traceback


class MessageType(Enum):
    """Types of messages on the EventBus"""
    # Requests
    AGENT_REQUEST = "agent_request"
    TTS_REQUEST = "tts_request"

    # Responses
    AGENT_RESPONSE = "agent_response"
    TTS_COMPLETE = "tts_complete"

    # Control
    SHUTDOWN = "shutdown"
    HEALTH_CHECK = "health_check"
    HEALTH_RESPONSE = "health_response"
    CANCEL = "cancel"

    # Status updates
    AGENT_STATUS = "agent_status"
    TTS_STATUS = "tts_status"

    # RL Training Events
    EPISODE_COMPLETE = "episode_complete"  # Emitted when an episode finishes


@dataclass
class BusMessage:
    """A message on the EventBus"""
    type: MessageType
    payload: Dict[str, Any] = field(default_factory=dict)
    request_id: str = ""
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type.value,
            "payload": self.payload,
            "request_id": self.request_id,
            "timestamp": self.timestamp
        }


@dataclass
class AgentRequest:
    """Request for the Agent worker"""
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
    """Result from the Agent worker"""
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
    """Request for the TTS worker"""
    request_id: str
    text: str
    priority: int = 1  # 0 = highest (acknowledgments), 1 = normal
    response_type: str = "completion"  # acknowledgment, progress, completion, error


class EventBus:
    """
    Central event bus for inter-process communication.

    Architecture:
    - Main Process: Produces AgentRequests, consumes AgentResults
    - Agent Process: Consumes AgentRequests, produces AgentResults + TTSRequests
    - TTS Process: Consumes TTSRequests
    - RL Process: Consumes EpisodeComplete events, produces RL training logs

    Features:
    - Backpressure: Latest request replaces pending (for Agent queue)
    - Cancellation: Shared event to signal cancel across processes
    - Health monitoring: Periodic health checks
    - Episode completion events for RL training
    """

    def __init__(self, max_agent_pending: int = 1):
        # Queues for Agent worker
        self.agent_request_queue: Queue = Queue(maxsize=max_agent_pending + 1)
        self.agent_response_queue: Queue = Queue()

        # Queue for TTS worker (unbounded - we want all speech queued)
        self.tts_queue: Queue = Queue()

        # Queue for RL training events (unbounded - we want all episodes logged)
        self.rl_events_queue: Queue = Queue()

        # Control events
        self.shutdown_event: Event = Event()
        self.cancel_event: Event = Event()  # Signal to cancel current Agent work
        self.agent_busy_event: Event = Event()  # Set when Agent is processing
        self.tts_speaking_event: Event = Event()  # Set while TTS is actively speaking

        # Health tracking
        self._agent_last_heartbeat = mp.Value('d', time.time())
        self._tts_last_heartbeat = mp.Value('d', time.time())

        self.logger = logging.getLogger(__name__)

    # =========================================================================
    # MAIN PROCESS METHODS (Producer for Agent, Consumer for responses)
    # =========================================================================

    def submit_agent_request(self, request: AgentRequest) -> bool:
        """
        Submit a request to the Agent worker.

        Uses backpressure: if Agent is busy and queue has pending items,
        clears the queue so the new request takes priority.

        Returns True if submitted successfully.
        """
        # If agent is busy and there are pending requests, clear them
        # (user's latest request is what matters)
        if self.agent_busy_event.is_set():
            self._clear_queue(self.agent_request_queue)
            # Signal cancellation of current work
            self.cancel_event.set()

        try:
            msg = BusMessage(
                type=MessageType.AGENT_REQUEST,
                payload=request.to_dict(),
                request_id=request.request_id
            )
            self.agent_request_queue.put_nowait(msg)
            return True
        except queue.Full:
            # Queue full even after clearing - shouldn't happen
            self.logger.warning("Agent request queue full, request dropped")
            return False

    def get_agent_response(self, timeout: float = 0.1) -> Optional[AgentResult]:
        """
        Get a response from the Agent worker (non-blocking by default).
        Called by main process to check for completed work.
        """
        try:
            msg = self.agent_response_queue.get(timeout=timeout)
            if msg.type == MessageType.AGENT_RESPONSE:
                payload = msg.payload
                return AgentResult(
                    request_id=payload.get("request_id", ""),
                    success=payload.get("success", False),
                    content=payload.get("content", ""),
                    spoken_response=payload.get("spoken_response", ""),
                    tools_used=payload.get("tools_used", []),
                    duration_ms=payload.get("duration_ms", 0),
                    error=payload.get("error"),
                    metadata=payload.get("metadata", {})
                )
        except queue.Empty:
            return None
        return None

    def submit_tts_request(self, request: TTSRequest):
        """Submit a TTS request (can be called from main or agent process)"""
        msg = BusMessage(
            type=MessageType.TTS_REQUEST,
            payload={
                "request_id": request.request_id,
                "text": request.text,
                "priority": request.priority,
                "response_type": request.response_type
            },
            request_id=request.request_id
        )
        self.tts_queue.put(msg)

    # =========================================================================
    # AGENT WORKER METHODS
    # =========================================================================

    def get_agent_request(self, timeout: float = 0.5) -> Optional[AgentRequest]:
        """
        Get next request for Agent worker.
        Called by Agent process.
        """
        try:
            msg = self.agent_request_queue.get(timeout=timeout)
            if msg.type == MessageType.AGENT_REQUEST:
                payload = msg.payload
                return AgentRequest(
                    request_id=payload.get("request_id", ""),
                    speech_text=payload.get("speech_text", ""),
                    tier=payload.get("tier", "standard"),
                    context=payload.get("context"),
                    conversation_history=payload.get("conversation_history", [])
                )
            elif msg.type == MessageType.SHUTDOWN:
                return None
        except queue.Empty:
            return None
        return None

    def submit_agent_response(self, result: AgentResult):
        """Submit Agent result back to main process"""
        msg = BusMessage(
            type=MessageType.AGENT_RESPONSE,
            payload={
                "request_id": result.request_id,
                "success": result.success,
                "content": result.content,
                "spoken_response": result.spoken_response,
                "tools_used": result.tools_used,
                "duration_ms": result.duration_ms,
                "error": result.error,
                "metadata": result.metadata
            },
            request_id=result.request_id
        )
        self.agent_response_queue.put(msg)

    def set_agent_busy(self, busy: bool):
        """Mark agent as busy/idle"""
        if busy:
            self.agent_busy_event.set()
        else:
            self.agent_busy_event.clear()
            # Clear cancel signal when done
            self.cancel_event.clear()

    def is_cancelled(self) -> bool:
        """Check if current work should be cancelled"""
        return self.cancel_event.is_set()

    def agent_heartbeat(self):
        """Called by Agent worker to signal it's alive"""
        with self._agent_last_heartbeat.get_lock():
            self._agent_last_heartbeat.value = time.time()

    # =========================================================================
    # TTS WORKER METHODS
    # =========================================================================

    def get_tts_request(self, timeout: float = 0.5) -> Optional[TTSRequest]:
        """Get next TTS request. Called by TTS process."""
        try:
            msg = self.tts_queue.get(timeout=timeout)
            if msg.type == MessageType.TTS_REQUEST:
                payload = msg.payload
                return TTSRequest(
                    request_id=payload.get("request_id", ""),
                    text=payload.get("text", ""),
                    priority=payload.get("priority", 1),
                    response_type=payload.get("response_type", "completion")
                )
            elif msg.type == MessageType.SHUTDOWN:
                return None
        except queue.Empty:
            return None
        return None

    def clear_tts_queue(self):
        """Clear pending TTS (used for interruption)"""
        self._clear_queue(self.tts_queue)

    def tts_heartbeat(self):
        """Called by TTS worker to signal it's alive"""
        with self._tts_last_heartbeat.get_lock():
            self._tts_last_heartbeat.value = time.time()

    # =========================================================================
    # CONTROL METHODS
    # =========================================================================

    def shutdown(self):
        """Signal all workers to shut down"""
        self.shutdown_event.set()

        # Send shutdown messages to queues
        shutdown_msg = BusMessage(type=MessageType.SHUTDOWN)
        try:
            self.agent_request_queue.put_nowait(shutdown_msg)
        except queue.Full:
            pass
        try:
            self.tts_queue.put_nowait(shutdown_msg)
        except queue.Full:
            pass

    def is_shutdown(self) -> bool:
        """Check if shutdown has been signaled"""
        return self.shutdown_event.is_set()

    def get_agent_last_heartbeat(self) -> float:
        """Thread/process-safe read of the last Agent heartbeat timestamp"""
        with self._agent_last_heartbeat.get_lock():
            return self._agent_last_heartbeat.value

    def get_tts_last_heartbeat(self) -> float:
        """Thread/process-safe read of the last TTS heartbeat timestamp"""
        with self._tts_last_heartbeat.get_lock():
            return self._tts_last_heartbeat.value

    def check_agent_health(self, timeout_s: float = 10.0) -> bool:
        """Check if Agent worker is healthy"""
        last = self.get_agent_last_heartbeat()
        return (time.time() - last) < timeout_s

    def check_tts_health(self, timeout_s: float = 10.0) -> bool:
        """Check if TTS worker is healthy"""
        last = self.get_tts_last_heartbeat()
        return (time.time() - last) < timeout_s

    # =========================================================================
    # UTILITIES
    # =========================================================================

    def _clear_queue(self, q: Queue):
        """Clear all items from a queue"""
        while True:
            try:
                q.get_nowait()
            except queue.Empty:
                break

    # =========================================================================
    # RL TRAINING METHODS
    # =========================================================================

    def emit_episode_complete(self, episode_data: Dict[str, Any]):
        """
        Emit an episode completion event for RL training.
        Called by Agent when an episode finishes.

        Args:
            episode_data: Complete episode data including req_id, exec_id, plan, trace, reflection
        """
        msg = BusMessage(
            type=MessageType.EPISODE_COMPLETE,
            payload=episode_data,
            request_id=episode_data.get("req_id", "")
        )
        self.rl_events_queue.put(msg)

    def get_episode_event(self, timeout: float = 0.5) -> Optional[Dict[str, Any]]:
        """
        Get next episode completion event.
        Called by RL reward shaping process.
        """
        try:
            msg = self.rl_events_queue.get(timeout=timeout)
            if msg.type == MessageType.EPISODE_COMPLETE:
                return msg.payload
            elif msg.type == MessageType.SHUTDOWN:
                return None
        except queue.Empty:
            return None
        return None
