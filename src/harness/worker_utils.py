"""
Utilities for running ProcessWorker instances in subprocesses.
"""

from typing import Type
from multiprocessing import Queue
import logging

from communication.mailbox import Mailbox
from harness.process_worker import ProcessWorker


def run_worker_process(
    worker_class: Type[ProcessWorker],
    worker_id: str,
    mailbox_queue: Queue,
    worker_kwargs: dict
):
    """
    Entry point for worker subprocess.

    This is a top-level function (not a closure) so it can be pickled
    by multiprocessing.Process with 'spawn' start method.

    Args:
        worker_class: ProcessWorker subclass to instantiate
        worker_id: Worker identifier
        mailbox_queue: Shared multiprocessing.Queue for mailbox
        worker_kwargs: Additional kwargs for worker constructor
    """
    # Setup logging for this process
    logging.basicConfig(
        level=logging.INFO,
        format=f'%(asctime)s [{worker_id}-%(process)d] %(levelname)s %(message)s',
        datefmt='%H:%M:%S'
    )
    logger = logging.getLogger(worker_id)

    # Create mailbox from shared queue
    mailbox = Mailbox(worker_id=worker_id, queue_impl=mailbox_queue)

    # Instantiate worker
    worker = worker_class(
        mailbox=mailbox,
        logger=logger,
        **worker_kwargs
    )

    # Run worker
    worker.run()
