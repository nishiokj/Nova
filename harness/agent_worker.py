"""
Agent Worker - Separate process for LLM reasoning and tool execution.

Runs in its own process to avoid GIL contention with main audio/STT process.
Consumes from EventBus Agent queue, executes Agent logic, sends TTS requests.
"""

import sys
import os
import time
import logging
import traceback
from typing import Optional, Dict, Any, List

# Ensure parent directory is in path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness.event_bus import (
    EventBus, AgentRequest, AgentResult, TTSRequest
)
from harness.config import (
    HarnessConfig, AgentConfig, LLMConfig,
    load_or_create_config
)
from harness.tool_registry import ToolRegistry
from harness.router import Router, TaskClassification, TaskTier
from harness.agent import Agent, TieredAgent, AgentStep, AgentResponse
from harness.logger import StructuredLogger, get_logger, set_logger


class AgentWorker:
    """
    Agent Worker that runs in a separate process.

    Features:
    - Processes agent requests independently of main process
    - Sends TTS requests for acknowledgments and responses
    - Supports cancellation via EventBus cancel signal
    - Health heartbeats for monitoring
    - Stateless: conversation context passed with each request
    """

    def __init__(
        self,
        event_bus: EventBus,
        config: Optional[HarnessConfig] = None,
        config_path: Optional[str] = None
    ):
        self.event_bus = event_bus
        self.logger = logging.getLogger(f"{__name__}.AgentWorker")

        # Load configuration
        if config:
            self._config = config
        elif config_path:
            self._config = load_or_create_config(config_path)
        else:
            self._config = load_or_create_config()

        # Components (initialized in initialize())
        self.tool_registry: Optional[ToolRegistry] = None
        self.router: Optional[Router] = None
        self.agent: Optional[TieredAgent] = None

        self._initialized = False
        self._request_count = 0

    def initialize(self) -> bool:
        """Initialize Agent components"""
        try:
            self.logger.info("AgentWorker: Initializing components...")

            # Setup logging for this process
            self._setup_logging()

            # Initialize Tool Registry
            self.tool_registry = ToolRegistry(self._config.tools)
            self.logger.info(f"AgentWorker: Tool registry initialized with {len(self.tool_registry.list_tools())} tools")

            # Initialize Router
            self.router = Router(self._config.router)
            for tier in TaskTier:
                tier_llm = self._config.llm_configs.get(tier.value)
                if tier_llm:
                    self.router.set_tier_config(tier, tier_llm)

            # Initialize Tiered Agent
            self.agent = TieredAgent(
                config=self._config.agent,
                tool_registry=self.tool_registry,
                tier_configs=self._config.llm_configs
            )

            self._initialized = True
            self.logger.info("AgentWorker: Initialization complete")
            return True

        except Exception as e:
            self.logger.error(f"AgentWorker initialization failed: {e}\n{traceback.format_exc()}")
            return False

    def _setup_logging(self):
        """Setup structured logging for this process"""
        try:
            log_config = self._config.logging
            logger = StructuredLogger(
                name="agent_worker",
                log_dir=log_config.log_dir,
                log_level=log_config.log_level,
                log_to_file=log_config.log_to_file,
                log_to_console=log_config.log_to_console,
                structured_format=log_config.structured_format
            )
            set_logger(logger)
        except Exception as e:
            self.logger.warning(f"Could not setup structured logging: {e}")

    def _generate_action_preview(self, speech_text: str, classification: TaskClassification) -> str:
        """Generate a brief action preview for acknowledgment"""
        text_lower = speech_text.lower()

        if "search" in text_lower or "find" in text_lower or "look up" in text_lower:
            return "I'll search for that information"
        elif "calculate" in text_lower or "compute" in text_lower:
            return "I'll calculate that for you"
        elif "run" in text_lower or "execute" in text_lower:
            return "I'll run that command"
        elif "read" in text_lower or "show" in text_lower or "open" in text_lower:
            return "I'll get that for you"
        elif "write" in text_lower or "create" in text_lower:
            return "I'll create that"
        elif classification.tier == TaskTier.SIMPLE:
            return "Let me help you with that"
        elif classification.tier == TaskTier.ADVANCED:
            return "I'll work on this task"
        else:
            return "I'm working on that"

    def _get_canned_acknowledgment(self, action_description: str, user_input: str) -> str:
        """Get a fast canned acknowledgment (no LLM call)"""
        action_lower = (action_description or "").lower()
        input_lower = (user_input or "").lower()

        if any(w in action_lower for w in ["search", "looking", "find", "look up"]):
            return "Let me look that up quickly."
        elif any(w in action_lower for w in ["execute", "run", "command"]):
            return "Running that now."
        elif any(w in action_lower for w in ["calculate", "compute"]):
            return "Calculating that for you."
        elif any(w in input_lower for w in ["what is", "what's", "how much", "price"]):
            return "Let me check that for you."
        elif any(w in input_lower for w in ["time", "date", "weather"]):
            return "One moment."
        else:
            return "Working on that now."

    def _generate_spoken_response(self, agent_response: AgentResponse) -> str:
        """Generate a spoken version of the response (may be abbreviated)"""
        content = agent_response.content

        # If response is too long, summarize
        if len(content) > 5000:
            paragraphs = content.split('\n\n')
            if paragraphs:
                first_para = paragraphs[0]
                if len(first_para) > 3000:
                    sentences = first_para.split('. ')
                    if sentences:
                        return sentences[0] + ". I've provided the full details."
                return first_para[:3000] + "... I've provided more details."

        return content

    def _create_progress_callback(self, request_id: str):
        """Create a callback to send TTS progress during agent execution"""
        last_tool = [None]  # Use list for mutable closure

        def on_step(step: AgentStep):
            if step.tool_name and step.tool_name != last_tool[0]:
                last_tool[0] = step.tool_name
                tool_lower = step.tool_name.lower()

                # Generate progress message
                if "search" in tool_lower or "web" in tool_lower:
                    msg = "Searching now."
                elif "fetch" in tool_lower or "get" in tool_lower:
                    msg = "Getting that information."
                elif "read" in tool_lower or "file" in tool_lower:
                    msg = "Reading the file."
                elif "bash" in tool_lower or "command" in tool_lower:
                    msg = "Running the command."
                else:
                    msg = None  # Don't speak for every tool

                if msg:
                    self.event_bus.submit_tts_request(TTSRequest(
                        request_id=request_id,
                        text=msg,
                        priority=1,
                        response_type="progress"
                    ))

        return on_step

    def process_request(self, request: AgentRequest) -> AgentResult:
        """
        Process a single agent request.

        Steps:
        1. Route to determine tier
        2. Send acknowledgment TTS
        3. Execute agent with progress callbacks
        4. Send completion TTS
        5. Return result
        """
        start_time = time.time()
        self._request_count += 1

        self.logger.info(
            f"AgentWorker: Processing request #{self._request_count}: "
            f"'{request.speech_text[:60]}...' (tier_hint={request.tier})"
        )

        try:
            # Mark as busy
            self.event_bus.set_agent_busy(True)

            # Step 1: Route to determine tier
            classification, tier_config = self.router.route(request.speech_text, request.context)
            tier = classification.tier_name

            self.logger.info(f"AgentWorker: Routed to tier '{tier}' (confidence={classification.confidence:.2f})")

            # Step 2: Send acknowledgment TTS
            action_preview = self._generate_action_preview(request.speech_text, classification)
            ack_text = self._get_canned_acknowledgment(action_preview, request.speech_text)

            self.event_bus.submit_tts_request(TTSRequest(
                request_id=request.request_id,
                text=ack_text,
                priority=0,  # High priority for acks
                response_type="acknowledgment"
            ))

            # Check for cancellation before heavy work
            if self.event_bus.is_cancelled():
                self.logger.info("AgentWorker: Request cancelled before agent execution")
                return AgentResult(
                    request_id=request.request_id,
                    success=False,
                    content="Request cancelled",
                    spoken_response="",
                    error="Cancelled"
                )

            # Step 3: Execute agent with progress callbacks
            tier_agent = self.agent._get_agent(tier)
            progress_callback = self._create_progress_callback(request.request_id)
            tier_agent.add_step_callback(progress_callback)

            try:
                agent_response = self.agent.run(
                    user_input=request.speech_text,
                    tier=tier,
                    context=request.context
                )
            finally:
                # Clean up callback
                if progress_callback in tier_agent._step_callbacks:
                    tier_agent._step_callbacks.remove(progress_callback)

            # Check for cancellation after agent execution
            if self.event_bus.is_cancelled():
                self.logger.info("AgentWorker: Request cancelled after agent execution")
                return AgentResult(
                    request_id=request.request_id,
                    success=False,
                    content=agent_response.content,
                    spoken_response="",
                    error="Cancelled"
                )

            # Step 4: Generate and send completion TTS
            if agent_response.success:
                spoken_response = self._generate_spoken_response(agent_response)

                self.event_bus.submit_tts_request(TTSRequest(
                    request_id=request.request_id,
                    text=spoken_response,
                    priority=1,
                    response_type="completion"
                ))
            else:
                error_msg = f"I ran into an issue: {agent_response.error or 'Unknown error'}"
                spoken_response = error_msg

                self.event_bus.submit_tts_request(TTSRequest(
                    request_id=request.request_id,
                    text=error_msg,
                    priority=0,  # High priority for errors
                    response_type="error"
                ))

            duration_ms = (time.time() - start_time) * 1000

            self.logger.info(
                f"AgentWorker: Request #{self._request_count} complete in {duration_ms:.0f}ms "
                f"(tools={agent_response.tools_used})"
            )

            return AgentResult(
                request_id=request.request_id,
                success=agent_response.success,
                content=agent_response.content,
                spoken_response=spoken_response,
                tools_used=agent_response.tools_used,
                duration_ms=duration_ms,
                error=agent_response.error,
                metadata={
                    "tier": tier,
                    "confidence": classification.confidence,
                    "steps": len(agent_response.steps)
                }
            )

        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            error_msg = f"Agent execution failed: {str(e)}"
            self.logger.error(f"AgentWorker: {error_msg}\n{traceback.format_exc()}")

            # Send error TTS
            self.event_bus.submit_tts_request(TTSRequest(
                request_id=request.request_id,
                text="I'm sorry, something went wrong. Please try again.",
                priority=0,
                response_type="error"
            ))

            return AgentResult(
                request_id=request.request_id,
                success=False,
                content=error_msg,
                spoken_response="I'm sorry, something went wrong.",
                duration_ms=duration_ms,
                error=str(e)
            )

        finally:
            self.event_bus.set_agent_busy(False)

    def run(self):
        """
        Main worker loop. Runs until shutdown signal.
        """
        self.logger.info(f"AgentWorker: Starting (PID: {os.getpid()})")

        if not self.initialize():
            self.logger.error("AgentWorker: Failed to initialize, exiting")
            return

        self.logger.info("AgentWorker: Ready for requests")

        while not self.event_bus.is_shutdown():
            try:
                # Heartbeat
                self.event_bus.agent_heartbeat()

                # Get next request
                request = self.event_bus.get_agent_request(timeout=0.5)

                if request is None:
                    continue

                # Process the request
                result = self.process_request(request)

                # Submit result back to main process
                self.event_bus.submit_agent_response(result)

            except Exception as e:
                self.logger.error(f"AgentWorker loop error: {e}\n{traceback.format_exc()}")
                time.sleep(0.1)

        self.logger.info("AgentWorker: Shutting down")
        self.cleanup()

    def cleanup(self):
        """Clean up resources"""
        # Any cleanup needed for agent/tool registry
        pass


def run_agent_worker_process(
    agent_request_queue,
    agent_response_queue,
    tts_queue,
    shutdown_event,
    cancel_event,
    agent_busy_event,
    agent_heartbeat,
    config_dict: Optional[Dict[str, Any]] = None,
    config_path: Optional[str] = None
):
    """
    Top-level function to run Agent worker in a subprocess.
    Must be top-level (not a closure) for proper pickling with spawn.
    """
    import logging
    import time
    import traceback
    import sys
    import os
    import queue

    # Setup logging for this process
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [AGENT-%(process)d] %(levelname)s %(message)s',
        datefmt='%H:%M:%S',
        stream=sys.stdout
    )
    logger = logging.getLogger("AgentWorker")

    logger.info(f"Agent Worker starting (PID: {os.getpid()})")

    try:
        # Import harness components (in subprocess)
        from harness.config import HarnessConfig, load_or_create_config
        from harness.tool_registry import ToolRegistry
        from harness.router import Router, TaskClassification, TaskTier
        from harness.agent import TieredAgent
        from harness.event_bus import (
            AgentRequest, AgentResult, TTSRequest,
            BusMessage, MessageType
        )

        # Load configuration
        if config_dict:
            config = HarnessConfig.from_dict(config_dict)
        elif config_path:
            config = load_or_create_config(config_path)
        else:
            config = load_or_create_config()

        # Initialize components
        tool_registry = ToolRegistry(config.tools)
        logger.info(f"Tool registry: {len(tool_registry.list_tools())} tools")

        router = Router(config.router)
        for tier in TaskTier:
            tier_llm = config.llm_configs.get(tier.value)
            if tier_llm:
                router.set_tier_config(tier, tier_llm)

        agent = TieredAgent(
            config=config.agent,
            tool_registry=tool_registry,
            tier_configs=config.llm_configs
        )

        logger.info("Agent Worker initialized")

        # Helper to send TTS
        def send_tts(text: str, request_id: str, priority: int = 1, response_type: str = "completion"):
            msg = BusMessage(
                type=MessageType.TTS_REQUEST,
                payload={
                    "request_id": request_id,
                    "text": text,
                    "priority": priority,
                    "response_type": response_type
                },
                request_id=request_id
            )
            tts_queue.put(msg)

        # Helper for acknowledgments
        def get_acknowledgment(speech_text: str, classification) -> str:
            text_lower = speech_text.lower()
            if "search" in text_lower or "find" in text_lower:
                return "Let me look that up."
            elif "calculate" in text_lower:
                return "Calculating that for you."
            elif "run" in text_lower or "execute" in text_lower:
                return "Running that now."
            elif classification.tier == TaskTier.SIMPLE:
                return "On it."
            else:
                return "Working on that now."

        # Helper for spoken response
        def generate_spoken_response(content: str) -> str:
            if len(content) > 5000:
                paragraphs = content.split('\n\n')
                if paragraphs:
                    first = paragraphs[0]
                    if len(first) > 3000:
                        return first[:3000] + "... I've provided more details."
                    return first
            return content

        request_count = 0

        # Main loop
        while not shutdown_event.is_set():
            try:
                # Heartbeat
                agent_heartbeat.value = time.time()

                # Get next request
                try:
                    msg = agent_request_queue.get(timeout=0.5)
                except queue.Empty:
                    continue

                if msg is None:
                    continue

                # Check for shutdown
                if hasattr(msg, 'type') and msg.type.value == 'shutdown':
                    logger.info("Received shutdown signal")
                    break

                # Parse request
                if not hasattr(msg, 'payload'):
                    continue

                payload = msg.payload
                request_id = payload.get("request_id", f"req_{request_count}")
                speech_text = payload.get("speech_text", "")
                tier_hint = payload.get("tier", "standard")
                context = payload.get("context")

                if not speech_text:
                    continue

                request_count += 1
                logger.info(f"[{request_id}] Processing: {speech_text[:60]}...")

                start_time = time.time()
                agent_busy_event.set()

                try:
                    # Route
                    classification, _ = router.route(speech_text, context)
                    tier = classification.tier_name
                    logger.info(f"[{request_id}] Routed to tier '{tier}'")

                    # Send acknowledgment
                    ack = get_acknowledgment(speech_text, classification)
                    send_tts(ack, request_id, priority=0, response_type="acknowledgment")

                    # Check cancellation
                    if cancel_event.is_set():
                        logger.info(f"[{request_id}] Cancelled before agent")
                        cancel_event.clear()
                        continue

                    # Run agent
                    agent_response = agent.run(
                        user_input=speech_text,
                        tier=tier,
                        context=context
                    )

                    # Check cancellation after agent
                    if cancel_event.is_set():
                        logger.info(f"[{request_id}] Cancelled after agent")
                        cancel_event.clear()
                        continue

                    # Generate response
                    if agent_response.success:
                        spoken = generate_spoken_response(agent_response.content)
                        send_tts(spoken, request_id, priority=1, response_type="completion")
                    else:
                        error_msg = f"I ran into an issue: {agent_response.error or 'Unknown error'}"
                        spoken = error_msg
                        send_tts(error_msg, request_id, priority=0, response_type="error")

                    duration_ms = (time.time() - start_time) * 1000

                    # Send result back
                    result_msg = BusMessage(
                        type=MessageType.AGENT_RESPONSE,
                        payload={
                            "request_id": request_id,
                            "success": agent_response.success,
                            "content": agent_response.content,
                            "spoken_response": spoken,
                            "tools_used": agent_response.tools_used,
                            "duration_ms": duration_ms,
                            "error": agent_response.error,
                            "metadata": {"tier": tier}
                        },
                        request_id=request_id
                    )
                    agent_response_queue.put(result_msg)

                    logger.info(f"[{request_id}] Complete in {duration_ms:.0f}ms")

                except Exception as e:
                    duration_ms = (time.time() - start_time) * 1000
                    logger.error(f"[{request_id}] Error: {e}\n{traceback.format_exc()}")

                    send_tts("I'm sorry, something went wrong.", request_id, priority=0, response_type="error")

                    result_msg = BusMessage(
                        type=MessageType.AGENT_RESPONSE,
                        payload={
                            "request_id": request_id,
                            "success": False,
                            "content": str(e),
                            "spoken_response": "I'm sorry, something went wrong.",
                            "tools_used": [],
                            "duration_ms": duration_ms,
                            "error": str(e),
                            "metadata": {}
                        },
                        request_id=request_id
                    )
                    agent_response_queue.put(result_msg)

                finally:
                    agent_busy_event.clear()

            except Exception as e:
                logger.error(f"Agent loop error: {e}\n{traceback.format_exc()}")

        logger.info("Agent Worker shutting down")

    except Exception as e:
        logger.error(f"Agent Worker fatal error: {e}\n{traceback.format_exc()}")


def create_agent_worker(
    event_bus: EventBus,
    config: Optional[HarnessConfig] = None,
    config_path: Optional[str] = None
):
    """Factory function to create Agent worker process arguments"""
    # Serialize config to dict if provided (for pickling)
    config_dict = config.to_dict() if config else None

    return (
        run_agent_worker_process,
        (
            event_bus.agent_request_queue,
            event_bus.agent_response_queue,
            event_bus.tts_queue,
            event_bus.shutdown_event,
            event_bus.cancel_event,
            event_bus.agent_busy_event,
            event_bus._agent_last_heartbeat,
            config_dict,
            config_path
        )
    )
