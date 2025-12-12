"""
RL Worker - Background process for reward shaping and RL log generation.

This worker:
1. Consumes episode completion events from EventBus
2. Processes episodes through RewardShaper
3. Writes canonicalized RL training logs
4. Operates independently from user-facing agent workflow

CRITICAL: This worker NEVER influences the user-facing agent or episodes.
"""

import time
import logging

from communication.event_bus import EventBus

from .reward_shaper import RewardShaper


def rl_worker_loop(event_bus: EventBus, log_dir: str = "logs"):
    """
    Main loop for RL worker process.

    Args:
        event_bus: Shared EventBus instance
        log_dir: Directory for RL training logs
    """
    # Setup logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
    )
    logger = logging.getLogger("rl_worker")
    logger.info("RL worker starting...")

    # Create reward shaper
    reward_shaper = RewardShaper(log_dir=log_dir)

    try:
        while not event_bus.is_shutdown():
            # Get next episode event
            episode_data = event_bus.get_episode_event(timeout=0.5)

            if episode_data:
                logger.info(
                    f"Processing episode: {episode_data.get('req_id')} "
                    f"(exec: {episode_data.get('exec_id')})"
                )

                # Process episode and generate RL training log
                reward_shaper.process_episode(episode_data)

                logger.debug(
                    f"Episode {episode_data.get('req_id')} processed and logged"
                )

            # Small sleep to prevent tight loop
            time.sleep(0.01)

    except KeyboardInterrupt:
        logger.info("RL worker received shutdown signal")
    except Exception as e:
        logger.error(f"RL worker error: {e}", exc_info=True)
    finally:
        logger.info("RL worker shutting down")


# Top-level function for multiprocessing (must be picklable)
def start_rl_worker(event_bus: EventBus, log_dir: str = "logs"):
    """Entry point for RL worker process"""
    rl_worker_loop(event_bus, log_dir)
