"""
TTSWorker - Process worker for text-to-speech.

Receives TTSRequestEvent from mailbox, speaks using TTSEngine.
"""

import time
from typing import Dict, Any, Optional
import logging

from communication.events import Event, TTSRequestedEvent
from communication.mailbox import Mailbox
from services.tts_engine import TTSEngine, create_tts_engine
from communication.process_worker import ProcessWorker


class TTSWorker(ProcessWorker):
    """
    TTS worker process.

    Responsibilities:
    - Receive TTSRequestedEvent from mailbox
    - Speak text using TTSEngine
    - Handle cancellation/interruption
    """

    def __init__(
        self,
        mailbox: Mailbox,
        logger: Optional[logging.Logger] = None,
        voice_config: Optional[Dict[str, Any]] = None,
        cancel_event=None,
        speaking_event=None
    ):
        super().__init__(mailbox, logger)
        self.voice_config = voice_config or {}
        self.cancel_event = cancel_event  # Optional: for barge-in
        self.speaking_event = speaking_event  # Optional: signal when speaking
        self.engine: Optional[TTSEngine] = None

    def initialize(self) -> bool:
        """Initialize TTS engine"""
        try:
            self.engine = create_tts_engine(self.voice_config)
            self.logger.info(f"TTSWorker initialized with {self.engine.engine_type}")
            return True
        except Exception as e:
            self.logger.error(f"TTSWorker initialization failed: {e}")
            return False

    def process_event(self, event: Event) -> None:
        """Process TTS request from mailbox"""
        if isinstance(event, TTSRequestedEvent):
            self._speak(event)

    def _speak(self, event: TTSRequestedEvent):
        """Speak text from TTS request"""
        if not self.engine:
            self.logger.error("No TTS engine available")
            return

        # Set speaking flag
        if self.speaking_event:
            self.speaking_event.set()

        try:
            # Check for cancellation before speaking
            if self.cancel_event and self.cancel_event.is_set():
                self.logger.info("TTS cancelled before speaking")
                return

            self.logger.info(
                f"Speaking [{event.response_type}]: {event.text[:60]}..."
            )

            start_time = time.time()
            success = self.engine.speak(event.text)
            duration_ms = (time.time() - start_time) * 1000

            if success:
                self.logger.info(f"Spoke in {duration_ms:.0f}ms")
            else:
                self.logger.warning("TTS failed")

        except Exception as e:
            self.logger.error(f"TTS error: {e}")
        finally:
            # Clear speaking flag
            if self.speaking_event:
                self.speaking_event.clear()

    def cleanup(self):
        """Clean up TTS engine"""
        if self.engine:
            self.engine.cleanup()


# # =============================================================================
# # LEGACY FACTORY FUNCTION
# # =============================================================================
# # Keep for backward compatibility with old ProcessManager
# # TODO: Remove in Phase 8 after ProcessManager migration
# # =============================================================================

# def _legacy_tts_worker_process(
#     tts_queue,
#     shutdown_event,
#     cancel_event,
#     heartbeat_value,
#     voice_config,
#     speaking_event
# ):
#     """Legacy TTS worker process using old queue-based pattern"""
#     import logging
#     import time
#     from queue import Empty
#     from services.tts_engine import create_tts_engine

#     logger = logging.getLogger("TTSWorker")
#     logger.info("TTS worker started (legacy mode)")

#     # Initialize TTS engine
#     try:
#         engine = create_tts_engine(voice_config or {})
#         logger.info(f"TTS engine initialized: {engine.engine_type}")
#     except Exception as e:
#         logger.error(f"Failed to initialize TTS engine: {e}")
#         return

#     # Worker loop
#     while not shutdown_event.is_set():
#         try:
#             # Heartbeat
#             with heartbeat_value.get_lock():
#                 heartbeat_value.value = time.time()

#             # Get TTS request
#             try:
#                 request = tts_queue.get(timeout=0.5)
#             except Empty:
#                 continue

#             if request is None:  # Shutdown signal
#                 break

#             # Check for cancellation
#             if cancel_event.is_set():
#                 logger.info("TTS cancelled")
#                 continue

#             # Speak
#             speaking_event.set()
#             try:
#                 text = request.text if hasattr(request, 'text') else str(request)
#                 logger.info(f"Speaking: {text[:60]}...")
#                 engine.speak(text)
#             except Exception as e:
#                 logger.error(f"TTS error: {e}")
#             finally:
#                 speaking_event.clear()

#         except Exception as e:
#             logger.error(f"TTS worker error: {e}", exc_info=True)

#     logger.info("TTS worker stopped")
#     engine.cleanup()


# def create_tts_worker(event_bus, voice_config: Optional[Dict[str, Any]] = None):
#     """
#     LEGACY: Factory function for old ProcessManager.

#     This maintains backward compatibility with the old worker creation pattern.
#     New code should use ProcessManager.register_worker() directly.

#     Args:
#         event_bus: Legacy EventBus instance
#         voice_config: Voice configuration

#     Returns:
#         Tuple of (target_function, args) for Process creation
#     """
#     return (
#         _legacy_tts_worker_process,
#         (
#             event_bus.tts_queue,
#             event_bus.shutdown_event,
#             event_bus.cancel_event,
#             event_bus._tts_last_heartbeat,
#             voice_config,
#             event_bus.tts_speaking_event
#         )
#     )
