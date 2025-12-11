"""
ProcessManager - Dedicated worker supervisor for the EventBus pipelines.

Responsibilities:
- Start Agent/TTS worker processes from factory tuples
- Monitor liveness via OS process state and heartbeat timestamps
- Restart workers when they die or stop sending heartbeats
"""

from __future__ import annotations

import logging
import threading
import time
from multiprocessing import Process
from typing import Callable, Optional, Tuple

from .event_bus import EventBus


Factory = Tuple[Callable, tuple]


class ProcessManager:
    """
    Supervises worker processes connected to an EventBus instance.

    Health is determined by both process liveness and heartbeat freshness.
    The manager escalates via logging and automatically restarts unhealthy workers.
    """

    def __init__(
        self,
        event_bus: EventBus,
        check_interval: float = 2.0,
        agent_timeout: float = 30.0,
        tts_timeout: float = 30.0
    ):
        self.event_bus = event_bus
        self.logger = logging.getLogger(f"{__name__}.process_manager")
        self.check_interval = check_interval
        self.agent_timeout = agent_timeout
        self.tts_timeout = tts_timeout

        self._agent_factory: Optional[Factory] = None
        self._tts_factory: Optional[Factory] = None

        self._agent_process: Optional[Process] = None
        self._tts_process: Optional[Process] = None

        self._monitor_thread: Optional[threading.Thread] = None
        self._running = False

    # --------------------------------------------------------------------- #
    # Factory configuration
    # --------------------------------------------------------------------- #
    def set_agent_factory(self, factory: Factory):
        """Configure the Agent worker factory tuple (target function, args)."""
        self._agent_factory = factory

    def set_tts_factory(self, factory: Factory):
        """Configure the TTS worker factory tuple (target function, args)."""
        self._tts_factory = factory

    # --------------------------------------------------------------------- #
    # Lifecycle management
    # --------------------------------------------------------------------- #
    def start(self):
        """Start configured worker processes and the health monitor thread."""
        if self._running:
            return

        self._running = True
        self._start_agent_process()
        self._start_tts_process()

        self._monitor_thread = threading.Thread(
            target=self._monitor_loop,
            daemon=True,
            name="ProcessMonitor"
        )
        self._monitor_thread.start()

        self.logger.info("ProcessManager started")

    def stop(self):
        """Stop monitoring, terminate workers, and signal EventBus shutdown."""
        self._running = False
        self.event_bus.shutdown()

        if self._monitor_thread and self._monitor_thread.is_alive():
            self._monitor_thread.join(timeout=2.0)

        self._stop_process(self._agent_process)
        self._stop_process(self._tts_process)

        self._agent_process = None
        self._tts_process = None

        self.logger.info("ProcessManager stopped")

    # --------------------------------------------------------------------- #
    # Monitoring helpers
    # --------------------------------------------------------------------- #
    def _monitor_loop(self):
        """Continuously evaluate worker health and restart as necessary."""
        while self._running and not self.event_bus.is_shutdown():
            try:
                self._ensure_agent_health()
                self._ensure_tts_health()
                time.sleep(self.check_interval)
            except Exception as exc:
                # If we cannot monitor state there is no way to recover silently.
                self.logger.error("Health monitor error: %s", exc)
                time.sleep(1.0)

    def _ensure_agent_health(self):
        if not self._agent_factory:
            return

        if not self._agent_process or not self._agent_process.is_alive():
            self.logger.warning("Agent process not alive, restarting...")
            self._start_agent_process()
            return

        if self._heartbeat_expired(self.event_bus.get_agent_last_heartbeat(), self.agent_timeout):
            self.logger.warning("Agent heartbeat stalled, restarting worker...")
            self._restart_agent_process()

    def _ensure_tts_health(self):
        if not self._tts_factory:
            return

        if not self._tts_process or not self._tts_process.is_alive():
            self.logger.warning("TTS process not alive, restarting...")
            self._start_tts_process()
            return

        if self._heartbeat_expired(self.event_bus.get_tts_last_heartbeat(), self.tts_timeout):
            self.logger.warning("TTS heartbeat stalled, restarting worker...")
            self._restart_tts_process()

    # --------------------------------------------------------------------- #
    # Process orchestration
    # --------------------------------------------------------------------- #
    def _start_agent_process(self):
        if not self._agent_factory:
            self.logger.error("Agent factory not configured; cannot start worker.")
            return
        if self._agent_process and self._agent_process.is_alive():
            return

        target, args = self._agent_factory
        self._agent_process = Process(target=target, args=args, daemon=True, name="AgentWorker")
        self._agent_process.start()
        self.logger.info("Agent process started (PID=%s)", self._agent_process.pid)

    def _start_tts_process(self):
        if not self._tts_factory:
            self.logger.error("TTS factory not configured; cannot start worker.")
            return
        if self._tts_process and self._tts_process.is_alive():
            return

        target, args = self._tts_factory
        self._tts_process = Process(target=target, args=args, daemon=True, name="TTSWorker")
        self._tts_process.start()
        self.logger.info("TTS process started (PID=%s)", self._tts_process.pid)

    def _restart_agent_process(self):
        self._stop_process(self._agent_process)
        self._agent_process = None
        self._start_agent_process()

    def _restart_tts_process(self):
        self._stop_process(self._tts_process)
        self._tts_process = None
        self._start_tts_process()

    def _stop_process(self, proc: Optional[Process]):
        if not proc:
            return
        proc.join(timeout=5.0)
        if proc.is_alive():
            proc.terminate()

    # --------------------------------------------------------------------- #
    # Utilities
    # --------------------------------------------------------------------- #
    @staticmethod
    def _heartbeat_expired(last_heartbeat: float, timeout: float) -> bool:
        return (time.time() - last_heartbeat) > timeout

    @property
    def agent_alive(self) -> bool:
        """Return True when the Agent worker process is alive."""
        return self._agent_process is not None and self._agent_process.is_alive()

    @property
    def tts_alive(self) -> bool:
        """Return True when the TTS worker process is alive."""
        return self._tts_process is not None and self._tts_process.is_alive()
