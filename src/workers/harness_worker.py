"""
HarnessWorker - Process worker for AgentHarness.

Receives AgentRequestSubmittedEvent from mailbox, processes via AgentHarness,
publishes responses back to EventBus.

Implements ProcessWorker interface (same pattern as TTSWorker).
"""

import time
from typing import Dict, Any, Optional
import logging

from communication.events import Event, AgentRequestSubmittedEvent, AgentResponseCompleteEvent, TTSRequestedEvent
from communication.mailbox import Mailbox
from communication.event_bus import EventBusProtocol
from communication.process_worker import ProcessWorker
from harness.harness import AgentHarness, HarnessResponse
from util.config import HarnessConfig, load_or_create_config
from util.runtime import create_runtime


class HarnessWorker(ProcessWorker):
    """
    Harness worker process.

    Responsibilities:
    - Receive AgentRequestSubmittedEvent from mailbox
    - Process via AgentHarness
    - Publish AgentResponse and TTS events back to EventBus
    """

    def __init__(
        self,
        mailbox: Mailbox,
        logger: Optional[logging.Logger] = None,
        event_bus: Optional[EventBusProtocol] = None,
        config: Optional[HarnessConfig] = None,
        config_path: Optional[str] = None
    ):
        super().__init__(mailbox, logger)
        self.event_bus = event_bus  # To publish responses
        self.config = config
        self.config_path = config_path

        # Will be initialized in initialize()
        self.harness: Optional[AgentHarness] = None

    def initialize(self) -> bool:
        """Initialize AgentHarness"""
        try:
            # Load config
            if self.config is None:
                if self.config_path:
                    self.config = load_or_create_config(self.config_path)
                else:
                    self.config = load_or_create_config()

            # Create runtime and harness
            runtime = create_runtime(config=self.config)
            self.harness = AgentHarness(runtime=runtime)

            self.logger.info(f"HarnessWorker initialized")
            return True

        except Exception as e:
            self.logger.error(f"HarnessWorker initialization failed: {e}", exc_info=True)
            return False

    def process_event(self, event: Event) -> None:
        """Process agent request from mailbox"""
        if isinstance(event, AgentRequestSubmittedEvent):
            self._handle_agent_request(event)

    def _handle_agent_request(self, event: AgentRequestSubmittedEvent):
        """Handle agent request and publish responses"""
        if not self.harness:
            self.logger.error("Harness not initialized")
            return

        request_id = event.request_id
        self.logger.info(f"[{request_id}] Processing agent request")

        try:
            start_time = time.time()

            # Process via harness
            harness_response: HarnessResponse = self.harness.process(
                speech_text=event.speech_text,
                context=event.context,
                request_id=request_id
            )

            duration_ms = (time.time() - start_time) * 1000

            # Publish AgentResponse event
            if self.event_bus:
                agent_response_event = AgentResponseCompleteEvent(
                    request_id=request_id,
                    success=harness_response.agent_response.success if harness_response.agent_response else False,
                    content=harness_response.full_response,
                    tools_used=harness_response.agent_response.tools_used if harness_response.agent_response else [],
                    duration_ms=duration_ms,
                    error=harness_response.agent_response.error if harness_response.agent_response else None,
                    metadata=harness_response.metadata or {}
                )
                self.event_bus.publish(agent_response_event)

            self.logger.info(f"[{request_id}] Completed in {duration_ms:.0f}ms")

        except Exception as e:
            self.logger.error(f"[{request_id}] Agent processing failed: {e}", exc_info=True)

            # Publish error response
            if self.event_bus:
                error_event = AgentResponseCompleteEvent(
                    request_id=request_id,
                    success=False,
                    content=str(e),
                    spoken_response="I'm sorry, something went wrong.",
                    tools_used=[],
                    duration_ms=0,
                    error=str(e),
                    metadata={"error": str(e)}
                )
                self.event_bus.publish(error_event)

    def cleanup(self):
        """Clean up harness resources"""
        if self.harness:
            self.harness.cleanup()
        self.logger.info("HarnessWorker cleaned up")


# # =============================================================================
# # LEGACY FACTORY FUNCTION
# # =============================================================================
# # Keep for backward compatibility with old ProcessManager
# # TODO: Remove in Phase 8 after ProcessManager migration
# # =============================================================================

# def create_harness_process(
#     event_bus,
#     config: Optional[HarnessConfig] = None,
#     config_path: Optional[str] = None
# ):
#     """
#     LEGACY: Factory function for old ProcessManager.

#     This maintains backward compatibility with the old worker creation pattern.
#     New code should use ProcessManager.register_worker() directly.

#     Args:
#         event_bus: Legacy EventBus instance
#         config: Optional harness configuration
#         config_path: Optional path to config file

#     Returns:
#         Tuple of (target_function, args) for Process creation
#     """
#     # Import old worker function for compatibility
#     from harness.harness_process import run_harness_process

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
