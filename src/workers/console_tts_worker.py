"""
ConsoleTTSWorker - Process worker for headless TTS output.

Receives TTSRequestedEvent and prints the text to stdout/logs instead of playing audio.
Useful for Docker/macOS/CI where audio passthrough is unavailable.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from communication.events import Event, TTSRequestedEvent
from communication.mailbox import Mailbox
from communication.process_worker import ProcessWorker


class ConsoleTTSWorker(ProcessWorker):
    """A TTS worker that logs/prints responses instead of speaking them."""

    def __init__(
        self,
        mailbox: Mailbox,
        logger: Optional[logging.Logger] = None,
        prefix: str = "TTS",
        include_request_id: bool = True,
        include_response_type: bool = True,
    ):
        super().__init__(mailbox, logger)
        self.prefix = prefix
        self.include_request_id = include_request_id
        self.include_response_type = include_response_type

    def initialize(self) -> bool:
        self.logger.info("ConsoleTTSWorker initialized (headless)")
        return True

    def process_event(self, event: Event) -> None:
        if not isinstance(event, TTSRequestedEvent):
            return

        parts: list[str] = [self.prefix]
        if self.include_request_id and event.request_id:
            parts.append(event.request_id)
        if self.include_response_type and getattr(event, "response_type", None):
            parts.append(str(event.response_type))

        header = " ".join(f"[{p}]" for p in parts if p)
        text = event.text or ""
        self.logger.info(f"{header} {text}")

    def cleanup(self) -> None:
        self.logger.info("ConsoleTTSWorker cleaned up")

