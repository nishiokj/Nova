"""
Base Voice Application - Common functionality for all runtime modes.
"""

import os
import sys
import logging
import uuid
from abc import ABC, abstractmethod
from typing import Optional

from app_config import AppConfig
from communication import EventBusProtocol
from services import TextLinterService


class BaseVoiceApp(ABC):
    """
    Base class for voice applications.

    Handles:
    - Configuration loading
    - Logger creation
    - Common lifecycle methods
    - Dependency injection setup
    """

    def __init__(self, config: AppConfig):
        """
        Initialize base application.

        Args:
            config: Application configuration
        """
        self.config = config
        self.logger = self._setup_logging()
        self.event_bus: Optional[EventBusProtocol] = None
        self.running = False

        # Common services
        self.linter: Optional[TextLinterService] = None

    def _setup_logging(self) -> logging.Logger:
        """
        Setup logging based on configuration.

        Returns:
            Configured logger instance
        """
        log_config = self.config.logging

        # Create logs directory
        os.makedirs(log_config.log_dir, exist_ok=True)

        # Configure root logger
        handlers = []

        if log_config.log_to_file:
            file_handler = logging.FileHandler(
                os.path.join(log_config.log_dir, "app.log")
            )
            file_handler.setLevel(getattr(logging, log_config.level))
            file_handler.setFormatter(logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
            ))
            handlers.append(file_handler)

        if log_config.log_to_console:
            console_handler = logging.StreamHandler(sys.stdout)
            console_handler.setLevel(getattr(logging, log_config.level))
            console_handler.setFormatter(logging.Formatter(
                '%(asctime)s [%(levelname)s] %(message)s',
                datefmt='%H:%M:%S'
            ))
            handlers.append(console_handler)

        # Configure logging
        logging.basicConfig(
            level=getattr(logging, log_config.level),
            handlers=handlers
        )

        # Suppress noisy libraries
        for noisy in ['httpx', 'httpcore', 'openai', 'faster_whisper', 'urllib3', 'asyncio']:
            logging.getLogger(noisy).setLevel(logging.WARNING)

        logger = logging.getLogger("app")
        logger.setLevel(getattr(logging, log_config.level))

        return logger

    def _create_linter(self) -> TextLinterService:
        """
        Create text linter service with injected dependencies.

        Returns:
            Configured TextLinterService
        """
        return TextLinterService(
            logger=self.logger.getChild("linter"),
            cache_size=self.config.linter.cache_size
        )

    @staticmethod
    def _generate_request_id() -> str:
        """Generate unique request ID"""
        return f"req_{uuid.uuid4().hex[:12]}"

    @abstractmethod
    def start(self) -> bool:
        """
        Start the application.

        Returns:
            True if started successfully
        """
        pass

    @abstractmethod
    def stop(self):
        """Stop the application"""
        pass

    def run_blocking(self):
        """Run the application and block until stopped"""
        if not self.start():
            self.logger.error("Failed to start application")
            return

        try:
            import time
            while self.running:
                time.sleep(0.5)
        except KeyboardInterrupt:
            self.logger.info("Received interrupt signal")
        finally:
            self.stop()
