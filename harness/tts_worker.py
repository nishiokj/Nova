"""
TTS Worker - Separate process for text-to-speech.

Runs in its own process to avoid GIL contention with main audio/STT process.
Consumes from EventBus TTS queue and speaks via pyttsx3 or VoiceStreamer.
"""

import sys
import os
import time
import logging
import traceback
from typing import Optional, Dict, Any

# Ensure parent directory is in path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness.event_bus import EventBus, TTSRequest


class TTSWorker:
    """
    TTS Worker that runs in a separate process.

    Features:
    - Processes TTS queue independently of main process
    - Supports interruption via EventBus cancel signal
    - Health heartbeats for monitoring
    - Graceful shutdown
    """

    def __init__(
        self,
        event_bus: EventBus,
        voice_config: Optional[Dict[str, Any]] = None
    ):
        self.event_bus = event_bus
        self.voice_config = voice_config or {}
        self.logger = logging.getLogger(f"{__name__}.TTSWorker")

        self._engine = None
        self._engine_type = "none"
        self._initialized = False
        self._speaking = False

    def initialize(self) -> bool:
        """Initialize TTS engine"""
        try:
            self.logger.info("TTSWorker: Initializing TTS engine...")

            # Try VoiceStreamer first
            try:
                from voice import VoiceConfig, VoiceStreamer
                config = VoiceConfig(**self.voice_config)
                self._engine = VoiceStreamer(config)
                self._engine_type = "VoiceStreamer"
                self.logger.info("TTSWorker: Using VoiceStreamer engine")
            except Exception as e:
                self.logger.warning(f"TTSWorker: VoiceStreamer not available ({e}), trying pyttsx3")

                # Fallback to pyttsx3
                try:
                    import pyttsx3
                    self._engine = pyttsx3.init()
                    self._engine.setProperty('rate', self.voice_config.get('rate', 180))
                    self._engine.setProperty('volume', self.voice_config.get('volume', 0.8))
                    self._engine_type = "pyttsx3"
                    self.logger.info("TTSWorker: Using pyttsx3 engine")
                except Exception as e2:
                    self.logger.error(f"TTSWorker: pyttsx3 also failed: {e2}")
                    self._engine = None
                    self._engine_type = "none"

            self._initialized = True

            if self._engine_type == "none":
                self.logger.error("TTSWorker: NO TTS ENGINE AVAILABLE!")
                return False

            return True

        except Exception as e:
            self.logger.error(f"TTSWorker initialization failed: {e}\n{traceback.format_exc()}")
            return False

    def _speak_text(self, text: str) -> bool:
        """
        Speak text. Returns True if successful.
        Checks for cancellation between sentences.
        """
        if not self._engine:
            self.logger.error(f"TTSWorker: No engine! Text lost: {text[:60]}...")
            return False

        self._speaking = True
        try:
            # For long text, split into sentences and check cancellation between
            sentences = self._split_into_sentences(text)

            for sentence in sentences:
                # Check for cancellation
                if self.event_bus.is_cancelled():
                    self.logger.info("TTSWorker: Cancelled mid-speech")
                    self._stop_current_speech()
                    return False

                # Speak the sentence
                self._speak_sentence(sentence)

            return True

        except Exception as e:
            self.logger.error(f"TTSWorker speak error: {e}")
            return False
        finally:
            self._speaking = False

    def _split_into_sentences(self, text: str) -> list:
        """Split text into sentences for interruptible speech"""
        import re
        # Split on sentence boundaries but keep the punctuation
        sentences = re.split(r'(?<=[.!?])\s+', text)
        return [s.strip() for s in sentences if s.strip()]

    def _speak_sentence(self, text: str):
        """Speak a single sentence"""
        if hasattr(self._engine, 'speak_blocking'):
            self._engine.speak_blocking(text)
        elif hasattr(self._engine, 'start_streaming'):
            # VoiceStreamer
            self._engine.start_streaming()
            self._engine.add_complete_text(text)
            if hasattr(self._engine, 'wait_until_idle'):
                self._engine.wait_until_idle()
        else:
            # pyttsx3
            self._engine.say(text)
            self._engine.runAndWait()

    def _stop_current_speech(self):
        """Stop any current speech (for cancellation)"""
        try:
            if hasattr(self._engine, 'stop'):
                self._engine.stop()
            elif hasattr(self._engine, 'endLoop'):
                self._engine.endLoop()
        except Exception:
            pass  # Best effort

    def run(self):
        """
        Main worker loop. Runs until shutdown signal.
        """
        self.logger.info(f"TTSWorker: Starting (PID: {os.getpid()})")

        if not self.initialize():
            self.logger.error("TTSWorker: Failed to initialize, exiting")
            return

        self.logger.info(f"TTSWorker: Initialized with {self._engine_type} engine")

        while not self.event_bus.is_shutdown():
            try:
                # Heartbeat
                self.event_bus.tts_heartbeat()

                # Get next TTS request
                request = self.event_bus.get_tts_request(timeout=0.5)

                if request is None:
                    continue

                self.logger.info(
                    f"TTSWorker: Speaking [{request.response_type}] "
                    f"'{request.text[:60]}...' (len={len(request.text)})"
                )

                start_time = time.time()
                success = self._speak_text(request.text)
                duration_ms = (time.time() - start_time) * 1000

                if success:
                    self.logger.info(f"TTSWorker: Spoke in {duration_ms:.0f}ms")
                else:
                    self.logger.warning(f"TTSWorker: Speech failed/cancelled")

            except Exception as e:
                self.logger.error(f"TTSWorker loop error: {e}\n{traceback.format_exc()}")
                time.sleep(0.1)

        self.logger.info("TTSWorker: Shutting down")
        self.cleanup()

    def cleanup(self):
        """Clean up resources"""
        if self._engine and hasattr(self._engine, 'cleanup'):
            self._engine.cleanup()

    @property
    def is_speaking(self) -> bool:
        return self._speaking


def run_tts_worker_process(
    tts_queue,
    shutdown_event,
    cancel_event,
    tts_heartbeat,
    voice_config,
    tts_speaking_event
):
    """
    Top-level function to run TTS worker in a subprocess.
    Must be top-level (not a closure) for proper pickling with spawn.
    """
    import logging
    import time
    import traceback
    import sys
    import os
    import subprocess
    import platform

    # Setup logging for this process
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [TTS-%(process)d] %(levelname)s %(message)s',
        datefmt='%H:%M:%S',
        stream=sys.stdout
    )
    logger = logging.getLogger("TTSWorker")

    logger.info(f"TTS Worker starting (PID: {os.getpid()})")

    # Determine TTS engine to use
    engine = None
    engine_type = "none"
    use_say_command = False

    # On macOS, prefer the native 'say' command - it's more reliable than pyttsx3
    if platform.system() == "Darwin":
        # Check if 'say' command is available
        try:
            subprocess.run(["say", "-v", "?"], capture_output=True, check=True, timeout=5)
            use_say_command = True
            engine_type = "macos_say"
            logger.info("Using macOS 'say' command (most reliable)")
        except Exception as e:
            logger.warning(f"macOS 'say' command not available: {e}")

    # Fallback to pyttsx3 if not using say command
    if not use_say_command:
        try:
            import pyttsx3
            engine = pyttsx3.init()
            engine.setProperty('rate', (voice_config or {}).get('rate', 180))
            engine.setProperty('volume', (voice_config or {}).get('volume', 0.8))
            engine_type = "pyttsx3"
            logger.info("Using pyttsx3 engine")
        except Exception as e2:
            logger.error(f"pyttsx3 failed: {e2}")
            engine = None
            engine_type = "none"

    if engine_type == "none":
        logger.error("NO TTS ENGINE AVAILABLE - exiting")
        return

    logger.info(f"TTS Worker initialized with {engine_type}")

    # Define speak function based on engine type
    def speak_text(text: str) -> bool:
        """Speak text using the available engine"""
        if tts_speaking_event:
            tts_speaking_event.set()
        try:
            if use_say_command:
                # Use macOS 'say' command - runs in subprocess, very reliable
                try:
                    rate = (voice_config or {}).get('rate', 180)
                    result = subprocess.run(
                        ["say", "-r", str(rate), text],
                        capture_output=True,
                        timeout=300  # 5 minute timeout for long text
                    )
                    return result.returncode == 0
                except subprocess.TimeoutExpired:
                    logger.warning("say command timed out")
                    return False
                except Exception as e:
                    logger.error(f"say command failed: {e}")
                    return False
            else:
                # Use pyttsx3
                try:
                    engine.say(text)
                    engine.runAndWait()
                    return True
                except Exception as e:
                    logger.error(f"pyttsx3 failed: {e}")
                    return False
        finally:
            if tts_speaking_event:
                tts_speaking_event.clear()

    # Main loop
    try:
        while not shutdown_event.is_set():
            try:
                # Heartbeat
                tts_heartbeat.value = time.time()

                # Get next request from queue
                try:
                    msg = tts_queue.get(timeout=0.5)
                except:
                    continue

                if msg is None:
                    continue

                # Check for shutdown message
                if hasattr(msg, 'type') and msg.type.value == 'shutdown':
                    logger.info("Received shutdown signal")
                    break

                # Extract text from message
                if hasattr(msg, 'payload'):
                    text = msg.payload.get('text', '')
                    response_type = msg.payload.get('response_type', 'completion')
                else:
                    continue

                if not text:
                    continue

                logger.info(f"Speaking [{response_type}]: {text[:60]}...")

                # Check for cancellation
                if cancel_event.is_set():
                    logger.info("Cancelled, skipping speech")
                    continue

                # Speak the text
                start_time = time.time()
                logger.debug(f"SPEAKING THIS TEXT", text)
                success = speak_text(text)
                duration_ms = (time.time() - start_time) * 1000

                if success:
                    logger.info(f"Spoke in {duration_ms:.0f}ms")
                else:
                    logger.warning(f"Speech failed after {duration_ms:.0f}ms")

            except Exception as e:
                logger.error(f"TTS loop error: {e}\n{traceback.format_exc()}")

        logger.info("TTS Worker shutting down")

        # Cleanup
        if engine and hasattr(engine, 'cleanup'):
            engine.cleanup()

    except Exception as e:
        logger.error(f"TTS Worker fatal error: {e}\n{traceback.format_exc()}")


def create_tts_worker(event_bus: EventBus, voice_config: Optional[Dict[str, Any]] = None):
    """Factory function to create TTS worker process arguments"""
    # Return a tuple of (target_function, args) for Process creation
    return (
        run_tts_worker_process,
        (
            event_bus.tts_queue,
            event_bus.shutdown_event,
            event_bus.cancel_event,
            event_bus._tts_last_heartbeat,
            voice_config,
            event_bus.tts_speaking_event
        )
    )
