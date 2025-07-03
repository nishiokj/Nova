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
        
    def list_devices(self) -> List[Dict[str, Any]]:
        """List all available audio devices"""
        try:
            p = pyaudio.PyAudio()
            devices = []
            
            for i in range(p.get_device_count()):
                info = p.get_device_info_by_index(i)
                devices.append({
                    'index': i,
                    'name': info['name'],
                    'channels': info['maxInputChannels'],
                    'sample_rate': info['defaultSampleRate'],
                    'is_input': info['maxInputChannels'] > 0
                })
            
            p.terminate()
            return devices
        except Exception as e:
            self.logger.error(f"Error listing audio devices: {e}")
            return []
    
    def find_input_device(self) -> Optional[int]:
        """Find suitable input device based on configuration"""
        devices = self.list_devices()
        
        # Filter input devices only
        input_devices = [d for d in devices if d['is_input']]
        
        if not input_devices:
            self.logger.warning("No input devices found")
            return None
        
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
        
        # Use first available input device
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
                frame_rate=32000,
                channels=self.config.channels
            )
            
            # Convert to wav format in memory
            wav_data = audio_segment.export(format="wav").read()
            
            # Create AudioData object
            audio_data_obj = sr.AudioData(wav_data, 32000, 2)
            
            # Perform speech recognition
            text = self.recognizer.recognize_google(audio_data_obj)
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
                    
                    if transcript:
                        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        speech_log = f"[{timestamp}] SPEECH: {transcript}"
                        self.logger.info(speech_log)
                        
                        # Log to speech.logs file
                        with open("logs/speech.logs", "a", encoding="utf-8") as f:
                            f.write(speech_log + "\n")
                
                else:
                    # Sleep when queue is empty
                    time.sleep(0.1)
                    
            except Exception as e:
                self.logger.error(f"Error in ChildProcessor: {e}")
                time.sleep(1.0)
        
        self.logger.info("ChildProcessor stopped")


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
        
        # Speech detection state
        self.speech_frames = []
        self.is_speech_active = False
        self.speech_start_time = None
        self.last_speech_time = None
    
    def initialize_audio_stream(self, device_index: int):
        """Initialize PyAudio stream"""
        try:
            self.pyaudio_instance = pyaudio.PyAudio()
            
            # Validate device
            device_info = self.pyaudio_instance.get_device_info_by_index(device_index)
            self.logger.info(f"Using audio device: {device_info['name']}")
            
            # Force 16000 Hz for VAD compatibility, we'll resample if needed
            hardware_rate = 44100  # Common hardware rate
            vad_rate = 32000      # VAD compatible rate
            
            # Store both rates
            self.hardware_rate = hardware_rate
            self.vad_rate = vad_rate
            
            # Update config to use VAD rate for processing
            self.config.config["sample_rate"] = vad_rate
            
            self.logger.info(f"Using hardware rate: {hardware_rate} Hz, VAD rate: {vad_rate} Hz")
            
            # Create audio stream
            self.audio_stream = self.pyaudio_instance.open(
                format=pyaudio.paInt16,
                channels=self.config.channels,
                rate=vad_rate,
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
    
    def is_speech(self, audio_chunk: bytes) -> bool:
        """Check if audio chunk contains speech using VAD"""
        try:
            # VAD requires specific sample rates
            if self.config.sample_rate not in [8000, 16000, 32000, 48000]:
                self.logger.warning(f"Sample rate {self.config.sample_rate} not supported by VAD")
                return False
            
            # VAD requires specific chunk durations
            if self.config.chunk_duration_ms not in [10, 20, 30]:
                self.logger.warning(f"Chunk duration {self.config.chunk_duration_ms}ms not supported by VAD")
                return False
            
            return self.vad.is_speech(audio_chunk, self.config.sample_rate)
            
        except Exception as e:
            self.logger.error(f"Error in VAD processing: {e}")
            return False
    
    def process_speech_detection(self, audio_chunk: bytes, is_speech: bool):
        """Process speech detection logic and manage speech segments"""
        current_time = time.time()
        
        if is_speech:
            self.last_speech_time = current_time
            
            if not self.is_speech_active:
                # Start of speech detected
                self.is_speech_active = True
                self.speech_start_time = current_time
                self.speech_frames = []
                self.logger.debug("Speech started")
            
            # Accumulate speech frames
            self.speech_frames.append(audio_chunk)
            
        else:
            # No speech detected
            if self.is_speech_active:
                silence_duration = current_time - self.last_speech_time
                
                if silence_duration > (self.config.silence_timeout_ms / 1000.0):
                    # End of speech detected
                    self.end_speech_segment()
    
    def end_speech_segment(self):
        """End current speech segment and send to processing queue"""
        if self.speech_frames:
            # Combine all speech frames
            combined_audio = b''.join(self.speech_frames)
            
            # Send to child processor
            try:
                self.audio_queue.put(combined_audio, timeout=1.0)
                self.logger.debug(f"Speech segment sent to processor ({len(combined_audio)} bytes)")
            except Exception as e:
                self.logger.error(f"Error sending audio to queue: {e}")
        
        # Reset speech detection state
        self.is_speech_active = False
        self.speech_frames = []
        self.speech_start_time = None
        self.last_speech_time = None
    
    def run(self, device_index: int):
        """Main processing loop"""
        if not self.initialize_audio_stream(device_index):
            self.logger.error("Failed to initialize audio stream")
            return
        
        self.running = True
        self.logger.info("MainProcessor started")
        
        try:
            while self.running:
                # Read audio chunk
                audio_chunk = self.audio_stream.read(self.config.chunk_size)
                
                # Check for speech
                is_speech = self.is_speech(audio_chunk)
                
                # Process speech detection
                self.process_speech_detection(audio_chunk, is_speech)
                
        except KeyboardInterrupt:
            self.logger.info("Received interrupt signal")
        except Exception as e:
            self.logger.info(f"Error in MainProcessor: {e}")
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
    
    def start_child_process(self):
        """Start the child processor"""
        child_processor = ChildProcessor(self.audio_queue, self.config)
        self.child_process = Process(target=child_processor.run)
        self.child_process.start()
        self.logger.info("Child processor started")
    
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
            print(f"  Index: {device['index']}, Name: {device['name']}, "
                  f"Channels: {device['channels']}, Input: {device['is_input']}")
        return
    
    # Start the audio agent
    agent = AudioAgent(args.config)
    agent.run()


if __name__ == "__main__":
    main()
