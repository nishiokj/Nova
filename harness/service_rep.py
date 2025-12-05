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
        self._engine_type = "none"  # Track which engine we're using
        self._initialized = False
        self._speaking = False
        self._speak_queue = queue.PriorityQueue()
        self._speak_thread = None
        self._running = False
        self._items_queued = 0  # DIAGNOSTIC: track queue activity
        self._items_spoken = 0  # DIAGNOSTIC: track successful speaks
        self._last_error = None  # DIAGNOSTIC: track last error

    def initialize(self) -> bool:
        """Initialize TTS engine"""
        try:
            import sys
            print("🔊 TTS INIT: Starting...", flush=True)
            self.logger.info("🔊 TTS INIT: Starting initialization...", component="tts")
            # Try to import and use voice.py
            try:
                from voice import VoiceConfig, VoiceStreamer
                config = VoiceConfig(**self.voice_config)
                self._engine = VoiceStreamer(config)
                self._engine_type = "VoiceStreamer"
                print("✅ TTS: Using VoiceStreamer engine", flush=True)
                self.logger.info("🔊 TTS INIT: Using VoiceStreamer engine", component="tts")
            except Exception as e:
                # LOUD - print to stderr so user SEES the failure reason
                import traceback
                print(f"⚠️  TTS: VoiceStreamer failed: {e}", file=sys.stderr, flush=True)
                print(traceback.format_exc(), file=sys.stderr, flush=True)
                self.logger.warning(f"🔊 TTS INIT: VoiceStreamer not available ({e}), trying pyttsx3", component="tts")
                # Fallback to pyttsx3
                try:
                    import pyttsx3
                    self._engine = pyttsx3.init()
                    self._engine.setProperty('rate', self.voice_config.get('rate', 180))
                    self._engine.setProperty('volume', self.voice_config.get('volume', 0.8))
                    self._engine_type = "pyttsx3"
                    print("✅ TTS: Using pyttsx3 engine", flush=True)
                    self.logger.info("🔊 TTS INIT: Using pyttsx3 engine", component="tts")
                except Exception as e2:
                    # LOUD - print to stderr so user SEES the failure
                    print(f"❌ TTS: pyttsx3 also failed: {e2}", file=sys.stderr, flush=True)
                    self.logger.error(f"🔊 TTS INIT: pyttsx3 failed: {e2}", component="tts")
                    self._engine = None
                    self._engine_type = "none"

            self._initialized = True

            # Start speak thread
            self._running = True
            self._speak_thread = threading.Thread(target=self._speak_loop, daemon=True, name="TTS-Speaker")
            self._speak_thread.start()

            self.logger.info(
                f"🔊 TTS INIT: Complete. engine={self._engine_type}, thread={self._speak_thread.name}, "
                f"thread_alive={self._speak_thread.is_alive()}",
                component="tts"
            )

            # LOUD FAILURE: If no engine, print to stderr so user SEES it
            if self._engine_type == "none":
                import sys
                msg = (
                    "\n" + "="*60 + "\n"
                    "⚠️  TTS ENGINE NOT AVAILABLE - NO AUDIO OUTPUT!\n"
                    "    Install pyttsx3: pip install pyttsx3\n"
                    "    Or ensure voice.py VoiceStreamer is importable\n"
                    + "="*60 + "\n"
                )
                print(msg, file=sys.stderr)
                self.logger.warning(msg, component="tts")

            return True

        except Exception as e:
            import traceback
            self.logger.error(f"🔊 TTS INIT FAILED: {e}\n{traceback.format_exc()}", component="tts")
            return False

    def _speak_loop(self):
        """Background thread for speaking queued messages"""
        thread_id = threading.current_thread().name
        self.logger.info(f"🔊 TTS THREAD [{thread_id}]: Speak loop STARTED, waiting for items...", component="tts")

        while self._running:
            try:
                # Use timeout so we can check _running periodically and log health
                try:
                    response = self._speak_queue.get(timeout=5.0)
                except queue.Empty:
                    # Heartbeat log every 5s when idle
                    if self._running:
                        qsize = self._speak_queue.qsize()
                        self.logger.debug(
                            f"🔊 TTS THREAD [{thread_id}]: Heartbeat - queue_size={qsize}, "
                            f"queued={self._items_queued}, spoken={self._items_spoken}",
                            component="tts"
                        )
                    continue

                # Got an item!
                text_preview = response.text[:80].replace('\n', ' ') if response.text else "(empty)"
                self.logger.info(
                    f"🔊 TTS THREAD [{thread_id}]: DEQUEUED [{response.response_type.value}] "
                    f"text='{text_preview}...' (len={len(response.text)})",
                    component="tts"
                )

                try:
                    start_time = time.time()
                    self._speak_text(response.text)
                    duration_ms = (time.time() - start_time) * 1000
                    self._items_spoken += 1
                    self.logger.info(
                        f"🔊 TTS THREAD [{thread_id}]: SPOKE in {duration_ms:.0f}ms - "
                        f"total_spoken={self._items_spoken}",
                        component="tts"
                    )
                except Exception as speak_err:
                    import traceback
                    self._last_error = str(speak_err)
                    self.logger.error(
                        f"🔊 TTS THREAD [{thread_id}]: SPEAK FAILED: {speak_err}\n{traceback.format_exc()}",
                        component="tts"
                    )
                finally:
                    self._speak_queue.task_done()

            except Exception as e:
                import traceback
                self._last_error = str(e)
                self.logger.error(
                    f"🔊 TTS THREAD [{thread_id}]: LOOP ERROR: {e}\n{traceback.format_exc()}",
                    component="tts"
                )

        self.logger.info(f"🔊 TTS THREAD [{thread_id}]: Speak loop EXITING (_running=False)", component="tts")

    def _speak_text(self, text: str):
        """Actually speak the text"""
        import subprocess
        import platform

        text_preview = text[:60].replace('\n', ' ') if text else "(empty)"

        self._speaking = True
        try:
            self.logger.info(
                f"🔊 TTS SPEAK [{self._engine_type}]: Starting... text='{text_preview}...' (len={len(text)})",
                component="tts"
            )

            # On macOS, prefer the 'say' command - it's much more reliable than pyttsx3
            # pyttsx3's NSSpeechDriver has thread affinity issues that cause silent failures
            if platform.system() == "Darwin":
                try:
                    self.logger.info(f"🔊 TTS SPEAK: Using macOS 'say' command", component="tts")
                    rate = self.voice_config.get('rate', 180)
                    result = subprocess.run(
                        ["say", "-r", str(rate), text],
                        capture_output=True,
                        timeout=300  # 5 minute timeout for long text
                    )
                    if result.returncode == 0:
                        self.logger.info(f"🔊 TTS SPEAK: Complete!", component="tts")
                    else:
                        self.logger.warning(f"🔊 TTS SPEAK: say command returned {result.returncode}", component="tts")
                    return
                except subprocess.TimeoutExpired:
                    self.logger.warning("🔊 TTS SPEAK: say command timed out", component="tts")
                    return
                except Exception as e:
                    self.logger.warning(f"🔊 TTS SPEAK: say command failed ({e}), falling back to engine", component="tts")
                    # Fall through to other engines

            if not self._engine:
                # LOUD FAILURE - Don't silently swallow this!
                import sys
                msg = f"❌ TTS SILENT FAIL: No engine! Text lost: '{text_preview}...'"
                print(msg, file=sys.stderr)
                self.logger.error(msg, component="tts")
                return

            if hasattr(self._engine, 'speak_blocking'):
                # Prefer a single blocking speak to avoid streaming cut-offs
                self.logger.info(f"🔊 TTS SPEAK: Using speak_blocking()", component="tts")
                self._engine.speak_blocking(text)

            elif hasattr(self._engine, 'start_streaming'):
                # VoiceStreamer
                self.logger.info(f"🔊 TTS SPEAK: Using VoiceStreamer start_streaming()", component="tts")
                self._engine.start_streaming()
                self._engine.add_complete_text(text)
                wait_fn = getattr(self._engine, "wait_until_idle", None)
                if callable(wait_fn):
                    self.logger.info(f"🔊 TTS SPEAK: Waiting for VoiceStreamer to finish...", component="tts")
                    wait_fn()

            else:
                # pyttsx3 - WARNING: This has thread affinity issues on macOS
                self.logger.info(f"🔊 TTS SPEAK: Using pyttsx3 say() + runAndWait()", component="tts")
                self._engine.say(text)
                self.logger.info(f"🔊 TTS SPEAK: pyttsx3.say() done, calling runAndWait()...", component="tts")
                self._engine.runAndWait()
                self.logger.info(f"🔊 TTS SPEAK: pyttsx3.runAndWait() returned", component="tts")

            self.logger.info(f"🔊 TTS SPEAK: Complete!", component="tts")

        except Exception as e:
            import traceback
            self._last_error = str(e)
            self.logger.error(
                f"🔊 TTS SPEAK ERROR [{self._engine_type}]: {e}\n{traceback.format_exc()}",
                component="tts"
            )
            raise  # Re-raise so _speak_loop can log it too

        finally:
            self._speaking = False

    def speak(self, response: SpokenResponse):
        """Queue a response to be spoken"""
        text_preview = response.text[:60].replace('\n', ' ') if response.text else "(empty)"

        # DIAGNOSTIC: Check thread health before queuing
        thread_alive = self._speak_thread.is_alive() if self._speak_thread else False
        queue_size_before = self._speak_queue.qsize()

        self._items_queued += 1
        self._speak_queue.put(response)

        queue_size_after = self._speak_queue.qsize()

        self.logger.info(
            f"🔊 TTS QUEUE: [{response.response_type.value}] QUEUED #{self._items_queued} - "
            f"text='{text_preview}...' | queue_before={queue_size_before} → after={queue_size_after} | "
            f"thread_alive={thread_alive} | engine={self._engine_type}",
            component="tts"
        )

        # DIAGNOSTIC: Warn if thread is dead
        if not thread_alive:
            self.logger.error(
                f"🔊 TTS QUEUE: WARNING - TTS thread is DEAD! Items will NOT be spoken! "
                f"last_error={self._last_error}",
                component="tts"
            )

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
                "Done—here’s what I found.",
            ]
        }

        self._response_index = {}  # Track which response to use next

    def initialize(self) -> bool:
        """Initialize the ServiceRep"""
        import threading
        self.logger.info(
            f"🎯 SERVICE_REP.initialize CALLED from thread={threading.current_thread().name} | enabled={self.enabled}",
            component="service_rep"
        )
        result = self.tts.initialize()
        self.logger.info(
            f"🎯 SERVICE_REP.initialize RESULT={result} | tts_engine={self.tts._engine_type} | "
            f"tts_thread_alive={self.tts._speak_thread.is_alive() if self.tts._speak_thread else False}",
            component="service_rep"
        )
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
        import threading
        self.logger.info(
            f"🎯 SERVICE_REP.acknowledge_request CALLED from thread={threading.current_thread().name} | "
            f"enabled={self.enabled}",
            component="service_rep"
        )

        if not self.enabled:
            self.logger.warning("🎯 SERVICE_REP.acknowledge_request: SKIPPED - disabled!", component="service_rep")
            return

        acknowledgment = self.generate_acknowledgment(user_input, agent_action)
        if acknowledgment:
            self.logger.info(
                f"🎯 SERVICE_REP.acknowledge_request: Generated ack='{acknowledgment}', creating SpokenResponse...",
                component="service_rep"
            )
            response = SpokenResponse(
                text=acknowledgment,
                response_type=ResponseType.ACKNOWLEDGMENT,
                priority=0,  # High priority for acknowledgments
                metadata={"user_input": user_input, "agent_action": agent_action}
            )
            self._speak_and_notify(response)
            self.logger.info("🎯 SERVICE_REP.acknowledge_request: DONE", component="service_rep")
        else:
            self.logger.warning("🎯 SERVICE_REP.acknowledge_request: No acknowledgment generated!", component="service_rep")

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
        # DIAGNOSTIC: Log entry with full context
        import threading
        caller_thread = threading.current_thread().name
        text_preview = result_summary[:100].replace('\n', ' ') if result_summary else "(empty)"

        self.logger.info(
            f"🎯 SERVICE_REP.report_completion CALLED from thread={caller_thread} | "
            f"enabled={self.enabled} | text='{text_preview}...' (len={len(result_summary) if result_summary else 0})",
            component="service_rep"
        )

        if not self.enabled:
            self.logger.warning(
                f"🎯 SERVICE_REP.report_completion: SKIPPED - ServiceRep is DISABLED!",
                component="service_rep"
            )
            return

        if not result_summary or not result_summary.strip():
            self.logger.warning(
                f"🎯 SERVICE_REP.report_completion: SKIPPED - result_summary is empty!",
                component="service_rep"
            )
            return

        response = SpokenResponse(
            text=result_summary,
            response_type=ResponseType.COMPLETION,
            priority=1,
            metadata={"full_result": full_result}
        )

        self.logger.info(
            f"🎯 SERVICE_REP.report_completion: Created SpokenResponse, calling _speak_and_notify...",
            component="service_rep"
        )
        self._speak_and_notify(response)
        self.logger.info(
            f"🎯 SERVICE_REP.report_completion: _speak_and_notify returned",
            component="service_rep"
        )

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
        import threading
        text_preview = response.text[:80].replace('\n', ' ') if response.text else "(empty)"

        self.logger.info(
            f"🔔 _speak_and_notify ENTRY: [{response.response_type.value}] "
            f"thread={threading.current_thread().name} | text='{text_preview}...'",
            component="service_rep"
        )

        # DIAGNOSTIC: Check TTS state before calling
        tts_thread_alive = self.tts._speak_thread.is_alive() if self.tts._speak_thread else False
        tts_initialized = self.tts._initialized
        tts_engine_type = self.tts._engine_type
        tts_queue_size = self.tts._speak_queue.qsize()

        self.logger.info(
            f"🔔 _speak_and_notify TTS STATE: initialized={tts_initialized}, engine={tts_engine_type}, "
            f"thread_alive={tts_thread_alive}, queue_size={tts_queue_size}",
            component="service_rep"
        )

        if not tts_initialized:
            self.logger.error(
                f"🔔 _speak_and_notify: TTS NOT INITIALIZED! Speech will be lost!",
                component="service_rep"
            )

        if not tts_thread_alive:
            self.logger.error(
                f"🔔 _speak_and_notify: TTS THREAD IS DEAD! last_error={self.tts._last_error}",
                component="service_rep"
            )

        self.logger.info(f"🔔 _speak_and_notify: Calling tts.speak()...", component="service_rep")
        self.tts.speak(response)
        self.logger.info(
            f"🔔 _speak_and_notify: tts.speak() returned, new queue_size={self.tts._speak_queue.qsize()}",
            component="service_rep"
        )

        # Notify callbacks
        callback_count = len(self._response_callbacks)
        if callback_count > 0:
            self.logger.info(
                f"🔔 _speak_and_notify: Notifying {callback_count} callbacks...",
                component="service_rep"
            )

        for i, callback in enumerate(self._response_callbacks):
            try:
                callback(response)
                self.logger.debug(f"🔔 _speak_and_notify: Callback {i+1}/{callback_count} succeeded", component="service_rep")
            except Exception as e:
                import traceback
                self.logger.error(
                    f"🔔 _speak_and_notify: Callback {i+1}/{callback_count} FAILED: {e}\n{traceback.format_exc()}",
                    component="service_rep"
                )

        self.logger.info(f"🔔 _speak_and_notify EXIT", component="service_rep")

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
