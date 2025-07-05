#!/usr/bin/env python3
"""
Voice Output Module - Text-to-Speech engine for streaming LLM responses
"""

import os
import sys
import time
import logging
import threading
from typing import Dict, Any, Optional, List, Callable
from queue import Queue, Empty
from dataclasses import dataclass
from datetime import datetime
import json

try:
    import pyttsx3
except ImportError:
    pyttsx3 = None

try:
    import pygame
except ImportError:
    pygame = None

try:
    import pyaudio
    import wave
except ImportError:
    pyaudio = None
    wave = None


@dataclass
class VoiceConfig:
    """Configuration for voice output"""
    engine: str = "pyttsx3"  # "pyttsx3", "espeak", "pygame", "system"
    voice_id: Optional[str] = None
    rate: int = 200  # Words per minute
    volume: float = 0.9  # 0.0 to 1.0
    pitch: int = 0  # -50 to 50
    output_device: Optional[str] = None
    chunk_size: int = 1024
    sample_rate: int = 22050
    streaming_enabled: bool = True
    sentence_delay: float = 0.1  # Delay between sentences
    word_delay: float = 0.05  # Delay between words for streaming


class VoiceOutputEngine:
    """Abstract base class for voice output engines"""
    
    def __init__(self, config: VoiceConfig):
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)
        self.is_initialized = False
        self.is_speaking = False
        self._stop_speaking = False
    
    def initialize(self) -> bool:
        """Initialize the voice engine"""
        raise NotImplementedError
    
    def speak(self, text: str, callback: Optional[Callable] = None) -> bool:
        """Speak text synchronously"""
        raise NotImplementedError
    
    def speak_async(self, text: str, callback: Optional[Callable] = None) -> bool:
        """Speak text asynchronously"""
        raise NotImplementedError
    
    def stop(self):
        """Stop current speech"""
        self._stop_speaking = True
    
    def cleanup(self):
        """Clean up resources"""
        pass
    
    def is_available(self) -> bool:
        """Check if this engine is available"""
        return True


class PyttsxEngine(VoiceOutputEngine):
    """PyTTSx3 voice engine implementation"""
    
    def __init__(self, config: VoiceConfig):
        super().__init__(config)
        self.engine = None
    
    def initialize(self) -> bool:
        """Initialize PyTTSx3 engine"""
        if pyttsx3 is None:
            self.logger.error("pyttsx3 not available")
            return False
        
        try:
            self.engine = pyttsx3.init()
            
            # Set voice properties
            if self.config.voice_id:
                voices = self.engine.getProperty('voices')
                for voice in voices:
                    if self.config.voice_id in voice.id:
                        self.engine.setProperty('voice', voice.id)
                        break
            
            self.engine.setProperty('rate', self.config.rate)
            self.engine.setProperty('volume', self.config.volume)
            
            self.is_initialized = True
            self.logger.info("PyTTSx3 engine initialized successfully")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to initialize PyTTSx3: {e}")
            return False
    
    def speak(self, text: str, callback: Optional[Callable] = None) -> bool:
        """Speak text using PyTTSx3"""
        if not self.is_initialized or not self.engine:
            return False
        
        try:
            self.is_speaking = True
            self._stop_speaking = False
            
            # Split text into sentences for better streaming
            sentences = self._split_into_sentences(text)
            
            for sentence in sentences:
                if self._stop_speaking:
                    break
                
                self.engine.say(sentence)
                self.engine.runAndWait()
                
                if callback:
                    callback(sentence)
                
                # Small delay between sentences
                time.sleep(self.config.sentence_delay)
            
            self.is_speaking = False
            return True
            
        except Exception as e:
            self.logger.error(f"Error in PyTTSx3 speak: {e}")
            self.is_speaking = False
            return False
    
    def speak_async(self, text: str, callback: Optional[Callable] = None) -> bool:
        """Speak text asynchronously"""
        thread = threading.Thread(target=self.speak, args=(text, callback), daemon=True)
        thread.start()
        return True
    
    def _split_into_sentences(self, text: str) -> List[str]:
        """Split text into sentences"""
        import re
        sentences = re.split(r'[.!?]+', text)
        return [s.strip() for s in sentences if s.strip()]
    
    def is_available(self) -> bool:
        """Check if PyTTSx3 is available"""
        return pyttsx3 is not None


class SystemEngine(VoiceOutputEngine):
    """System TTS engine (espeak, say, etc.)"""
    
    def __init__(self, config: VoiceConfig):
        super().__init__(config)
        self.tts_command = self._find_tts_command()
    
    def _find_tts_command(self) -> Optional[str]:
        """Find available system TTS command"""
        commands = {
            'espeak': 'espeak -s {rate} -v {voice} "{text}"',
            'say': 'say -r {rate} -v {voice} "{text}"',  # macOS
            'festival': 'echo "{text}" | festival --tts'  # Linux
        }
        
        for cmd, template in commands.items():
            if os.system(f"which {cmd} > /dev/null 2>&1") == 0:
                return template
        
        return None
    
    def initialize(self) -> bool:
        """Initialize system TTS"""
        if not self.tts_command:
            self.logger.error("No system TTS command found")
            return False
        
        self.is_initialized = True
        self.logger.info(f"System TTS initialized with command: {self.tts_command}")
        return True
    
    def speak(self, text: str, callback: Optional[Callable] = None) -> bool:
        """Speak text using system TTS"""
        if not self.is_initialized:
            return False
        
        try:
            self.is_speaking = True
            self._stop_speaking = False
            
            # Prepare command
            cmd = self.tts_command.format(
                rate=self.config.rate,
                voice=self.config.voice_id or "default",
                text=text.replace('"', '\\"')
            )
            
            # Execute TTS command
            os.system(cmd)
            
            if callback:
                callback(text)
            
            self.is_speaking = False
            return True
            
        except Exception as e:
            self.logger.error(f"Error in system TTS: {e}")
            self.is_speaking = False
            return False
    
    def speak_async(self, text: str, callback: Optional[Callable] = None) -> bool:
        """Speak text asynchronously"""
        thread = threading.Thread(target=self.speak, args=(text, callback), daemon=True)
        thread.start()
        return True
    
    def is_available(self) -> bool:
        """Check if system TTS is available"""
        return self.tts_command is not None


class VoiceStreamer:
    """Handles streaming text-to-speech for LLM responses"""
    
    def __init__(self, config: VoiceConfig):
        self.config = config
        self.logger = logging.getLogger(self.__class__.__name__)
        
        # Initialize voice engine
        self.engine = self._create_engine()
        
        # Streaming state
        self.text_queue = Queue()
        self.is_streaming = False
        self.stream_thread = None
        self.buffer = ""
        self.sentence_buffer = []
        
        # Callbacks
        self.speech_callbacks: List[Callable] = []
        
        # Initialize engine
        if self.engine and not self.engine.initialize():
            self.logger.error("Failed to initialize voice engine")
            self.engine = None
    
    def _create_engine(self) -> Optional[VoiceOutputEngine]:
        """Create appropriate voice engine"""
        engine_type = self.config.engine.lower()
        
        if engine_type == "pyttsx3":
            engine = PyttsxEngine(self.config)
        elif engine_type == "system":
            engine = SystemEngine(self.config)
        else:
            self.logger.error(f"Unknown engine type: {engine_type}")
            return None
        
        if not engine.is_available():
            self.logger.warning(f"Engine {engine_type} not available, trying fallback")
            # Try fallback engines
            for fallback_engine in [PyttsxEngine, SystemEngine]:
                try:
                    engine = fallback_engine(self.config)
                    if engine.is_available():
                        break
                except:
                    continue
            else:
                self.logger.error("No voice engines available")
                return None
        
        return engine
    
    def start_streaming(self):
        """Start streaming voice output"""
        if self.is_streaming or not self.engine:
            return
        
        self.is_streaming = True
        self.stream_thread = threading.Thread(target=self._streaming_loop, daemon=True)
        self.stream_thread.start()
        self.logger.info("Voice streaming started")
    
    def stop_streaming(self):
        """Stop streaming voice output"""
        if not self.is_streaming:
            return
        
        self.is_streaming = False
        if self.engine:
            self.engine.stop()
        
        if self.stream_thread:
            self.stream_thread.join(timeout=2.0)
        
        self.logger.info("Voice streaming stopped")
    
    def add_text_chunk(self, text_chunk: str):
        """Add text chunk to streaming queue"""
        if not self.is_streaming:
            return
        
        self.text_queue.put(text_chunk)
    
    def add_complete_text(self, text: str):
        """Add complete text and signal end of stream"""
        if not self.is_streaming:
            return
        
        self.text_queue.put(text)
        self.text_queue.put(None)  # Signal end of stream
    
    def _streaming_loop(self):
        """Main streaming loop"""
        while self.is_streaming:
            try:
                # Get text chunk with timeout
                text_chunk = self.text_queue.get(timeout=0.5)
                
                if text_chunk is None:
                    # End of stream signal
                    self._flush_buffer()
                    continue
                
                # Process text chunk
                self._process_text_chunk(text_chunk)
                
            except Empty:
                continue
            except Exception as e:
                self.logger.error(f"Error in streaming loop: {e}")
    
    def _process_text_chunk(self, text_chunk: str):
        """Process incoming text chunk"""
        self.buffer += text_chunk
        
        # Check for complete sentences
        sentences = self._extract_sentences(self.buffer)
        
        for sentence in sentences:
            if sentence.strip():
                self._speak_sentence(sentence)
                
                # Notify callbacks
                for callback in self.speech_callbacks:
                    try:
                        callback(sentence)
                    except Exception as e:
                        self.logger.error(f"Error in speech callback: {e}")
    
    def _extract_sentences(self, text: str) -> List[str]:
        """Extract complete sentences from buffer"""
        import re
        
        # Split on sentence boundaries
        sentences = re.split(r'([.!?]+)', text)
        
        complete_sentences = []
        remaining_text = ""
        
        for i in range(0, len(sentences) - 1, 2):
            if i + 1 < len(sentences):
                sentence = sentences[i] + sentences[i + 1]
                complete_sentences.append(sentence)
            else:
                remaining_text = sentences[i]
        
        # Update buffer with remaining text
        if len(sentences) % 2 == 1:
            remaining_text = sentences[-1]
        
        self.buffer = remaining_text
        return complete_sentences
    
    def _speak_sentence(self, sentence: str):
        """Speak a single sentence"""
        if not self.engine:
            return
        
        try:
            # Speak asynchronously to avoid blocking
            self.engine.speak_async(sentence)
            
            # Add slight delay for natural speech
            time.sleep(self.config.sentence_delay)
            
        except Exception as e:
            self.logger.error(f"Error speaking sentence: {e}")
    
    def _flush_buffer(self):
        """Flush remaining text in buffer"""
        if self.buffer.strip():
            self._speak_sentence(self.buffer)
            self.buffer = ""
    
    def add_speech_callback(self, callback: Callable):
        """Add callback for speech events"""
        self.speech_callbacks.append(callback)
    
    def remove_speech_callback(self, callback: Callable):
        """Remove speech callback"""
        if callback in self.speech_callbacks:
            self.speech_callbacks.remove(callback)
    
    def is_speaking(self) -> bool:
        """Check if currently speaking"""
        return self.engine.is_speaking if self.engine else False
    
    def get_voice_info(self) -> Dict[str, Any]:
        """Get voice engine information"""
        info = {
            "engine": self.config.engine,
            "rate": self.config.rate,
            "volume": self.config.volume,
            "streaming_enabled": self.config.streaming_enabled,
            "is_initialized": self.engine is not None and self.engine.is_initialized,
            "is_streaming": self.is_streaming
        }
        
        if self.engine:
            info["engine_type"] = self.engine.__class__.__name__
        
        return info
    
    def cleanup(self):
        """Clean up voice streamer resources"""
        self.stop_streaming()
        if self.engine:
            self.engine.cleanup()
        self.logger.info("Voice streamer cleaned up")


# Factory functions
def create_voice_config(config_dict: Dict[str, Any]) -> VoiceConfig:
    """Create VoiceConfig from dictionary"""
    return VoiceConfig(**config_dict)


def create_voice_streamer(config: VoiceConfig) -> VoiceStreamer:
    """Create VoiceStreamer instance"""
    return VoiceStreamer(config)


def create_voice_streamer_from_dict(config_dict: Dict[str, Any]) -> VoiceStreamer:
    """Create VoiceStreamer from configuration dictionary"""
    config = create_voice_config(config_dict)
    return create_voice_streamer(config)