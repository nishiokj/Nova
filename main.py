#!/usr/bin/env python3
"""
Main Entry Point - Voice-Activated AI Agent System (OPTIMIZED v2)

Architecture v2 - Multiprocess:
- Main Process: Audio capture, Whisper STT, request routing
- Agent Process: LLM reasoning, tool execution (no GIL contention)
- TTS Process: Speech synthesis (no GIL contention)

Communication via EventBus with multiprocessing.Queue

Performance optimizations:
- Local Whisper STT (faster-whisper) instead of Google API
- Multiprocessing for Agent and TTS (bypass GIL)
- Direct PCM-to-Whisper without WAV conversion
- Blocking queue.get() instead of poll+sleep
- Cached linting results
- Backpressure handling (latest request wins)

Target: 4s round-trip for tool-using queries
"""

import os
import sys
import re
import math
import time
import signal
import atexit
import logging
import argparse
import threading
import uuid
import numpy as np
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from typing import Optional, Callable, Tuple, Union
from queue import Queue, Empty
from dataclasses import dataclass

# Local imports
from audio import AudioConfig, AudioDeviceManager, MainProcessor

# Harness imports (v1 - single process, kept for compatibility)
from harness import (
    AgentHarness,
    HarnessConfig,
    RuntimeConfig,
    HarnessResponse,
    HarnessState,
    create_harness,
    load_or_create_config,
    StructuredLogger,
    get_logger,
    set_logger
)

# Harness imports (v2 - multiprocess)
from harness import (
    EventBus,
    ProcessManager,
    AgentRequest,
    AgentResult,
    TTSRequest,
    create_tts_worker,
    create_agent_worker
)


# =============================================================================
# LIGHTWEIGHT RUNTIME PROFILER
# =============================================================================


@dataclass
class _Metric:
    """Aggregation container for a single metric"""
    count: int = 0
    total_ms: float = 0.0
    min_ms: float = float("inf")
    max_ms: float = 0.0
    samples: deque = None

    def __post_init__(self):
        if self.samples is None:
            self.samples = deque(maxlen=500)

    def add(self, duration_ms: float):
        self.count += 1
        self.total_ms += duration_ms
        self.min_ms = min(self.min_ms, duration_ms)
        self.max_ms = max(self.max_ms, duration_ms)
        self.samples.append(duration_ms)

    def avg(self) -> float:
        return self.total_ms / self.count if self.count else 0.0

    def percentile(self, pct: float) -> float:
        if not self.samples:
            return 0.0
        ordered = sorted(self.samples)
        rank = (pct / 100.0) * (len(ordered) - 1)
        low = int(math.floor(rank))
        high = int(math.ceil(rank))
        if low == high:
            return ordered[low]
        frac = rank - low
        return ordered[low] + (ordered[high] - ordered[low]) * frac


class RuntimeProfiler:
    """
    Thread-safe runtime profiler that aggregates durations and emits a summary
    at shutdown. Intended to stay lightweight and always-on.
    """

    def __init__(self):
        self._metrics = {}
        self._lock = threading.Lock()
        self._start = time.perf_counter()
        self._reported = False
        atexit.register(self._auto_report)

    def measure(self, name: str):
        """Context manager for timing blocks"""
        profiler = self

        class _Timer:
            def __enter__(self_inner):
                self_inner.start = time.perf_counter()
                return self_inner

            def __exit__(self_inner, exc_type, exc_val, exc_tb):
                duration_ms = (time.perf_counter() - self_inner.start) * 1000
                profiler.record(name, duration_ms)

        return _Timer()

    def record(self, name: str, duration_ms: float):
        """Record a duration sample"""
        with self._lock:
            metric = self._metrics.get(name)
            if metric is None:
                metric = _Metric()
                self._metrics[name] = metric
            metric.add(duration_ms)

    def _auto_report(self):
        """Emit report automatically at interpreter shutdown"""
        self.report_summary()

    def report_summary(self, logger: Optional[logging.Logger] = None):
        """Print a consolidated performance summary (idempotent)"""
        with self._lock:
            if self._reported:
                return
            self._reported = True

            runtime_s = time.perf_counter() - self._start
            metrics = list(self._metrics.items())

        lines = []
        header = (
            f"\n=== Performance Profile "
            f"(runtime: {runtime_s:.1f}s, samples: {sum(m.count for _, m in metrics)}) ==="
        )
        lines.append(header)

        if not metrics:
            lines.append("No profiling samples collected.")
        else:
            metrics.sort(key=lambda kv: kv[1].avg(), reverse=True)
            lines.append(f"{'metric':30} count   avg_ms   p95_ms   max_ms")
            lines.append("-" * 65)
            for name, metric in metrics:
                lines.append(
                    f"{name:30} {metric.count:5d} "
                    f"{metric.avg():8.1f} {metric.percentile(95):8.1f} {metric.max_ms:8.1f}"
                )

        report = "\n".join(lines)
        print(report)
        (logger or logging.getLogger(__name__)).info(report)


# Global profiler instance shared by components
PROFILER = RuntimeProfiler()


# =============================================================================
# LOCAL WHISPER STT - Replaces Google API (~50-150ms vs 500-1500ms)
# =============================================================================

class LocalWhisperSTT:
    """
    Local speech-to-text using faster-whisper.
    Much faster than Google API with comparable accuracy.
    """

    def __init__(
        self,
        model_size: str = "base.en",  # Options: tiny.en, base.en, small.en, medium.en
        device: str = "auto",          # auto, cpu, cuda
        compute_type: Optional[str] = None  # auto-select when None/default
    ):
        self.logger = logging.getLogger(__name__)
        self.model = None
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type or "auto"
        if self.compute_type == "default":
            self.compute_type = "auto"
        self._initialized = False
        self._resolved_device = None
        self._resolved_compute_type = None

    def _probe_module(self, module_name: str):
        """Try to import a module without raising import errors"""
        try:
            return __import__(module_name)
        except Exception:
            return None

    def _detect_backend(self) -> str:
        """Infer which device backend we should target"""
        if self.device != "auto":
            return self.device

        # Prefer CUDA if any GPU is visible
        try:
            import ctranslate2

            if hasattr(ctranslate2, "get_cuda_device_count"):
                if ctranslate2.get_cuda_device_count() > 0:
                    return "cuda"
        except Exception:
            pass

        torch = self._probe_module("torch")
        if torch is not None:
            try:
                if hasattr(torch, "cuda") and torch.cuda.is_available():
                    return "cuda"
            except Exception:
                pass

            try:
                if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                    return "mps"
            except Exception:
                pass

        # Metal backend without torch detection (common on Apple Silicon)
        if sys.platform == "darwin" and os.environ.get("WHISPER_FORCE_MPS") == "1":
            return "mps"

        return "cpu"

    def _select_compute_type(self, backend: str) -> str:
        """Pick the best compute_type supported by the backend"""
        if self.compute_type not in ("auto", None):
            return self.compute_type

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

        # Final fallback if nothing matched
        return "int8" if target == "cpu" else "float16"

    def _resolve_runtime_options(self) -> Tuple[str, str]:
        """Determine the device + compute type that will actually be used"""
        backend = self._detect_backend()
        compute_type = self._select_compute_type(backend)

        self.logger.info(
            "Whisper backend resolved to %s with compute_type=%s",
            backend,
            compute_type
        )
        return backend, compute_type

    def initialize(self) -> bool:
        """Initialize Whisper model (call once at startup)"""
        try:
            from faster_whisper import WhisperModel

            self.logger.info(f"Loading Whisper model: {self.model_size}")
            start = time.time()

            resolved_device, resolved_compute_type = self._resolve_runtime_options()

            self.model = WhisperModel(
                self.model_size,
                device=resolved_device,
                compute_type=resolved_compute_type
            )

            load_time = (time.time() - start) * 1000
            self.logger.info(f"Whisper model loaded in {load_time:.0f}ms")
            self._initialized = True
            # Store resolved configuration for reference
            self._resolved_device = resolved_device
            self._resolved_compute_type = resolved_compute_type
            return True

        except ImportError:
            self.logger.error("faster-whisper not installed. Run: pip install faster-whisper")
            return False
        except Exception as e:
            self.logger.error(f"Failed to load Whisper model: {e}")
            return False

    def transcribe_pcm(
        self,
        audio_data: bytes,
        sample_rate: int = 16000
    ) -> Optional[str]:
        """
        Transcribe PCM audio data directly (no WAV conversion).

        Args:
            audio_data: Raw PCM bytes (int16)
            sample_rate: Sample rate of the audio

        Returns:
            Transcribed text or None
        """
        if not self._initialized:
            if not self.initialize():
                return None

        try:
            # Convert PCM bytes to float32 numpy array (Whisper's expected format)
            audio_np = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0

            if audio_np.size == 0:
                self.logger.debug("Received empty audio chunk, skipping transcription")
                return None

            # Skip near-silent chunks (typically feedback/TTS bleed)
            rms = np.sqrt(np.mean(audio_np ** 2))
            if rms < 1e-4:
                self.logger.debug("Skipping near-silent audio chunk (rms=%0.6f)", rms)
                return None

            # Resample to 16kHz if needed (Whisper expects 16kHz)
            if sample_rate != 16000:
                from scipy import signal
                num_samples = max(1, int(len(audio_np) * 16000 / sample_rate))
                audio_np = signal.resample(audio_np, num_samples)

            # Ensure we never feed NaNs/Infs to Whisper (occurs if resample produced them)
            if not np.isfinite(audio_np).all():
                self.logger.warning("Non-finite samples detected post-resample, sanitizing chunk")
                audio_np = np.nan_to_num(audio_np, nan=0.0, posinf=0.0, neginf=0.0)

            if audio_np.size == 0:
                self.logger.debug("Audio chunk collapsed after resample, skipping transcription")
                return None

            # Transcribe
            start = time.time()
            segments, info = self.model.transcribe(
                audio_np,
                beam_size=1,           # Faster with beam_size=1
                vad_filter=True,       # Filter out non-speech
                vad_parameters=dict(
                    min_silence_duration_ms=200,  # Faster endpoint detection
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

            return text if text else None

        except Exception as e:
            self.logger.error(f"Whisper transcription error: {e}")
            return None


# =============================================================================
# FALLBACK GOOGLE STT (if faster-whisper not available)
# =============================================================================

class GoogleSTT:
    """Fallback to Google Speech Recognition if Whisper unavailable"""

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.recognizer = None
        self._initialized = False

    def initialize(self) -> bool:
        try:
            import speech_recognition as sr
            self.recognizer = sr.Recognizer()
            self._initialized = True
            return True
        except ImportError:
            self.logger.error("speech_recognition not installed")
            return False

    def transcribe_pcm(self, audio_data: bytes, sample_rate: int = 16000) -> Optional[str]:
        if not self._initialized:
            if not self.initialize():
                return None

        try:
            import speech_recognition as sr
            from pydub import AudioSegment

            # Convert to WAV (required for Google)
            audio_segment = AudioSegment(
                data=audio_data,
                sample_width=2,
                frame_rate=sample_rate,
                channels=1
            )
            wav_data = audio_segment.export(format="wav").read()
            audio_data_obj = sr.AudioData(wav_data, sample_rate, 2)

            text = self.recognizer.recognize_google(audio_data_obj)
            return text
        except Exception as e:
            self.logger.debug(f"Google STT error: {e}")
            return None


# =============================================================================
# OPTIMIZED TEXT LINTER - Module-level imports, cached results
# =============================================================================

# Pre-compiled regex patterns (module level, not per-call)
_FILLER_PATTERNS = [
    re.compile(r'\b' + word + r'\b', re.IGNORECASE)
    for word in ['um', 'uh', 'ah', 'er', 'hmm', 'hm', 'like', 'you know', 'i mean', 'so yeah', 'basically']
]

_CORRECTION_PATTERNS = {
    re.compile(r'\bgonna\b', re.IGNORECASE): 'going to',
    re.compile(r'\bwanna\b', re.IGNORECASE): 'want to',
    re.compile(r'\bgotta\b', re.IGNORECASE): 'got to',
    re.compile(r'\bkinda\b', re.IGNORECASE): 'kind of',
    re.compile(r'\bsorta\b', re.IGNORECASE): 'sort of',
    re.compile(r'\blemme\b', re.IGNORECASE): 'let me',
    re.compile(r'\bgimme\b', re.IGNORECASE): 'give me',
}


@dataclass
class LintResult:
    """Cached lint result to avoid duplicate processing"""
    original: str
    cleaned: str
    is_valid: bool


class TextLinter:
    """
    Cleans and lints transcribed speech text before processing.
    OPTIMIZED: Pre-compiled patterns, cached results.
    """

    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self._cache: dict = {}  # LRU-style cache
        self._cache_max = 100

    def lint(self, text: str) -> str:
        """
        Clean and normalize transcribed text.
        Returns cached result if available.
        """
        if not text:
            return ""

        # Check cache
        if text in self._cache:
            return self._cache[text].cleaned

        cleaned = text.strip()

        # Remove repeated words (common STT artifact)
        words = cleaned.split()
        deduplicated = []
        for i, word in enumerate(words):
            if i == 0 or word.lower() != words[i-1].lower():
                deduplicated.append(word)
        cleaned = ' '.join(deduplicated)

        # Remove filler words using pre-compiled patterns
        for pattern in _FILLER_PATTERNS:
            cleaned = pattern.sub('', cleaned)

        # Apply corrections using pre-compiled patterns
        for pattern, replacement in _CORRECTION_PATTERNS.items():
            cleaned = pattern.sub(replacement, cleaned)

        # Clean up extra whitespace
        cleaned = ' '.join(cleaned.split())

        # Ensure proper sentence ending
        if cleaned and cleaned[-1] not in '.?!':
            cleaned += '.'

        result = cleaned.strip()

        # Cache result
        self._cache_result(text, result)

        return result

    def lint_and_validate(self, text: str) -> LintResult:
        """
        Lint AND validate in one call (avoids duplicate linting).
        """
        if not text:
            return LintResult(text, "", False)

        # Check cache
        if text in self._cache:
            return self._cache[text]

        cleaned = self.lint(text)
        is_valid = self._check_validity(cleaned)

        result = LintResult(text, cleaned, is_valid)
        self._cache_result(text, cleaned, is_valid)

        return result

    def _check_validity(self, cleaned: str) -> bool:
        """Check if cleaned text is valid for processing"""
        if not cleaned:
            return False

        words = cleaned.replace('.', '').replace('?', '').replace('!', '').split()

        # Must have at least 2 meaningful words
        return len(words) >= 2

    def _cache_result(self, original: str, cleaned: str, is_valid: bool = True):
        """Cache lint result with LRU eviction"""
        if len(self._cache) >= self._cache_max:
            # Remove oldest entry
            oldest = next(iter(self._cache))
            del self._cache[oldest]

        self._cache[original] = LintResult(original, cleaned, is_valid)

    def is_valid_input(self, text: str) -> bool:
        """Check validity (uses cache)"""
        result = self.lint_and_validate(text)
        return result.is_valid


# =============================================================================
# OPTIMIZED SPEECH-TEXT BRIDGE - Non-blocking, efficient
# =============================================================================

class SpeechTextBridge:
    """
    Bridge between audio transcription and agent harness.
    OPTIMIZED: Non-blocking TTS, efficient processing.
    Includes TTS feedback loop prevention.
    """

    def __init__(
        self,
        harness: AgentHarness,
        text_linter: TextLinter,
        on_response: Optional[Callable[[HarnessResponse], None]] = None,
        profiler: RuntimeProfiler = None
    ):
        self.harness = harness
        self.linter = text_linter
        self.on_response = on_response
        self.logger = get_logger()
        self.profiler = profiler or PROFILER

        # Processing state
        self._processing = False
        self._last_response_time = 0
        self._min_response_interval = 0.5  # Reduced from 1.0s
        self._state_started_at = None
        self._current_state: Optional[HarnessState] = None

        # TTS feedback prevention - track recent TTS output
        self._recent_tts: deque = deque(maxlen=10)  # Last 10 TTS phrases
        self._tts_feedback_window = 8.0  # Ignore similar input for 8 seconds after TTS

        # Register harness callbacks
        self.harness.add_response_callback(self._on_harness_response)
        self.harness.add_state_callback(self._on_harness_state)

        # Hook into ServiceRep to track TTS output
        self._register_tts_tracking()

    def _register_tts_tracking(self):
        """Register callback to track TTS output for feedback prevention"""
        try:
            # Add callback to ServiceRep's response callbacks
            from harness.service_rep import SpokenResponse
            self.harness.service_rep.add_response_callback(self._on_tts_output)
            self.logger.debug("TTS tracking registered", component="bridge")
        except Exception as e:
            self.logger.warning(f"Could not register TTS tracking: {e}", component="bridge")

    def _on_tts_output(self, response):
        """Track TTS output to prevent feedback loops"""
        if response and response.text:
            # Store normalized text with timestamp
            normalized = self._normalize_for_comparison(response.text)
            self._recent_tts.append((time.time(), normalized))

    def _normalize_for_comparison(self, text: str) -> str:
        """Normalize text for fuzzy comparison"""
        # Lowercase, remove punctuation, collapse whitespace
        text = text.lower()
        text = re.sub(r'[^\w\s]', '', text)
        text = ' '.join(text.split())
        return text

    def _is_tts_feedback(self, text: str) -> bool:
        """Check if transcription matches recent TTS output (feedback loop)"""
        if not text:
            return False

        normalized = self._normalize_for_comparison(text)
        current_time = time.time()

        for tts_time, tts_text in self._recent_tts:
            # Only check within feedback window
            if current_time - tts_time > self._tts_feedback_window:
                continue

            # Check for significant overlap (fuzzy match)
            # If input contains most of TTS output or vice versa, it's feedback
            if len(normalized) < 3 or len(tts_text) < 3:
                continue

            # Check substring match
            if normalized in tts_text or tts_text in normalized:
                return True

            # Check word overlap (more than 60% of words match)
            input_words = set(normalized.split())
            tts_words = set(tts_text.split())

            if len(input_words) > 0 and len(tts_words) > 0:
                overlap = len(input_words & tts_words)
                min_len = min(len(input_words), len(tts_words))
                if min_len > 0 and overlap / min_len > 0.6:
                    return True

        return False

    def process_transcription(self, text: str) -> Optional[HarnessResponse]:
        """
        Process transcribed speech text through the harness.
        OPTIMIZED: Uses lint_and_validate to avoid duplicate work.
        Includes TTS feedback loop prevention.
        """
        # Check rate limiting
        current_time = time.time()
        if current_time - self._last_response_time < self._min_response_interval:
            self.logger.debug("Rate limited, skipping input", component="bridge")
            return None

        # Check for TTS feedback loop BEFORE linting (fast rejection)
        if self._is_tts_feedback(text):
            self.logger.debug(f"TTS feedback rejected: {text[:50]}", component="bridge")
            return None

        # Lint AND validate in one call
        with (self.profiler.measure("bridge.lint_validate_ms") if self.profiler else nullcontext()):
            lint_result = self.linter.lint_and_validate(text)

        if not lint_result.is_valid:
            self.logger.debug(f"Invalid input rejected: {text[:50]}", component="bridge")
            return None

        self.logger.info(f"Processing: {lint_result.cleaned}", component="bridge")

        # Process through harness
        self._processing = True
        try:
            with (self.profiler.measure("harness.process_ms") if self.profiler else nullcontext()):
                response = self.harness.process(lint_result.cleaned)
            self._last_response_time = time.time()
            return response
        finally:
            self._processing = False

    def process_transcription_async(self, text: str):
        """Submit transcription for async processing"""
        lint_result = self.linter.lint_and_validate(text)

        if not lint_result.is_valid:
            return

        self.harness.submit_request(lint_result.cleaned, callback=self.on_response)

    def _on_harness_response(self, response: HarnessResponse):
        """Internal callback for harness responses"""
        self.logger.info(
            f"Response generated in {response.duration_ms:.0f}ms",
            component="bridge"
        )
        if self.profiler:
            self.profiler.record("harness.reported_duration_ms", response.duration_ms)

        if self.on_response:
            self.on_response(response)

    def _on_harness_state(self, state: HarnessState):
        """Internal callback for harness state changes"""
        if self.profiler:
            now = time.perf_counter()
            if self._current_state is not None and self._state_started_at is not None:
                elapsed_ms = (now - self._state_started_at) * 1000
                metric_name = f"harness.state.{self._current_state.value}_ms"
                self.profiler.record(metric_name, elapsed_ms)
            self._current_state = state
            self._state_started_at = now

        self.logger.debug(f"Harness state: {state.value}", component="bridge")

    @property
    def is_processing(self) -> bool:
        return self._processing


# =============================================================================
# OPTIMIZED AUDIO PROCESSOR - Threading, blocking queue, direct Whisper
# =============================================================================

class OptimizedAudioProcessor:
    """
    Integrated audio processor with all optimizations.
    - Uses threading.Queue instead of multiprocessing.Queue
    - Blocking queue.get() instead of poll+sleep
    - Direct PCM to Whisper (no WAV conversion)
    - Local Whisper STT
    """

    def __init__(
        self,
        audio_queue: Queue,  # threading.Queue, not multiprocessing
        audio_config: AudioConfig,
        bridge: SpeechTextBridge,
        whisper_model: str = "base.en",
        use_whisper: bool = True,
        profiler: RuntimeProfiler = None
    ):
        self.audio_queue = audio_queue
        self.config = audio_config
        self.bridge = bridge
        self.logger = logging.getLogger(__name__)
        self.running = False
        self.profiler = profiler or PROFILER
        self._tts_holdoff_s = 0.35
        self._last_tts_activity = 0.0
        self._harness_executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="harness-worker"
        )

        # Choose STT engine
        if use_whisper:
            self.stt = LocalWhisperSTT(model_size=whisper_model)
        else:
            self.stt = GoogleSTT()

    def _should_skip_for_tts(self) -> bool:
        """Skip STT when TTS is speaking or has just finished"""
        harness = getattr(self.bridge, "harness", None)
        now = time.time()

        if harness:
            service_rep = getattr(harness, "service_rep", None)
            if service_rep and getattr(service_rep, "enabled", False):
                try:
                    if service_rep.is_speaking:
                        self._last_tts_activity = now
                        return True
                except Exception:
                    pass

        if self._last_tts_activity and (now - self._last_tts_activity) < self._tts_holdoff_s:
            return True

        return False

    def _submit_transcription(self, transcript: str, receive_time: float):
        """Send transcription to harness on a background worker"""
        if not transcript or not self._harness_executor:
            return
        self._harness_executor.submit(self._process_transcription_task, transcript, receive_time)

    def _process_transcription_task(self, transcript: str, receive_time: float):
        """Background worker that routes transcription through the bridge"""
        try:
            response = self.bridge.process_transcription(transcript)
            if not response:
                return

            total_time = time.time()
            if self.profiler:
                self.profiler.record(
                    "pipeline.voice_to_response_ms",
                    (total_time - receive_time) * 1000
                )

            preview = (
                f"{response.spoken_response[:100]}..."
                if len(response.spoken_response) > 100
                else response.spoken_response
            )
            self.logger.info(
                f"Total pipeline: {(total_time - receive_time)*1000:.0f}ms | Response: {preview}"
            )
        except Exception as e:
            self.logger.error(f"Async transcription processing failed: {e}")

    def initialize(self) -> bool:
        """Pre-initialize STT model"""
        return self.stt.initialize()

    def run(self):
        """Main processing loop - OPTIMIZED"""
        self.running = True
        self.logger.info("OptimizedAudioProcessor started")

        # Pre-initialize Whisper
        if not self.stt._initialized:
            self.stt.initialize()

        while self.running:
            try:
                # OPTIMIZED: Blocking get with short timeout (was poll+sleep)
                queue_start = time.perf_counter()
                try:
                    audio_data = self.audio_queue.get(timeout=0.05)
                except Empty:
                    continue
                finally:
                    if self.profiler:
                        wait_ms = (time.perf_counter() - queue_start) * 1000
                        self.profiler.record("audio.queue_wait_ms", wait_ms)

                if audio_data is None:
                    break

                if not audio_data or len(audio_data) < 100:
                    self.logger.debug("Skipped empty audio chunk")
                    continue

                if self._should_skip_for_tts():
                    self.logger.debug("Discarded audio chunk while TTS was active")
                    continue

                # Timestamp for latency tracking
                receive_time = time.time()

                # OPTIMIZED: Direct PCM to Whisper (no WAV conversion)
                with (self.profiler.measure("stt.transcription_ms") if self.profiler else nullcontext()):
                    transcript = self.stt.transcribe_pcm(
                        audio_data,
                        sample_rate=self.config.sample_rate
                    )

                if transcript:
                    transcribe_time = time.time()
                    self.logger.info(
                        f"Transcribed in {(transcribe_time - receive_time)*1000:.0f}ms: {transcript}"
                    )

                    # Process through bridge asynchronously (which goes to harness)
                    self._submit_transcription(transcript, receive_time)

            except Exception as e:
                self.logger.error(f"Error in OptimizedAudioProcessor: {e}")
                import traceback
                traceback.print_exc()

        self.logger.info("OptimizedAudioProcessor stopped")

    def stop(self):
        """Stop the processor"""
        self.running = False
        if self._harness_executor:
            self._harness_executor.shutdown(wait=False)


# =============================================================================
# OPTIMIZED VOICE AGENT SYSTEM
# =============================================================================

class VoiceAgentSystem:
    """
    Main voice agent system - OPTIMIZED for low latency.
    Uses threading instead of multiprocessing for lower IPC overhead.
    """

    def __init__(
        self,
        harness_config_path: str = None,
        audio_config_path: str = "config/audio_config.json",
        router_enabled: bool = True,
        tts_enabled: bool = True,
        default_tier: str = "standard",
        whisper_model: str = "base.en",
        use_whisper: bool = True
    ):
        self.logger = self._setup_logging()
        self.profiler = PROFILER
        self.whisper_model = whisper_model
        self.use_whisper = use_whisper

        # Load configurations
        self.audio_config = AudioConfig(audio_config_path)

        # Create harness (pre-warms LLM clients)
        self.harness = create_harness(
            config_path=harness_config_path,
            router_enabled=router_enabled,
            service_rep_enabled=tts_enabled,
            default_tier=default_tier,
            profiler=self.profiler
        )

        # Create text linter
        self.linter = TextLinter()

        # Create bridge
        self.bridge = SpeechTextBridge(
            harness=self.harness,
            text_linter=self.linter,
            on_response=self._on_response,
            profiler=self.profiler
        )

        # OPTIMIZED: Use threading.Queue instead of multiprocessing.Queue
        self.audio_queue = Queue()
        self.device_manager = AudioDeviceManager(self.audio_config)

        # Processing components
        self.audio_processor = None
        self.main_processor = None
        self.processor_thread = None
        self.main_processor_thread = None

        # State
        self.running = False

        self.logger.info("VoiceAgentSystem initialized (OPTIMIZED)")

    def _setup_logging(self) -> logging.Logger:
        """Setup logging for the system - CLEAN output"""
        os.makedirs("logs", exist_ok=True)

        # Only configure root logger for file output - harness logger handles console
        logging.basicConfig(
            level=logging.WARNING,  # Suppress INFO from other libraries
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler("logs/voice_agent.log"),
            ]
        )

        # Suppress noisy libraries
        for noisy in ['httpx', 'httpcore', 'openai', 'faster_whisper', 'urllib3', 'asyncio']:
            logging.getLogger(noisy).setLevel(logging.WARNING)

        # Our logger gets INFO level
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)

        # Add console handler just for our module
        console = logging.StreamHandler(sys.stdout)
        console.setLevel(logging.INFO)
        console.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s', datefmt='%H:%M:%S'))
        logger.addHandler(console)
        logger.propagate = False

        return logger

    def _on_response(self, response: HarnessResponse):
        """Callback for harness responses"""
        self.logger.info(
            f"[RESPONSE] {response.spoken_response[:200]}"
            + ("..." if len(response.spoken_response) > 200 else "")
        )

        if response.classification:
            self.logger.info(
                f"[ROUTING] Tier: {response.classification.tier_name}, "
                f"Confidence: {response.classification.confidence:.2f}"
            )

        if response.agent_response and response.agent_response.tools_used:
            self.logger.info(f"[TOOLS] Used: {', '.join(response.agent_response.tools_used)}")

    def start(self):
        """Start the voice agent system"""
        self.logger.info("Starting VoiceAgentSystem (OPTIMIZED)...")
        self.running = True

        # Find audio device
        device_index = self.device_manager.wait_for_input_device()
        if device_index is None:
            self.logger.error("No audio input device found")
            return False

        self.logger.info(f"Using audio device index: {device_index}")

        # Start harness async processing
        self.harness.start_async_processing()

        # Create OPTIMIZED audio processor
        self.audio_processor = OptimizedAudioProcessor(
            audio_queue=self.audio_queue,
            audio_config=self.audio_config,
            bridge=self.bridge,
            whisper_model=self.whisper_model,
            use_whisper=self.use_whisper,
            profiler=self.profiler
        )

        # Pre-initialize STT model
        self.logger.info("Pre-loading STT model...")
        self.audio_processor.initialize()

        # Start processor in thread
        self.processor_thread = threading.Thread(
            target=self.audio_processor.run,
            daemon=True
        )
        self.processor_thread.start()

        # Create main audio processor (uses our threading queue)
        self.main_processor = MainProcessor(
            self.audio_config,
            self.audio_queue,
            tts_block_event=self.harness.tts_speaking_event
        )

        # Start main processor in thread
        self.main_processor_thread = threading.Thread(
            target=self.main_processor.run,
            args=(device_index,),
            daemon=True
        )
        self.main_processor_thread.start()

        self.logger.info("VoiceAgentSystem started successfully (OPTIMIZED)")
        self.logger.info("Speak to interact with the AI agent...")

        return True

    def run_blocking(self):
        """Run the system and block until stopped"""
        if not self.start():
            return

        try:
            while self.running:
                time.sleep(0.5)
        except KeyboardInterrupt:
            self.logger.info("Received interrupt signal")
        finally:
            self.stop()

    def stop(self):
        """Stop the voice agent system"""
        self.logger.info("Stopping VoiceAgentSystem...")
        self.running = False

        # Stop components
        if self.main_processor:
            self.main_processor.stop()

        if self.audio_processor:
            self.audio_processor.stop()
            self.audio_queue.put(None)  # Signal shutdown

        # Stop harness
        self.harness.stop_async_processing()
        self.harness.cleanup()

        # Wait for threads
        if self.processor_thread and self.processor_thread.is_alive():
            self.processor_thread.join(timeout=5.0)

        if self.main_processor_thread and self.main_processor_thread.is_alive():
            self.main_processor_thread.join(timeout=5.0)

        self.logger.info("VoiceAgentSystem stopped")
        # Emit profiling summary at shutdown
        self.profiler.report_summary(logger=self.logger)


# =============================================================================
# VOICE AGENT SYSTEM V2 - MULTIPROCESS ARCHITECTURE
# =============================================================================

class VoiceAgentSystemV2:
    """
    Voice agent system with multiprocess architecture.

    Architecture:
    - Main Process: Audio capture, Whisper STT, request routing
    - Agent Process: LLM reasoning, tool execution
    - TTS Process: Speech synthesis

    Benefits:
    - No GIL contention between STT, Agent, and TTS
    - True parallelism for I/O-bound operations
    - Backpressure handling (latest request wins)
    - Health monitoring with auto-restart
    """

    def __init__(
        self,
        harness_config_path: str = None,
        audio_config_path: str = "config/audio_config.json",
        whisper_model: str = "base.en",
        use_whisper: bool = True,
        default_tier: str = "standard"
    ):
        self.logger = self._setup_logging()
        self.profiler = PROFILER

        # Load configurations
        self.audio_config = AudioConfig(audio_config_path)
        self.harness_config_path = harness_config_path
        self.harness_config = load_or_create_config(harness_config_path) if harness_config_path else None
        self.default_tier = default_tier
        self.whisper_model = whisper_model
        self.use_whisper = use_whisper

        # EventBus for inter-process communication
        self.event_bus = EventBus(max_agent_pending=1)

        # Process manager
        self.process_manager = ProcessManager(self.event_bus)

        # Audio components (run in main process)
        self.audio_queue = Queue()
        self.device_manager = AudioDeviceManager(self.audio_config)
        self.audio_processor = None
        self.main_processor = None

        # Threads for main process
        self.processor_thread = None
        self.main_processor_thread = None
        self.response_thread = None

        # Text processing
        self.linter = TextLinter()

        # State
        self.running = False
        self._request_count = 0

        self.logger.info("VoiceAgentSystemV2 initialized (MULTIPROCESS)")

    def _setup_logging(self) -> logging.Logger:
        """Setup logging for the system"""
        os.makedirs("logs", exist_ok=True)

        logging.basicConfig(
            level=logging.WARNING,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler("logs/voice_agent_v2.log"),
            ]
        )

        # Suppress noisy libraries
        for noisy in ['httpx', 'httpcore', 'openai', 'faster_whisper', 'urllib3', 'asyncio']:
            logging.getLogger(noisy).setLevel(logging.WARNING)

        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)

        console = logging.StreamHandler(sys.stdout)
        console.setLevel(logging.INFO)
        console.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s', datefmt='%H:%M:%S'))
        logger.addHandler(console)
        logger.propagate = False

        return logger

    def _process_transcription(self, text: str, receive_time: float):
        """Process a transcription by submitting to the Agent process via EventBus"""
        # Lint and validate
        with self.profiler.measure("bridge.lint_validate_ms"):
            lint_result = self.linter.lint_and_validate(text)

        if not lint_result.is_valid:
            self.logger.debug(f"Invalid input rejected: {text[:50]}")
            return

        self._request_count += 1
        request_id = f"req_{self._request_count}_{uuid.uuid4().hex[:8]}"

        self.logger.info(f"[{request_id}] Processing: {lint_result.cleaned}")

        # Submit to Agent via EventBus (non-blocking)
        request = AgentRequest(
            request_id=request_id,
            speech_text=lint_result.cleaned,
            tier=self.default_tier,
            context=None,
            conversation_history=[]
        )

        with self.profiler.measure("eventbus.submit_ms"):
            self.event_bus.submit_agent_request(request)

        self.logger.debug(f"[{request_id}] Submitted to Agent process")

    def _response_monitor_loop(self):
        """Monitor for Agent responses and log them"""
        self.logger.info("Response monitor started")

        while self.running:
            try:
                result = self.event_bus.get_agent_response(timeout=0.5)
                if result:
                    self.logger.info(
                        f"[{result.request_id}] Response received in {result.duration_ms:.0f}ms: "
                        f"{result.spoken_response[:100]}..."
                    )
                    self.profiler.record("pipeline.agent_response_ms", result.duration_ms)

                    if result.tools_used:
                        self.logger.info(f"[{result.request_id}] Tools used: {', '.join(result.tools_used)}")

            except Exception as e:
                self.logger.error(f"Response monitor error: {e}")

        self.logger.info("Response monitor stopped")

    def start(self):
        """Start the voice agent system with multiprocess architecture"""
        self.logger.info("Starting VoiceAgentSystemV2 (MULTIPROCESS)...")
        self.running = True

        # Find audio device
        device_index = self.device_manager.wait_for_input_device()
        if device_index is None:
            self.logger.error("No audio input device found")
            return False

        self.logger.info(f"Using audio device index: {device_index}")

        # Setup worker factories
        voice_config = {
            "engine": "pyttsx3",
            "rate": 180,
            "volume": 0.8
        }

        self.process_manager.set_tts_factory(
            create_tts_worker(self.event_bus, voice_config)
        )

        self.process_manager.set_agent_factory(
            create_agent_worker(
                self.event_bus,
                config=self.harness_config,
                config_path=self.harness_config_path
            )
        )

        # Start worker processes
        self.logger.info("Starting worker processes...")
        self.process_manager.start()

        # Give workers time to initialize
        time.sleep(1.0)

        # Create audio processor (runs in main process with STT)
        self.audio_processor = OptimizedAudioProcessorV2(
            audio_queue=self.audio_queue,
            audio_config=self.audio_config,
            on_transcription=self._process_transcription,
            whisper_model=self.whisper_model,
            use_whisper=self.use_whisper,
            profiler=self.profiler
        )

        # Pre-initialize STT model
        self.logger.info("Pre-loading STT model...")
        self.audio_processor.initialize()

        # Start audio processor thread
        self.processor_thread = threading.Thread(
            target=self.audio_processor.run,
            daemon=True,
            name="AudioProcessor"
        )
        self.processor_thread.start()

        # Start main audio capture
        self.main_processor = MainProcessor(
            self.audio_config,
            self.audio_queue,
            tts_block_event=self.event_bus.tts_speaking_event
        )
        self.main_processor_thread = threading.Thread(
            target=self.main_processor.run,
            args=(device_index,),
            daemon=True,
            name="AudioCapture"
        )
        self.main_processor_thread.start()

        # Start response monitor thread
        self.response_thread = threading.Thread(
            target=self._response_monitor_loop,
            daemon=True,
            name="ResponseMonitor"
        )
        self.response_thread.start()

        self.logger.info("VoiceAgentSystemV2 started successfully")
        self.logger.info("Speak to interact with the AI agent...")

        return True

    def run_blocking(self):
        """Run the system and block until stopped"""
        if not self.start():
            return

        try:
            while self.running:
                # Check process health
                if not self.process_manager.agent_alive:
                    self.logger.warning("Agent process not alive!")
                if not self.process_manager.tts_alive:
                    self.logger.warning("TTS process not alive!")

                time.sleep(0.5)

        except KeyboardInterrupt:
            self.logger.info("Received interrupt signal")
        finally:
            self.stop()

    def stop(self):
        """Stop the voice agent system"""
        self.logger.info("Stopping VoiceAgentSystemV2...")
        self.running = False

        # Stop audio components
        if self.main_processor:
            self.main_processor.stop()

        if self.audio_processor:
            self.audio_processor.stop()
            self.audio_queue.put(None)

        # Stop worker processes
        self.process_manager.stop()

        # Wait for threads
        if self.processor_thread and self.processor_thread.is_alive():
            self.processor_thread.join(timeout=5.0)

        if self.main_processor_thread and self.main_processor_thread.is_alive():
            self.main_processor_thread.join(timeout=5.0)

        if self.response_thread and self.response_thread.is_alive():
            self.response_thread.join(timeout=2.0)

        self.logger.info("VoiceAgentSystemV2 stopped")
        self.profiler.report_summary(logger=self.logger)


class OptimizedAudioProcessorV2:
    """
    Audio processor for V2 multiprocess architecture.
    Only handles STT - Agent/TTS are in separate processes.
    """

    def __init__(
        self,
        audio_queue: Queue,
        audio_config: AudioConfig,
        on_transcription: Callable[[str, float], None],
        whisper_model: str = "base.en",
        use_whisper: bool = True,
        profiler: RuntimeProfiler = None
    ):
        self.audio_queue = audio_queue
        self.config = audio_config
        self.on_transcription = on_transcription
        self.logger = logging.getLogger(__name__)
        self.running = False
        self.profiler = profiler or PROFILER

        # Choose STT engine
        if use_whisper:
            self.stt = LocalWhisperSTT(model_size=whisper_model)
        else:
            self.stt = GoogleSTT()

    def initialize(self) -> bool:
        """Pre-initialize STT model"""
        return self.stt.initialize()

    def run(self):
        """Main processing loop"""
        self.running = True
        self.logger.info("OptimizedAudioProcessorV2 started")

        while self.running:
            try:
                # Blocking get with short timeout
                try:
                    audio_data = self.audio_queue.get(timeout=0.05)
                except Empty:
                    continue

                if audio_data is None:
                    break

                if not audio_data or len(audio_data) < 100:
                    continue

                receive_time = time.time()

                # Transcribe
                with self.profiler.measure("stt.transcription_ms"):
                    transcript = self.stt.transcribe_pcm(
                        audio_data,
                        sample_rate=self.config.sample_rate
                    )

                if transcript:
                    transcribe_time = time.time()
                    self.logger.info(
                        f"Transcribed in {(transcribe_time - receive_time)*1000:.0f}ms: {transcript}"
                    )

                    # Call the transcription handler (submits to EventBus)
                    self.on_transcription(transcript, receive_time)

            except Exception as e:
                self.logger.error(f"Error in OptimizedAudioProcessorV2: {e}")
                import traceback
                traceback.print_exc()

        self.logger.info("OptimizedAudioProcessorV2 stopped")

    def stop(self):
        """Stop the processor"""
        self.running = False


# =============================================================================
# INTERACTIVE MODE
# =============================================================================

def interactive_mode(harness: AgentHarness):
    """Run in interactive text mode (for testing without audio)"""
    print("\n" + "="*60)
    print("Voice Agent System - Interactive Mode (OPTIMIZED)")
    print("="*60)
    print("Type your messages below. Type 'quit' or 'exit' to stop.")
    print("Commands: /router on|off, /tts on|off, /tier simple|standard|advanced")
    print("="*60 + "\n")

    linter = TextLinter()

    while True:
        try:
            user_input = input("\nYou: ").strip()

            if not user_input:
                continue

            if user_input.lower() in ['quit', 'exit', 'q']:
                print("Goodbye!")
                break

            # Handle commands
            if user_input.startswith('/'):
                parts = user_input.split()
                cmd = parts[0].lower()

                if cmd == '/router':
                    if len(parts) > 1:
                        if parts[1].lower() == 'on':
                            harness.enable_router()
                            print("Router enabled")
                        else:
                            harness.disable_router()
                            print("Router disabled")
                    continue

                elif cmd == '/tts':
                    if len(parts) > 1:
                        if parts[1].lower() == 'on':
                            harness.enable_service_rep()
                            print("TTS enabled")
                        else:
                            harness.disable_service_rep()
                            print("TTS disabled")
                    continue

                elif cmd == '/tier':
                    if len(parts) > 1:
                        harness.set_default_tier(parts[1])
                        print(f"Default tier set to: {parts[1]}")
                    continue

                elif cmd == '/tools':
                    tools = harness.list_tools()
                    print(f"Available tools: {', '.join(tools)}")
                    continue

                elif cmd == '/benchmark':
                    # Quick latency benchmark
                    print("Running latency benchmark...")
                    start = time.time()
                    response = harness.process("What time is it?")
                    elapsed = (time.time() - start) * 1000
                    print(f"Latency: {elapsed:.0f}ms (target: 300ms)")
                    continue

                elif cmd == '/help':
                    print("Commands:")
                    print("  /router on|off - Enable/disable task routing")
                    print("  /tts on|off    - Enable/disable text-to-speech")
                    print("  /tier <name>   - Set default tier (simple/standard/advanced)")
                    print("  /tools         - List available tools")
                    print("  /benchmark     - Run latency benchmark")
                    print("  /help          - Show this help")
                    continue

            # Process input - measure latency
            start_time = time.time()
            lint_result = linter.lint_and_validate(user_input)

            print("\nAgent: ", end="", flush=True)

            # Process with streaming
            full_response = ""
            for chunk in harness.process_streaming(lint_result.cleaned):
                print(chunk, end="", flush=True)
                full_response += chunk

            elapsed = (time.time() - start_time) * 1000
            print(f"\n\n[Latency: {elapsed:.0f}ms]")

        except KeyboardInterrupt:
            print("\nGoodbye!")
            break
        except Exception as e:
            print(f"\nError: {e}")


# =============================================================================
# MAIN ENTRY POINT
# =============================================================================

def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="Voice-Activated AI Agent System (OPTIMIZED v2)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py                    # Start with voice input (v1 single-process)
  python main.py --v2               # Start with voice input (v2 multiprocess - RECOMMENDED)
  python main.py --interactive      # Text-only interactive mode
  python main.py --list-devices     # List audio devices
  python main.py --no-router        # Disable task routing (faster)
  python main.py --tier advanced    # Use advanced tier by default
  python main.py --whisper tiny.en  # Use tiny Whisper model (fastest)
  python main.py --google-stt       # Use Google STT instead of Whisper

Architecture:
  v1 (default): Single process with threading - simpler but GIL-limited
  v2 (--v2):    Multiprocess - Agent and TTS in separate processes, no GIL contention
        """
    )

    parser.add_argument(
        "--config",
        default="config/harness_config.json",
        help="Path to harness configuration file"
    )
    parser.add_argument(
        "--audio-config",
        default="config/audio_config.json",
        help="Path to audio configuration file"
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="List available audio devices and exit"
    )
    parser.add_argument(
        "--interactive", "-i",
        action="store_true",
        help="Run in interactive text mode (no audio)"
    )
    parser.add_argument(
        "--no-router",
        action="store_true",
        help="Disable task routing (faster)"
    )
    parser.add_argument(
        "--no-tts",
        action="store_true",
        help="Disable text-to-speech output"
    )
    parser.add_argument(
        "--tier",
        choices=["simple", "standard", "advanced"],
        default="standard",
        help="Default agent tier"
    )
    parser.add_argument(
        "--whisper",
        choices=["tiny.en", "base.en", "small.en", "medium.en"],
        default="base.en",
        help="Whisper model size (tiny.en is fastest, medium.en is most accurate)"
    )
    parser.add_argument(
        "--google-stt",
        action="store_true",
        help="Use Google STT instead of local Whisper (slower but no model download)"
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging"
    )
    parser.add_argument(
        "--v2",
        action="store_true",
        help="Use v2 multiprocess architecture (Agent and TTS in separate processes)"
    )

    args = parser.parse_args()

    # Setup logging level
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    # List devices and exit
    if args.list_devices:
        config = AudioConfig(args.audio_config)
        device_manager = AudioDeviceManager(config)
        devices = device_manager.list_devices()

        print("\nAvailable Audio Devices:")
        print("-" * 60)
        for device in devices:
            vad_rates = ', '.join(map(str, device['supported_vad_rates'])) or 'None'
            print(f"  [{device['index']}] {device['name']}")
            print(f"      Channels: {device['channels']}, Input: {device['is_input']}")
            print(f"      VAD Rates: {vad_rates}")
            print()
        return

    # Interactive mode
    if args.interactive:
        harness = create_harness(
            config_path=args.config if os.path.exists(args.config) else None,
            router_enabled=not args.no_router,
            service_rep_enabled=not args.no_tts,
            default_tier=args.tier,
            profiler=PROFILER
        )

        try:
            interactive_mode(harness)
        finally:
            harness.cleanup()
            PROFILER.report_summary()
        return

    # Full voice mode
    if args.v2:
        # V2: Multiprocess architecture (Agent and TTS in separate processes)
        print("=" * 60)
        print("Starting Voice Agent System V2 (MULTIPROCESS)")
        print("  - Main Process: Audio capture, Whisper STT")
        print("  - Agent Process: LLM reasoning, tool execution")
        print("  - TTS Process: Speech synthesis")
        print("=" * 60)

        system = VoiceAgentSystemV2(
            harness_config_path=args.config if os.path.exists(args.config) else None,
            audio_config_path=args.audio_config,
            whisper_model=args.whisper,
            use_whisper=not args.google_stt,
            default_tier=args.tier
        )
    else:
        # V1: Single process with threading (original)
        system = VoiceAgentSystem(
            harness_config_path=args.config if os.path.exists(args.config) else None,
            audio_config_path=args.audio_config,
            router_enabled=not args.no_router,
            tts_enabled=not args.no_tts,
            default_tier=args.tier,
            whisper_model=args.whisper,
            use_whisper=not args.google_stt
        )

    # Handle signals
    def signal_handler(signum, frame):
        print("\nShutting down...")
        try:
            system.stop()
        finally:
            # Ensure profiler flushes even on signal-triggered exits
            PROFILER.report_summary(logger=system.logger)
            sys.exit(0)

    # Handle common termination signals (including terminal close)
    for sig_name in ("SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"):
        if hasattr(signal, sig_name):
            signal.signal(getattr(signal, sig_name), signal_handler)

    # Run
    system.run_blocking()


if __name__ == "__main__":
    main()
