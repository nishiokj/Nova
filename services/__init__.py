"""
Services Layer - Pure functions with no domain knowledge.

Services are stateless processors that take inputs and return outputs.
They have no knowledge of EventBus, Harness, or application orchestration.
Dependencies (logger, config) are injected.
"""

from .audio_service import AudioService, AudioChunk
from .stt_service import STTService, TranscriptionResult
from .text_linter_service import TextLinterService, LintResult

__all__ = [
    'AudioService',
    'AudioChunk',
    'STTService',
    'TranscriptionResult',
    'TextLinterService',
    'LintResult'
]
