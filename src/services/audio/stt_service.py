"""
STT Service - Pure speech-to-text transcription with no domain coupling.

Responsibilities:
- Audio transcription using Whisper or Google STT
- Direct PCM-to-text conversion

Does NOT know about:
- AgentHarness
- EventBus
- Application orchestration
"""

import time
import logging
import numpy as np
from dataclasses import dataclass
from typing import Optional
from .audio_service import AudioChunk


@dataclass
class STTConfig:
    """STT service configuration"""
    engine: str = "whisper"  # "whisper" or "google"
    model_size: str = "base.en"  # For Whisper: tiny.en, base.en, small.en, medium.en
    device: str = "auto"  # auto, cpu, cuda, mps
    compute_type: str = "auto"  # auto or specific type
    beam_size: int = 1
    vad_filter: bool = True


@dataclass
class TranscriptionResult:
    """Result of transcription"""
    text: str
    duration_ms: float
    confidence: Optional[float] = None
    language: Optional[str] = None


class STTService:
    """
    Pure STT service with no domain coupling.

    Responsibilities:
    - Transcribe audio to text
    - Handle multiple STT engines (Whisper, Google)

    Dependencies injected:
    - Config
    - Logger
    """

    def __init__(self, config: STTConfig, logger: logging.Logger):
        """
        Initialize STT service with injected dependencies.

        Args:
            config: STT configuration
            logger: Injected logger instance
        """
        self.config = config
        self.logger = logger
        self._engine = None
        self._initialized = False

    def initialize(self) -> bool:
        """
        Initialize the STT engine.

        Returns:
            True if successful, False otherwise
        """
        if self._initialized:
            return True

        try:
            if self.config.engine == "whisper":
                self._engine = self._initialize_whisper()
            elif self.config.engine == "google":
                self._engine = self._initialize_google()
            else:
                self.logger.error(f"Unknown STT engine: {self.config.engine}")
                return False

            self._initialized = True
            self.logger.info(f"STT engine initialized: {self.config.engine}")
            return True

        except Exception as e:
            self.logger.error(f"Failed to initialize STT engine: {e}")
            return False

    def _initialize_whisper(self):
        """Initialize Whisper STT engine"""
        from faster_whisper import WhisperModel

        self.logger.info(f"Loading Whisper model: {self.config.model_size}")
        start = time.time()

        # Resolve device and compute type
        resolved_device = self._detect_backend()
        resolved_compute_type = self._select_compute_type(resolved_device)

        model = WhisperModel(
            self.config.model_size,
            device=resolved_device,
            compute_type=resolved_compute_type
        )

        load_time = (time.time() - start) * 1000
        self.logger.info(
            f"Whisper model loaded in {load_time:.0f}ms "
            f"(device={resolved_device}, compute_type={resolved_compute_type})"
        )

        return model

    def _initialize_google(self):
        """Initialize Google STT engine"""
        import speech_recognition as sr
        recognizer = sr.Recognizer()
        self.logger.info("Google STT initialized")
        return recognizer

    def transcribe(self, audio: AudioChunk) -> Optional[TranscriptionResult]:
        """
        Transcribe audio chunk to text.

        Args:
            audio: AudioChunk to transcribe

        Returns:
            TranscriptionResult if successful, None otherwise
        """
        if not self._initialized:
            if not self.initialize():
                return None

        if self.config.engine == "whisper":
            return self._transcribe_whisper(audio)
        elif self.config.engine == "google":
            return self._transcribe_google(audio)
        else:
            self.logger.error(f"Unknown STT engine: {self.config.engine}")
            return None

    def _transcribe_whisper(self, audio: AudioChunk) -> Optional[TranscriptionResult]:
        """Transcribe using Whisper"""
        try:
            # Convert PCM bytes to float32 numpy array
            audio_np = np.frombuffer(audio.data, dtype=np.int16).astype(np.float32) / 32768.0

            if audio_np.size == 0:
                self.logger.debug("Received empty audio chunk, skipping transcription")
                return None

            # Skip near-silent chunks
            rms = np.sqrt(np.mean(audio_np ** 2))
            if rms < 1e-4:
                self.logger.debug("Skipping near-silent audio chunk (rms=%0.6f)", rms)
                return None

            # Resample to 16kHz if needed (Whisper expects 16kHz)
            if audio.sample_rate != 16000:
                from scipy import signal
                num_samples = max(1, int(len(audio_np) * 16000 / audio.sample_rate))
                audio_np = signal.resample(audio_np, num_samples)

            # Ensure no NaNs/Infs
            if not np.isfinite(audio_np).all():
                self.logger.warning("Non-finite samples detected post-resample, sanitizing chunk")
                audio_np = np.nan_to_num(audio_np, nan=0.0, posinf=0.0, neginf=0.0)

            if audio_np.size == 0:
                self.logger.debug("Audio chunk collapsed after resample, skipping transcription")
                return None

            # Transcribe
            start = time.time()
            segments, info = self._engine.transcribe(
                audio_np,
                beam_size=self.config.beam_size,
                vad_filter=self.config.vad_filter,
                vad_parameters=dict(
                    min_silence_duration_ms=200,
                )
            )

            # Collect all segments
            text_parts = []
            for segment in segments:
                text_parts.append(segment.text.strip())

            text = " ".join(text_parts).strip()
            duration = (time.time() - start) * 1000

            if text:
                self.logger.debug(f"Whisper transcribed in {duration:.0f}ms: {text[:50]}...")
                return TranscriptionResult(
                    text=text,
                    duration_ms=duration,
                    language=info.language if hasattr(info, 'language') else None
                )

            return None

        except Exception as e:
            self.logger.error(f"Whisper transcription error: {e}")
            return None

    def _transcribe_google(self, audio: AudioChunk) -> Optional[TranscriptionResult]:
        """Transcribe using Google STT"""
        try:
            import speech_recognition as sr
            from pydub import AudioSegment

            # Convert to WAV (required for Google)
            audio_segment = AudioSegment(
                data=audio.data,
                sample_width=2,
                frame_rate=audio.sample_rate,
                channels=1
            )
            wav_data = audio_segment.export(format="wav").read()
            audio_data_obj = sr.AudioData(wav_data, audio.sample_rate, 2)

            start = time.time()
            text = self._engine.recognize_google(audio_data_obj)
            duration = (time.time() - start) * 1000

            if text:
                self.logger.debug(f"Google STT transcribed in {duration:.0f}ms: {text[:50]}...")
                return TranscriptionResult(
                    text=text,
                    duration_ms=duration
                )

            return None

        except sr.UnknownValueError:
            self.logger.debug("Google STT could not understand audio")
            return None
        except sr.RequestError as e:
            self.logger.error(f"Google STT service error: {e}")
            return None
        except Exception as e:
            self.logger.error(f"Google STT error: {e}")
            return None

    def _detect_backend(self) -> str:
        """Infer which device backend we should target"""
        if self.config.device != "auto":
            return self.config.device

        # Try to detect CUDA
        try:
            import ctranslate2
            if hasattr(ctranslate2, "get_cuda_device_count"):
                if ctranslate2.get_cuda_device_count() > 0:
                    return "cuda"
        except Exception:
            pass

        # Try to detect via torch
        try:
            import torch
            if hasattr(torch, "cuda") and torch.cuda.is_available():
                return "cuda"
            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                return "mps"
        except Exception:
            pass

        return "cpu"

    def _select_compute_type(self, backend: str) -> str:
        """Pick the best compute_type supported by the backend"""
        if self.config.compute_type not in ("auto", None):
            return self.config.compute_type

        preferred_order = {
            "cuda": ["float16", "int8_float16", "int8"],
            "mps": ["float16", "int8_float16"],
            "cpu": ["int8_float32", "int8", "float32"]
        }

        target = "cuda" if backend in ("cuda", "mps") else "cpu"
        supported = None

        try:
            import ctranslate2
            supported = ctranslate2.get_supported_compute_types(target)
        except Exception:
            supported = None

        for option in preferred_order.get(backend, preferred_order["cpu"]):
            if not supported or option in supported:
                return option

        return "int8" if target == "cpu" else "float16"
