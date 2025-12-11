"""
Audio Service - Pure audio processing with no domain coupling.

Responsibilities:
- Voice Activity Detection (VAD)
- Audio chunk processing
- Noise filtering

Does NOT know about:
- AgentHarness
- EventBus
- TTS state
"""

import time
import logging
import numpy as np
import pyaudio
import webrtcvad
from dataclasses import dataclass
from typing import Optional, List
from collections import deque


@dataclass
class AudioChunk:
    """Pure data structure for processed audio"""
    data: bytes
    sample_rate: int
    timestamp: float
    duration_seconds: float

    @property
    def size_bytes(self) -> int:
        return len(self.data)


@dataclass
class AudioConfig:
    """Audio service configuration"""
    sample_rate: int = 32000
    chunk_duration_ms: int = 30
    channels: int = 1
    vad_aggressiveness: int = 2
    speech_timeout_ms: int = 1000
    silence_timeout_ms: int = 500
    min_speech_duration_s: float = 0.3
    device_index: Optional[int] = None

    @property
    def chunk_size(self) -> int:
        """Calculate chunk size in samples"""
        return int(self.sample_rate * self.chunk_duration_ms / 1000)


class NoiseFilter:
    """
    Advanced noise filtering and voice signal enhancement.
    Stateless processor with calibration state.
    """

    def __init__(self, sample_rate: int = 16000, frame_duration_ms: int = 30):
        self.sample_rate = sample_rate
        self.frame_duration_ms = frame_duration_ms
        self.frame_size = int(sample_rate * frame_duration_ms / 1000)

        # Noise floor estimation
        self.noise_floor = 0.0
        self.noise_floor_samples = []
        self.noise_floor_window = 50
        self.noise_floor_percentile = 10

        # Energy thresholds
        self.min_speech_energy = 100
        self.speech_energy_ratio = 3.0

        # Frequency analysis for voice detection
        self.voice_freq_low = 85
        self.voice_freq_high = 3500

        # Smoothing
        self.energy_history = []
        self.energy_history_size = 5

        # Calibration state
        self.is_calibrated = False
        self.calibration_frames = 0
        self.calibration_target = 15

    def calibrate(self, audio_chunk: bytes) -> bool:
        """
        Calibrate noise floor from ambient audio.
        Returns True when calibration is complete.
        """
        energy = self._calculate_energy(audio_chunk)
        self.noise_floor_samples.append(energy)
        self.calibration_frames += 1

        if self.calibration_frames >= self.calibration_target:
            sorted_samples = sorted(self.noise_floor_samples)
            percentile_idx = int(len(sorted_samples) * self.noise_floor_percentile / 100)
            self.noise_floor = sorted_samples[percentile_idx] if sorted_samples else 100
            self.noise_floor = max(self.noise_floor, self.min_speech_energy)
            self.is_calibrated = True
            return True

        return False

    def is_voice(self, audio_chunk: bytes) -> tuple:
        """
        Comprehensive voice detection using multiple features.
        Returns (is_voice, confidence, features)
        """
        energy = self._calculate_energy(audio_chunk)
        zcr = self._calculate_zero_crossing_rate(audio_chunk)
        spectral_centroid = self._calculate_spectral_centroid(audio_chunk)
        voice_band_ratio = self._calculate_voice_band_energy_ratio(audio_chunk)

        self.energy_history.append(energy)
        if len(self.energy_history) > self.energy_history_size:
            self.energy_history.pop(0)

        smoothed_energy = np.mean(self.energy_history)

        features = {
            'energy': energy,
            'smoothed_energy': smoothed_energy,
            'zcr': zcr,
            'spectral_centroid': spectral_centroid,
            'voice_band_ratio': voice_band_ratio,
            'noise_floor': self.noise_floor
        }

        confidence = 0.0

        # Energy check
        energy_threshold = self.noise_floor * self.speech_energy_ratio
        if smoothed_energy > energy_threshold:
            confidence += 0.4
        elif smoothed_energy > self.noise_floor * 1.5:
            confidence += 0.2

        # Voice band energy ratio
        if voice_band_ratio > 0.4:
            confidence += 0.3
        elif voice_band_ratio > 0.25:
            confidence += 0.15

        # Zero crossing rate
        if 0.01 < zcr < 0.15:
            confidence += 0.2
        elif zcr < 0.2:
            confidence += 0.1

        # Spectral centroid
        if 300 < spectral_centroid < 2000:
            confidence += 0.1

        is_voice = confidence >= 0.5
        return is_voice, confidence, features

    def update_noise_floor(self, energy: float, is_speech: bool):
        """Adaptively update noise floor during non-speech"""
        if not is_speech and self.is_calibrated:
            self.noise_floor_samples.append(energy)
            if len(self.noise_floor_samples) > self.noise_floor_window:
                self.noise_floor_samples.pop(0)

            if len(self.noise_floor_samples) >= 10:
                sorted_samples = sorted(self.noise_floor_samples)
                percentile_idx = int(len(sorted_samples) * self.noise_floor_percentile / 100)
                new_floor = sorted_samples[percentile_idx]
                self.noise_floor = 0.9 * self.noise_floor + 0.1 * new_floor

    def _calculate_energy(self, audio_chunk: bytes) -> float:
        """Calculate RMS energy of audio chunk"""
        samples = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32)
        if len(samples) == 0:
            return 0.0
        rms = np.sqrt(np.mean(samples ** 2))
        return rms

    def _calculate_zero_crossing_rate(self, audio_chunk: bytes) -> float:
        """Calculate zero crossing rate"""
        samples = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32)
        if len(samples) < 2:
            return 0.0
        signs = np.sign(samples)
        signs[signs == 0] = 1
        crossings = np.sum(np.abs(np.diff(signs)) > 0)
        return crossings / len(samples)

    def _calculate_spectral_centroid(self, audio_chunk: bytes) -> float:
        """Calculate spectral centroid"""
        samples = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32)
        if len(samples) < 256:
            return 0.0
        windowed = samples * np.hanning(len(samples))
        fft = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(len(windowed), 1.0 / self.sample_rate)
        if np.sum(fft) == 0:
            return 0.0
        centroid = np.sum(freqs * fft) / np.sum(fft)
        return centroid

    def _calculate_voice_band_energy_ratio(self, audio_chunk: bytes) -> float:
        """Calculate ratio of energy in voice frequency band vs total"""
        samples = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32)
        if len(samples) < 256:
            return 0.0
        windowed = samples * np.hanning(len(samples))
        fft = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(len(windowed), 1.0 / self.sample_rate)
        total_energy = np.sum(fft ** 2)
        if total_energy == 0:
            return 0.0
        voice_mask = (freqs >= self.voice_freq_low) & (freqs <= self.voice_freq_high)
        voice_energy = np.sum(fft[voice_mask] ** 2)
        return voice_energy / total_energy


class AudioService:
    """
    Pure audio processing service.

    Responsibilities:
    - VAD-based speech detection
    - Audio segmentation
    - Noise filtering

    This is a pure service with no knowledge of:
    - AgentHarness
    - EventBus
    - TTS state
    - Application orchestration
    """

    def __init__(self, config: AudioConfig, logger: logging.Logger):
        """
        Initialize audio service with injected dependencies.

        Args:
            config: Audio configuration
            logger: Injected logger instance
        """
        self.config = config
        self.logger = logger
        self.vad = webrtcvad.Vad(config.vad_aggressiveness)
        self.noise_filter = NoiseFilter(
            sample_rate=config.sample_rate,
            frame_duration_ms=config.chunk_duration_ms
        )

        # Speech detection state
        self.speech_frames: List[bytes] = []
        self.is_speech_active = False
        self.speech_start_time: Optional[float] = None
        self.last_speech_time: Optional[float] = None

        # Ring buffer for pre-roll
        self.pre_roll_buffer: deque = deque(maxlen=5)

        # Consecutive frame tracking
        self.consecutive_speech_frames = 0
        self.consecutive_silence_frames = 0
        self.min_speech_frames_start = 2
        self.min_silence_frames_end = 15

        # Statistics
        self.total_frames_processed = 0
        self.speech_frames_count = 0

    def calibrate_noise_floor(self, audio_chunk: bytes) -> bool:
        """
        Calibrate noise floor from ambient audio.

        Args:
            audio_chunk: Raw audio bytes

        Returns:
            True when calibration is complete
        """
        return self.noise_filter.calibrate(audio_chunk)

    def is_speech(self, audio_chunk: bytes) -> tuple:
        """
        Check if audio chunk contains speech using multi-layer detection.

        Args:
            audio_chunk: Raw audio bytes

        Returns:
            Tuple of (is_speech, confidence, details)
        """
        try:
            # Validate sample rate for VAD
            if self.config.sample_rate not in [8000, 16000, 32000, 48000]:
                self.logger.warning(f"Sample rate {self.config.sample_rate} not supported by VAD")
                return False, 0.0, {}

            # Validate chunk duration for VAD
            if self.config.chunk_duration_ms not in [10, 20, 30]:
                self.logger.warning(f"Chunk duration {self.config.chunk_duration_ms}ms not supported by VAD")
                return False, 0.0, {}

            # Layer 1: WebRTC VAD
            vad_result = self.vad.is_speech(audio_chunk, self.config.sample_rate)

            # Layer 2: Advanced noise filter analysis
            voice_result, voice_confidence, features = self.noise_filter.is_voice(audio_chunk)

            # Combine results
            if vad_result and voice_result:
                combined_confidence = 0.5 + (voice_confidence * 0.5)
                is_speech = True
            elif vad_result or voice_result:
                combined_confidence = voice_confidence
                is_speech = voice_confidence > 0.6
            else:
                combined_confidence = voice_confidence
                is_speech = False

            details = {
                'vad_result': vad_result,
                'voice_result': voice_result,
                'voice_confidence': voice_confidence,
                'combined_confidence': combined_confidence,
                **features
            }

            return is_speech, combined_confidence, details

        except Exception as e:
            self.logger.error(f"Error in VAD processing: {e}")
            return False, 0.0, {'error': str(e)}

    def process_frame(self, audio_chunk: bytes) -> Optional[AudioChunk]:
        """
        Process a single audio frame and return a complete speech segment when detected.

        Args:
            audio_chunk: Raw audio bytes

        Returns:
            AudioChunk if speech segment is complete, None otherwise
        """
        current_time = time.time()
        self.total_frames_processed += 1

        # Check for speech
        is_speech, confidence, details = self.is_speech(audio_chunk)

        # Update pre-roll buffer
        self.pre_roll_buffer.append(audio_chunk)

        if is_speech:
            self.consecutive_speech_frames += 1
            self.consecutive_silence_frames = 0
            self.speech_frames_count += 1
            self.last_speech_time = current_time

            if not self.is_speech_active:
                # Start speech segment after minimum consecutive frames
                if self.consecutive_speech_frames >= self.min_speech_frames_start:
                    self.is_speech_active = True
                    self.speech_start_time = current_time
                    # Include pre-roll buffer
                    self.speech_frames = list(self.pre_roll_buffer)
                    self.logger.debug(f"Speech started (confidence: {confidence:.2f})")

            if self.is_speech_active:
                self.speech_frames.append(audio_chunk)
        else:
            self.consecutive_silence_frames += 1
            self.consecutive_speech_frames = 0

            # Update noise floor during silence
            energy = self.noise_filter._calculate_energy(audio_chunk)
            self.noise_filter.update_noise_floor(energy, is_speech=False)

            if self.is_speech_active:
                # Also add silence frames to capture trailing audio
                self.speech_frames.append(audio_chunk)

                # End speech segment after minimum consecutive silence frames
                if self.consecutive_silence_frames >= self.min_silence_frames_end:
                    silence_duration = current_time - self.last_speech_time if self.last_speech_time else 0

                    if silence_duration > (self.config.silence_timeout_ms / 1000.0):
                        return self._finalize_speech_segment()

        return None

    def _finalize_speech_segment(self) -> Optional[AudioChunk]:
        """
        Finalize current speech segment and reset state.

        Returns:
            AudioChunk if segment is valid, None otherwise
        """
        if not self.speech_frames:
            self._reset_state()
            return None

        # Combine all speech frames
        combined_audio = b''.join(self.speech_frames)

        # Calculate speech duration
        speech_duration = time.time() - self.speech_start_time if self.speech_start_time else 0

        # Filter out very short segments (likely noise)
        if speech_duration < self.config.min_speech_duration_s:
            self.logger.debug(f"Discarded short segment: {speech_duration:.2f}s")
            self._reset_state()
            return None

        self.logger.info(f"Speech segment finalized: {len(combined_audio)} bytes, {speech_duration:.2f}s")

        chunk = AudioChunk(
            data=combined_audio,
            sample_rate=self.config.sample_rate,
            timestamp=self.speech_start_time or time.time(),
            duration_seconds=speech_duration
        )

        self._reset_state()
        return chunk

    def _reset_state(self):
        """Reset speech detection state"""
        self.is_speech_active = False
        self.speech_frames = []
        self.speech_start_time = None
        self.last_speech_time = None
        self.consecutive_speech_frames = 0
        self.consecutive_silence_frames = 0
        self.pre_roll_buffer.clear()

    def force_finalize(self) -> Optional[AudioChunk]:
        """
        Force finalize current speech segment (e.g., on shutdown).

        Returns:
            AudioChunk if there's an active segment, None otherwise
        """
        if self.is_speech_active and self.speech_frames:
            return self._finalize_speech_segment()
        return None
