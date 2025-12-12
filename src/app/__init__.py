"""
Application Layer - Orchestrates services and domain logic.

Responsibilities:
- Wire services together via EventBus
- Inject dependencies (logger, config)
- Handle application lifecycle
- Bridge service layer and domain layer
"""

from .base_app import BaseVoiceApp
#from .single_process_app import SingleProcessVoiceApp
from .multi_process_app import MultiProcessVoiceApp

__all__ = [
    'BaseVoiceApp',
    'SingleProcessVoiceApp',
    'MultiProcessVoiceApp',
]
