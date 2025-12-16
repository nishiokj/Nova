"""
ProcessManager - Manages worker process lifecycle.

Uses ProcessWorker interface + Mailbox pattern.
"""

from typing import Dict, Type, Any, Optional
from multiprocessing import Process, Queue
import threading
import time
import logging

from communication.event_bus import EventBus #, LegacyEventBus
from communication.mailbox import Mailbox
from communication.events import EventType
from communication.process_worker import ProcessWorker
from .worker_utils import run_worker_process


class ProcessManager:
    """
    Manages lifecycle of ProcessWorker instances.

    Responsibilities:
    - Create mailboxes for each worker
    - Subscribe mailboxes to event types
    - Start/stop worker processes
    - Monitor health
    """

    def __init__(
        self,
        event_bus,  # Can be EventBus or LegacyEventBus
        check_interval: float = 2.0
    ):
        self.event_bus = event_bus
        self.logger = logging.getLogger(__name__)
        self.check_interval = check_interval

        # Worker registry
        self._workers: Dict[str, Dict[str, Any]] = {}

        # Monitor thread
        self._monitor_thread: Optional[threading.Thread] = None
        self._running = False

    def register_worker(
        self,
        worker_id: str,
        worker_class: Type[ProcessWorker],
        subscribe_to: list,  # List[EventType]
        worker_kwargs: Dict[str, Any] = None
    ):
        """
        Register a worker with the manager.

        Args:
            worker_id: Unique worker identifier
            worker_class: ProcessWorker subclass
            subscribe_to: List of event types to subscribe to
            worker_kwargs: Additional kwargs for worker constructor
        """
        if worker_id in self._workers:
            raise ValueError(f"Worker {worker_id} already registered")

        # Create mailbox with shared queue
        mailbox_queue = Queue()
        mailbox = Mailbox(worker_id=worker_id, queue_impl=mailbox_queue)

        # Subscribe mailbox to event types
        mailbox.subscribe_to(self.event_bus, *subscribe_to)

        # Store worker info
        self._workers[worker_id] = {
            "worker_class": worker_class,
            "mailbox": mailbox,
            "mailbox_queue": mailbox_queue,
            "worker_kwargs": worker_kwargs or {},
            "process": None,
            "subscribe_to": subscribe_to
        }

        self.logger.info(
            f"Registered worker '{worker_id}' "
            f"(subscribes to: {[et.name for et in subscribe_to]})"
        )

    def start(self):
        """Start all registered workers and health monitor"""
        if self._running:
            return

        self._running = True

        # Start all registered workers
        for worker_id in self._workers:
            self._start_worker(worker_id)

        # Start health monitor
        self._monitor_thread = threading.Thread(
            target=self._monitor_loop,
            daemon=True,
            name="ProcessMonitor"
        )
        self._monitor_thread.start()

        self.logger.info("ProcessManager started")

    def stop(self):
        """Stop all workers"""
        self._running = False

        # Signal EventBus shutdown (will send ShutdownEvent to all mailboxes)
        self.event_bus.shutdown()

        # Wait for monitor to stop
        if self._monitor_thread and self._monitor_thread.is_alive():
            self._monitor_thread.join(timeout=2.0)

        # Terminate all workers
        for worker_id, info in self._workers.items():
            self._stop_worker(worker_id)

        self.logger.info("ProcessManager stopped")

    def _start_worker(self, worker_id: str):
        """Start a worker process"""
        info = self._workers[worker_id]

        if info["process"] and info["process"].is_alive():
            return  # Already running

        # Create process
        process = Process(
            target=run_worker_process,
            args=(
                info["worker_class"],
                worker_id,
                info["mailbox_queue"],
                info["worker_kwargs"]
            ),
            daemon=True,
            name=worker_id
        )

        process.start()
        info["process"] = process

        self.logger.info(f"Started worker '{worker_id}' (PID: {process.pid})")

    def _stop_worker(self, worker_id: str):
        """Stop a worker process"""
        info = self._workers.get(worker_id)
        if not info:
            return

        process = info["process"]
        if not process:
            return

        process.join(timeout=5.0)
        if process.is_alive():
            process.terminate()
            process.join(timeout=2.0)

        info["process"] = None
        self.logger.info(f"Stopped worker '{worker_id}'")

    def _monitor_loop(self):
        """Monitor worker health and restart if needed"""
        while self._running and not self.event_bus.is_shutdown():
            try:
                for worker_id, info in self._workers.items():
                    process = info["process"]

                    if not process or not process.is_alive():
                        self.logger.warning(f"Worker '{worker_id}' died, restarting...")
                        self._start_worker(worker_id)

                time.sleep(self.check_interval)

            except Exception as e:
                self.logger.error(f"Monitor error: {e}")
                time.sleep(1.0)

    @property
    def worker_count(self) -> int:
        """Number of registered workers"""
        return len(self._workers)

    def get_worker_status(self, worker_id: str) -> str:
        """Get worker status"""
        info = self._workers.get(worker_id)
        if not info:
            return "unknown"

        process = info["process"]
        if not process:
            return "not_started"

        if process.is_alive():
            return "running"

        return "dead"

    @property
    def agent_alive(self) -> bool:
        """Check if service_rep worker is alive (backwards compatibility)"""
        return self.get_worker_status("service_rep") == "running"

    @property
    def service_rep_alive(self) -> bool:
        """Check if service_rep worker is alive"""
        return self.get_worker_status("service_rep") == "running"

    @property
    def tts_alive(self) -> bool:
        """Check if TTS worker is alive"""
        return self.get_worker_status("tts") == "running"
