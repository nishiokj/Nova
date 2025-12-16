"""
ProcessWorker - Standard interface for all worker processes.

All worker processes inherit from this base class, providing:
- Standard lifecycle (initialize, run, cleanup)
- Event loop with mailbox
- Graceful shutdown handling
"""

from abc import ABC, abstractmethod
import threading
import logging
from typing import Optional

from communication.mailbox import Mailbox
from communication.events import Event, ShutdownEvent


class ProcessWorker(ABC):
    """
    Standard interface for all worker processes.

    Provides:
    - Mailbox for receiving events
    - Standard lifecycle methods
    - Event loop that handles shutdown gracefully
    """

    def __init__(self, mailbox: Mailbox, logger: Optional[logging.Logger] = None):
        """
        Initialize worker.

        Args:
            mailbox: Mailbox for receiving events
            logger: Logger instance (will create if not provided)
        """
        self.mailbox = mailbox
        self.logger = logger or logging.getLogger(self.__class__.__name__)
        self._shutdown = threading.Event()

    @abstractmethod
    def initialize(self) -> bool:
        """
        Initialize resources.

        Called once before the event loop starts.

        Returns:
            True if initialization successful, False otherwise
        """
        pass

    @abstractmethod
    def process_event(self, event: Event) -> None:
        """
        Process a single event from mailbox.

        Args:
            event: Event to process
        """
        pass

    @abstractmethod
    def cleanup(self) -> None:
        """
        Clean up resources.

        Called once after the event loop exits.
        """
        pass

    def run(self) -> None:
        """
        Standard event loop (same for all workers).

        This method:
        1. Calls initialize()
        2. Loops, receiving events from mailbox and calling process_event()
        3. Exits on shutdown event
        4. Calls cleanup()
        """
        if not self.initialize():
            self.logger.error(f"{self.__class__.__name__}: Initialization failed")
            return

        self.logger.info(f"{self.__class__.__name__}: Running")

        while True:
            try:
                event = self.mailbox.receive()

                if event is None:
                    continue

                if isinstance(event, ShutdownEvent):
                    self.logger.info(f"{self.__class__.__name__}: Received shutdown event")
                    break

                self.process_event(event)

            except Exception as e:
                self.logger.error(f"Error processing event: {e}", exc_info=True)

            if self._shutdown.is_set():
                break

        self.cleanup()
        self.logger.info(f"{self.__class__.__name__}: Stopped")

    def shutdown(self) -> None:
        """Signal shutdown"""
        if not self._shutdown.is_set():
            self._shutdown.set()
            self.mailbox.deliver(ShutdownEvent())
