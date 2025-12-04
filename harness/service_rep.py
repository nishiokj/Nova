"""
ServiceRep - Service Representative for TTS user communication.
Generates spoken acknowledgments and responses for the user.
"""

import sys
import os
import threading
import queue
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Callable
from enum import Enum

# Add parent directory to path for voice module
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from .config import ServiceRepConfig, LLMConfig
from .llm_adapter import LLMAdapter, create_adapter, Message, MessageRole
from .logger import get_logger


class ResponseType(Enum):
    """Types of ServiceRep responses"""
    ACKNOWLEDGMENT = "acknowledgment"  # Brief ack of user request
    PROGRESS = "progress"              # Update on what agent is doing
    COMPLETION = "completion"          # Final response to user
    ERROR = "error"                    # Error message
    CLARIFICATION = "clarification"    # Asking for clarification


@dataclass
class SpokenResponse:
    """A response to be spoken to the user"""
    text: str
    response_type: ResponseType
    priority: int = 1  # 0 = highest priority
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __lt__(self, other):
        return self.priority < other.priority


class TTSEngine:
    """
    Text-to-speech engine wrapper.
    Integrates with the voice.py module.
    """

    def __init__(self, voice_config: Dict[str, Any] = None):
        self.logger = get_logger()
        self.voice_config = voice_config or {}
        self._engine = None
        self._initialized = False
        self._speaking = False
        self._speak_queue = queue.PriorityQueue()
        self._speak_thread = None
        self._running = False

    def initialize(self) -> bool:
        """Initialize TTS engine"""
        try:
            # Try to import and use voice.py
            try:
                from voice import VoiceConfig, VoiceStreamer
                config = VoiceConfig(**self.voice_config)
                self._engine = VoiceStreamer(config)
                self.logger.info("Initialized voice streamer", component="tts")
            except ImportError:
                # Fallback to pyttsx3
                try:
                    import pyttsx3
                    self._engine = pyttsx3.init()
                    self._engine.setProperty('rate', self.voice_config.get('rate', 180))
                    self._engine.setProperty('volume', self.voice_config.get('volume', 0.8))
                    self.logger.info("Initialized pyttsx3 engine", component="tts")
                except ImportError:
                    self.logger.warning("No TTS engine available", component="tts")
                    self._engine = None

            self._initialized = True

            # Start speak thread
            self._running = True
            self._speak_thread = threading.Thread(target=self._speak_loop, daemon=True)
            self._speak_thread.start()

            return True

        except Exception as e:
            self.logger.error(f"Failed to initialize TTS: {e}", component="tts")
            return False

    def _speak_loop(self):
        """Background thread for speaking queued messages"""
        while self._running:
            try:
                response = self._speak_queue.get(timeout=0.5)
                self._speak_text(response.text)
                self._speak_queue.task_done()
            except queue.Empty:
                continue
            except Exception as e:
                self.logger.error(f"TTS speak error: {e}", component="tts")

    def _speak_text(self, text: str):
        """Actually speak the text"""
        if not self._engine:
            self.logger.info(f"[TTS] {text}", component="tts")
            return

        self._speaking = True
        try:
            if hasattr(self._engine, 'start_streaming'):
                # VoiceStreamer
                self._engine.start_streaming()
                self._engine.add_complete_text(text)
            else:
                # pyttsx3
                self._engine.say(text)
                self._engine.runAndWait()
        except Exception as e:
            self.logger.error(f"TTS error: {e}", component="tts")
        finally:
            self._speaking = False

    def speak(self, response: SpokenResponse):
        """Queue a response to be spoken"""
        self.logger.tts_output(response.text)
        self._speak_queue.put(response)

    def speak_now(self, text: str, response_type: ResponseType = ResponseType.ACKNOWLEDGMENT):
        """Immediately speak text (adds to front of queue)"""
        response = SpokenResponse(
            text=text,
            response_type=response_type,
            priority=0
        )
        self.speak(response)

    @property
    def is_speaking(self) -> bool:
        return self._speaking

    def stop(self):
        """Stop TTS and clear queue"""
        self._running = False
        # Clear queue
        while not self._speak_queue.empty():
            try:
                self._speak_queue.get_nowait()
            except queue.Empty:
                break

        if self._speak_thread:
            self._speak_thread.join(timeout=2.0)

    def cleanup(self):
        """Clean up resources"""
        self.stop()
        if self._engine and hasattr(self._engine, 'cleanup'):
            self._engine.cleanup()


class ServiceRep:
    """
    Service Representative - Handles verbal communication with the user.
    Generates natural acknowledgments and responses via TTS.
    """

    def __init__(self, config: ServiceRepConfig):
        self.config = config
        self.logger = get_logger()
        self.enabled = config.enabled

        # LLM for generating acknowledgments
        self._llm: Optional[LLMAdapter] = None
        if config.llm_config:
            self._llm = create_adapter(config.llm_config)

        # TTS engine
        self.tts = TTSEngine({
            "engine": config.voice_engine,
            "rate": config.voice_rate,
            "volume": config.voice_volume
        })

        # Response callbacks
        self._response_callbacks: List[Callable[[SpokenResponse], None]] = []

        # Canned responses for common situations
        self._canned_responses = {
            "thinking": [
                "Let me think about that.",
                "Working on it.",
                "One moment please.",
                "I'm on it.",
            ],
            "searching": [
                "Let me search for that.",
                "Looking that up for you.",
                "Searching now.",
            ],
            "executing": [
                "Running that for you.",
                "Executing now.",
                "On it.",
            ],
            "error": [
                "I ran into an issue.",
                "Something went wrong.",
                "I'm having trouble with that.",
            ],
            "clarification": [
                "Could you clarify what you mean?",
                "I'm not sure I understand.",
                "Could you be more specific?",
            ],
            "done": [
                "Done.",
                "All set.",
                "Here you go.",
            ]
        }

        self._response_index = {}  # Track which response to use next

    def initialize(self) -> bool:
        """Initialize the ServiceRep"""
        return self.tts.initialize()

    def _get_canned_response(self, category: str) -> str:
        """Get next canned response for category (round-robin)"""
        if category not in self._canned_responses:
            return ""

        responses = self._canned_responses[category]
        index = self._response_index.get(category, 0)
        response = responses[index]
        self._response_index[category] = (index + 1) % len(responses)
        return response

    def generate_acknowledgment(
        self,
        user_input: str,
        agent_action: str,
        use_llm: bool = True
    ) -> str:
        """
        Generate an acknowledgment for the user based on what the agent will do.

        Args:
            user_input: What the user said
            agent_action: What the agent plans to do
            use_llm: Whether to use LLM or canned responses

        Returns:
            Acknowledgment text to speak
        """
        if not self.enabled:
            return ""

        # Try LLM-generated acknowledgment
        if use_llm and self._llm:
            try:
                prompt = self.config.acknowledgment_prompt.format(
                    user_input=user_input,
                    agent_action=agent_action
                )

                messages = [
                    Message(
                        MessageRole.SYSTEM,
                        "You are a friendly voice assistant. Generate brief, natural spoken responses. Keep it under 15 words."
                    ),
                    Message(MessageRole.USER, prompt)
                ]

                response = self._llm.complete(messages, max_tokens=50, temperature=0.7)
                acknowledgment = response.content.strip()

                # Clean up any quotes or formatting
                acknowledgment = acknowledgment.strip('"\'')

                self.logger.service_rep_acknowledgment(user_input, acknowledgment)
                return acknowledgment

            except Exception as e:
                self.logger.error(f"LLM acknowledgment failed: {e}", component="service_rep")

        # Fallback to canned responses based on action keywords
        action_lower = agent_action.lower()
        if "search" in action_lower or "looking" in action_lower:
            return self._get_canned_response("searching")
        elif "execute" in action_lower or "run" in action_lower:
            return self._get_canned_response("executing")
        elif "think" in action_lower or "analyz" in action_lower:
            return self._get_canned_response("thinking")
        else:
            return self._get_canned_response("thinking")

    def acknowledge_request(self, user_input: str, agent_action: str):
        """
        Acknowledge a user request and speak it.

        Args:
            user_input: What the user said
            agent_action: What the agent plans to do
        """
        if not self.enabled:
            return

        acknowledgment = self.generate_acknowledgment(user_input, agent_action)
        if acknowledgment:
            response = SpokenResponse(
                text=acknowledgment,
                response_type=ResponseType.ACKNOWLEDGMENT,
                priority=0,  # High priority for acknowledgments
                metadata={"user_input": user_input, "agent_action": agent_action}
            )
            self._speak_and_notify(response)

    def report_progress(self, progress_message: str):
        """
        Report progress to the user.

        Args:
            progress_message: Brief description of current progress
        """
        if not self.enabled:
            return

        response = SpokenResponse(
            text=progress_message,
            response_type=ResponseType.PROGRESS,
            priority=1,
            metadata={}
        )
        self._speak_and_notify(response)

    def report_completion(self, result_summary: str, full_result: Optional[str] = None):
        """
        Report completion of a task.

        Args:
            result_summary: Brief spoken summary
            full_result: Full result (for display, not spoken)
        """
        if not self.enabled:
            return

        response = SpokenResponse(
            text=result_summary,
            response_type=ResponseType.COMPLETION,
            priority=1,
            metadata={"full_result": full_result}
        )
        self._speak_and_notify(response)

    def report_error(self, error_message: str, technical_details: Optional[str] = None):
        """
        Report an error to the user.

        Args:
            error_message: User-friendly error message
            technical_details: Technical details (for logging)
        """
        if not self.enabled:
            return

        response = SpokenResponse(
            text=error_message,
            response_type=ResponseType.ERROR,
            priority=0,  # Errors are high priority
            metadata={"technical_details": technical_details}
        )
        self._speak_and_notify(response)

    def ask_clarification(self, question: str):
        """
        Ask the user for clarification.

        Args:
            question: The clarification question
        """
        if not self.enabled:
            return

        response = SpokenResponse(
            text=question,
            response_type=ResponseType.CLARIFICATION,
            priority=0,
            metadata={}
        )
        self._speak_and_notify(response)

    def speak_text(self, text: str, response_type: ResponseType = ResponseType.COMPLETION):
        """
        Speak arbitrary text.

        Args:
            text: Text to speak
            response_type: Type of response
        """
        if not self.enabled:
            return

        response = SpokenResponse(
            text=text,
            response_type=response_type,
            priority=1,
            metadata={}
        )
        self._speak_and_notify(response)

    def _speak_and_notify(self, response: SpokenResponse):
        """Speak response and notify callbacks"""
        self.tts.speak(response)

        for callback in self._response_callbacks:
            try:
                callback(response)
            except Exception as e:
                self.logger.error(f"Response callback error: {e}", component="service_rep")

    def add_response_callback(self, callback: Callable[[SpokenResponse], None]):
        """Add callback for spoken responses"""
        self._response_callbacks.append(callback)

    def remove_response_callback(self, callback: Callable[[SpokenResponse], None]):
        """Remove response callback"""
        if callback in self._response_callbacks:
            self._response_callbacks.remove(callback)

    @property
    def is_speaking(self) -> bool:
        """Check if currently speaking"""
        return self.tts.is_speaking

    def wait_for_speech(self, timeout: float = 30.0):
        """Wait for current speech to finish"""
        import time
        start = time.time()
        while self.is_speaking and (time.time() - start) < timeout:
            time.sleep(0.1)

    def enable(self):
        """Enable ServiceRep"""
        self.enabled = True
        self.config.enabled = True

    def disable(self):
        """Disable ServiceRep"""
        self.enabled = False
        self.config.enabled = False

    def cleanup(self):
        """Clean up resources"""
        self.tts.cleanup()


class StreamingServiceRep(ServiceRep):
    """
    ServiceRep that supports streaming LLM responses.
    Speaks chunks as they arrive for lower latency.
    """

    def __init__(self, config: ServiceRepConfig):
        super().__init__(config)
        self._buffer = ""
        self._buffer_threshold = 50  # Chars before speaking

    def stream_response_chunk(self, chunk: str):
        """
        Process a streaming response chunk.
        Buffers until enough text for natural speech.
        """
        if not self.enabled:
            return

        self._buffer += chunk

        # Check for sentence boundaries or buffer threshold
        sentences = self._extract_speakable_sentences()
        for sentence in sentences:
            if sentence.strip():
                self.speak_text(sentence, ResponseType.COMPLETION)

    def _extract_speakable_sentences(self) -> List[str]:
        """Extract complete sentences from buffer"""
        import re

        sentences = []
        # Split on sentence boundaries
        parts = re.split(r'([.!?]+)', self._buffer)

        complete_text = ""
        remaining = ""

        for i in range(0, len(parts) - 1, 2):
            if i + 1 < len(parts):
                sentence = parts[i] + parts[i + 1]
                if len(sentence.strip()) > 10:  # Minimum sentence length
                    sentences.append(sentence)
            else:
                remaining = parts[i]

        # Keep remaining text in buffer
        if len(parts) % 2 == 1:
            remaining = parts[-1]

        self._buffer = remaining
        return sentences

    def flush_buffer(self):
        """Speak any remaining buffered text"""
        if self._buffer.strip():
            self.speak_text(self._buffer.strip(), ResponseType.COMPLETION)
            self._buffer = ""
