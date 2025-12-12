"""
ServiceRep - Service Representative for TTS user communication.
Generates spoken acknowledgments and responses for the user.
"""

import sys
import os
import time
import threading
import queue
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Callable
from enum import Enum

# Add parent directory to path for voice module
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from .config import ServiceRepConfig, LLMConfig
from .llm_adapter import LLMAdapter, create_adapter, Message, MessageRole
from .logger import StructuredLogger


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

    def __init__(
        self,
        voice_config: Dict[str, Any] = None,
        speech_block_event: Optional[threading.Event] = None,
        cancel_event: Optional[threading.Event] = None,
        logger: Optional[StructuredLogger] = None
    ):
        self.logger = logger or StructuredLogger()
        self.voice_config = voice_config or {}
        self._engine = None
        self._engine_type = "none"  # Track which engine we're using
        self._initialized = False
        self._speaking = False
        self._speak_queue = queue.PriorityQueue()
        self._speak_thread = None
        self._running = False
        self._items_queued = 0  # DIAGNOSTIC: track queue activity
        self._items_spoken = 0  # DIAGNOSTIC: track successful speaks
        self._last_error = None  # DIAGNOSTIC: track last error
        self._speech_block_event = speech_block_event
        self._cancel_event = cancel_event  # For barge-in support
        self._current_proc = None  # Track current TTS subprocess for interruption

    def initialize(self) -> bool:
        """Initialize TTS engine"""
        try:
            import sys
            self.logger.system_init("tts", "starting")
            # Try to import and use voice.py
            try:
                from voice import VoiceConfig, VoiceStreamer
                config = VoiceConfig(**self.voice_config)
                self._engine = VoiceStreamer(config)
                self._engine_type = "VoiceStreamer"
                self.logger.system_init("tts", "ready", {"engine": "VoiceStreamer"})
            except Exception as e:
                self.logger.tts_event("voicestreamer_failed", {"error": str(e)})
                # Fallback to pyttsx3
                try:
                    import pyttsx3
                    self._engine = pyttsx3.init()
                    self._engine.setProperty('rate', self.voice_config.get('rate', 180))
                    self._engine.setProperty('volume', self.voice_config.get('volume', 0.8))
                    self._engine_type = "pyttsx3"
                    self.logger.system_init("tts", "ready", {"engine": "pyttsx3"})
                except Exception as e2:
                    self.logger.error(f"TTS init failed: {e2}", component="tts")
                    self._engine = None
                    self._engine_type = "none"

            self._initialized = True

            # Start speak thread
            self._running = True
            self._speak_thread = threading.Thread(target=self._speak_loop, daemon=True, name="TTS-Speaker")
            self._speak_thread.start()

            # LOUD FAILURE: If no engine, print to stderr so user SEES it
            if self._engine_type == "none":
                msg = "TTS ENGINE NOT AVAILABLE - NO AUDIO OUTPUT!"
                print(f"⚠️  {msg}", file=sys.stderr)
                self.logger.warning(msg, component="tts")

            return True

        except Exception as e:
            self.logger.error(f"TTS init failed: {e}", component="tts")
            return False

    def _speak_loop(self):
        """Background thread for speaking queued messages"""
        self.logger.tts_event("thread_started")

        while self._running:
            try:
                # Use timeout so we can check _running periodically
                try:
                    response = self._speak_queue.get(timeout=5.0)
                except queue.Empty:
                    # Heartbeat log every 5s when idle - DEBUG only
                    if self._running:
                        self.logger.heartbeat("tts", {
                            "queue": self._speak_queue.qsize(),
                            "spoken": self._items_spoken
                        })
                    continue

                try:
                    start_time = time.time()
                    self._speak_text(response.text)
                    duration_ms = (time.time() - start_time) * 1000
                    self._items_spoken += 1
                    self.logger.tts_event("spoke", {"ms": round(duration_ms), "total": self._items_spoken})
                except Exception as speak_err:
                    self._last_error = str(speak_err)
                    self.logger.error(f"TTS speak failed: {speak_err}", component="tts")
                finally:
                    self._speak_queue.task_done()

            except Exception as e:
                self._last_error = str(e)
                self.logger.error(f"TTS loop error: {e}", component="tts")

        self.logger.tts_event("thread_stopped")

    def _speak_text(self, text: str):
        """Actually speak the text"""
        import subprocess
        import platform

        self._speaking = True
        if self._speech_block_event:
            self._speech_block_event.set()
        try:
            # On macOS, prefer the 'say' command - more reliable than pyttsx3
            if platform.system() == "Darwin":
                try:
                    rate = self.voice_config.get('rate', 180)
                    # Use Popen for interruptibility (barge-in support)
                    self._current_proc = subprocess.Popen(
                        ["say", "-r", str(rate), text],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL
                    )
                    # Poll for completion while checking cancel_event
                    while self._current_proc.poll() is None:
                        if self._cancel_event and self._cancel_event.is_set():
                            self.logger.tts_event("barge_in_interrupt")
                            self._current_proc.terminate()
                            try:
                                self._current_proc.wait(timeout=0.5)
                            except subprocess.TimeoutExpired:
                                self._current_proc.kill()
                            return
                        time.sleep(0.05)  # Check every 50ms
                    if self._current_proc.returncode != 0:
                        self.logger.tts_event("say_error", {"code": self._current_proc.returncode})
                    return
                except Exception as e:
                    self.logger.tts_event("say_failed", {"error": str(e)})
                    # Fall through to other engines
                finally:
                    self._current_proc = None

            if not self._engine:
                import sys
                print(f"❌ TTS: No engine!", file=sys.stderr)
                self.logger.error("TTS no engine", component="tts")
                return

            if hasattr(self._engine, 'speak_blocking'):
                self._engine.speak_blocking(text)
            elif hasattr(self._engine, 'start_streaming'):
                # VoiceStreamer
                stop_fn = getattr(self._engine, "stop_streaming", None) or getattr(self._engine, "stop", None)
                if callable(stop_fn):
                    stop_fn()
                self._engine.start_streaming()
                self._engine.add_complete_text(text)
                wait_fn = getattr(self._engine, "wait_until_idle", None)
                if callable(wait_fn):
                    wait_fn()
                flush_fn = getattr(self._engine, "_flush_buffer", None)
                if callable(flush_fn):
                    flush_fn()
                stop_fn = getattr(self._engine, "stop_streaming", None) or getattr(self._engine, "stop", None)
                if callable(stop_fn):
                    stop_fn()
            else:
                # pyttsx3
                self._engine.say(text)
                self._engine.runAndWait()

        except Exception as e:
            self._last_error = str(e)
            self.logger.error(f"TTS speak error: {e}", component="tts")
            raise

        finally:
            self._speaking = False
            self._current_proc = None
            if self._speech_block_event:
                self._speech_block_event.clear()

    def speak(self, response: SpokenResponse):
        """Queue a response to be spoken"""
        thread_alive = self._speak_thread.is_alive() if self._speak_thread else False

        self._items_queued += 1
        self._speak_queue.put(response)

        self.logger.tts_event("queued", {
            "type": response.response_type.value,
            "len": len(response.text) if response.text else 0
        })

        if not thread_alive:
            self.logger.error("TTS thread dead", component="tts")

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

    def clear_queue(self):
        """Clear pending TTS queue (for barge-in support)"""
        cleared = 0
        while not self._speak_queue.empty():
            try:
                self._speak_queue.get_nowait()
                cleared += 1
            except queue.Empty:
                break
        if cleared > 0:
            self.logger.tts_event("queue_cleared", {"items": cleared})

    def stop(self):
        """Stop TTS and clear queue"""
        self._running = False
        self.clear_queue()

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

    def __init__(
        self,
        config: ServiceRepConfig,
        speech_block_event: Optional[threading.Event] = None,
        cancel_event: Optional[threading.Event] = None,
        logger: Optional[StructuredLogger] = None
    ):
        self.config = config
        self.logger = logger or StructuredLogger()
        self.enabled = config.enabled
        self._speech_block_event = speech_block_event
        self._cancel_event = cancel_event

        # LLM for generating acknowledgments
        self._llm: Optional[LLMAdapter] = None
        if config.llm_config:
            self._llm = create_adapter(config.llm_config, logger=self.logger)

        # TTS engine
        self.tts = TTSEngine(
            {
                "engine": config.voice_engine,
                "rate": config.voice_rate,
                "volume": config.voice_volume
            },
            speech_block_event=speech_block_event,
            cancel_event=cancel_event,
            logger=self.logger
        )

        # Response callbacks
        self._response_callbacks: List[Callable[[SpokenResponse], None]] = []

        # Load canned responses from config
        self._canned_responses = self._load_canned_responses()
        self._response_index = {}  # Track which response to use next

    def _load_canned_responses(self) -> Dict[str, List[str]]:
        """Load canned responses from config file"""
        import json
        from pathlib import Path

        config_path = Path(__file__).parent.parent / "config" / "service_rep_config.json"
        try:
            with open(config_path, 'r') as f:
                data = json.load(f)
                return data.get("canned_responses", {})
        except Exception:
            # Fallback to hardcoded defaults
            return {
                "thinking": [
                    "Got it—one sec.",
                    "On it.",
                    "Let me think for a moment.",
                    "Working on that now.",
                ],
                "searching": [
                    "Let me look that up quickly.",
                    "Searching for the latest.",
                    "Checking that now.",
                ],
                "executing": [
                    "Running that now.",
                    "Executing—I'll update you in a moment.",
                    "Got it, running that.",
                ],
                "error": [
                    "I ran into an issue.",
                    "Something went wrong.",
                    "I'm having trouble with that.",
                ],
                "clarification": [
                    "Quick clarification—what exactly do you want?",
                    "I want to be sure—can you specify?",
                    "Could you be a bit more specific?",
                ],
                "done": [
                    "All set.",
                    "Here you go.",
                    "Done—here's what I found.",
                ]
            }

    def initialize(self) -> bool:
        """Initialize the ServiceRep"""
        result = self.tts.initialize()
        self.logger.system_init("service_rep", "ready" if result else "failed", {
            "engine": self.tts._engine_type
        })
        return result

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
        use_llm: bool = False  # NEVER use LLM - canned responses are instant
    ) -> str:
        """
        Generate an acknowledgment for the user based on what the agent will do.
        ALWAYS uses canned responses for instant feedback (0ms vs 500-1500ms LLM).

        Args:
            user_input: What the user said
            agent_action: What the agent plans to do
            use_llm: IGNORED - always uses canned responses

        Returns:
            Acknowledgment text to speak (never empty)
        """
        if not self.enabled:
            return ""

        # ALWAYS use fast canned responses - LLM is too slow for acknowledgments
        action_lower = (agent_action or "").lower()
        input_lower = (user_input or "").lower()

        # Match based on action description
        if any(w in action_lower for w in ["search", "looking", "find", "look up"]):
            ack = self._get_canned_response("searching")
        elif any(w in action_lower for w in ["execute", "run", "command", "bash", "script"]):
            ack = self._get_canned_response("executing")
        elif any(w in action_lower for w in ["calculate", "compute", "math"]):
            ack = "Calculating that for you."
        elif any(w in action_lower for w in ["read", "get", "fetch", "retrieve"]):
            ack = "Getting that for you."
        elif any(w in action_lower for w in ["create", "write", "generate"]):
            ack = "Working on that."
        # Also match on user input for common patterns
        elif any(w in input_lower for w in ["what is", "what's", "how much", "price", "cost"]):
            ack = "Let me check that for you."
        elif any(w in input_lower for w in ["search", "find", "look up"]):
            ack = self._get_canned_response("searching")
        elif any(w in input_lower for w in ["time", "date", "weather"]):
            ack = "One moment."
        else:
            ack = self._get_canned_response("thinking")

        # NEVER return empty - always have a fallback
        if not ack:
            ack = "Working on it."

        self.logger.service_rep_acknowledgment(user_input, ack)
        return ack

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
                priority=0,
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

        if not result_summary or not result_summary.strip():
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

        # Notify callbacks
        for callback in self._response_callbacks:
            try:
                callback(response)
            except Exception as e:
                self.logger.error(f"Response callback failed: {e}", component="service_rep")

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

    def __init__(
        self,
        config: ServiceRepConfig,
        speech_block_event: Optional[threading.Event] = None,
        cancel_event: Optional[threading.Event] = None,
        logger: Optional[StructuredLogger] = None
    ):
        super().__init__(
            config,
            speech_block_event=speech_block_event,
            cancel_event=cancel_event,
            logger=logger
        )
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
