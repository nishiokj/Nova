"""
ServiceRep - Event-driven Service Representative (Refactored).

Responsibilities:
1. Listen to user speech (TranscriptionCompleteEvent)
2. Classify intent (stop, clarification, addition, normal request)
3. Route tasks to appropriate tier
4. Generate acknowledgments and responses
5. Publish TTS events (modality-agnostic)

This is a complete refactoring to be event-driven and decoupled from voice/TTS.
"""

import time
import threading
import queue
import random
import re
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List
from enum import Enum
import json
from pathlib import Path

from communication.events import (
    Event, EventType,
    TranscriptionCompleteEvent,
    AgentRequestSubmittedEvent,
    AgentResponseCompleteEvent,
    AgentProgressEvent,
    TTSRequestedEvent,
    StreamingChunkEvent,
)
from communication.event_bus import EventBusProtocol
from services.intent_classifier import (
    HybridIntentClassifier,
    UserIntent,
    IntentClassification,
    create_intent_classifier,
)
from services.router import Router, TaskClassification
from util.config import ServiceRepConfig, LLMConfig
from util.logger import StructuredLogger


class ResponseType(Enum):
    """Types of ServiceRep responses"""
    ACKNOWLEDGMENT = "acknowledgment"
    PROGRESS = "progress"
    COMPLETION = "completion"
    ERROR = "error"
    CLARIFICATION = "clarification"


@dataclass
class ServiceResponse:
    """
    Modality-agnostic response from ServiceRep.

    This represents WHAT to communicate, not HOW.
    The delivery mechanism (TTS, text, UI) is decided downstream.
    """
    text: str
    response_type: ResponseType
    priority: int = 1  # 0 = highest
    request_id: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)


class ServiceRep:
    """
    Service Representative - Orchestration layer for agent interactions.

    Core responsibilities:
    - Classify user intent (via IntentClassifier)
    - Route tasks (via Router)
    - Interface with AgentHarness directly (no IPC for heavy data)
    - Generate responses (acknowledgments, completions)
    - Publish TTS events to EventBus

    Architecture:
    - ServiceRep owns/creates AgentHarness
    - ServiceRep calls harness.process() directly (in-process)
    - ServiceRep subscribes to harness progress via callbacks
    - ServiceRep publishes only lightweight TTS strings to EventBus
    """

    def __init__(
        self,
        config: ServiceRepConfig,
        event_bus: EventBusProtocol,
        router: Router,
        harness: Optional['AgentHarness'] = None,  # Can inject or will create
        harness_config_path: Optional[str] = None,
        logger: Optional[StructuredLogger] = None,
        log_dir: Optional[str] = None
    ):
        self.config = config
        self.event_bus = event_bus
        self.router = router

        # Store log_dir for passing to child components
        self._log_dir = log_dir

        # Logger: use injected, or create from log_dir, or error
        if logger:
            self.logger = logger
        elif log_dir:
            self.logger = StructuredLogger(log_dir=log_dir, log_to_console=False)
        else:
            raise ValueError("ServiceRep requires either logger or log_dir parameter")

        self.enabled = config.enabled

        # Create or use injected AgentHarness
        if harness:
            self.harness = harness
        else:
            from .harness import AgentHarness
            self.harness = AgentHarness(
                config_path=harness_config_path,
                logger=self.logger,
                log_dir=self._log_dir
            )

        # Register progress callback with harness
        self.harness.add_progress_callback(self._on_harness_progress)

        # Thread/queue management for asynchronous execution
        # Queue items are: (request_id, text, tier, session_key)
        self._task_queue: "queue.Queue[Optional[tuple[str, str, str, Optional[str]]]]" = queue.Queue()
        self._worker_threads: List[threading.Thread] = []
        self._shutdown_event = threading.Event()
        self._state_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending_requests = 0
        self._active_thread_name: Optional[str] = None

        # Track paused request for ask_user resume flow
        self._paused_request_id: Optional[str] = None
        self._paused_session_key: Optional[str] = None

        # Intent classifier
        self.intent_classifier = create_intent_classifier(
            llm_config=config.llm_config,
            logger=self.logger,
            use_llm=True
        )

        # Load canned responses
        self._canned_responses = self._load_canned_responses()
        self._response_index: Dict[str, int] = {}

        # Lightweight small-talk patterns we can answer without invoking harness
        self._small_talk_patterns = [
            (re.compile(r"^(hi|hello|hey|hiya|yo|sup|hey there|hi there)$"), "greeting"),
            (re.compile(r"^good (morning|afternoon|evening)$"), "greeting"),
            (re.compile(r"^(thanks|thank you|thanks so much|thank you so much|thx|ty)$"), "thanks"),
            (re.compile(r"^(how are you|how are you doing|how's it going|hows it going|what's up|whats up)$"), "checkin"),
        ]
        self._small_talk_responses = {
            "greeting": [
                "Hi there! I'm ready whenever you need me.",
                "Hello! I'm here and ready to help.",
                "Hey there! Just say the word when you're ready."
            ],
            "thanks": [
                "You're welcome! Happy to help with anything else.",
                "No problem at all—just let me know if you need anything else.",
                "Anytime! I'm here whenever you need me."
            ],
            "checkin": [
                "I'm doing great and ready to help. What can I do for you?",
                "All good on my end—let me know what you need.",
                "Doing well and standing by whenever you're ready."
            ],
        }

        # Track current agent state
        self._agent_is_busy = False
        self._current_task: Optional[str] = None
        self._current_request_id: Optional[str] = None
        self._worker_count = max(1, getattr(config, "max_worker_threads", 1) or 1)
        self._start_worker_threads()

        self.logger.system_init("service_rep", "ready")

    def _start_worker_threads(self):
        """Spawn worker threads that consume tasks from the queue"""
        for idx in range(self._worker_count):
            worker = threading.Thread(
                target=self._worker_loop,
                name=f"ServiceRepWorker-{idx + 1}",
                daemon=True
            )
            worker.start()
            self._worker_threads.append(worker)

    def _worker_loop(self):
        """Continuously process tasks from the queue"""
        while True:
            try:
                task = self._task_queue.get(timeout=0.5)
            except queue.Empty:
                if self._shutdown_event.is_set():
                    break
                continue

            if task is None:
                self._task_queue.task_done()
                break

            if len(task) == 4:
                request_id, text, tier, session_key = task
                budget = None
            else:
                request_id, text, tier, session_key, budget = task
            with self._pending_lock:
                if self._pending_requests > 0:
                    self._pending_requests -= 1

            try:
                self._process_agent_task(request_id, text, tier, session_key, budget)
            finally:
                self._task_queue.task_done()

    def _enqueue_agent_task(
        self,
        request_id: str,
        text: str,
        tier: str,
        session_key: Optional[str] = None,
        budget: Optional[Dict[str, int]] = None,
    ):
        """Add a normal request to the worker queue"""
        with self._pending_lock:
            self._pending_requests += 1
        self._task_queue.put((request_id, text, tier, session_key, budget))

    def _process_agent_task(
        self,
        request_id: str,
        text: str,
        tier: str,
        session_key: Optional[str] = None,
        budget: Optional[Dict[str, int]] = None,
    ):
        """Execute a queued agent task (runs inside worker thread)"""
        self._set_active_request(request_id, text)
        try:
            # Create streaming callback to emit chunks as events
            def on_stream_chunk(chunk: str, chunk_index: int, is_final: bool):
                """Callback that emits StreamingChunkEvent for each chunk"""
                import sys
                print(f"[DEBUG ServiceRep] on_stream_chunk called: idx={chunk_index}, final={is_final}, chunk_len={len(chunk)}", file=sys.stderr, flush=True)
                if self.event_bus:
                    try:
                        chunk_event = StreamingChunkEvent(
                            request_id=request_id,
                            chunk=chunk,
                            chunk_index=chunk_index,
                            is_final=is_final
                        )
                        # Debug: check subscriptions
                        subs = self.event_bus._subscriptions.get(chunk_event.event_type, [])
                        print(f"[DEBUG ServiceRep] Publishing to event_bus, {len(subs)} subscribers for STREAMING_CHUNK", file=sys.stderr, flush=True)
                        self.event_bus.publish(chunk_event)
                    except Exception as e:
                        self.logger.error(
                            f"[{request_id}] Failed to publish StreamingChunkEvent: {e}",
                            component="service_rep"
                        )
                        import traceback
                        traceback.print_exc()

            harness_response = self.harness.process(
                speech_text=text,
                tier=tier,
                budget=budget,
                context=None,
                request_id=request_id,
                session_key=session_key,
                on_stream_chunk=on_stream_chunk
            )
            self._handle_harness_response(request_id, harness_response)

        except Exception as e:
            self.logger.error(f"[{request_id}] Harness call failed: {e}", component="service_rep")
            self._handle_harness_error(request_id, str(e))

        finally:
            self._clear_active_request()

    def _set_active_request(self, request_id: str, text: str):
        """Mark a request as currently being processed"""
        with self._state_lock:
            self._agent_is_busy = True
            self._current_request_id = request_id
            self._current_task = text
            self._active_thread_name = threading.current_thread().name

    def _clear_active_request(self):
        """Reset active request tracking"""
        with self._state_lock:
            self._agent_is_busy = False
            self._current_request_id = None
            self._current_task = None
            self._active_thread_name = None

    def _get_current_request_id(self) -> Optional[str]:
        with self._state_lock:
            return self._current_request_id

    def _get_current_task(self) -> Optional[str]:
        with self._state_lock:
            return self._current_task

    def _get_active_thread_name(self) -> Optional[str]:
        with self._state_lock:
            return self._active_thread_name

    def _is_agent_busy(self) -> bool:
        with self._state_lock:
            return self._agent_is_busy

    def _get_pending_request_count(self) -> int:
        with self._pending_lock:
            return self._pending_requests

    def _load_canned_responses(self) -> Dict[str, List[str]]:
        """Load canned responses from config"""
        config_path = Path(__file__).parent.parent / "config" / "service_rep_config.json"
        try:
            with open(config_path, 'r') as f:
                data = json.load(f)
                return data.get("canned_responses", {})
        except Exception:
            # Fallback defaults
            return {
                "thinking": ["Got it—one sec.", "On it.", "Working on that now."],
                "searching": ["Let me look that up quickly.", "Searching for the latest."],
                "executing": ["Running that now.", "Got it, running that."],
                "error": ["I ran into an issue.", "Something went wrong."],
                "done": ["All set.", "Here you go.", "Done."]
            }

    def _get_canned_response(self, category: str) -> str:
        """Get next canned response (round-robin)"""
        if category not in self._canned_responses:
            return ""

        responses = self._canned_responses[category]
        index = self._response_index.get(category, 0)
        response = responses[index]
        self._response_index[category] = (index + 1) % len(responses)
        return response

    def handle_transcription(self, event: TranscriptionCompleteEvent):
        """
        Handle transcribed speech from user.

        Flow:
        1. Check for resume from ask_user prompt
        2. Classify intent
        3. Route to appropriate tier (if normal request)
        4. Generate acknowledgment
        5. Publish AgentRequest + TTS events
        """
        text = event.text.strip()
        if not text:
            return

        request_id = event.request_id or self.logger.new_request()
        session_key = getattr(event, 'session_key', None)  # Extract session_key from event
        self.logger.request_received(text)

        # Check for resume from ask_user prompt response
        event_metadata = getattr(event, 'metadata', {}) or {}
        is_prompt_response = event_metadata.get('is_prompt_response', False)

        if is_prompt_response and self._paused_request_id:
            # This is a user response to an ask_user prompt - resume the paused agent
            answer = event_metadata.get('answer', text)
            self._handle_resume_request(request_id, answer)
            return

        # Fast path: greetings / small-talk should bypass the harness entirely
        if self._handle_small_talk(request_id, text):
            return

        # Step 1: Classify intent
        intent_result: IntentClassification = self.intent_classifier.classify(
            text,
            agent_is_busy=self._is_agent_busy(),
            current_task=self._get_current_task()
        )

        # Step 2: Handle based on intent
        if intent_result.intent == UserIntent.STOP:
            self._handle_stop_intent(request_id, text)

        elif intent_result.intent == UserIntent.CLARIFICATION:
            self._handle_clarification(request_id, text, intent_result)

        elif intent_result.intent == UserIntent.ADDITION:
            self._handle_addition(request_id, text, intent_result)

        elif intent_result.intent == UserIntent.QUESTION:
            self._handle_status_question(request_id, text)

        else:  # NORMAL_REQUEST
            self._handle_normal_request(request_id, text, session_key)

    def _handle_normal_request(self, request_id: str, text: str, session_key: Optional[str] = None):
        """Handle normal agent request - spawns background thread for agent"""
        # Route to determine tier
        classification, tier_config = self.router.route(text, context=None)

        # NOTE: Pre-acknowledgment is handled upstream in multi_process_app
        # We skip the ack phase here to avoid duplicate "Got it" messages
        # The pre-ack gives instant feedback (~50-100ms) before STT completes

        # Queue the request for worker threads to process
        self.logger.info(
            f"[{request_id}] Routed to tier={classification.tier_name}, queued={self._get_pending_request_count() + 1}",
            component="service_rep"
        )
        self._enqueue_agent_task(request_id, text, classification.tier_name, session_key, classification.budget)

    def _handle_resume_request(self, request_id: str, answer: str):
        """
        Handle resume from ask_user prompt - calls harness.resume_with_answer().

        Args:
            request_id: Request identifier for this response
            answer: User's answer to the prompt
        """
        paused_request_id = self._paused_request_id

        self.logger.info(
            f"[{request_id}] Resuming paused request {paused_request_id} with user answer",
            component="service_rep"
        )

        # Clear paused state before resuming
        self._paused_request_id = None
        session_key = self._paused_session_key
        self._paused_session_key = None

        # Mark agent as busy
        self._set_active_request(request_id, f"Resuming with answer: {answer[:50]}...")

        try:
            # Create streaming callback to emit chunks as events
            def on_stream_chunk(chunk: str, chunk_index: int, is_final: bool):
                """Callback that emits StreamingChunkEvent for each chunk"""
                if self.event_bus:
                    try:
                        chunk_event = StreamingChunkEvent(
                            request_id=request_id,
                            chunk=chunk,
                            chunk_index=chunk_index,
                            is_final=is_final
                        )
                        self.event_bus.publish(chunk_event)
                    except Exception as e:
                        self.logger.error(
                            f"[{request_id}] Failed to publish StreamingChunkEvent: {e}",
                            component="service_rep"
                        )

            # Call resume_with_answer instead of process
            harness_response = self.harness.resume_with_answer(answer)
            self._handle_harness_response(request_id, harness_response)

        except Exception as e:
            self.logger.error(f"[{request_id}] Resume failed: {e}", component="service_rep")
            self._handle_harness_error(request_id, str(e))

        finally:
            self._clear_active_request()

    def _handle_stop_intent(self, request_id: str, text: str):
        """Handle STOP intent - cancel current work"""
        if not self._is_agent_busy():
            # Nothing to stop
            self._publish_tts(
                text="I'm not doing anything right now.",
                response_type=ResponseType.COMPLETION,
                priority=0,
                request_id=request_id
            )
            return

        # Call harness control method to stop agent execution
        # This works because agent runs in background thread
        self.harness.stop()

        # Publish cancel event (for other listeners)
        from communication.events import Event, EventType
        cancel_event = Event()
        object.__setattr__(cancel_event, 'event_type', EventType.CANCEL)
        object.__setattr__(cancel_event, 'request_id', self._get_current_request_id())
        self.event_bus.publish(cancel_event)

        # Acknowledge cancellation
        self._publish_tts(
            text="Okay, stopping.",
            response_type=ResponseType.ACKNOWLEDGMENT,
            priority=0,
            request_id=request_id
        )

        self.logger.info(
            f"[{request_id}] Stop signal sent to running agent (thread: {self._get_active_thread_name() or 'none'})",
            component="service_rep"
        )

        # Note: Don't clear busy state here - agent thread will do it in finally block

    def _handle_clarification(self, request_id: str, text: str, intent: IntentClassification):
        """Handle CLARIFICATION intent - user is clarifying previous request"""
        if not self._is_agent_busy():
            # Treat as new request
            self._handle_normal_request(request_id, text)
            return

        # TODO: Inject clarification into running agent (Phase 5 advanced feature)
        # For now, acknowledge but don't support mid-execution injection
        self._publish_tts(
            text="Got the clarification. Let me finish this first.",
            response_type=ResponseType.ACKNOWLEDGMENT,
            priority=0,
            request_id=request_id
        )

        self.logger.info(
            f"[{request_id}] Clarification noted (mid-execution injection not yet supported)",
            component="service_rep"
        )

    def _handle_addition(self, request_id: str, text: str, intent: IntentClassification):
        """Handle ADDITION intent - user adding to current request"""
        if not self._is_agent_busy():
            # Treat as new request
            self._handle_normal_request(request_id, text)
            return

        # TODO: Inject addition into running agent (Phase 5 advanced feature)
        # For now, acknowledge but queue for later
        self._publish_tts(
            text="Noted. I'll handle that next.",
            response_type=ResponseType.ACKNOWLEDGMENT,
            priority=0,
            request_id=request_id
        )

        self.logger.info(
            f"[{request_id}] Addition noted (mid-execution injection not yet supported)",
            component="service_rep"
        )

    def _handle_status_question(self, request_id: str, text: str):
        """Handle status question"""
        if not self._is_agent_busy():
            pending = self._get_pending_request_count()
            if pending > 0:
                response_text = f"I have {pending} request{'s' if pending != 1 else ''} queued up."
            else:
                response_text = "I'm ready for your next request."
        else:
            current_task = self._get_current_task()
            response_text = f"I'm working on: {current_task}" if current_task else "I'm working on your last request."

        self._publish_tts(
            text=response_text,
            response_type=ResponseType.COMPLETION,
            priority=0,
            request_id=request_id
        )

    def _on_harness_progress(self, message: str, tool_name: Optional[str], step_number: int):
        """
        Callback for harness progress updates.

        Called by AgentHarness during execution.
        Emits AgentProgressEvent to event bus for TUI/other listeners.
        """
        if not self.enabled:
            return

        current_request_id = self._get_current_request_id()
        if not current_request_id:
            return

        # Emit progress event for TUI and other listeners
        if self.event_bus:
            try:
                progress_event = AgentProgressEvent(
                    request_id=current_request_id,
                    message=message,
                    tool_name=tool_name,
                    step_number=step_number
                )
                self.event_bus.publish(progress_event)
            except Exception as e:
                self.logger.error(
                    f"[{current_request_id}] Failed to publish AgentProgressEvent: {e}",
                    component="service_rep"
                )

    def _handle_harness_response(self, request_id: str, harness_response):
        """
        Handle harness response completion.

        Args:
            request_id: Request identifier
            harness_response: HarnessResponse from AgentHarness
        """
        if not self.enabled:
            return

        # Generate spoken response with intelligent error messaging
        success = harness_response.agent_response.success if harness_response.agent_response else False

        if success:
            # OPTIMIZATION: Use speech_text if agent provided it (direct TTS passthrough)
            # This bypasses LLM summarization and uses agent's pre-formatted speech text
            if harness_response.agent_response and harness_response.agent_response.speech_text:
                spoken_text = harness_response.agent_response.speech_text
            else:
                # Fallback: Summarize response for TTS
                spoken_text = self._summarize_harness_response(harness_response)
        else:
            # Get error from the right place
            agent_error = None
            if harness_response.agent_response:
                agent_error = harness_response.agent_response.error

            # Fall back to metadata error, then harness state error
            if not agent_error:
                agent_error = harness_response.metadata.get("error")

            # Generate intelligent error message
            spoken_text = self._generate_failure_message(
                harness_response=harness_response,
                error=agent_error
            )

        # Publish TTS
        response_type = ResponseType.COMPLETION if success else ResponseType.ERROR
        tools_used = harness_response.metadata.get("tools_used", [])

        self._publish_tts(
            text=spoken_text,
            response_type=response_type,
            priority=1,
            request_id=request_id,
            metadata={"success": success, "tools_used": tools_used}
        )

        # Publish full agent response event for listeners (e.g., TUI/status panes)
        if self.event_bus:
            try:
                error_msg = None
                if not success:
                    if harness_response.agent_response and harness_response.agent_response.error:
                        error_msg = harness_response.agent_response.error
                    else:
                        error_msg = harness_response.metadata.get("error")

                # Include paused state in metadata for TUI
                event_metadata = dict(harness_response.metadata or {})
                event_metadata["paused"] = harness_response.paused
                event_metadata["user_prompt"] = harness_response.user_prompt

                event_content = harness_response.full_response or ""
                if not success and not event_content.strip():
                    event_content = error_msg or spoken_text

                agent_event = AgentResponseCompleteEvent(
                    request_id=request_id,
                    success=success,
                    content=event_content,
                    spoken_response=spoken_text,
                    tools_used=tools_used,
                    duration_ms=harness_response.duration_ms,
                    error=error_msg,
                    metadata=event_metadata
                )
                self.event_bus.publish(agent_event)
            except Exception as event_err:
                self.logger.error(
                    f"[{request_id}] Failed to publish AgentResponseCompleteEvent: {event_err}",
                    component="service_rep"
                )

        # Store paused state for ask_user resume flow
        if harness_response.paused:
            self._paused_request_id = request_id
            self._paused_session_key = getattr(harness_response, 'session_key', None)
            self.logger.info(
                f"[{request_id}] Agent paused awaiting user input",
                component="service_rep"
            )
        else:
            # Clear paused state on non-paused response
            self._paused_request_id = None
            self._paused_session_key = None

        self.logger.info(
            f"[{request_id}] Response delivered: success={success}, paused={harness_response.paused}",
            component="service_rep"
        )

    def _generate_failure_message(self, harness_response, error: Optional[str]) -> str:
        """
        Generate an intelligent failure message based on what actually happened.

        Args:
            harness_response: HarnessResponse from AgentHarness
            error: Error string from agent_response.error

        Returns:
            Human-friendly spoken error message
        """
        # Check if there's actually a response but reflection determined failure
        has_response = bool(harness_response.full_response and len(harness_response.full_response) > 20)

        # Get reflection data if available
        reflection = harness_response.agent_response.reflection if harness_response.agent_response else None

        if has_response and reflection:
            # Agent completed but reflection says goal not achieved
            if reflection.gaps:
                # Explain what's missing
                gap_summary = reflection.gaps[0] if len(reflection.gaps) == 1 else f"{len(reflection.gaps)} issues"
                return f"I completed the task, but {gap_summary}. {harness_response.spoken_response[:100] if harness_response.spoken_response else ''}"
            else:
                # Generic goal not achieved with response
                return f"I may not have fully achieved your goal. {harness_response.spoken_response[:100] if harness_response.spoken_response else ''}"

        elif has_response:
            # Has response but no reflection data
            return f"I completed the task but may have encountered issues: {error or 'Please check the results'}"

        elif error:
            # No response, but we have an error description
            if "goal not achieved" in error.lower():
                return "I wasn't able to complete your request."
            elif ";" in error:
                # Multiple gaps joined with semicolons
                first_gap = error.split(";")[0].strip()
                return f"I ran into an issue: {first_gap}"
            else:
                return f"I ran into an issue: {error}"

        else:
            # No response, no error - truly unknown
            return "I'm sorry, something went wrong and I couldn't complete the task."

    def _handle_harness_error(self, request_id: str, error_msg: str):
        """Handle harness execution error"""
        if not self.enabled:
            return

        # Publish error TTS
        self._publish_tts(
            text=f"I'm sorry, something went wrong: {error_msg}",
            response_type=ResponseType.ERROR,
            priority=1,
            request_id=request_id
        )

        if self.event_bus:
            try:
                failure_event = AgentResponseCompleteEvent(
                    request_id=request_id,
                    success=False,
                    content="",
                    spoken_response=f"I'm sorry, something went wrong: {error_msg}",
                    tools_used=[],
                    duration_ms=0.0,
                    error=error_msg,
                    metadata={"error": error_msg or "unknown_error"}
                )
                self.event_bus.publish(failure_event)
            except Exception as event_err:
                self.logger.error(
                    f"[{request_id}] Failed to publish failure response event: {event_err}",
                    component="service_rep"
                )

    def _summarize_harness_response(self, harness_response) -> str:
        """
        Summarize harness response for speech.

        If response is too long or contains file operations,
        generate abbreviated spoken version.

        Args:
            harness_response: HarnessResponse from AgentHarness

        Returns:
            Spoken summary of the response
        """
        content = harness_response.spoken_response or harness_response.full_response or ""
        metadata = harness_response.metadata or {}

        # Check for file operations
        if harness_response.agent_response and harness_response.agent_response.metadata:
            file_ops = harness_response.agent_response.metadata.get("file_operations", [])
            if file_ops:
                return self._summarize_file_operations(file_ops)

        # If too long, truncate
        if len(content) > 5000:
            # Take first paragraph
            paragraphs = content.split('\n\n')
            if paragraphs:
                first_para = paragraphs[0]
                if len(first_para) > 3000:
                    sentences = first_para.split('. ')
                    if sentences:
                        return sentences[0] + ". I've provided the full details."
                return first_para[:3000] + "... More details available."

        return content

    def _summarize_file_operations(self, file_ops: List[Dict[str, Any]]) -> str:
        """Summarize file operations for speech"""
        summaries = []
        seen_paths = set()

        for op in file_ops[:3]:  # Max 3
            path = op.get("path") or ""
            action = (op.get("action") or "write").capitalize()

            if path and path in seen_paths:
                continue

            summaries.append(f"{action} {path or 'file'}")
            if path:
                seen_paths.add(path)

        result = "; ".join(summaries) + ". Files saved."
        if len(file_ops) > 3:
            result += f" ({len(file_ops)} total.)"

        return result

    def _generate_acknowledgment(self, text: str, classification: TaskClassification) -> str:
        """Generate acknowledgment for request"""
        text_lower = text.lower()

        # Match based on content
        if any(w in text_lower for w in ["search", "find", "look up"]):
            return self._get_canned_response("searching")
        elif any(w in text_lower for w in ["run", "execute", "command"]):
            return self._get_canned_response("executing")
        elif any(w in text_lower for w in ["calculate", "compute"]):
            return "Calculating that for you."
        else:
            return self._get_canned_response("thinking")

    def _publish_tts(
        self,
        text: str,
        response_type: ResponseType,
        priority: int,
        request_id: str,
        metadata: Optional[Dict[str, Any]] = None
    ):
        """Publish TTS event"""
        tts_event = TTSRequestedEvent(
            request_id=request_id,
            text=text,
            priority=priority,
            response_type=response_type.value
        )
        self.event_bus.publish(tts_event)

        self.logger.tts_event("requested", {
            "type": response_type.value,
            "len": len(text),
            "priority": priority
        })

    def enable(self):
        """Enable ServiceRep"""
        self.enabled = True
        self.config.enabled = True

    def disable(self):
        """Disable ServiceRep"""
        self.enabled = False
        self.config.enabled = False

    def cleanup(self):
        """Cleanup resources"""
        # Stop any running agent
        if self._is_agent_busy():
            self.harness.stop()

        # Signal worker threads to exit after finishing current work
        self._shutdown_event.set()
        for _ in self._worker_threads:
            self._task_queue.put(None)

        for thread in self._worker_threads:
            thread.join(timeout=5.0)
            if thread.is_alive():
                self.logger.warning(f"{thread.name} did not complete in time", component="service_rep")

        # Cleanup harness
        if self.harness:
            self.harness.cleanup()

        self.logger.info("ServiceRep cleaned up", component="service_rep")

    def _handle_small_talk(self, request_id: str, text: str) -> bool:
        """Handle simple greetings/thanks without invoking the harness."""
        normalized = (text or "").strip().lower()
        if not normalized:
            return False

        normalized = re.sub(r"[!.?]+$", "", normalized)

        for pattern, category in self._small_talk_patterns:
            if pattern.match(normalized):
                response_text = random.choice(
                    self._small_talk_responses.get(category, ["I'm here whenever you need me."])
                )

                self.logger.info(
                    f"[{request_id}] Auto-responded to {category} small talk",
                    component="service_rep"
                )

                self._publish_tts(
                    text=response_text,
                    response_type=ResponseType.COMPLETION,
                    priority=1,
                    request_id=request_id
                )

                if self.event_bus:
                    # Emit streaming chunk for quick answer (for TUI display)
                    chunk_event = StreamingChunkEvent(
                        request_id=request_id,
                        chunk=response_text,
                        chunk_index=0,
                        is_final=False
                    )
                    self.event_bus.publish(chunk_event)

                    # Emit final streaming chunk
                    final_chunk_event = StreamingChunkEvent(
                        request_id=request_id,
                        chunk="",
                        chunk_index=1,
                        is_final=True
                    )
                    self.event_bus.publish(final_chunk_event)

                    # Emit completion event
                    auto_event = AgentResponseCompleteEvent(
                        request_id=request_id,
                        success=True,
                        content=response_text,
                        spoken_response=response_text,
                        tools_used=[],
                        duration_ms=0.0,
                        metadata={"auto_response": category}
                    )
                    self.event_bus.publish(auto_event)

                return True

        return False


def create_service_rep(
    config: ServiceRepConfig,
    event_bus: EventBusProtocol,
    router: Router,
    harness: Optional['AgentHarness'] = None,
    harness_config_path: Optional[str] = None,
    logger: Optional[StructuredLogger] = None,
    log_dir: Optional[str] = None
) -> ServiceRep:
    """
    Factory function to create ServiceRep.

    Args:
        config: ServiceRep configuration
        event_bus: Event bus for publishing TTS events
        router: Router for task classification
        harness: Optional AgentHarness instance (will create if not provided)
        harness_config_path: Path to harness config (used if harness not provided)
        logger: Optional pre-configured logger instance
        log_dir: Optional log directory (used to create logger if not provided)

    Returns:
        ServiceRep instance with integrated AgentHarness
    """
    return ServiceRep(
        config=config,
        event_bus=event_bus,
        router=router,
        harness=harness,
        harness_config_path=harness_config_path,
        logger=logger,
        log_dir=log_dir
    )
