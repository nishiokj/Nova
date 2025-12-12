# """
# AgentHarness - Main orchestrator for the agentic system.
# Coordinates Router, ServiceRep, Agent, and Tool execution.
# """

# import os
# import time
# import threading
# import queue
# from dataclasses import dataclass, field
# from typing import Dict, Any, Optional, List, Callable, Generator
# from enum import Enum
# from contextlib import nullcontext

# from .config import HarnessConfig, RuntimeConfig, load_or_create_config
# from .logger import StructuredLogger
# from .llm_adapter import create_adapter, Message, MessageRole
# from .tool_registry import ToolRegistry, ToolConfig
# from .router import Router, TaskClassification, TaskTier
# from .service_rep import ResponseType, SpokenResponse
# from .agent import Agent, AgentResponse, AgentStep, TieredAgent
# from .runtime import HarnessRuntime, create_runtime
# from .agent_execution_logger import AgentExecutionLogger


# class HarnessState(Enum):
#     """Harness execution states"""
#     IDLE = "idle"
#     PROCESSING = "processing"
#     ROUTING = "routing"
#     ACKNOWLEDGING = "acknowledging"
#     AGENT_WORKING = "agent_working"
#     RESPONDING = "responding"
#     ERROR = "error"


# @dataclass
# class HarnessResponse:
#     """Complete response from the harness"""
#     spoken_response: str       # What was spoken to the user
#     full_response: str         # Full text response
#     agent_response: AgentResponse
#     classification: Optional[TaskClassification] = None
#     state: HarnessState = HarnessState.IDLE
#     duration_ms: float = 0
#     metadata: Dict[str, Any] = field(default_factory=dict)

#     def to_dict(self) -> Dict[str, Any]:
#         return {
#             "spoken_response": self.spoken_response,
#             "full_response": self.full_response,
#             "agent_response": self.agent_response.to_dict() if self.agent_response else None,
#             "classification": {
#                 "tier": self.classification.tier_name,
#                 "confidence": self.classification.confidence
#             } if self.classification else None,
#             "state": self.state.value,
#             "duration_ms": self.duration_ms,
#             "metadata": self.metadata
#         }


# class AgentHarness:
#     """
#     Main orchestrator for the agentic system.

#     Flow:
#     1. Receive linted speech text
#     2. (Optional) Route to determine task tier
#     3. ServiceRep acknowledges request via TTS
#     4. Agent processes with tools
#     5. ServiceRep speaks final response
#     """

#     def __init__(
#         self,
#         config: Optional[HarnessConfig] = None,
#         config_path: str = None,
#         profiler: Optional[Any] = None,
#         runtime: Optional[HarnessRuntime] = None,
#         logger: Optional[StructuredLogger] = None,
#         execution_logger: Optional[AgentExecutionLogger] = None
#     ):
#         if runtime and (config or config_path):
#             raise ValueError("Provide either an existing runtime or configuration inputs, not both.")

#         self.runtime = runtime or create_runtime(
#             config=config,
#             config_path=config_path,
#             profiler=profiler,
#             logger=logger,
#             execution_logger=execution_logger
#         )

#         # Instrumentation
#         self.profiler = profiler if profiler is not None else self.runtime.profiler
#         self._runtime_config = self.runtime.runtime_config
#         self.logger: StructuredLogger = self.runtime.logger

#         # State management
#         self._state = HarnessState.IDLE
#         self._lock = threading.Lock()
#         self._tts_speaking_event = threading.Event()

#         # Core components sourced from runtime
#         self.tool_registry = self.runtime.tool_registry
#         self.router = self.runtime.router
#         self.agent = self.runtime.agent
#         self.service_rep = self.runtime.create_service_rep(
#             speech_block_event=self._tts_speaking_event
#         )

#         # Internal bookkeeping
#         self._last_progress_tool = None

#         # Request queue for async processing
#         self._request_queue: queue.Queue = queue.Queue()
#         self._processing_thread: Optional[threading.Thread] = None
#         self._running = False

#         # Callbacks
#         self._response_callbacks: List[Callable[[HarnessResponse], None]] = []
#         self._state_callbacks: List[Callable[[HarnessState], None]] = []

#         self.logger.system_init("harness", "ready")

#     def _profile(self, metric_name: str):
#         """Helper to get profiler context if available"""
#         if not self.profiler:
#             return nullcontext()
#         return self.profiler.measure(metric_name)

#     def _set_state(self, state: HarnessState):
#         """Set harness state and notify callbacks"""
#         self._state = state
#         for callback in self._state_callbacks:
#             try:
#                 callback(state)
#             except Exception as e:
#                 self.logger.error(f"State callback error: {e}", component="harness")

#     def process(
#         self,
#         speech_text: str,
#         context: Optional[str] = None,
#         request_id: Optional[str] = None
#     ) -> HarnessResponse:
#         """
#         Process linted speech text through the full pipeline.

#         Args:
#             speech_text: The linted/cleaned speech transcription
#             context: Optional additional context
#             request_id: Optional pre-assigned request identifier

#         Returns:
#             HarnessResponse with spoken and full response
#         """
#         request_id = request_id or self.logger.new_request()
#         start_time = time.time()

#         self.logger.request_received(speech_text)
#         call_dir = os.getcwd()
#         self._set_state(HarnessState.PROCESSING)
#         classification = None
#         agent_response = None
#         spoken_response = ""
#         full_response = ""

#         try:
#             # Step 1: Route (if enabled)
#             self._set_state(HarnessState.ROUTING)
#             with self._profile("harness.route_ms"):
#                 classification, tier_config = self.router.route(speech_text, context)
#             # Note: router.py already logs input_parsed

#             # Step 2: ServiceRep acknowledgment
#             self._set_state(HarnessState.ACKNOWLEDGING)

#             # Generate brief action description for acknowledgment
#             with self._profile("harness.action_preview_ms"):
#                 action_description = self._generate_action_preview(speech_text, classification)
#             with self._profile("harness.service_rep_ack_ms"):
#                 self.service_rep.acknowledge_request(speech_text, action_description)

#             # Step 3: Agent execution with progress updates
#             self._set_state(HarnessState.AGENT_WORKING)

#             # Reset progress tracking and wire up callback
#             self._last_progress_tool = None
#             progress_callback = self._create_progress_callback()

#             # Get the agent for this tier and add progress callback
#             tier_agent = self.agent._get_agent(classification.tier_name)
#             tier_agent.add_step_callback(progress_callback)

#             try:
#                 with self.tool_registry.with_working_dir(call_dir):
#                     with self._profile("harness.agent_run_ms"):
#                         agent_response = self.agent.run(
#                             user_input=speech_text,
#                             tier=classification.tier_name,
#                             context=context
#                         )
#             finally:
#                 # Clean up callback to avoid accumulation
#                 if progress_callback in tier_agent._step_callbacks:
#                     tier_agent._step_callbacks.remove(progress_callback)

#             # Step 4: Generate and speak response
#     #        self._set_state(HarnessState.RESPONDING)

#             if agent_response.success:
#                 # Generate spoken response (may be abbreviated)
#                 with self._profile("harness.spoken_response_ms"):
#                     spoken_response = self._generate_spoken_response(agent_response)
#                 full_response = agent_response.content
#                 file_ops = agent_response.metadata.get("file_operations", []) if agent_response.metadata else []
#                 for op in file_ops:
#                     self.logger.file_operation(
#                         "harness_file",
#                         op.get("path"),
#                         status="noted",
#                         detail=f"tool={op.get('tool')} action={op.get('action')}",
#                         component="harness"
#                     )
#                 # Speak the response
#                 with self._profile("harness.service_rep_respond_ms"):
#                     self.service_rep.report_completion(spoken_response, full_response)
#             else:
#                 # Handle error
#                 error_msg = f"I ran into an issue: {agent_response.error or 'Unknown error'}"
#                 spoken_response = error_msg
#                 full_response = agent_response.content

#                 with self._profile("harness.service_rep_error_ms"):
#                     self.service_rep.report_error(spoken_response, agent_response.error)

#             # Complete
#             self._set_state(HarnessState.IDLE)
#             duration_ms = (time.time() - start_time) * 1000

#             with self._profile("harness.output_serialization_ms"):
#                 # Include success status from agent response
#                 response_metadata = {
#                     "tier": classification.tier_name,
#                     "tools_used": agent_response.tools_used if agent_response else [],
#                     "success": agent_response.success if agent_response else False,
#                     "goal_achieved": agent_response.goal_achieved if agent_response else False,
#                 }
#                 if agent_response and agent_response.metadata:
#                     if "status" in agent_response.metadata:
#                         response_metadata["status"] = agent_response.metadata["status"]
#                     if "had_tool_failures" in agent_response.metadata:
#                         response_metadata["had_tool_failures"] = agent_response.metadata["had_tool_failures"]
#                     if "plan_type" in agent_response.metadata:
#                         response_metadata["plan_type"] = agent_response.metadata["plan_type"]
#                     if "reflection_confidence" in agent_response.metadata:
#                         response_metadata["reflection_conf"] = agent_response.metadata["reflection_confidence"]
#                 if agent_response and agent_response.error:
#                     response_metadata["error"] = agent_response.error

#                 self.logger.response_sent(spoken_response, metadata=response_metadata)

#             response = HarnessResponse(
#                 spoken_response=spoken_response,
#                 full_response=full_response,
#                 agent_response=agent_response,
#                 classification=classification,
#                 state=HarnessState.IDLE,
#                 duration_ms=duration_ms,
#                 metadata={
#                     "request_id": request_id,
#                     "tier": classification.tier_name
#                 }
#             )

#             # Notify callbacks
#             for callback in self._response_callbacks:
#                 try:
#                     callback(response)
#                 except Exception as e:
#                     self.logger.error(f"Response callback error: {e}", component="harness")

#             return response

#         except Exception as e:
#             self._set_state(HarnessState.ERROR)
#             self.logger.error(f"Harness processing failed: {e}", component="harness", error=e)

#             # Speak error to user
#             error_spoken = "I'm sorry, something went wrong. Please try again."
#             with self._profile("harness.service_rep_error_ms"):
#                 self.service_rep.report_error(error_spoken, str(e))

#             return HarnessResponse(
#                 spoken_response=error_spoken,
#                 full_response=f"Error: {str(e)}",
#                 agent_response=agent_response,
#                 classification=classification,
#                 state=HarnessState.ERROR,
#                 duration_ms=(time.time() - start_time) * 1000,
#                 metadata={"error": str(e), "request_id": request_id}
#             )

#     def process_streaming(
#         self,
#         speech_text: str,
#         context: Optional[str] = None
#     ) -> Generator[str, None, HarnessResponse]:
#         """
#         Process with streaming response.
#         Yields chunks as they're generated.
#         """
#         request_id = self.logger.new_request()
#         start_time = time.time()

#         self.logger.request_received(speech_text)
#         call_dir = os.getcwd()
#         self._set_state(HarnessState.PROCESSING)

#         classification = None
#         full_content = ""

#         try:
#             # Route
#             self._set_state(HarnessState.ROUTING)
#             classification, _ = self.router.route(speech_text, context)
#             # Note: router.py already logs input_parsed

#             # Acknowledge
#             self._set_state(HarnessState.ACKNOWLEDGING)
#             action_preview = self._generate_action_preview(speech_text, classification)
#             self.service_rep.acknowledge_request(speech_text, action_preview)

#             # Stream agent response with progress updates
#             self._set_state(HarnessState.AGENT_WORKING)

#             # Reset progress tracking and wire up callback
#             self._last_progress_tool = None
#             progress_callback = self._create_progress_callback()

#             agent = self.agent._get_agent(classification.tier_name)
#             agent.add_step_callback(progress_callback)
#             agent_response = None

#             with self.tool_registry.with_working_dir(call_dir):
#                 for chunk in agent.run_streaming(speech_text, context):
#                     full_content += chunk
#                     yield chunk

#                     # Stream to TTS
#                     if hasattr(self.service_rep, 'stream_response_chunk'):
#                         self.service_rep.stream_response_chunk(chunk)

#             # Flush any remaining TTS buffer
#             if hasattr(self.service_rep, 'flush_buffer'):
#                 self.service_rep.flush_buffer()

#             # Clean up progress callback
#             if progress_callback in agent._step_callbacks:
#                 agent._step_callbacks.remove(progress_callback)

#             self._set_state(HarnessState.IDLE)
#             duration_ms = (time.time() - start_time) * 1000

#             return HarnessResponse(
#                 spoken_response=full_content[:500],  # Truncate for spoken
#                 full_response=full_content,
#                 agent_response=AgentResponse(content=full_content, success=True),
#                 classification=classification,
#                 state=HarnessState.IDLE,
#                 duration_ms=duration_ms,
#                 metadata={"request_id": request_id, "streaming": True}
#             )

#         except Exception as e:
#             self._set_state(HarnessState.ERROR)
#             self.logger.error(f"Streaming processing failed: {e}", component="harness")
#             yield f"\nError: {str(e)}"

#             # Clean up progress callback on error (if it was created)
#             try:
#                 if progress_callback and agent and progress_callback in agent._step_callbacks:
#                     agent._step_callbacks.remove(progress_callback)
#             except (NameError, AttributeError):
#                 pass  # Callback wasn't created yet

#             return HarnessResponse(
#                 spoken_response="An error occurred",
#                 full_response=full_content + f"\nError: {str(e)}",
#                 agent_response=AgentResponse(content=full_content, success=False, error=str(e)),
#                 classification=classification,
#                 state=HarnessState.ERROR,
#                 duration_ms=(time.time() - start_time) * 1000
#             )

#     def _generate_action_preview(self, speech_text: str, classification: TaskClassification) -> str:
#         """Generate a brief action preview for acknowledgment"""
#         # Simple heuristic-based preview generation
#         text_lower = speech_text.lower()

#         if "search" in text_lower or "find" in text_lower or "look up" in text_lower:
#             return "I'll search for that information"
#         elif "calculate" in text_lower or "compute" in text_lower:
#             return "I'll calculate that for you"
#         elif "run" in text_lower or "execute" in text_lower:
#             return "I'll run that command"
#         elif "read" in text_lower or "show" in text_lower or "open" in text_lower:
#             return "I'll get that for you"
#         elif "write" in text_lower or "create" in text_lower:
#             return "I'll create that"
#         elif classification.tier == TaskTier.SIMPLE:
#             return "Let me help you with that"
#         elif classification.tier == TaskTier.ADVANCED:
#             return "I'll work on this task"
#         else:
#             return "I'm working on that"

#     def _get_tool_progress_message(self, tool_name: str, step_number: int) -> Optional[str]:
#         """
#         Get a progress message for tool execution.
#         Returns None if we shouldn't speak (to avoid over-chatting).
#         """
#         # Don't repeat progress for same tool
#         if self._last_progress_tool == tool_name:
#             return None

#         self._last_progress_tool = tool_name
#         tool_lower = tool_name.lower()

#         # Map tools to spoken progress messages
#         if "search" in tool_lower or "web" in tool_lower:
#             return "Searching now."
#         elif "fetch" in tool_lower or "get" in tool_lower:
#             return "Getting that information."
#         elif "read" in tool_lower or "file" in tool_lower:
#             return "Reading the file."
#         elif "write" in tool_lower or "save" in tool_lower:
#             return "Writing the file."
#         elif "bash" in tool_lower or "command" in tool_lower or "exec" in tool_lower:
#             return "Running the command."
#         elif "calc" in tool_lower or "math" in tool_lower:
#             return "Calculating."
#         else:
#             # Only speak for first tool call to avoid over-chatting
#             if step_number == 0:
#                 return "Working on it."
#             return None

#     def _create_progress_callback(self) -> Callable[[AgentStep], None]:
#         """Create a callback to report progress during agent execution"""
#         def on_step(step: AgentStep):
#             # Only report progress for tool executions
#             if step.tool_name:
#                 progress_msg = self._get_tool_progress_message(step.tool_name, step.step_number)
#                 if progress_msg:
#                     self.service_rep.report_progress(progress_msg)

#         return on_step

#     def _generate_spoken_response(self, agent_response: AgentResponse) -> str:
#         """Generate a spoken version of the response (may be abbreviated)"""
#         content = agent_response.content or ""
#         metadata = agent_response.metadata or {}
#         file_ops = metadata.get("file_operations", [])

#         if file_ops:
#             summaries = []
#             seen_paths = set()
#             for op in file_ops:
#                 path = op.get("path") or ""
#                 action = (op.get("action") or "write").capitalize()
#                 if path and path in seen_paths:
#                     continue
#                 summaries.append(f"{action} {path or 'the requested file'}")
#                 if path:
#                     seen_paths.add(path)
#                 if len(summaries) >= 3:
#                     break

#             file_summary = "; ".join(summaries)
#             spoken = f"{file_summary}. I've saved the requested content to disk."
#             if len(file_ops) > len(summaries):
#                 spoken += f" ({len(file_ops)} files total.)"
#             spoken += " Let me know if you want me to read any part of it aloud."
#             return spoken

#         # If response is too long, summarize
#         if len(content) > 5000:
#             # Take first paragraph or sentence
#             paragraphs = content.split('\n\n')
#             if paragraphs:
#                 first_para = paragraphs[0]
#                 if len(first_para) > 3000:
#                     # Take first sentence
#                     sentences = first_para.split('. ')
#                     if sentences:
#                         return sentences[0] + ". I've provided the full details."
#                 return first_para[:3000] + "... I've provided more details."

#         return content

#     # Async processing methods

#     def start_async_processing(self):
#         """Start background thread for async request processing"""
#         if self._running:
#             return

#         self._running = True
#         self._processing_thread = threading.Thread(target=self._async_processing_loop, daemon=True)
#         self._processing_thread.start()
#         self.logger.info("Async processing started", component="harness")

#     def stop_async_processing(self):
#         """Stop async processing"""
#         self._running = False
#         if self._processing_thread:
#             self._processing_thread.join(timeout=5.0)
#         self.logger.info("Async processing stopped", component="harness")

#     def _async_processing_loop(self):
#         """Background processing loop"""
#         while self._running:
#             try:
#                 request = self._request_queue.get(timeout=0.5)
#                 if request is None:
#                     continue

#                 speech_text, context, callback = request
#                 response = self.process(speech_text, context)

#                 if callback:
#                     callback(response)

#             except queue.Empty:
#                 continue
#             except Exception as e:
#                 self.logger.error(f"Async processing error: {e}", component="harness")

#     def submit_request(
#         self,
#         speech_text: str,
#         context: Optional[str] = None,
#         callback: Optional[Callable[[HarnessResponse], None]] = None
#     ):
#         """Submit request for async processing"""
#         self._request_queue.put((speech_text, context, callback))

#     # Configuration and state management

#     @property
#     def state(self) -> HarnessState:
#         """Get current harness state"""
#         return self._state

#     @property
#     def config(self) -> RuntimeConfig:
#         """Get runtime configuration"""
#         return self._runtime_config

#     def update_config(self, updates: Dict[str, Any]) -> List[str]:
#         """Update configuration at runtime"""
#         successful = self._runtime_config.update(updates)
#         for path in successful:
#             self.logger.config_change(path, "previous", updates.get(path))
#         return successful

#     def enable_router(self):
#         """Enable router"""
#         self.router.enable()
#         self.logger.info("Router enabled", component="harness")

#     def disable_router(self):
#         """Disable router"""
#         self.router.disable()
#         self.logger.info("Router disabled", component="harness")

#     def enable_service_rep(self):
#         """Enable ServiceRep TTS"""
#         self.service_rep.enable()
#         self.logger.info("ServiceRep enabled", component="harness")

#     def disable_service_rep(self):
#         """Disable ServiceRep TTS"""
#         self.service_rep.disable()
#         self.logger.info("ServiceRep disabled", component="harness")

#     def set_default_tier(self, tier: str):
#         """Set default agent tier"""
#         self.router.set_default_tier(tier)
#         self.agent.set_tier(tier)
#         self.logger.info(f"Default tier set to: {tier}", component="harness")

#     # Tool management

#     def register_tool(self, tool):
#         """Register a new tool"""
#         self.tool_registry.register(tool)

#     def enable_tool(self, name: str):
#         """Enable a tool"""
#         self.tool_registry.enable(name)

#     def disable_tool(self, name: str):
#         """Disable a tool"""
#         self.tool_registry.disable(name)

#     def list_tools(self) -> List[str]:
#         """List available tools"""
#         return [t.name for t in self.tool_registry.list_tools()]

#     # Callbacks

#     def add_response_callback(self, callback: Callable[[HarnessResponse], None]):
#         """Add callback for completed responses"""
#         self._response_callbacks.append(callback)

#     def add_state_callback(self, callback: Callable[[HarnessState], None]):
#         """Add callback for state changes"""
#         self._state_callbacks.append(callback)

#     # Cleanup

#     def cleanup(self):
#         """Clean up all resources"""
#         self.stop_async_processing()
#         self.service_rep.cleanup()
#         self.logger.info("AgentHarness cleaned up", component="harness")

#     @property
#     def tts_speaking_event(self) -> threading.Event:
#         """Event that is set while ServiceRep/TTS is speaking"""
#         return self._tts_speaking_event


# # Factory function
# def create_harness(
#     config_path: str = None,
#     router_enabled: bool = True,
#     service_rep_enabled: bool = True,
#     default_tier: str = "standard",
#     profiler: Optional[Any] = None,
#     logger: Optional[StructuredLogger] = None,
#     execution_logger: Optional[AgentExecutionLogger] = None
# ) -> AgentHarness:
#     """
#     Create and configure an AgentHarness instance.

#     Args:
#         config_path: Path to configuration file
#         router_enabled: Whether to enable routing
#         service_rep_enabled: Whether to enable TTS
#         default_tier: Default agent tier
#         profiler: Optional profiler for runtime metrics

#     Returns:
#         Configured AgentHarness instance
#     """
#     config = load_or_create_config(config_path) if config_path else HarnessConfig()

#     config.router.enabled = router_enabled
#     config.service_rep.enabled = service_rep_enabled
#     config.agent.tier = default_tier

#     runtime = create_runtime(
#         config=config,
#         profiler=profiler,
#         logger=logger,
#         execution_logger=execution_logger
#     )
#     return AgentHarness(runtime=runtime)
