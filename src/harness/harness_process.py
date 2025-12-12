# """
# HarnessProcess - Runs AgentHarness inside a dedicated worker process.

# Bridges the communication EventBus queues with the domain-layer harness so that
# all routing, acknowledgments, and agent control are handled by AgentHarness.
# """

# from __future__ import annotations

# import logging
# import queue
# import time
# import traceback
# from typing import Optional, Dict, Any

# from communication.event_bus import (
#     AgentRequest,
#     AgentResult,
#     BusMessage,
#     MessageType,
# )
# from harness.config import HarnessConfig, load_or_create_config
# from harness.harness import AgentHarness
# from harness.runtime import create_runtime


# class EventBusTTSEngine:
#     """
#     Lightweight TTS adapter that publishes ServiceRep speech to the EventBus.
#     """

#     def __init__(self, tts_queue, tts_speaking_event):
#         self.tts_queue = tts_queue
#         self.tts_speaking_event = tts_speaking_event
#         self.current_request_id: str = ""
#         self._engine_type = "event_bus"

#     def initialize(self) -> bool:
#         return True

#     def speak(self, response):
#         """Publish speech requests to the shared TTS queue."""
#         request_id = response.metadata.get("request_id") if response.metadata else None
#         request_id = request_id or self.current_request_id

#         msg = BusMessage(
#             type=MessageType.TTS_REQUEST,
#             payload={
#                 "request_id": request_id or "",
#                 "text": response.text,
#                 "priority": response.priority,
#                 "response_type": response.response_type.value,
#             },
#             request_id=request_id or "",
#         )
#         self.tts_queue.put(msg)

#     @property
#     def is_speaking(self) -> bool:
#         return bool(self.tts_speaking_event and self.tts_speaking_event.is_set())

#     def cleanup(self):
#         """No-op for compatibility."""
#         return True

#     def stop(self):
#         """Compatibility shim with TTSEngine interface."""
#         return True


# def _deserialize_agent_request(msg: BusMessage) -> Optional[AgentRequest]:
#     """Convert BusMessage payload into an AgentRequest."""
#     if not isinstance(msg, BusMessage):
#         return None
#     if msg.type != MessageType.AGENT_REQUEST:
#         return None

#     payload = msg.payload or {}
#     return AgentRequest(
#         request_id=payload.get("request_id", msg.request_id or ""),
#         speech_text=payload.get("speech_text", ""),
#         tier=payload.get("tier", "standard"),
#         context=payload.get("context"),
#         conversation_history=payload.get("conversation_history", []),
#     )


# def _build_cancel_result(request_id: str, message: str) -> AgentResult:
#     """Construct a cancellation result for the main process."""
#     return AgentResult(
#         request_id=request_id,
#         success=False,
#         content=message,
#         spoken_response="",
#         tools_used=[],
#         duration_ms=0,
#         error="Cancelled",
#         metadata={"cancelled": True},
#     )


# def _send_result(queue_obj, request_id: str, result: AgentResult):
#     """Serialize and send an AgentResult via BusMessage."""
#     queue_obj.put(
#         BusMessage(
#             type=MessageType.AGENT_RESPONSE,
#             payload={
#                 "request_id": result.request_id,
#                 "success": result.success,
#                 "content": result.content,
#                 "spoken_response": result.spoken_response,
#                 "tools_used": result.tools_used,
#                 "duration_ms": result.duration_ms,
#                 "error": result.error,
#                 "metadata": result.metadata or {},
#             },
#             request_id=request_id,
#         )
#     )


# def run_harness_process(
#     agent_request_queue,
#     agent_response_queue,
#     tts_queue,
#     shutdown_event,
#     cancel_event,
#     agent_busy_event,
#     agent_heartbeat,
#     tts_speaking_event,
#     config_dict: Optional[Dict[str, Any]] = None,
#     config_path: Optional[str] = None,
# ):
#     """
#     Entry point executed in the dedicated Harness process.
#     """
#     logging.basicConfig(
#         level=logging.INFO,
#         format="%(asctime)s [HARNESS-%(process)d] %(levelname)s %(message)s",
#         datefmt="%H:%M:%S",
#     )
#     logger = logging.getLogger("HarnessProcess")
#     logger.info("Harness process starting")

#     try:
#         # Load configuration
#         if config_dict:
#             config = HarnessConfig.from_dict(config_dict)
#         elif config_path:
#             config = load_or_create_config(config_path)
#         else:
#             config = load_or_create_config()

#         runtime = create_runtime(config=config)
#         harness = AgentHarness(runtime=runtime)

#         # Replace ServiceRep TTS engine with EventBus publisher
#         try:
#             if hasattr(harness.service_rep.tts, "cleanup"):
#                 harness.service_rep.tts.cleanup()
#         except Exception:
#             logger.warning("Failed to cleanup default TTS engine before swap")

#         tts_engine = EventBusTTSEngine(tts_queue, tts_speaking_event)
#         harness.service_rep.tts = tts_engine
#         tts_engine.initialize()

#         logger.info("Harness process ready for requests")

#         while not shutdown_event.is_set():
#             try:
#                 agent_heartbeat.value = time.time()

#                 try:
#                     msg = agent_request_queue.get(timeout=0.5)
#                 except queue.Empty:
#                     continue

#                 if msg is None:
#                     continue

#                 if isinstance(msg, BusMessage) and msg.type == MessageType.SHUTDOWN:
#                     logger.info("Harness process received shutdown signal")
#                     break

#                 request = msg if isinstance(msg, AgentRequest) else _deserialize_agent_request(msg)
#                 if request is None or not request.speech_text:
#                     continue

#                 agent_busy_event.set()
#                 tts_engine.current_request_id = request.request_id

#                 if cancel_event.is_set():
#                     logger.info(f"[{request.request_id}] Cancelled before harness execution")
#                     cancel_result = _build_cancel_result(request.request_id, "Request cancelled")
#                     _send_result(agent_response_queue, request.request_id, cancel_result)
#                     continue

#                 start_time = time.time()
#                 response = harness.process(
#                     request.speech_text,
#                     context=request.context,
#                     request_id=request.request_id,
#                 )
#                 duration_ms = (time.time() - start_time) * 1000

#                 if cancel_event.is_set():
#                     logger.info(f"[{request.request_id}] Cancelled post-processing")
#                     cancel_result = _build_cancel_result(
#                         request.request_id,
#                         response.full_response if response.full_response else "Request cancelled",
#                     )
#                     _send_result(agent_response_queue, request.request_id, cancel_result)
#                     continue

#                 agent_result = AgentResult(
#                     request_id=request.request_id,
#                     success=response.agent_response.success if response.agent_response else False,
#                     content=response.full_response,
#                     spoken_response=response.spoken_response,
#                     tools_used=response.agent_response.tools_used if response.agent_response else [],
#                     duration_ms=duration_ms,
#                     error=response.agent_response.error if response.agent_response else None,
#                     metadata=response.metadata,
#                 )

#                 _send_result(agent_response_queue, request.request_id, agent_result)

#             except Exception as exc:
#                 logger.error(f"Harness loop error: {exc}\n{traceback.format_exc()}")
#                 error_msg = "I'm sorry, something went wrong. Please try again."
#                 err_result = AgentResult(
#                     request_id=request.request_id if "request" in locals() else "",
#                     success=False,
#                     content=str(exc),
#                     spoken_response=error_msg,
#                     tools_used=[],
#                     duration_ms=0,
#                     error=str(exc),
#                     metadata={"error": str(exc)},
#                 )
#                 _send_result(agent_response_queue, err_result.request_id, err_result)
#             finally:
#                 agent_busy_event.clear()
#                 cancel_event.clear()

#         logger.info("Harness process shutting down")

#     except Exception as exc:
#         logger.error(f"Harness process fatal error: {exc}\n{traceback.format_exc()}")


# def create_harness_process(
#     event_bus,
#     config: Optional[HarnessConfig] = None,
#     config_path: Optional[str] = None,
# ):
#     """
#     Factory helper wired into ProcessManager for spawning the harness process.
#     """
#     config_dict = config.to_dict() if config else None

#     return (
#         run_harness_process,
#         (
#             event_bus.agent_request_queue,
#             event_bus.agent_response_queue,
#             event_bus.tts_queue,
#             event_bus.shutdown_event,
#             event_bus.cancel_event,
#             event_bus.agent_busy_event,
#             event_bus._agent_last_heartbeat,
#             event_bus.tts_speaking_event,
#             config_dict,
#             config_path,
#         ),
#     )
