"""
Audio domain services.

Provides reusable processing utilities for microphone input and speech-to-text.
"""

from .audio_service import AudioService, AudioChunk, AudioConfig
from .stt_service import STTService, TranscriptionResult, STTConfig

__all__ = [
    'AudioService',
    'AudioChunk',
    'AudioConfig',
    'STTService',
    'TranscriptionResult',
    'STTConfig',
]
