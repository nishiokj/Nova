"""
Event definitions for the communication layer.

All events are immutable dataclasses that represent state transitions or data flow.
"""

import time
from enum import Enum, auto
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


class EventType(Enum):
    """Types of events in the system"""
    # Audio pipeline
    AUDIO_CAPTURED = auto()
    TRANSCRIPTION_COMPLETE = auto()

    # Agent pipeline
    AGENT_REQUEST_SUBMITTED = auto()
    AGENT_RESPONSE_COMPLETE = auto()

    # TTS pipeline
    TTS_REQUESTED = auto()
    TTS_COMPLETE = auto()

    # Control
    SHUTDOWN = auto()
    CANCEL = auto()
    HEALTH_CHECK = auto()


@dataclass(frozen=True)
class Event:
    """Base event class - all events inherit from this"""
    event_type: EventType
    timestamp: float = field(default_factory=time.time)
    request_id: str = ""


@dataclass(frozen=True)
class AudioCapturedEvent(Event):
    """Event: Audio chunk captured and ready for STT"""
    audio_data: bytes = b""
    sample_rate: int = 16000
    duration_seconds: float = 0.0

    def __post_init__(self):
        # Set event_type
        object.__setattr__(self, 'event_type', EventType.AUDIO_CAPTURED)


@dataclass(frozen=True)
class TranscriptionCompleteEvent(Event):
    """Event: STT transcription complete"""
    text: str = ""
    confidence: Optional[float] = None
    duration_ms: float = 0.0

    def __post_init__(self):
        object.__setattr__(self, 'event_type', EventType.TRANSCRIPTION_COMPLETE)


@dataclass(frozen=True)
class AgentRequestSubmittedEvent(Event):
    """Event: Request submitted to agent"""
    speech_text: str = ""
    tier: str = "standard"
    context: Optional[str] = None
    conversation_history: List[Dict[str, str]] = field(default_factory=list)

    def __post_init__(self):
        object.__setattr__(self, 'event_type', EventType.AGENT_REQUEST_SUBMITTED)


@dataclass(frozen=True)
class AgentResponseCompleteEvent(Event):
    """Event: Agent response complete"""
    success: bool = False
    content: str = ""
    spoken_response: str = ""
    tools_used: List[str] = field(default_factory=list)
    duration_ms: float = 0.0
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        object.__setattr__(self, 'event_type', EventType.AGENT_RESPONSE_COMPLETE)


@dataclass(frozen=True)
class TTSRequestedEvent(Event):
    """Event: TTS requested"""
    text: str = ""
    priority: int = 1  # 0 = highest (acknowledgments), 1 = normal
    response_type: str = "completion"  # acknowledgment, progress, completion, error

    def __post_init__(self):
        object.__setattr__(self, 'event_type', EventType.TTS_REQUESTED)


@dataclass(frozen=True)
class TTSCompleteEvent(Event):
    """Event: TTS playback complete"""
    text: str = ""
    duration_ms: float = 0.0

    def __post_init__(self):
        object.__setattr__(self, 'event_type', EventType.TTS_COMPLETE)


@dataclass(frozen=True)
class ShutdownEvent(Event):
    """Event: System shutdown requested"""
    reason: str = "user_request"

    def __post_init__(self):
        object.__setattr__(self, 'event_type', EventType.SHUTDOWN)
