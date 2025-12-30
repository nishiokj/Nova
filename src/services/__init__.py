"""
Services Layer - Pure functions with no domain knowledge.

Services are stateless processors that take inputs and return outputs.
They have no knowledge of EventBus, Harness, or application orchestration.
Dependencies (logger, config) are injected.

Import services explicitly from their submodules:
    from services.audio import AudioService, STTService
    from services.language import TextLinterService
    from services.router import Router
    from services.intent_classifier import HybridIntentClassifier
"""

# No eager imports - this allows importing specific modules without
# triggering heavy dependencies (e.g., audio libs) in other modules.
