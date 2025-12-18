"""Push-to-Talk Audio Worker

Simplified audio worker for push-to-talk mode that records audio on demand
and publishes transcription events to the event bus.

Uses the shared STTService for transcription (Whisper-based).
"""

import os
import sys
import time
import logging
from typing import Optional

import pyaudio

# Add src to path for imports
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from communication import EventBus
from communication.events import TranscriptionCompleteEvent
from audio_pipeline.audio_pipeline import AudioConfig, AudioDeviceManager
from services.audio.stt_service import STTService, STTConfig
from services.audio.audio_service import AudioChunk


class PushToTalkAudioWorker:
    """Audio worker for push-to-talk mode.

    Records audio while recording_event is set, then transcribes using
    the shared STTService and publishes the result to the event bus.
    """

    def __init__(
        self,
        event_bus: EventBus,
        recording_event,
        audio_config: Optional[AudioConfig] = None,
        stt_config: Optional[STTConfig] = None,
        target_mailbox=None,
    ):
        """Initialize PTT audio worker.

        Args:
            event_bus: Event bus for publishing transcription events
            recording_event: Event that signals when to record (threading.Event or mp.Event)
            audio_config: Audio configuration (uses defaults if None)
            stt_config: STT configuration (uses defaults if None)
            target_mailbox: Optional mailbox to deliver transcripts directly (bypasses event bus)
        """
        self.event_bus = event_bus
        self.recording_event = recording_event
        self.target_mailbox = target_mailbox
        self.audio_config = audio_config or AudioConfig()
        self.logger = logging.getLogger(__name__)

        # Audio components
        self.device_manager = AudioDeviceManager(self.audio_config)
        self.pyaudio_instance: Optional[pyaudio.PyAudio] = None
        self.audio_stream: Optional[pyaudio.Stream] = None

        # STT service (initialized lazily)
        self.stt_config = stt_config or STTConfig(
            engine="whisper",
            model_size="base",
            device="auto",
            compute_type="auto",
            vad_filter=True,
            filter_hallucinations=True,
        )
        self.stt_service: Optional[STTService] = None

        # State
        self.running = False
        self.device_index: Optional[int] = None
        self.request_counter = 0
        self.sample_rate = 16000  # Standard rate for speech recognition

    def initialize_stt(self) -> bool:
        """Initialize STT service.

        Returns:
            True if initialization successful, False otherwise
        """
        try:
            self.logger.info(f"Initializing STT service (engine={self.stt_config.engine})")

            # STTService handles output suppression internally during model load
            self.stt_service = STTService(self.stt_config, self.logger)
            if not self.stt_service.initialize():
                self.logger.error("STT service failed to initialize")
                return False

            self.logger.info("STT service initialized successfully")
            return True
        except Exception as e:
            self.logger.error(f"Failed to initialize STT service: {e}")
            return False

    def initialize_audio(self) -> bool:
        """Initialize audio device and stream.

        Returns:
            True if initialization successful, False otherwise
        """
        try:
            # Find suitable input device
            self.device_index = self.device_manager.find_input_device()
            if self.device_index is None:
                self.logger.error("No suitable audio input device found")
                return False

            self.pyaudio_instance = pyaudio.PyAudio()
            device_info = self.pyaudio_instance.get_device_info_by_index(self.device_index)
            self.logger.info(f"Using audio device: {device_info['name']}")

            chunk_size = 1024

            self.audio_stream = self.pyaudio_instance.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=self.sample_rate,
                input=True,
                input_device_index=self.device_index,
                frames_per_buffer=chunk_size,
            )

            self.logger.info(f"Audio stream initialized: {self.sample_rate}Hz, {chunk_size} samples/chunk")
            return True

        except Exception as e:
            self.logger.error(f"Failed to initialize audio: {e}")
            return False

    def cleanup_audio(self):
        """Clean up audio resources."""
        if self.audio_stream:
            try:
                self.audio_stream.stop_stream()
                self.audio_stream.close()
            except Exception as e:
                self.logger.warning(f"Error closing audio stream: {e}")
            self.audio_stream = None

        if self.pyaudio_instance:
            try:
                self.pyaudio_instance.terminate()
            except Exception as e:
                self.logger.warning(f"Error terminating PyAudio: {e}")
            self.pyaudio_instance = None

    def record_audio(self) -> Optional[bytes]:
        """Record audio while recording_event is set.

        Returns:
            Recorded audio data as bytes, or None if recording failed
        """
        if not self.audio_stream:
            self.logger.error("Audio stream not initialized")
            return None

        audio_frames = []
        chunk_size = 1024

        try:
            self.logger.info("Recording started")

            while self.recording_event.is_set() and self.running:
                try:
                    data = self.audio_stream.read(chunk_size, exception_on_overflow=False)
                    audio_frames.append(data)
                except Exception as e:
                    self.logger.warning(f"Error reading audio chunk: {e}")
                    break

            self.logger.info(f"Recording stopped, captured {len(audio_frames)} chunks")

            if not audio_frames:
                return None

            return b"".join(audio_frames)

        except Exception as e:
            self.logger.error(f"Error during recording: {e}")
            return None

    def transcribe_audio(self, audio_data: bytes, duration_seconds: float) -> Optional[str]:
        """Transcribe audio data to text using STTService.

        Args:
            audio_data: Raw audio data (16-bit PCM)
            duration_seconds: Duration of the audio in seconds

        Returns:
            Transcribed text, or None if transcription failed
        """
        if not self.stt_service:
            self.logger.error("STT service not initialized")
            return None

        try:
            # Create AudioChunk for STTService
            audio_chunk = AudioChunk(
                data=audio_data,
                sample_rate=self.sample_rate,
                timestamp=time.time(),
                duration_seconds=duration_seconds,
            )

            self.logger.info("Transcribing audio...")
            result = self.stt_service.transcribe(audio_chunk)

            if result and result.text:
                self.logger.info(f"Transcription: {result.text}")
                return result.text
            else:
                self.logger.warning("STT service returned empty transcription")
                return None

        except Exception as e:
            self.logger.error(f"Error during transcription: {e}")
            return None

    def publish_transcription(self, text: str, duration_ms: float):
        """Publish transcription event to event bus or direct mailbox.

        Args:
            text: Transcribed text
            duration_ms: Recording duration in milliseconds
        """
        self.request_counter += 1
        request_id = f"ptt_{self.request_counter}_{int(time.time() * 1000) % 100000}"

        event = TranscriptionCompleteEvent(
            request_id=request_id,
            text=text,
            confidence=None,
            duration_ms=duration_ms,
        )

        if self.target_mailbox:
            # Deliver straight to the provided mailbox to avoid auto-submission
            try:
                self.target_mailbox.deliver(event)
                self.logger.info(f"Delivered transcription to mailbox: {request_id}")
            except Exception as exc:
                self.logger.error(f"Failed to deliver transcription to mailbox: {exc}")
        else:
            self.event_bus.publish(event)
            self.logger.info(f"Published transcription event: {request_id}")

    def run(self):
        """Main worker loop."""
        self.logger.info("PushToTalkAudioWorker starting")

        # Suppress console logging for workers
        if os.getenv("LOG_TO_CONSOLE", "true").lower() == "false":
            for handler in self.logger.handlers[:]:
                if isinstance(handler, logging.StreamHandler):
                    self.logger.removeHandler(handler)

        # Initialize STT service
        if not self.initialize_stt():
            self.logger.error("Failed to initialize STT service, worker exiting")
            return

        # Initialize audio
        if not self.initialize_audio():
            self.logger.error("Failed to initialize audio, worker exiting")
            return

        self.running = True

        try:
            while self.running:
                # Wait for recording signal
                self.recording_event.wait(timeout=0.1)

                if not self.running:
                    break

                if self.recording_event.is_set():
                    # Record audio
                    start_time = time.time()
                    audio_data = self.record_audio()
                    duration_seconds = time.time() - start_time
                    duration_ms = duration_seconds * 1000

                    if audio_data and len(audio_data) > 0:
                        # Transcribe using STTService
                        text = self.transcribe_audio(audio_data, duration_seconds)

                        if text:
                            # Publish to event bus
                            self.publish_transcription(text, duration_ms)
                        else:
                            self.logger.warning("Transcription failed or returned empty")
                    else:
                        self.logger.warning("No audio data captured")

        except KeyboardInterrupt:
            self.logger.info("Received interrupt signal")
        except Exception as e:
            self.logger.error(f"Error in worker loop: {e}")
            import traceback

            traceback.print_exc()
        finally:
            self.cleanup_audio()
            self.logger.info("PushToTalkAudioWorker stopped")

    def stop(self):
        """Stop the worker."""
        self.running = False


def worker_main(event_bus: EventBus, recording_event):
    """Worker process entry point.

    Args:
        event_bus: Event bus for publishing events
        recording_event: Event to signal when to record
    """
    worker = PushToTalkAudioWorker(event_bus, recording_event)
    worker.run()
