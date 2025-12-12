"""
Services Layer - Pure functions with no domain knowledge.

Services are stateless processors that take inputs and return outputs.
They have no knowledge of EventBus, Harness, or application orchestration.
Dependencies (logger, config) are injected.
"""

from .audio import (
    AudioService,
    AudioChunk,
    AudioConfig,
    STTService,
    TranscriptionResult,
    STTConfig,
)
from .language import TextLinterService, LintResult

__all__ = [
    'AudioService',
    'AudioChunk',
    'AudioConfig',
    'STTService',
    'TranscriptionResult',
    'STTConfig',
    'TextLinterService',
    'LintResult'
]
