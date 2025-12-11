"""
Communication Layer - Universal event-based IPC.

Provides protocol and implementations for both single-process and multi-process runtimes.
Services publish and subscribe to events without knowing about the underlying transport.
"""

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
from .in_memory_bus import InMemoryEventBus
from .multiprocess_bus import MultiProcessEventBus

__all__ = [
    # Events
    'Event',
    'EventType',
    'AudioCapturedEvent',
    'TranscriptionCompleteEvent',
    'AgentRequestSubmittedEvent',
    'AgentResponseCompleteEvent',
    'TTSRequestedEvent',
    'TTSCompleteEvent',
    'ShutdownEvent',
    # Protocol and implementations
    'EventBusProtocol',
    'InMemoryEventBus',
    'MultiProcessEventBus',
]
