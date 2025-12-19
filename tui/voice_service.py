"""Modular voice (PTT) service for TUI applications.

This module provides a VoiceService class that can be used by any TUI
to add push-to-talk voice input capability. The service is designed
to be decoupled from specific TUI implementations.

Features:
- Lazy initialization of audio worker
- Callback-based event notification
- Thread-safe state management
- Clean lifecycle management
"""

from __future__ import annotations

import logging
import threading
import time
from queue import Empty
from typing import TYPE_CHECKING, Callable, Optional

if TYPE_CHECKING:
    from communication import EventBus, Mailbox
    from communication.events import TranscriptionCompleteEvent


class VoiceService:
    """Modular push-to-talk voice service.

    This service manages the PTT audio worker and provides a clean
    interface for TUI applications to use voice input.

    Usage:
        voice = VoiceService(event_bus, transcription_mailbox)
        voice.on_recording_start = lambda: state.set_status("Recording...")
        voice.on_recording_stop = lambda: state.set_status("Transcribing...")
        voice.on_transcription = lambda text: state.set_input(text)

        if voice.start():
            # Voice mode ready
            voice.begin_recording()  # When PTT key pressed
            # ... user holds key ...
            voice.end_recording()    # When PTT key released
            # Transcription callback fires when ready

        voice.stop()  # Cleanup
    """

    def __init__(
        self,
        event_bus: "EventBus",
        transcription_mailbox: "Mailbox",
        logger: Optional[logging.Logger] = None,
    ):
        """Initialize voice service.

        Args:
            event_bus: Event bus for communication
            transcription_mailbox: Mailbox to receive transcription events
            logger: Optional logger instance
        """
        self._event_bus = event_bus
        self._transcription_mailbox = transcription_mailbox
        self._logger = logger or logging.getLogger(__name__)

        # Internal state
        self._recording_event = threading.Event()
        self._ptt_worker: Optional["PushToTalkAudioWorker"] = None
        self._worker_thread: Optional[threading.Thread] = None
        self._running = False
        self._is_recording = False

        # Lock for thread-safe operations
        self._lock = threading.Lock()

        # Callbacks for TUI integration (set these before calling start())
        self.on_recording_start: Optional[Callable[[], None]] = None
        self.on_recording_stop: Optional[Callable[[], None]] = None
        self.on_transcription: Optional[Callable[[str], None]] = None
        self.on_error: Optional[Callable[[str], None]] = None

    @property
    def is_active(self) -> bool:
        """Check if voice service is active and ready."""
        with self._lock:
            return self._running and self._ptt_worker is not None

    @property
    def is_recording(self) -> bool:
        """Check if currently recording."""
        with self._lock:
            return self._is_recording

    def start(self) -> bool:
        """Start the voice service.

        Initializes the PTT audio worker in a background thread.

        Returns:
            True if service started successfully, False otherwise
        """
        with self._lock:
            if self._running:
                self._logger.warning("Voice service already running")
                return True

            try:
                # Import here to avoid circular imports and lazy load audio deps
                from workers.ptt_audio_worker import PushToTalkAudioWorker

                # Create PTT worker with our recording event
                self._ptt_worker = PushToTalkAudioWorker(
                    event_bus=self._event_bus,
                    recording_event=self._recording_event,
                    target_mailbox=self._transcription_mailbox,
                )

                # Start worker in background thread
                self._worker_thread = threading.Thread(
                    target=self._ptt_worker.run,
                    daemon=True,
                    name="PTTAudioWorker",
                )
                self._worker_thread.start()

                self._running = True
                self._logger.info("Voice service started")
                return True

            except ImportError as e:
                self._logger.error(f"Failed to import PTT worker: {e}")
                if self.on_error:
                    self.on_error(f"Voice dependencies not available: {e}")
                return False

            except Exception as e:
                self._logger.error(f"Failed to start voice service: {e}")
                if self.on_error:
                    self.on_error(f"Failed to start voice: {e}")
                return False

    def stop(self):
        """Stop the voice service and clean up resources."""
        with self._lock:
            if not self._running:
                return

            self._running = False

            # Clear recording event in case we're mid-recording
            self._recording_event.clear()
            self._is_recording = False

            # Stop the worker
            if self._ptt_worker:
                try:
                    self._ptt_worker.stop()
                except Exception as e:
                    self._logger.warning(f"Error stopping PTT worker: {e}")
                self._ptt_worker = None

            # Wait for thread to finish
            if self._worker_thread and self._worker_thread.is_alive():
                self._worker_thread.join(timeout=2.0)
            self._worker_thread = None

            self._logger.info("Voice service stopped")

    def begin_recording(self):
        """Begin recording audio.

        Called when the PTT key is pressed. Sets the recording event
        which signals the PTT worker to start capturing audio.
        """
        with self._lock:
            if not self._running or not self._ptt_worker:
                self._logger.warning("Voice service not active, cannot record")
                return

            if self._is_recording:
                self._logger.warning("Already recording")
                return

            self._is_recording = True
            self._recording_event.set()

        # Fire callback outside lock to avoid deadlock
        if self.on_recording_start:
            try:
                self.on_recording_start()
            except Exception as e:
                self._logger.error(f"Error in on_recording_start callback: {e}")

        self._logger.info("Recording started")

    def end_recording(self):
        """End recording audio.

        Called when the PTT key is released. Clears the recording event
        which signals the PTT worker to stop capturing and begin transcription.
        """
        with self._lock:
            if not self._is_recording:
                return

            self._is_recording = False
            self._recording_event.clear()

        # Fire callback outside lock
        if self.on_recording_stop:
            try:
                self.on_recording_stop()
            except Exception as e:
                self._logger.error(f"Error in on_recording_stop callback: {e}")

        self._logger.info("Recording stopped, transcription will follow")

    def poll_transcription(self, timeout: float = 0.01) -> Optional[str]:
        """Poll for transcription results.

        This should be called periodically when waiting for transcription.
        When a transcription is received, fires on_transcription callback.

        Args:
            timeout: Poll timeout in seconds

        Returns:
            Transcribed text if available, None otherwise
        """
        from communication.events import TranscriptionCompleteEvent

        try:
            event = self._transcription_mailbox.receive(timeout=timeout)

            if event and isinstance(event, TranscriptionCompleteEvent):
                # Only process PTT transcriptions (not text input)
                if event.request_id and event.request_id.startswith("ptt_"):
                    if event.text:
                        # Fire callback
                        if self.on_transcription:
                            try:
                                self.on_transcription(event.text)
                            except Exception as e:
                                self._logger.error(
                                    f"Error in on_transcription callback: {e}"
                                )
                        return event.text
                    else:
                        self._logger.warning("Received empty transcription")
                        if self.on_error:
                            self.on_error("Voice input was unclear, please try again")

        except Empty:
            pass
        except Exception as e:
            self._logger.error(f"Error polling transcription: {e}")

        return None

    def process_transcription_event(
        self, event: "TranscriptionCompleteEvent"
    ) -> Optional[str]:
        """Process a transcription event directly.

        Alternative to polling - call this when the TUI receives
        a TranscriptionCompleteEvent from its event monitor.

        Args:
            event: The transcription event

        Returns:
            Transcribed text if valid PTT event, None otherwise
        """
        # Only process PTT transcriptions
        if not (event.request_id and event.request_id.startswith("ptt_")):
            return None

        if event.text:
            # Fire callback
            if self.on_transcription:
                try:
                    self.on_transcription(event.text)
                except Exception as e:
                    self._logger.error(f"Error in on_transcription callback: {e}")
            return event.text
        else:
            self._logger.warning("Received empty transcription")
            if self.on_error:
                self.on_error("Voice input was unclear, please try again")
            return None


class VoiceInputHandler:
    """High-level voice input handling with key detection.

    Provides utilities for detecting PTT key press/release in raw terminal mode.
    This is a helper class that TUIs can use alongside VoiceService.
    """

    # PTT key configuration
    PTT_KEY = " "  # Space bar

    # Key release detection: count consecutive timeouts
    # Key repeat typically fires every 30-50ms
    # 3 timeouts of 40ms = ~120ms of silence = key released
    RELEASE_THRESHOLD = 3
    POLL_TIMEOUT = 0.04  # 40ms

    def __init__(self, voice_service: VoiceService):
        """Initialize voice input handler.

        Args:
            voice_service: The voice service to control
        """
        self.voice = voice_service
        self._consecutive_timeouts = 0

    def handle_key(self, char: str, is_buffer_empty: bool) -> bool:
        """Handle a key press for potential PTT activation.

        Args:
            char: The character pressed
            is_buffer_empty: Whether the input buffer is empty

        Returns:
            True if key was handled as PTT trigger, False otherwise
        """
        # Only trigger PTT on space when buffer is empty
        if char == self.PTT_KEY and is_buffer_empty:
            if self.voice.is_active:
                self.voice.begin_recording()
                return True
        return False

    def detect_release(self, has_input: bool) -> bool:
        """Detect if PTT key was released.

        Call this in a loop while recording. Uses consecutive timeout
        detection since we can't directly detect key-up events.

        Args:
            has_input: Whether keyboard input was detected this poll

        Returns:
            True if key release detected, False if still held
        """
        if has_input:
            # Key pressed - reset timeout counter
            self._consecutive_timeouts = 0
            return False
        else:
            # No input - timeout
            self._consecutive_timeouts += 1
            if self._consecutive_timeouts >= self.RELEASE_THRESHOLD:
                # Key released (no input for ~120ms)
                self._consecutive_timeouts = 0
                self.voice.end_recording()
                return True
            return False

    def reset(self):
        """Reset release detection state."""
        self._consecutive_timeouts = 0
