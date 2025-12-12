"""
Single-Process Voice Application.

Architecture:
- All components run in threads within a single process
- Fast IPC via threading.Queue (InMemoryEventBus)
- Simpler to debug, but limited by GIL
- Services communicate via EventBus (pub/sub model)
"""

import time
import threading
from queue import Queue, Empty
from typing import Optional

from app_config import AppConfig
from communication import (
    InMemoryEventBus,
    AudioCapturedEvent,
    TranscriptionCompleteEvent,
    AgentRequestSubmittedEvent,
    AgentResponseCompleteEvent,
    TTSRequestedEvent,
    EventType,
)
from services.audio import (
    AudioService,
    AudioConfig as ServiceAudioConfig,
    STTService,
    STTConfig,
    AudioChunk,
)
from services.language import TextLinterService
from audio_pipeline import AudioDeviceManager, AudioConfig as DeviceAudioConfig
from harness import create_harness

from .base_app import BaseVoiceApp


class SingleProcessVoiceApp(BaseVoiceApp):
    """
    Single-process voice application with clean architecture.

    Flow:
    1. Audio capture → AudioCapturedEvent
    2. STT processes audio → TranscriptionCompleteEvent
    3. Linter validates text → AgentRequestSubmittedEvent
    4. Harness processes → AgentResponseCompleteEvent
    5. ServiceRep speaks response

    All components run in threads, communicate via EventBus.
    """

    def __init__(self, config: AppConfig):
        """
        Initialize single-process application.

        Args:
            config: Application configuration
        """
        super().__init__(config)

        # Create EventBus (in-memory for single-process)
        self.event_bus = InMemoryEventBus()

        # Create services with injected dependencies
        self.audio_service = self._create_audio_service()
        self.stt_service = self._create_stt_service()
        self.linter = self._create_linter()

        # Create harness (domain layer)
        self.harness = self._create_harness()

        # Audio hardware components
        self.device_manager = AudioDeviceManager(self._create_device_audio_config())
        self.audio_queue = Queue()

        # Worker threads
        self.audio_capture_thread: Optional[threading.Thread] = None
        self.audio_process_thread: Optional[threading.Thread] = None
        self.stt_thread: Optional[threading.Thread] = None
        self.event_monitor_thread: Optional[threading.Thread] = None

        # Wire event handlers
        self._setup_event_handlers()

        self.logger.info("SingleProcessVoiceApp initialized")

    def _create_audio_service(self) -> AudioService:
        """Create audio service with injected dependencies"""
        service_config = ServiceAudioConfig(
            sample_rate=self.config.audio.sample_rate,
            chunk_duration_ms=self.config.audio.chunk_duration_ms,
            channels=self.config.audio.channels,
            vad_aggressiveness=self.config.audio.vad_aggressiveness,
            speech_timeout_ms=self.config.audio.speech_timeout_ms,
            silence_timeout_ms=self.config.audio.silence_timeout_ms,
            min_speech_duration_s=self.config.audio.min_speech_duration_s,
            device_index=self.config.audio.device_index,
        )

        return AudioService(
            config=service_config,
            logger=self.logger.getChild("audio")
        )

    def _create_stt_service(self) -> STTService:
        """Create STT service with injected dependencies"""
        stt_config = STTConfig(
            engine=self.config.stt.engine,
            model_size=self.config.stt.model_size,
            device=self.config.stt.device,
            compute_type=self.config.stt.compute_type,
            beam_size=self.config.stt.beam_size,
            vad_filter=self.config.stt.vad_filter
        )

        return STTService(
            config=stt_config,
            logger=self.logger.getChild("stt")
        )

    def _create_device_audio_config(self) -> DeviceAudioConfig:
        """Create audio config for device manager"""
        return DeviceAudioConfig(self.config.audio.to_dict())

    def _create_harness(self):
        """Create harness with configuration"""
        harness = create_harness(
            config_path=self.config.harness.config_path,
            router_enabled=self.config.harness.router_enabled,
            service_rep_enabled=self.config.harness.service_rep_enabled,
            default_tier=self.config.harness.default_tier
        )
        return harness

    def _setup_event_handlers(self):
        """Wire services via EventBus"""
        # Audio → STT
        self.event_bus.subscribe(
            EventType.AUDIO_CAPTURED,
            self._on_audio_captured
        )

        # STT → Linter → Harness
        self.event_bus.subscribe(
            EventType.TRANSCRIPTION_COMPLETE,
            self._on_transcription
        )

        # Harness → Log (TTS is handled by harness.service_rep)
        self.event_bus.subscribe(
            EventType.AGENT_RESPONSE_COMPLETE,
            self._on_agent_response
        )

    def _on_audio_captured(self, event: AudioCapturedEvent):
        """Handle audio captured event - forward to STT"""
        audio_chunk = AudioChunk(
            data=event.audio_data,
            sample_rate=event.sample_rate,
            timestamp=event.timestamp,
            duration_seconds=event.duration_seconds
        )

        result = self.stt_service.transcribe(audio_chunk)
        if result and result.text:
            self.event_bus.publish(TranscriptionCompleteEvent(
                request_id=event.request_id or self._generate_request_id(),
                text=result.text,
                confidence=result.confidence,
                duration_ms=result.duration_ms
            ))

    def _on_transcription(self, event: TranscriptionCompleteEvent):
        """Handle transcription complete - lint and send to harness"""
        lint_result = self.linter.lint_and_validate(event.text, min_words=self.config.linter.min_words)

        if not lint_result.is_valid:
            self.logger.debug(f"Invalid input rejected: {event.text[:50]}")
            return

        self.logger.info(f"Processing: {lint_result.cleaned}")

        # Process through harness (domain layer)
        response = self.harness.process(lint_result.cleaned)

        # Publish completion event
        self.event_bus.publish(AgentResponseCompleteEvent(
            request_id=event.request_id,
            success=response.agent_response.success if response.agent_response else False,
            content=response.full_response,
            spoken_response=response.spoken_response,
            tools_used=response.agent_response.tools_used if response.agent_response else [],
            duration_ms=response.duration_ms
        ))

    def _on_agent_response(self, event: AgentResponseCompleteEvent):
        """Handle agent response complete - log it"""
        self.logger.info(
            f"[{event.request_id}] Response in {event.duration_ms:.0f}ms: "
            f"{event.spoken_response[:100]}"
        )

        if event.tools_used:
            self.logger.info(f"[{event.request_id}] Tools used: {', '.join(event.tools_used)}")

    def _audio_capture_loop(self, device_index: int):
        """Audio capture loop - reads from microphone"""
        import pyaudio

        self.logger.info("Audio capture loop started")

        # Initialize PyAudio stream
        pa = pyaudio.PyAudio()
        stream = None

        try:
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=self.config.audio.channels,
                rate=self.config.audio.sample_rate,
                input=True,
                input_device_index=device_index,
                frames_per_buffer=self.audio_service.config.chunk_size
            )

            while self.running:
                try:
                    audio_chunk = stream.read(
                        self.audio_service.config.chunk_size,
                        exception_on_overflow=False
                    )
                    self.audio_queue.put(audio_chunk, timeout=0.1)
                except Exception as e:
                    self.logger.error(f"Audio capture error: {e}")

        finally:
            if stream:
                stream.stop_stream()
                stream.close()
            pa.terminate()
            self.logger.info("Audio capture loop stopped")

    def _audio_process_loop(self):
        """Audio processing loop - VAD and speech detection"""
        self.logger.info("Audio processing loop started")

        # Calibrate noise floor
        calibration_complete = False
        self.logger.info("Calibrating noise floor...")

        while self.running:
            try:
                audio_chunk = self.audio_queue.get(timeout=0.5)

                # Calibration phase
                if not calibration_complete:
                    if self.audio_service.calibrate_noise_floor(audio_chunk):
                        calibration_complete = True
                        self.logger.info("Noise floor calibrated, listening for speech...")
                    continue

                # Process frame
                result = self.audio_service.process_frame(audio_chunk)

                if result:
                    # Publish audio captured event
                    self.event_bus.publish(AudioCapturedEvent(
                        request_id=self._generate_request_id(),
                        audio_data=result.data,
                        sample_rate=result.sample_rate,
                        duration_seconds=result.duration_seconds,
                        timestamp=result.timestamp
                    ))

            except Empty:
                continue
            except Exception as e:
                self.logger.error(f"Audio processing error: {e}", exc_info=True)

        self.logger.info("Audio processing loop stopped")

    def start(self) -> bool:
        """Start the single-process application"""
        self.logger.info("Starting SingleProcessVoiceApp...")
        self.running = True

        # Find audio device
        device_index = self.device_manager.wait_for_input_device()
        if device_index is None:
            self.logger.error("No audio input device found")
            return False

        self.logger.info(f"Using audio device index: {device_index}")

        # Initialize STT
        self.logger.info("Initializing STT service...")
        if not self.stt_service.initialize():
            self.logger.error("Failed to initialize STT service")
            return False

        # Start audio capture thread
        self.audio_capture_thread = threading.Thread(
            target=self._audio_capture_loop,
            args=(device_index,),
            daemon=True,
            name="AudioCapture"
        )
        self.audio_capture_thread.start()

        # Start audio processing thread
        self.audio_process_thread = threading.Thread(
            target=self._audio_process_loop,
            daemon=True,
            name="AudioProcess"
        )
        self.audio_process_thread.start()

        self.logger.info("SingleProcessVoiceApp started successfully")
        self.logger.info("Speak to interact with the AI agent...")

        return True

    def stop(self):
        """Stop the application"""
        self.logger.info("Stopping SingleProcessVoiceApp...")
        self.running = False

        # Shutdown EventBus
        self.event_bus.shutdown()

        # Stop harness
        if self.harness:
            self.harness.cleanup()

        # Wait for threads
        if self.audio_capture_thread and self.audio_capture_thread.is_alive():
            self.audio_capture_thread.join(timeout=2.0)

        if self.audio_process_thread and self.audio_process_thread.is_alive():
            self.audio_process_thread.join(timeout=2.0)

        self.logger.info("SingleProcessVoiceApp stopped")
