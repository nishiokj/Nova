"""
TTSEngine - Internal TTS abstraction for TTSWorker.

Handles actual speech synthesis (like Planner is internal to Agent).
"""

from abc import ABC, abstractmethod
from typing import Dict, Any
import subprocess
import platform
import logging


class TTSEngine(ABC):
    """Abstract TTS engine interface"""

    @abstractmethod
    def speak(self, text: str) -> bool:
        """
        Speak text. Returns True if successful.

        Args:
            text: Text to speak

        Returns:
            True if successful, False otherwise
        """
        pass

    @abstractmethod
    def cleanup(self) -> None:
        """Clean up resources."""
        pass


class MacOSSayEngine(TTSEngine):
    """macOS 'say' command engine"""

    def __init__(self, config: Dict[str, Any]):
        self.rate = config.get("rate", 180)
        self.voice = config.get("voice")  # Optional voice name
        self.engine_type = "macos_say"
        self.logger = logging.getLogger(self.__class__.__name__)

        # Log voice selection
        if self.voice:
            self.logger.info(f"Using macOS voice: {self.voice} at {self.rate} wpm")
        else:
            self.logger.info(f"Using default macOS voice at {self.rate} wpm")

    def speak(self, text: str) -> bool:
        try:
            # Build command with optional voice parameter
            cmd = ["say", "-r", str(self.rate)]
            if self.voice:
                cmd.extend(["-v", self.voice])
            cmd.append(text)

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            proc.wait()
            return proc.returncode == 0
        except Exception as e:
            self.logger.error(f"MacOS say failed: {e}")
            return False

    def cleanup(self):
        pass


class Pyttsx3Engine(TTSEngine):
    """pyttsx3 fallback engine"""

    def __init__(self, config: Dict[str, Any]):
        import pyttsx3
        self.engine = pyttsx3.init()
        self.engine.setProperty("rate", config.get("rate", 180))
        self.engine.setProperty("volume", config.get("volume", 0.8))

        # Set voice if specified
        voice_name = config.get("voice")
        if voice_name:
            voices = self.engine.getProperty("voices")
            for voice in voices:
                if voice_name.lower() in voice.name.lower():
                    self.engine.setProperty("voice", voice.id)
                    self.logger = logging.getLogger(self.__class__.__name__)
                    self.logger.info(f"Using pyttsx3 voice: {voice.name}")
                    break

        self.engine_type = "pyttsx3"
        self.logger = logging.getLogger(self.__class__.__name__)

    def speak(self, text: str) -> bool:
        try:
            self.engine.say(text)
            self.engine.runAndWait()
            return True
        except Exception as e:
            self.logger.error(f"pyttsx3 failed: {e}")
            return False

    def cleanup(self):
        if hasattr(self.engine, "stop"):
            self.engine.stop()


def create_tts_engine(config: Dict[str, Any]) -> TTSEngine:
    """
    Factory: Create appropriate TTS engine for platform

    Args:
        config: TTS configuration (rate, volume, etc.)

    Returns:
        TTSEngine instance

    Raises:
        RuntimeError: If no TTS engine is available
    """
    logger = logging.getLogger(__name__)

    # Try macOS 'say' first
    if platform.system() == "Darwin":
        try:
            result = subprocess.run(
                ["say", "-v", "?"],
                capture_output=True,
                check=True,
                timeout=2
            )
            logger.info("Using macOS 'say' TTS engine")
            return MacOSSayEngine(config)
        except Exception as e:
            logger.warning(f"macOS 'say' not available: {e}")

    # Fallback to pyttsx3
    try:
        import pyttsx3
        logger.info("Using pyttsx3 TTS engine")
        return Pyttsx3Engine(config)
    except Exception as e:
        logger.error(f"pyttsx3 not available: {e}")

    raise RuntimeError("No TTS engine available")
