"""
Multi-Process Voice Application.

Architecture:
- Main Process: Audio capture + STT
- Agent Process: Harness/Agent processing
- TTS Process: Speech synthesis
- IPC via multiprocessing.Queue (MultiProcessEventBus)
- No GIL contention, true parallelism
"""

import time
import threading
from queue import Queue, Empty
from typing import Optional
import sys

from app_config import AppConfig
from communication import (
    AudioCapturedEvent,
    EventBus,
    TranscriptionCompleteEvent,
    AgentRequestSubmittedEvent,
    TTSRequestedEvent,
    Mailbox,
)
from communication.events import EventType
from services.audio import (
    AudioService,
    AudioConfig as ServiceAudioConfig,
    STTService,
    STTConfig,
)
from services.language import TextLinterService
from audio_pipeline import AudioDeviceManager, AudioConfig as DeviceAudioConfig
from .process_manager import ProcessManager

from .base_app import BaseVoiceApp


class MultiProcessVoiceApp(BaseVoiceApp):
    """
    Multi-process voice application with clean architecture.

    Architecture:
    - Main Process: Audio capture, STT, text linting
    - Agent Process: Harness processing, agent execution
    - TTS Process: Speech synthesis
    - All communicate via MultiProcessEventBus

    Flow:
    1. Main: Audio capture → STT → Linter
    2. Main publishes AgentRequestSubmittedEvent
    3. Agent process receives, processes via harness
    4. Agent publishes AgentResponseCompleteEvent + TTSRequestedEvent
    5. TTS process receives, speaks response
    """

    def __init__(self, config: AppConfig):
        """
        Initialize multi-process application.

        Args:
            config: Application configuration
        """
        super().__init__(config)

        # Create EventBus (multiprocess for IPC)
        self.event_bus = EventBus()

        # Create shared control events for worker coordination
        from multiprocessing import Event as MPEvent
        self.cancel_event = MPEvent()
        self.tts_speaking_event = MPEvent()

        # Create mailbox for receiving agent responses
        from multiprocessing import Queue as MPQueue
        self.response_mailbox = Mailbox("main_app", MPQueue())
        self.response_mailbox.subscribe_to(self.event_bus, EventType.AGENT_RESPONSE_COMPLETE)

        # Create process manager
        self.process_manager = ProcessManager(
            event_bus=self.event_bus,
            check_interval=config.runtime.health_check_interval_s
        )

        # Main process services (Audio + STT only)
        self.audio_service = self._create_audio_service()
        self.stt_service = self._create_stt_service()
        self.linter = self._create_linter()

        # Audio hardware components
        self.device_manager = AudioDeviceManager(self._create_device_audio_config())
        self.audio_queue = Queue()

        # Worker threads (main process only)
        self.audio_capture_thread: Optional[threading.Thread] = None
        self.audio_process_thread: Optional[threading.Thread] = None
        self.response_monitor_thread: Optional[threading.Thread] = None
        self.headless_input_thread: Optional[threading.Thread] = None

        # Request counter
        self._request_count = 0

        self.logger.info("MultiProcessVoiceApp initialized")

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
            vad_filter=self.config.stt.vad_filter,
            filter_hallucinations=getattr(self.config.stt, 'filter_hallucinations', True)
        )

        return STTService(
            config=stt_config,
            logger=self.logger.getChild("stt")
        )

    def _create_device_audio_config(self) -> DeviceAudioConfig:
        """Create audio config for device manager"""
        return DeviceAudioConfig(self.config.audio.to_dict())

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
                    # Skip audio capture when TTS is speaking
                    if self.tts_speaking_event.is_set():
                        time.sleep(0.1)
                        continue

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
        """Audio processing loop - VAD, speech detection, STT, and submission"""
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
                audio_result = self.audio_service.process_frame(audio_chunk)

                if audio_result:
                    # OPTIMIZATION: Immediate pre-acknowledgment on silence detection
                    # User just stopped speaking - acknowledge IMMEDIATELY before STT completes
                    # This gives instant feedback (~50-100ms) while STT processes in background
                    self._request_count += 1
                    request_id = f"req_{self._request_count}_{self._generate_request_id()[:8]}"

                    # Publish instant acknowledgment (before transcription)
                    # self.event_bus.publish(TTSRequestedEvent(
                    #     request_id=request_id,
                    #     text="Got it.",  # Ultra-short for speed
                    #     priority=0,
                    #     response_type="pre_acknowledgment"
                    # ))

                    # NOW transcribe (user already heard "Got it")
                    stt_result = self.stt_service.transcribe(audio_result)

                    if stt_result and stt_result.text:
                        self.logger.info(f"Transcribed: {stt_result.text}")

                        # Lint and validate
                        lint_result = self.linter.lint_and_validate(
                            stt_result.text,
                            min_words=self.config.linter.min_words
                        )

                        if not lint_result.is_valid:
                            self.logger.debug(f"Invalid input rejected: {stt_result.text[:50]}")
                            continue

                        # request_id already created above for pre-ack
                        self.logger.info(f"[{request_id}] Transcription complete: {lint_result.cleaned}")

                        self.event_bus.publish(TranscriptionCompleteEvent(
                            request_id=request_id,
                            text=lint_result.cleaned,
                            confidence=stt_result.confidence if hasattr(stt_result, 'confidence') else None,
                            duration_ms=0.0
                        ))

            except Empty:
                continue
            except Exception as e:
                self.logger.error(f"Audio processing error: {e}", exc_info=True)

        self.logger.info("Audio processing loop stopped")

    def _response_monitor_loop(self):
        """Monitor for Agent responses and log them"""
        from communication.events import AgentResponseCompleteEvent

        self.logger.info("Response monitor started")

        while self.running:
            try:
                event = self.response_mailbox.receive(timeout=0.5)
                if event and isinstance(event, AgentResponseCompleteEvent):
                    self.logger.info(
                        f"[{event.request_id}] Response in {event.duration_ms:.0f}ms: "
                        f"{event.spoken_response[:100]}"
                    )

                    if event.tools_used:
                        self.logger.info(f"[{event.request_id}] Tools used: {', '.join(event.tools_used)}")

            except Exception as e:
                self.logger.error(f"Response monitor error: {e}")

        self.logger.info("Response monitor stopped")

    def _headless_stdin_loop(self):
        """Read text lines from stdin and publish TranscriptionCompleteEvent."""
        self.logger.info("Headless input loop started (stdin)")

        try:
            if sys.stdin is None or sys.stdin.closed:
                self.logger.info("No stdin available; headless input disabled")
                return

            for line in sys.stdin:
                if not self.running:
                    break

                text = (line or "").strip()
                if not text:
                    continue

                if text in {"/quit", "/exit"}:
                    self.logger.info("Received headless exit command")
                    self.running = False
                    self.event_bus.shutdown()
                    self.process_manager.stop()
                    break

                self._request_count += 1
                request_id = f"headless_{self._request_count}_{self._generate_request_id()[:8]}"
                self.logger.info(f"[{request_id}] Headless input: {text}")

                self.event_bus.publish(TranscriptionCompleteEvent(
                    request_id=request_id,
                    text=text,
                    confidence=None,
                    duration_ms=0.0
                ))
        except Exception as e:
            self.logger.error(f"Headless input loop error: {e}", exc_info=True)
        finally:
            self.logger.info("Headless input loop stopped")

    def start(self) -> bool:
        """Start the multi-process application"""
        self.logger.info("Starting MultiProcessVoiceApp (MULTIPROCESS)...")
        self.running = True

        # Headless mode: skip microphone/STT and accept text via stdin.
        if getattr(self.config.runtime, "headless", False):
            from communication.events import EventType
            from workers.console_tts_worker import ConsoleTTSWorker
            from workers.service_rep_worker import ServiceRepWorker
            from util.config import ServiceRepConfig

            self.process_manager.register_worker(
                worker_id="tts",
                worker_class=ConsoleTTSWorker,
                subscribe_to=[EventType.TTS_REQUESTED],
                worker_kwargs={}
            )

            service_rep_config = ServiceRepConfig(
                enabled=True,
                llm_config=None
            )
            self.process_manager.register_worker(
                worker_id="service_rep",
                worker_class=ServiceRepWorker,
                subscribe_to=[EventType.TRANSCRIPTION_COMPLETE],
                worker_kwargs={
                    "event_bus": self.event_bus,
                    "service_rep_config": service_rep_config,
                    "harness_config_path": self.config.harness.config_path
                }
            )

            self.logger.info("Starting worker processes (headless)...")
            self.process_manager.start()
            time.sleep(1.0)

            self.headless_input_thread = threading.Thread(
                target=self._headless_stdin_loop,
                daemon=True,
                name="HeadlessInput"
            )
            self.headless_input_thread.start()

            self.logger.info("MultiProcessVoiceApp started in headless mode")
            self.logger.info("Type a request and press Enter (use /exit to quit)")
            return True

        # Find audio device
        device_index = self.device_manager.wait_for_input_device()
        if device_index is None:
            self.logger.error("No audio input device found")
            return False

        self.logger.info(f"Using audio device index: {device_index}")

        # Register TTS worker
        from communication.events import EventType
        from harness import TTSWorker
        from workers.service_rep_worker import ServiceRepWorker

        voice_config = {
            "engine": "pyttsx3",
            "rate": 180,
            "volume": 0.8
        }

        self.process_manager.register_worker(
            worker_id="tts",
            worker_class=TTSWorker,
            subscribe_to=[EventType.TTS_REQUESTED],
            worker_kwargs={
                "voice_config": voice_config,
                "cancel_event": self.cancel_event,
                "speaking_event": self.tts_speaking_event,
            }
        )

        # Register ServiceRep worker (contains AgentHarness)
        # ServiceRep receives transcriptions, calls harness directly, publishes TTS
        from util.config import ServiceRepConfig

        service_rep_config = ServiceRepConfig(
            enabled=True,
            llm_config=None  # Will use defaults
        )

        self.process_manager.register_worker(
            worker_id="service_rep",
            worker_class=ServiceRepWorker,
            subscribe_to=[EventType.TRANSCRIPTION_COMPLETE],
            worker_kwargs={
                "event_bus": self.event_bus,
                "service_rep_config": service_rep_config,
                "harness_config_path": self.config.harness.config_path
            }
        )

        # Start worker processes
        self.logger.info("Starting worker processes...")
        self.process_manager.start()

        # Give workers time to initialize
        time.sleep(1.0)

        # Initialize STT in main process
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

        # Start response monitor thread
        self.response_monitor_thread = threading.Thread(
            target=self._response_monitor_loop,
            daemon=True,
            name="ResponseMonitor"
        )
        self.response_monitor_thread.start()

        self.logger.info("MultiProcessVoiceApp started successfully")
        self.logger.info("Speak to interact with the AI agent...")

        return True

    def stop(self):
        """Stop the application"""
        self.logger.info("Stopping MultiProcessVoiceApp...")
        self.running = False

        # Shutdown EventBus
        self.event_bus.shutdown()

        # Stop worker processes
        self.process_manager.stop()

        # Wait for threads
        if self.audio_capture_thread and self.audio_capture_thread.is_alive():
            self.audio_capture_thread.join(timeout=2.0)

        if self.audio_process_thread and self.audio_process_thread.is_alive():
            self.audio_process_thread.join(timeout=2.0)

        if self.response_monitor_thread and self.response_monitor_thread.is_alive():
            self.response_monitor_thread.join(timeout=2.0)

        if self.headless_input_thread and self.headless_input_thread.is_alive():
            if threading.current_thread() is not self.headless_input_thread:
                self.headless_input_thread.join(timeout=2.0)

        self.logger.info("MultiProcessVoiceApp stopped")
