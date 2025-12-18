"""
ServiceRepWorker - Process worker for ServiceRep.

This worker:
- Receives TranscriptionCompleteEvent from mailbox
- Delegates to ServiceRep for all processing
- ServiceRep owns AgentHarness and calls it directly (no IPC for heavy data)
- ServiceRep publishes only lightweight TTS strings to EventBus
"""

from typing import Optional
import logging

from communication.events import Event, TranscriptionCompleteEvent
from communication.mailbox import Mailbox
from communication.event_bus import EventBusProtocol
from communication.process_worker import ProcessWorker
from harness.service_rep import ServiceRep, create_service_rep
from util.config import ServiceRepConfig
from services.router import Router


class ServiceRepWorker(ProcessWorker):
    """
    ServiceRep worker process.

    Responsibilities:
    - Receive TranscriptionCompleteEvent from mailbox
    - Delegate to ServiceRep for orchestration
    - ServiceRep handles:
      * Intent classification
      * Task routing
      * Direct calls to AgentHarness (in-process)
      * TTS event publishing

    IMPORTANT: log_dir is required for proper logging. All logs (requests.jsonl,
    health.jsonl, llm_requests.log, etc.) will be written to this directory.
    """

    def __init__(
        self,
        mailbox: Mailbox,
        logger: Optional[logging.Logger] = None,
        event_bus: Optional[EventBusProtocol] = None,
        service_rep_config: Optional[ServiceRepConfig] = None,
        harness_config_path: Optional[str] = None,
        log_dir: Optional[str] = None
    ):
        super().__init__(mailbox, logger)
        self.event_bus = event_bus

        # Configuration
        self.service_rep_config = service_rep_config or ServiceRepConfig(enabled=True)
        self.harness_config_path = harness_config_path
        self._log_dir = log_dir

        # Will be initialized in initialize()
        self.service_rep: Optional[ServiceRep] = None
        self.router: Optional[Router] = None

    def initialize(self) -> bool:
        """Initialize ServiceRep and dependencies"""
        try:
            # Validate log_dir is provided
            if not self._log_dir:
                raise ValueError("log_dir is required for ServiceRepWorker - pass it via worker_kwargs")

            # Create router
            from services.router import Router
            from util.config import RouterConfig

            router_config = RouterConfig(
                enabled=True,
                default_tier="standard",
                llm_config=None  # Use pattern matching only for speed
            )
            self.router = Router(config=router_config)

            # Create ServiceRep (which will create AgentHarness)
            # Pass log_dir so all loggers write to the application's log directory
            self.service_rep = create_service_rep(
                config=self.service_rep_config,
                event_bus=self.event_bus,
                router=self.router,
                harness_config_path=self.harness_config_path,
                log_dir=self._log_dir  # All logs go to the application's log folder
            )

            self.logger.info(f"ServiceRepWorker initialized (log_dir={self._log_dir})")
            return True

        except Exception as e:
            self.logger.error(f"ServiceRepWorker initialization failed: {e}", exc_info=True)
            return False

    def process_event(self, event: Event) -> None:
        """Process transcription event from mailbox"""
        if isinstance(event, TranscriptionCompleteEvent):
            self._handle_transcription(event)

    def _handle_transcription(self, event: TranscriptionCompleteEvent):
        """Handle transcription by delegating to ServiceRep"""
        if not self.service_rep:
            self.logger.error("ServiceRep not initialized")
            return

        try:
            # Delegate to ServiceRep - it handles everything:
            # - Intent classification
            # - Routing
            # - Acknowledgment TTS
            # - Direct harness call
            # - Response summarization
            # - Completion TTS
            self.service_rep.handle_transcription(event)

        except Exception as e:
            self.logger.error(f"Error handling transcription: {e}", exc_info=True)

    def cleanup(self):
        """Clean up ServiceRep resources"""
        if self.service_rep:
            self.service_rep.cleanup()
        self.logger.info("ServiceRepWorker cleaned up")
