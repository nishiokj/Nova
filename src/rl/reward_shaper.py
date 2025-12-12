"""
RL Reward Shaper - Assigns per-step rewards for reinforcement learning training.

This component:
1. Consumes episode completion events from the EventBus
2. Analyzes plan steps and execution trace
3. Assigns per-step rewards based on success, efficiency, and contribution to goal
4. Writes canonicalized RL training logs (separate from user-facing logs)

CRITICAL: This system NEVER influences the user-facing agent or the episode that produced it.
It only creates training data for future model improvements.
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Optional, List
from logging.handlers import RotatingFileHandler
from enum import Enum


class StepClassification(Enum):
    """Quality classification for a step"""
    EXCELLENT = "excellent"  # Perfect execution, highly efficient
    GOOD = "good"            # Successful, reasonable approach
    OK = "ok"                # Worked but suboptimal
    POOR = "poor"            # Completed but inefficient or unnecessary
    FAILED = "failed"        # Step failed


@dataclass
class StepReward:
    """Reward information for a single step"""
    step_id: str
    step_num: int
    reward: float               # Reward value for this step
    done: bool                  # Whether this was the terminal step
    classification: str         # Quality classification (excellent/good/ok/poor/failed)
    explanation: Optional[str] = None  # Why this reward was assigned

    def to_dict(self) -> Dict[str, Any]:
        return {
            "step_id": self.step_id,
            "step_num": self.step_num,
            "reward": self.reward,
            "done": self.done,
            "classification": self.classification,
            "explanation": self.explanation
        }


@dataclass
class EpisodeReward:
    """Complete reward information for an episode"""
    req_id: str
    exec_id: str
    plan_id: str

    # Episode-level metrics
    episode_reward: float           # Total episode reward
    goal_achieved: bool
    quality_notes: str              # Human-readable explanation

    # Per-step rewards
    steps: List[StepReward]

    # Metadata for joining with execution logs
    timestamp: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "req_id": self.req_id,
            "exec_id": self.exec_id,
            "plan_id": self.plan_id,
            "episode": {
                "goal_achieved": self.goal_achieved,
                "episode_reward": self.episode_reward,
                "quality_notes": self.quality_notes
            },
            "steps": [s.to_dict() for s in self.steps],
            "timestamp": self.timestamp
        }


class RewardShaper:
    """
    Shapes rewards for RL training based on episode outcomes and step execution.

    Reward Philosophy:
    - Terminal reward based on goal achievement (0.0 = failed, 1.0 = perfect)
    - Intermediate rewards based on step contribution and efficiency
    - Negative rewards for failures, unnecessary steps, or poor decisions
    - Dense rewards to guide learning (every step gets a reward)
    """

    def __init__(
        self,
        log_dir: str = "logs",
        max_log_size: int = 100 * 1024 * 1024,  # 100MB
        backup_count: int = 10
    ):
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)

        self.logger = logging.getLogger("rl_reward_shaper")
        self.logger.setLevel(logging.INFO)
        self.logger.handlers = []
        self.logger.propagate = False

        # Setup RL training log
        handler = RotatingFileHandler(
            self.log_dir / "rl_training.jsonl",
            maxBytes=max_log_size,
            backupCount=backup_count
        )
        handler.setFormatter(logging.Formatter('%(message)s'))
        self.logger.addHandler(handler)

    def shape_rewards(self, episode_data: Dict[str, Any]) -> EpisodeReward:
        """
        Analyze episode and assign per-step rewards.

        Args:
            episode_data: Complete episode data from agent execution
                - req_id, exec_id
                - plan: The execution plan
                - trace: Execution trace with steps
                - reflection: Reflection on goal achievement

        Returns:
            EpisodeReward with per-step rewards and episode-level metrics
        """
        req_id = episode_data.get("req_id", "unknown")
        exec_id = episode_data.get("exec_id", "unknown")
        plan = episode_data.get("plan", {})
        trace = episode_data.get("trace", {})
        reflection = episode_data.get("reflection", {})

        # Extract key metrics
        goal_achieved = reflection.get("goal_achieved", False)
        confidence = reflection.get("confidence", 0.0)
        gaps = reflection.get("gaps", [])

        steps_executed = trace.get("steps_executed", [])
        tool_calls = trace.get("tool_calls", 0)
        tool_failures = trace.get("tool_failures", 0)
        had_failures = trace.get("had_failures", False)

        plan_steps = plan.get("steps", [])
        total_planned_steps = len(plan_steps)

        # Calculate episode-level reward
        episode_reward = self._calculate_episode_reward(
            goal_achieved=goal_achieved,
            confidence=confidence,
            tool_calls=tool_calls,
            tool_failures=tool_failures,
            steps_executed=len(steps_executed),
            total_planned_steps=total_planned_steps
        )

        # Assign per-step rewards
        step_rewards = self._assign_step_rewards(
            steps_executed=steps_executed,
            plan_steps=plan_steps,
            episode_reward=episode_reward,
            goal_achieved=goal_achieved,
            had_failures=had_failures
        )

        # Generate quality notes
        quality_notes = self._generate_quality_notes(
            goal_achieved=goal_achieved,
            confidence=confidence,
            gaps=gaps,
            tool_calls=tool_calls,
            tool_failures=tool_failures,
            steps_count=len(steps_executed)
        )

        episode_reward_obj = EpisodeReward(
            req_id=req_id,
            exec_id=exec_id,
            plan_id=f"{exec_id}-plan",
            episode_reward=episode_reward,
            goal_achieved=goal_achieved,
            quality_notes=quality_notes,
            steps=step_rewards,
            timestamp=datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        )

        return episode_reward_obj

    def _calculate_episode_reward(
        self,
        goal_achieved: bool,
        confidence: float,
        tool_calls: int,
        tool_failures: int,
        steps_executed: int,
        total_planned_steps: int
    ) -> float:
        """
        Calculate total episode reward.

        Reward components:
        - Base reward: 0.0 (failed) to 1.0 (perfect success)
        - Confidence bonus: +0.0 to +0.2 based on reflection confidence
        - Efficiency bonus: +0.0 to +0.2 for efficient execution
        - Failure penalty: -0.1 per tool failure
        """
        if not goal_achieved:
            # Failed episodes get low reward (0.0 to 0.2 based on partial progress)
            partial_progress = min(steps_executed / max(total_planned_steps, 1), 1.0)
            return 0.1 * partial_progress

        # Base reward for success
        base_reward = 0.6

        # Confidence bonus (0.0 to 0.2)
        confidence_bonus = confidence * 0.2

        # Efficiency bonus (fewer steps = better)
        if total_planned_steps > 0 and steps_executed <= total_planned_steps:
            efficiency = 1.0 - (steps_executed / total_planned_steps - 1.0) if steps_executed > total_planned_steps else 1.0
            efficiency_bonus = efficiency * 0.2
        else:
            efficiency_bonus = 0.1

        # Tool failure penalty
        failure_penalty = tool_failures * 0.1

        total_reward = base_reward + confidence_bonus + efficiency_bonus - failure_penalty

        # Clamp to [0, 1]
        return max(0.0, min(1.0, total_reward))

    def _assign_step_rewards(
        self,
        steps_executed: List[Dict[str, Any]],
        plan_steps: List[Dict[str, Any]],
        episode_reward: float,
        goal_achieved: bool,
        had_failures: bool
    ) -> List[StepReward]:
        """
        Assign per-step rewards using reward shaping.

        Strategy:
        - Distribute episode reward across steps
        - Higher rewards for successful critical steps
        - Lower/negative rewards for failures or unnecessary steps
        - Terminal step gets largest reward
        """
        if not steps_executed:
            return []

        step_rewards = []
        num_steps = len(steps_executed)

        # Base reward per step (distributed evenly, then adjusted)
        base_per_step = episode_reward / num_steps if num_steps > 0 else 0.0

        for i, step_data in enumerate(steps_executed):
            step_num = step_data.get("step_num", i + 1)
            step_id = step_data.get("step_id", f"step-{step_num}")
            status = step_data.get("status", "unknown")
            tool_hint = step_data.get("tool_hint")
            error = step_data.get("error")
            duration_ms = step_data.get("duration_ms", 0)

            is_last_step = (i == num_steps - 1)

            # Classify step quality
            if status == "completed" and not error:
                if duration_ms < 1000 and tool_hint:  # Fast, successful tool use
                    classification = StepClassification.EXCELLENT
                    reward_multiplier = 1.5
                elif duration_ms < 5000:
                    classification = StepClassification.GOOD
                    reward_multiplier = 1.2
                else:
                    classification = StepClassification.OK
                    reward_multiplier = 1.0
            elif status == "partial":
                classification = StepClassification.OK
                reward_multiplier = 0.7
            elif status == "failed" or error:
                classification = StepClassification.FAILED
                reward_multiplier = -0.5
            else:
                classification = StepClassification.POOR
                reward_multiplier = 0.5

            # Calculate step reward
            step_reward = base_per_step * reward_multiplier

            # Terminal step bonus if goal achieved
            if is_last_step and goal_achieved:
                step_reward += 0.3

            # Generate explanation
            explanation = self._generate_step_explanation(
                classification=classification,
                status=status,
                tool_hint=tool_hint,
                error=error,
                is_terminal=is_last_step
            )

            step_rewards.append(StepReward(
                step_id=step_id,
                step_num=step_num,
                reward=round(step_reward, 4),
                done=is_last_step,
                classification=classification.value,
                explanation=explanation
            ))

        return step_rewards

    def _generate_step_explanation(
        self,
        classification: StepClassification,
        status: str,
        tool_hint: Optional[str],
        error: Optional[str],
        is_terminal: bool
    ) -> str:
        """Generate human-readable explanation for step reward"""
        parts = []

        if classification == StepClassification.EXCELLENT:
            parts.append("Excellent execution: fast and successful")
        elif classification == StepClassification.GOOD:
            parts.append("Good execution: completed successfully")
        elif classification == StepClassification.OK:
            parts.append("Acceptable execution: completed but could be optimized")
        elif classification == StepClassification.POOR:
            parts.append("Poor execution: inefficient or unnecessary")
        elif classification == StepClassification.FAILED:
            parts.append("Failed execution")

        if error:
            parts.append(f"Error: {error[:100]}")

        if tool_hint:
            parts.append(f"Used tool: {tool_hint}")

        if is_terminal:
            parts.append("Terminal step")

        return "; ".join(parts)

    def _generate_quality_notes(
        self,
        goal_achieved: bool,
        confidence: float,
        gaps: List[str],
        tool_calls: int,
        tool_failures: int,
        steps_count: int
    ) -> str:
        """Generate human-readable quality summary"""
        if goal_achieved:
            notes = f"Goal achieved with {confidence:.0%} confidence. "
            notes += f"Executed {steps_count} steps with {tool_calls} tool calls."
            if tool_failures > 0:
                notes += f" Had {tool_failures} tool failures."
        else:
            notes = f"Goal not achieved (confidence: {confidence:.0%}). "
            if gaps:
                notes += f"Gaps: {', '.join(gaps[:2])}. "
            notes += f"Executed {steps_count} steps before stopping."

        return notes

    def log_episode_reward(self, episode_reward: EpisodeReward):
        """Write canonicalized RL training log to disk"""
        self.logger.info(json.dumps(episode_reward.to_dict()))

    def process_episode(self, episode_data: Dict[str, Any]):
        """
        Process a complete episode: shape rewards and log.

        This is the main entry point called when an episode completes.
        """
        try:
            episode_reward = self.shape_rewards(episode_data)
            self.log_episode_reward(episode_reward)

            self.logger.debug(
                f"Processed episode {episode_reward.req_id}: "
                f"reward={episode_reward.episode_reward:.3f}, "
                f"goal_achieved={episode_reward.goal_achieved}"
            )
        except Exception as e:
            self.logger.error(f"Error processing episode: {e}")


def get_reward_shaper() -> RewardShaper:
    """Get or create global reward shaper instance"""
    global _global_reward_shaper
    if '_global_reward_shaper' not in globals():
        _global_reward_shaper = RewardShaper()
    return _global_reward_shaper


# Global instance
_global_reward_shaper: Optional[RewardShaper] = None
