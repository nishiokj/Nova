#!/usr/bin/env python3
"""
Audio VAD Processor - Long-running agent for voice activity detection and speech transcription
"""

import os
import sys
import time
import json
import logging
import argparse
import threading
import multiprocessing
from multiprocessing import Queue, Process
from typing import Optional, Dict, Any, List
from datetime import datetime

import numpy as np
import pyaudio
import webrtcvad
import speech_recognition as sr
from pydub import AudioSegment


class AudioConfig:
    """Configuration manager for audio processing parameters"""
    
    def __init__(self, config_path: str = "config/audio_config.json"):
        self.config_path = config_path
        self.config = self._load_config()
        
    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from JSON file"""
        try:
            with open(self.config_path, 'r') as f:
                return json.load(f)
        except FileNotFoundError:
            logging.error(f"Config file not found: {self.config_path}")
            return self._default_config()
        except json.JSONDecodeError as e:
            logging.error(f"Invalid JSON in config file: {e}")
            return self._default_config()
    
    def _default_config(self) -> Dict[str, Any]:
        """Default configuration values"""
        return {
            "sample_rate": 32000,
            "chunk_duration_ms": 30,
            "channels": 1,
            "format": "pcm_16",
            "vad_aggressiveness": 2,
            "speech_timeout_ms": 1000,
            "silence_timeout_ms": 500,
            "device_index": None,
            "device_name": None
        }
    
    @property
    def sample_rate(self) -> int:
        return self.config["sample_rate"]
    
    @property
    def chunk_duration_ms(self) -> int:
        return self.config["chunk_duration_ms"]
    
    @property
    def channels(self) -> int:
        return self.config["channels"]
    
    @property
    def vad_aggressiveness(self) -> int:
        return self.config["vad_aggressiveness"]
    
    @property
    def speech_timeout_ms(self) -> int:
        return self.config["speech_timeout_ms"]
    
    @property
    def silence_timeout_ms(self) -> int:
        return self.config["silence_timeout_ms"]
    
    @property
    def device_index(self) -> Optional[int]:
        return self.config["device_index"]
    
    @property
    def device_name(self) -> Optional[str]:
        return self.config["device_name"]
    
    @property
    def chunk_size(self) -> int:
        """Calculate chunk size in samples"""
        return int(self.sample_rate * self.chunk_duration_ms / 1000)


class AudioDeviceManager:
    """Manages audio device detection and availability"""
    
    def __init__(self, config: AudioConfig):
        self.config = config
        self.logger = logging.getLogger(__name__)
        
    def _suppress_alsa_errors(self):
        """Suppress ALSA error messages during device detection"""
        try:
            # Try to redirect ALSA errors to null
            import ctypes
            import os
            
            # Redirect stderr to null temporarily
            self._original_stderr = os.dup(2)
            devnull = os.open(os.devnull, os.O_WRONLY)
            os.dup2(devnull, 2)
            os.close(devnull)
            
        except Exception:
            # If suppression fails, continue without it
            pass
    
    def _restore_stderr(self):
        """Restore stderr after ALSA error suppression"""
        try:
            if hasattr(self, '_original_stderr'):
                os.dup2(self._original_stderr, 2)
                os.close(self._original_stderr)
        except Exception:
            pass
        
    def list_devices(self) -> List[Dict[str, Any]]:
        """List all available audio devices with supported sample rates"""
        p = None
        
        # First try to suppress ALSA error messages
        self._suppress_alsa_errors()
        
        try:
            p = pyaudio.PyAudio()
            devices = []
            vad_rates = [8000, 16000, 32000, 48000]
            
            # Get device count with error handling
            try:
                device_count = p.get_device_count()
                self.logger.info(f"PyAudio found {device_count} audio devices")
                
                # If no devices found, try fallback immediately
                if device_count == 0:
                    self.logger.warning("PyAudio found 0 devices, trying fallback detection")
                    if p:
                        try:
                            p.terminate()
                        except:
                            pass
                    return self._try_platform_specific_detection()
                    
            except Exception as e:
                self.logger.error(f"Failed to get device count: {e}")
                if p:
                    try:
                        p.terminate()
                    except:
                        pass
                return self._try_platform_specific_detection()
            
            for i in range(device_count):
                try:
                    info = p.get_device_info_by_index(i)
                    self.logger.debug(f"Device {i}: {info['name']} - Input channels: {info['maxInputChannels']}")
                    
                    # Test supported VAD sample rates for input devices
                    supported_vad_rates = []
                    if info['maxInputChannels'] > 0:
                        for rate in vad_rates:
                            try:
                                # More robust stream testing with timeout
                                test_stream = p.open(
                                    format=pyaudio.paInt16,
                                    channels=min(1, info['maxInputChannels']),
                                    rate=rate,
                                    input=True,
                                    input_device_index=i,
                                    frames_per_buffer=512,
                                    start=False  # Don't start immediately
                                )
                                test_stream.close()
                                supported_vad_rates.append(rate)
                                self.logger.debug(f"Device {i} supports {rate} Hz")
                            except Exception as e:
                                self.logger.debug(f"Device {i} does not support {rate} Hz: {e}")
                                continue
                    
                    devices.append({
                        'index': i,
                        'name': info['name'],
                        'channels': info['maxInputChannels'],
                        'sample_rate': info['defaultSampleRate'],
                        'supported_vad_rates': supported_vad_rates,
                        'is_input': info['maxInputChannels'] > 0,
                        'host_api': info.get('hostApi', 'unknown')
                    })
                
                except Exception as e:
                    self.logger.warning(f"Error querying device {i}: {e}")
                    continue
            
            return devices
            
        except Exception as e:
            self.logger.error(f"Error initializing PyAudio: {e}")
            # Try alternative methods for different platforms
            return self._try_platform_specific_detection()
        finally:
            # Restore stderr
            self._restore_stderr()
            if p:
                try:
                    p.terminate()
                except:
                    pass
    
    def _try_platform_specific_detection(self) -> List[Dict[str, Any]]:
        """Try platform-specific audio device detection when PyAudio fails"""
        import platform
        import subprocess
        
        system = platform.system().lower()
        self.logger.info(f"Trying platform-specific detection for {system}")
        
        if system == "darwin":  # macOS
            return self._detect_macos_devices()
        elif system == "linux":
            return self._detect_linux_devices()
        elif system == "windows":
            return self._detect_windows_devices()
        else:
            self.logger.warning(f"Unsupported platform: {system}")
            return []
    
    def _detect_macos_devices(self) -> List[Dict[str, Any]]:
        """Detect audio devices on macOS"""
        try:
            import subprocess
            
            # Use system_profiler to get audio devices
            result = subprocess.run(
                ["system_profiler", "SPAudioDataType", "-json"],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                import json
                data = json.loads(result.stdout)
                devices = []
                
                for audio_data in data.get("SPAudioDataType", []):
                    for device_name, device_info in audio_data.items():
                        if isinstance(device_info, dict) and "coreaudio_input_source" in device_info:
                            devices.append({
                                'index': len(devices),
                                'name': device_name,
                                'channels': 1,  # Assume mono for safety
                                'sample_rate': 44100,  # Default sample rate
                                'supported_vad_rates': [16000, 32000],  # Conservative estimate
                                'is_input': True,
                                'host_api': 'coreaudio'
                            })
                
                self.logger.info(f"macOS detection found {len(devices)} input devices")
                return devices
        except Exception as e:
            self.logger.error(f"macOS device detection failed: {e}")
        
        return []
    
    def _detect_linux_devices(self) -> List[Dict[str, Any]]:
        """Detect audio devices on Linux"""
        try:
            import subprocess
            import os
            
            # Try ALSA first
            devices = []
            
            # Check /proc/asound/cards
            try:
                with open('/proc/asound/cards', 'r') as f:
                    for line in f:
                        if ':' in line and '[' in line:
                            card_info = line.strip()
                            devices.append({
                                'index': len(devices),
                                'name': card_info,
                                'channels': 1,
                                'sample_rate': 44100,
                                'supported_vad_rates': [16000, 32000],
                                'is_input': True,
                                'host_api': 'alsa'
                            })
            except Exception as e:
                self.logger.debug(f"Could not read /proc/asound/cards: {e}")
            
            # Try arecord -l as fallback
            if not devices:
                try:
                    result = subprocess.run(
                        ["arecord", "-l"],
                        capture_output=True,
                        text=True,
                        timeout=5
                    )
                    
                    if result.returncode == 0:
                        for line in result.stdout.split('\n'):
                            if 'card' in line.lower() and 'device' in line.lower():
                                devices.append({
                                    'index': len(devices),
                                    'name': line.strip(),
                                    'channels': 1,
                                    'sample_rate': 44100,
                                    'supported_vad_rates': [16000, 32000],
                                    'is_input': True,
                                    'host_api': 'alsa'
                                })
                except Exception as e:
                    self.logger.debug(f"arecord -l failed: {e}")
            
            # Docker environment fallback - check for mounted devices from host
            if not devices and os.path.exists('/.dockerenv'):
                self.logger.info("Docker environment detected, checking for host audio devices...")
                
                # Try to detect if we're in a Docker container with macOS host
                try:
                    # Check if we have macOS-style audio device info available
                    host_info = os.environ.get('HOST_AUDIO_DEVICES', '')
                    if host_info:
                        self.logger.info(f"Found host audio device info: {host_info}")
                        devices.append({
                            'index': 0,
                            'name': 'Host Audio Device (Docker)',
                            'channels': 1,
                            'sample_rate': 44100,
                            'supported_vad_rates': [16000, 32000],
                            'is_input': True,
                            'host_api': 'docker_host'
                        })
                    else:
                        # Create a dummy device for Docker testing
                        self.logger.warning("No host audio devices detected, creating dummy device for testing")
                        devices.append({
                            'index': 0,
                            'name': 'Docker Dummy Audio Device',
                            'channels': 1,
                            'sample_rate': 44100,
                            'supported_vad_rates': [16000, 32000],
                            'is_input': True,
                            'host_api': 'dummy'
                        })
                except Exception as e:
                    self.logger.error(f"Docker audio detection failed: {e}")
            
            self.logger.info(f"Linux detection found {len(devices)} input devices")
            return devices
            
        except Exception as e:
            self.logger.error(f"Linux device detection failed: {e}")
        
        return []
    
    def _detect_windows_devices(self) -> List[Dict[str, Any]]:
        """Detect audio devices on Windows"""
        try:
            import subprocess
            
            # Use PowerShell to get audio devices
            ps_command = '''
            Get-WmiObject -Class Win32_SoundDevice | 
            Where-Object { $_.Status -eq "OK" } | 
            Select-Object Name, DeviceID | 
            ConvertTo-Json
            '''
            
            result = subprocess.run(
                ["powershell", "-Command", ps_command],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                import json
                data = json.loads(result.stdout)
                devices = []
                
                # Handle both single device and array of devices
                if isinstance(data, dict):
                    data = [data]
                
                for device in data:
                    if device.get('Name'):
                        devices.append({
                            'index': len(devices),
                            'name': device['Name'],
                            'channels': 1,
                            'sample_rate': 44100,
                            'supported_vad_rates': [16000, 32000],
                            'is_input': True,
                            'host_api': 'wasapi'
                        })
                
                self.logger.info(f"Windows detection found {len(devices)} input devices")
                return devices
                
        except Exception as e:
            self.logger.error(f"Windows device detection failed: {e}")
        
        return []
    
    def find_input_device(self) -> Optional[int]:
        """Find suitable input device based on configuration"""
        devices = self.list_devices()
        
        # Filter input devices only
        input_devices = [d for d in devices if d['is_input']]
        
        if not input_devices:
            self.logger.warning("No input devices found")
            self.logger.info("Available devices (debug info):")
            for device in devices:
                self.logger.info(f"  Device {device['index']}: {device['name']} (input: {device['is_input']}, channels: {device['channels']})")
            return None
        
        self.logger.info(f"Found {len(input_devices)} input devices:")
        for device in input_devices:
            self.logger.info(f"  Device {device['index']}: {device['name']} (channels: {device['channels']}, VAD rates: {device['supported_vad_rates']})")
        
        # If specific device configured, try to find it
        if self.config.device_index is not None:
            for device in input_devices:
                if device['index'] == self.config.device_index:
                    self.logger.info(f"Using configured device index: {self.config.device_index}")
                    return self.config.device_index
        
        if self.config.device_name is not None:
            for device in input_devices:
                if self.config.device_name.lower() in device['name'].lower():
                    self.logger.info(f"Using configured device name: {device['name']}")
                    return device['index']
        
        # Prefer devices with VAD-compatible rates
        vad_compatible_devices = [d for d in input_devices if d['supported_vad_rates']]
        if vad_compatible_devices:
            default_device = vad_compatible_devices[0]
            self.logger.info(f"Using VAD-compatible device: {default_device['name']}")
            return default_device['index']
        
        # Use first available input device as fallback
        default_device = input_devices[0]
        self.logger.info(f"Using default input device: {default_device['name']}")
        return default_device['index']
    
    def wait_for_input_device(self, check_interval: int = 5) -> int:
        """Wait for input device to become available"""
        self.logger.info("Waiting for input device to become available...")
        
        while True:
            device_index = self.find_input_device()
            if device_index is not None:
                return device_index
            
            self.logger.info(f"No input device available, checking again in {check_interval} seconds...")
            time.sleep(check_interval)


class ChildProcessor:
    """Separate process for transcribing audio and logging speech"""
    
    def __init__(self, audio_queue: Queue, config: AudioConfig):
        self.audio_queue = audio_queue
        self.config = config
        self.logger = logging.getLogger(__name__)
        self.recognizer = sr.Recognizer()
        self.running = True
        
    def process_audio_chunk(self, audio_data: bytes) -> Optional[str]:
        """Transcribe audio chunk to text"""
        try:
            # Convert bytes to AudioData for speech recognition
            audio_segment = AudioSegment(
                data=audio_data,
                sample_width=2,  # 16-bit audio
                frame_rate=self.config.sample_rate,
                channels=self.config.channels
            )
            
            # Convert to wav format in memory
            wav_data = audio_segment.export(format="wav").read()
            
            # Create AudioData object
            audio_data_obj = sr.AudioData(wav_data, self.config.sample_rate, 2)
            
            # Perform speech recognition
            text = self.recognizer.recognize_google(audio_data_obj)
            print(text)
            return text
            
        except sr.UnknownValueError:
            self.logger.debug("Speech recognition could not understand audio")
            return None
        except sr.RequestError as e:
            self.logger.error(f"Speech recognition service error: {e}")
            return None
        except Exception as e:
            self.logger.error(f"Error processing audio chunk: {e}")
            return None
    
    def run(self):
        """Main processing loop for child process"""
        self.logger.info("ChildProcessor started")
        
        while self.running:
            try:
                # Wait for audio data with timeout
                if not self.audio_queue.empty():
                    audio_data = self.audio_queue.get(timeout=1.0)
                    
                    # Process the audio chunk
                    transcript = self.process_audio_chunk(audio_data)
                    self.logger.info(transcript)
                    if transcript:
                        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        speech_log = f"[{timestamp}] SPEECH: {transcript}"
                        self.logger.info(speech_log)
                        
                        # Log to speech.logs file
                        with open("logs/speech.logs", "a", encoding="utf-8") as f:
                            f.write(speech_log + "\n")
                
                else:
                    self.logger.info("empty")
                    # Sleep when queue is empty
                    time.sleep(0.1)
                    
            except Exception as e:
                self.logger.error(f"Error in ChildProcessor: {e}")
                time.sleep(1.0)
        
        self.logger.info("ChildProcessor stopped")


class NoiseFilter:
    """
    Advanced noise filtering and voice signal enhancement.
    Uses energy-based detection, spectral analysis, and adaptive thresholding.
    """

    def __init__(self, sample_rate: int = 16000, frame_duration_ms: int = 30):
        self.sample_rate = sample_rate
        self.frame_duration_ms = frame_duration_ms
        self.frame_size = int(sample_rate * frame_duration_ms / 1000)

        # Noise floor estimation (adaptive)
        self.noise_floor = 0.0
        self.noise_floor_samples = []
        self.noise_floor_window = 50  # Number of frames for noise estimation
        self.noise_floor_percentile = 10  # Use 10th percentile as noise floor

        # Energy thresholds
        self.min_speech_energy = 100  # Minimum energy to consider as potential speech
        self.speech_energy_ratio = 3.0  # Speech must be X times above noise floor

        # Frequency analysis for voice detection
        self.voice_freq_low = 85  # Hz - lowest voice frequency
        self.voice_freq_high = 3500  # Hz - highest voice frequency (narrower for clarity)

        # Smoothing for stable detection
        self.energy_history = []
        self.energy_history_size = 5

        # Calibration state (OPTIMIZED - reduced from 30 to 15 frames = ~450ms startup)
        self.is_calibrated = False
        self.calibration_frames = 0
        self.calibration_target = 15  # Frames needed for calibration (was 30 = 900ms)

    def calibrate(self, audio_chunk: bytes) -> bool:
        """
        Calibrate noise floor from ambient audio.
        Returns True when calibration is complete.
        """
        energy = self._calculate_energy(audio_chunk)
        self.noise_floor_samples.append(energy)
        self.calibration_frames += 1

        if self.calibration_frames >= self.calibration_target:
            # Calculate noise floor as percentile of collected samples
            sorted_samples = sorted(self.noise_floor_samples)
            percentile_idx = int(len(sorted_samples) * self.noise_floor_percentile / 100)
            self.noise_floor = sorted_samples[percentile_idx] if sorted_samples else 100

            # Set minimum threshold
            self.noise_floor = max(self.noise_floor, self.min_speech_energy)

            self.is_calibrated = True
            return True

        return False

    def _calculate_energy(self, audio_chunk: bytes) -> float:
        """Calculate RMS energy of audio chunk"""
        samples = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32)
        if len(samples) == 0:
            return 0.0

        # RMS energy
        rms = np.sqrt(np.mean(samples ** 2))
        return rms

    def _calculate_zero_crossing_rate(self, audio_chunk: bytes) -> float:
        """
        Calculate zero crossing rate - helps distinguish voice from noise.
        Voice typically has moderate ZCR, while noise has high ZCR.
        """
        samples = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32)
        if len(samples) < 2:
            return 0.0

        signs = np.sign(samples)
        signs[signs == 0] = 1  # Treat zeros as positive
        crossings = np.sum(np.abs(np.diff(signs)) > 0)

        return crossings / len(samples)

    def _calculate_spectral_centroid(self, audio_chunk: bytes) -> float:
        """
        Calculate spectral centroid - indicates "brightness" of sound.
        Voice typically has centroid in 500-2000 Hz range.
        """
        samples = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32)
        if len(samples) < 256:
            return 0.0

        # Apply window function
        windowed = samples * np.hanning(len(samples))

        # FFT
        fft = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(len(windowed), 1.0 / self.sample_rate)

        # Spectral centroid
        if np.sum(fft) == 0:
            return 0.0

        centroid = np.sum(freqs * fft) / np.sum(fft)
        return centroid

    def _calculate_voice_band_energy_ratio(self, audio_chunk: bytes) -> float:
        """
        Calculate ratio of energy in voice frequency band vs total.
        Voice should have high energy in 85-3500 Hz range.
        """
        samples = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32)
        if len(samples) < 256:
            return 0.0

        # Apply window
        windowed = samples * np.hanning(len(samples))

        # FFT
        fft = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(len(windowed), 1.0 / self.sample_rate)

        # Total energy
        total_energy = np.sum(fft ** 2)
        if total_energy == 0:
            return 0.0

        # Voice band energy
        voice_mask = (freqs >= self.voice_freq_low) & (freqs <= self.voice_freq_high)
        voice_energy = np.sum(fft[voice_mask] ** 2)

        return voice_energy / total_energy

    def update_noise_floor(self, energy: float, is_speech: bool):
        """Adaptively update noise floor during non-speech"""
        if not is_speech and self.is_calibrated:
            self.noise_floor_samples.append(energy)
            if len(self.noise_floor_samples) > self.noise_floor_window:
                self.noise_floor_samples.pop(0)

            # Update noise floor
            if len(self.noise_floor_samples) >= 10:
                sorted_samples = sorted(self.noise_floor_samples)
                percentile_idx = int(len(sorted_samples) * self.noise_floor_percentile / 100)
                new_floor = sorted_samples[percentile_idx]

                # Smooth update
                self.noise_floor = 0.9 * self.noise_floor + 0.1 * new_floor

    def is_voice(self, audio_chunk: bytes) -> tuple:
        """
        Comprehensive voice detection using multiple features.
        Returns (is_voice, confidence, features)
        """
        # Calculate features
        energy = self._calculate_energy(audio_chunk)
        zcr = self._calculate_zero_crossing_rate(audio_chunk)
        spectral_centroid = self._calculate_spectral_centroid(audio_chunk)
        voice_band_ratio = self._calculate_voice_band_energy_ratio(audio_chunk)

        # Add to energy history for smoothing
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

        # Decision logic
        confidence = 0.0

        # Energy check
        energy_threshold = self.noise_floor * self.speech_energy_ratio
        if smoothed_energy > energy_threshold:
            confidence += 0.4
        elif smoothed_energy > self.noise_floor * 1.5:
            confidence += 0.2

        # Voice band energy ratio check (should be > 0.3 for voice)
        if voice_band_ratio > 0.4:
            confidence += 0.3
        elif voice_band_ratio > 0.25:
            confidence += 0.15

        # ZCR check (voice typically 0.01-0.1, noise higher)
        if 0.01 < zcr < 0.15:
            confidence += 0.2
        elif zcr < 0.2:
            confidence += 0.1

        # Spectral centroid check (voice typically 300-2000 Hz)
        if 300 < spectral_centroid < 2000:
            confidence += 0.1

        is_voice = confidence >= 0.5

        return is_voice, confidence, features

    def apply_noise_gate(self, audio_chunk: bytes, threshold_db: float = -40) -> bytes:
        """Apply simple noise gate to reduce background noise"""
        samples = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float32)

        # Calculate dB level
        rms = np.sqrt(np.mean(samples ** 2))
        if rms == 0:
            return audio_chunk

        db = 20 * np.log10(rms / 32768)  # Relative to max int16

        if db < threshold_db:
            # Below threshold, attenuate
            attenuation = 0.1
            samples = samples * attenuation

        return samples.astype(np.int16).tobytes()


class MainProcessor:
    """Main audio processor with VAD and speech detection"""

    def __init__(self, config: AudioConfig, audio_queue: Queue):
        self.config = config
        self.audio_queue = audio_queue
        self.logger = logging.getLogger(__name__)
        self.vad = webrtcvad.Vad(self.config.vad_aggressiveness)
        self.audio_stream = None
        self.pyaudio_instance = None
        self.running = False

        # Advanced noise filter
        self.noise_filter = NoiseFilter(
            sample_rate=self.config.sample_rate,
            frame_duration_ms=self.config.chunk_duration_ms
        )

        # Speech detection state
        self.speech_frames = []
        self.is_speech_active = False
        self.speech_start_time = None
        self.last_speech_time = None

        # Ring buffer for pre-roll (capture audio before speech detected)
        self.pre_roll_buffer = []
        self.pre_roll_frames = 5  # Keep last 5 frames before speech

        # Consecutive frame tracking for robust detection (OPTIMIZED for low latency)
        self.consecutive_speech_frames = 0
        self.consecutive_silence_frames = 0
        self.min_speech_frames_start = 2  # Need 2 consecutive speech frames to start (was 3)
        self.min_silence_frames_end = 15   # Need 15 consecutive silence frames to end (was 15 = 450ms, now 240ms)

        # Statistics
        self.total_frames_processed = 0
        self.speech_frames_count = 0
    
    def get_supported_sample_rate(self, device_index: int) -> int:
        """Get the best supported sample rate for the device that's compatible with VAD"""
        vad_supported_rates = [8000, 16000, 32000, 48000]
        
        try:
            device_info = self.pyaudio_instance.get_device_info_by_index(device_index)
            default_rate = int(device_info['defaultSampleRate'])
            
            # Try VAD-compatible rates in order of preference
            preferred_rates = [32000, 16000, 48000, 8000]
            
            for rate in preferred_rates:
                try:
                    # Test if this rate is supported by the device
                    test_stream = self.pyaudio_instance.open(
                        format=pyaudio.paInt16,
                        channels=self.config.channels,
                        rate=rate,
                        input=True,
                        input_device_index=device_index,
                        frames_per_buffer=1024
                    )
                    test_stream.close()
                    self.logger.info(f"Device supports sample rate: {rate} Hz")
                    return rate
                except Exception:
                    continue
            
            # If no VAD rate works, use default and warn
            self.logger.warning(f"Device only supports {default_rate} Hz, VAD may not work properly")
            return default_rate
            
        except Exception as e:
            self.logger.error(f"Error detecting supported sample rates: {e}")
            return 16000  # Safe fallback
    
    def initialize_audio_stream(self, device_index: int):
        """Initialize PyAudio stream with dynamic sample rate detection"""
        try:
            self.pyaudio_instance = pyaudio.PyAudio()
            
            # Validate device
            device_info = self.pyaudio_instance.get_device_info_by_index(device_index)
            self.logger.info(f"Using audio device: {device_info['name']}")
            
            # Dynamically detect best supported sample rate
            optimal_rate = self.get_supported_sample_rate(device_index)
            
            # Update config to use the optimal rate
            self.config.config["sample_rate"] = optimal_rate
            
            # Recalculate chunk size based on new sample rate
            self.config.config["chunk_size"] = int(optimal_rate * self.config.chunk_duration_ms / 1000)
            
            self.logger.info(f"Using sample rate: {optimal_rate} Hz, chunk size: {self.config.chunk_size} samples")
            
            # Create audio stream
            self.audio_stream = self.pyaudio_instance.open(
                format=pyaudio.paInt16,
                channels=self.config.channels,
                rate=optimal_rate,
                input=True,
                input_device_index=device_index,
                frames_per_buffer=self.config.chunk_size
            )
            
            self.logger.info("Audio stream initialized successfully")
            return True
            
        except Exception as e:
            self.logger.error(f"Error initializing audio stream: {e}")
            return False
    
    def cleanup_audio_stream(self):
        """Clean up audio stream resources"""
        if self.audio_stream:
            self.audio_stream.stop_stream()
            self.audio_stream.close()
            self.audio_stream = None
        
        if self.pyaudio_instance:
            self.pyaudio_instance.terminate()
            self.pyaudio_instance = None
    
    def is_speech(self, audio_chunk: bytes) -> tuple:
        """
        Check if audio chunk contains speech using multi-layer detection.
        Returns (is_speech, confidence, details)
        """
        try:
            # VAD requires specific sample rates
            if self.config.sample_rate not in [8000, 16000, 32000, 48000]:
                self.logger.warning(f"Sample rate {self.config.sample_rate} not supported by VAD")
                return False, 0.0, {}

            # VAD requires specific chunk durations
            if self.config.chunk_duration_ms not in [10, 20, 30]:
                self.logger.warning(f"Chunk duration {self.config.chunk_duration_ms}ms not supported by VAD")
                return False, 0.0, {}

            # Layer 1: WebRTC VAD
            vad_result = self.vad.is_speech(audio_chunk, self.config.sample_rate)

            # Layer 2: Advanced noise filter analysis
            voice_result, voice_confidence, features = self.noise_filter.is_voice(audio_chunk)

            # Combine results - both must agree for high confidence
            if vad_result and voice_result:
                # Both agree it's speech
                combined_confidence = 0.5 + (voice_confidence * 0.5)
                is_speech = True
            elif vad_result or voice_result:
                # One thinks it's speech - use voice confidence to decide
                combined_confidence = voice_confidence
                is_speech = voice_confidence > 0.6  # Require higher confidence if disagreement
            else:
                # Neither thinks it's speech
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

    def process_speech_detection(self, audio_chunk: bytes, is_speech: bool, confidence: float = 0.0):
        """Process speech detection logic and manage speech segments with hysteresis"""
        current_time = time.time()
        self.total_frames_processed += 1

        # Update pre-roll buffer
        self.pre_roll_buffer.append(audio_chunk)
        if len(self.pre_roll_buffer) > self.pre_roll_frames:
            self.pre_roll_buffer.pop(0)

        if is_speech:
            self.consecutive_speech_frames += 1
            self.consecutive_silence_frames = 0
            self.speech_frames_count += 1
            self.last_speech_time = current_time

            if not self.is_speech_active:
                # Only start speech segment after minimum consecutive frames
                if self.consecutive_speech_frames >= self.min_speech_frames_start:
                    self.is_speech_active = True
                    self.speech_start_time = current_time
                    # Include pre-roll buffer
                    self.speech_frames = list(self.pre_roll_buffer)
                    self.logger.info(f"Speech started (confidence: {confidence:.2f})")

            if self.is_speech_active:
                # Accumulate speech frames
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

                # Only end speech segment after minimum consecutive silence frames
                if self.consecutive_silence_frames >= self.min_silence_frames_end:
                    # Also check if silence timeout exceeded
                    silence_duration = current_time - self.last_speech_time if self.last_speech_time else 0

                    if silence_duration > (self.config.silence_timeout_ms / 1000.0):
                        self.end_speech_segment()
    
    def end_speech_segment(self):
        """End current speech segment and send to processing queue"""
        if self.speech_frames:
            # Combine all speech frames
            combined_audio = b''.join(self.speech_frames)

            # Calculate speech duration
            speech_duration = time.time() - self.speech_start_time if self.speech_start_time else 0

            # Filter out very short segments (likely noise)
            min_speech_duration = 0.3  # Minimum 300ms
            if speech_duration >= min_speech_duration:
                # Send to child processor
                try:
                    self.audio_queue.put(combined_audio, timeout=1.0)
                    self.logger.info(f"Speech segment sent: {len(combined_audio)} bytes, {speech_duration:.2f}s")
                except Exception as e:
                    self.logger.error(f"Error sending audio to queue: {e}")
            else:
                self.logger.debug(f"Discarded short segment: {speech_duration:.2f}s")

        # Reset speech detection state
        self.is_speech_active = False
        self.speech_frames = []
        self.speech_start_time = None
        self.last_speech_time = None
        self.consecutive_speech_frames = 0
        self.consecutive_silence_frames = 0
        self.pre_roll_buffer = []
    
    def run(self, device_index: int):
        """Main processing loop with noise calibration"""
        if not self.initialize_audio_stream(device_index):
            self.logger.error("Failed to initialize audio stream")
            return

        # Update noise filter with actual sample rate
        self.noise_filter.sample_rate = self.config.sample_rate
        self.noise_filter.frame_size = self.config.chunk_size

        self.running = True
        self.logger.info("MainProcessor started")

        # Calibration phase
        self.logger.info("Calibrating noise floor... Please remain silent for a moment.")
        calibration_complete = False

        try:
            while self.running:
                # Read audio chunk
                try:
                    audio_chunk = self.audio_stream.read(self.config.chunk_size, exception_on_overflow=False)
                except Exception as read_error:
                    self.logger.warning(f"Audio read error: {read_error}")
                    continue

                # Calibration phase
                if not calibration_complete:
                    if self.noise_filter.calibrate(audio_chunk):
                        calibration_complete = True
                        self.logger.info(f"Noise floor calibrated: {self.noise_filter.noise_floor:.2f}")
                        self.logger.info("Listening for speech...")
                    continue

                # Check for speech using enhanced detection
                is_speech, confidence, details = self.is_speech(audio_chunk)

                # Debug logging for high-confidence events
                if is_speech and confidence > 0.7:
                    self.logger.debug(f"Speech detected: confidence={confidence:.2f}, "
                                     f"energy={details.get('energy', 0):.0f}, "
                                     f"voice_band_ratio={details.get('voice_band_ratio', 0):.2f}")

                # Process speech detection with confidence
                self.process_speech_detection(audio_chunk, is_speech, confidence)

        except KeyboardInterrupt:
            self.logger.info("Received interrupt signal")
        except Exception as e:
            self.logger.error(f"Error in MainProcessor: {e}")
            import traceback
            traceback.print_exc()
        finally:
            self.stop()
    
    def stop(self):
        """Stop the main processor"""
        self.running = False
        
        # End any active speech segment
        if self.is_speech_active:
            self.end_speech_segment()
        
        # Clean up audio stream
        self.cleanup_audio_stream()
        
        self.logger.info("MainProcessor stopped")


class AudioAgent:
    """Main audio processing agent"""
    
    def __init__(self, config_path: str = "config/audio_config.json"):
        self.config = AudioConfig(config_path)
        self.device_manager = AudioDeviceManager(self.config)
        self.audio_queue = Queue()
        self.child_process = None
        self.running = False
        
        # Setup logging
        self.setup_logging()
        self.logger = logging.getLogger(__name__)
        
    def setup_logging(self):
        """Setup logging configuration"""
        # Create logs directory if it doesn't exist
        os.makedirs("logs", exist_ok=True)
        
        # Configure logging
        log_level = os.getenv("AUDIO_LOG_LEVEL", "INFO").upper()
        logging.basicConfig(
            level=getattr(logging, log_level),
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler("logs/audio.log"),
                logging.StreamHandler(sys.stdout)
            ]
        )
        
        # Log system information for debugging
        import platform
        logger = logging.getLogger(__name__)
        logger.info(f"System: {platform.system()} {platform.release()}")
        logger.info(f"Python: {platform.python_version()}")
        logger.info(f"Platform: {platform.platform()}")
        logger.info(f"Machine: {platform.machine()}")
        logger.info(f"Processor: {platform.processor()}")
        
        # Log audio library availability
        try:
            import pyaudio
            logger.info(f"PyAudio version: {pyaudio.__version__}")
        except ImportError:
            logger.error("PyAudio not available")
        except Exception as e:
            logger.error(f"PyAudio error: {e}")
        
        try:
            import webrtcvad
            logger.info("WebRTC VAD available")
        except ImportError:
            logger.error("WebRTC VAD not available")
        except Exception as e:
            logger.error(f"WebRTC VAD error: {e}")
    
    def start_child_process(self):
        """Start the child processor"""
        try:
            child_processor = ChildProcessor(self.audio_queue, self.config)
            self.child_process = Process(target=child_processor.run)
            self.child_process.start()
            self.logger.info("Child processor started")
        except Exception: 
            self.logger.error("FAILED TO START CHILD PROCESSOR")
    
    def stop_child_process(self):
        """Stop the child processor"""
        if self.child_process and self.child_process.is_alive():
            # Send shutdown signal
            self.audio_queue.put(None)
            self.child_process.join(timeout=5.0)
            
            if self.child_process.is_alive():
                self.logger.warning("Child process did not terminate gracefully, forcing termination")
                self.child_process.terminate()
                self.child_process.join()
            
            self.logger.info("Child processor stopped")
    
    def run(self):
        """Main application loop"""
        self.logger.info("Audio Agent starting...")
        
        try:
            # Start child processor
            self.start_child_process()
            
            # Main loop
            self.running = True
            while self.running:
                try:
                    # Wait for input device
                    device_index = self.device_manager.wait_for_input_device()
                    
                    # Start main processor
                    main_processor = MainProcessor(self.config, self.audio_queue)
                    main_processor.run(device_index)
                    
                except KeyboardInterrupt:
                    self.logger.info("Received interrupt signal")
                    break
                except Exception as e:
                    self.logger.error(f"Error in main loop: {e}")
                    time.sleep(5.0)  # Wait before retrying
            
        finally:
            self.stop()
    
    def stop(self):
        """Stop the audio agent"""
        self.running = False
        self.stop_child_process()
        self.logger.info("Audio Agent stopped")


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description="Audio VAD Processor")
    parser.add_argument("--config", default="config/audio_config.json", help="Path to configuration file")
    parser.add_argument("--list-devices", action="store_true", help="List available audio devices")
    
    args = parser.parse_args()
    
    if args.list_devices:
        config = AudioConfig(args.config)
        device_manager = AudioDeviceManager(config)
        devices = device_manager.list_devices()
        
        print("Available audio devices:")
        for device in devices:
            vad_rates_str = ', '.join(map(str, device['supported_vad_rates'])) if device['supported_vad_rates'] else 'None'
            print(f"  Index: {device['index']}, Name: {device['name']}, "
                  f"Channels: {device['channels']}, Input: {device['is_input']}, "
                  f"VAD Rates: {vad_rates_str}")
        return
    
    # Start the audio agent
    agent = AudioAgent(args.config)
    agent.run()


if __name__ == "__main__":
    main()
