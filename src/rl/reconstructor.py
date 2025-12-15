"""
RL Episode Reconstructor - Rebuild complete episodes for training.

This module reconstructs full episodes from referenced logs:
1. Queries execution logs by exec_id
2. Resolves all references (system prompts, tool manifests)
3. Joins with RL training logs
4. Produces complete episode with full state/context

Output: FullEpisode object with everything needed for RL training.
"""

import json
from pathlib import Path
from typing import Dict, Any, Optional, List
from dataclasses import dataclass, field
from datetime import datetime

from util.manifest_store import (
    get_manifest_store,
    SystemPromptManifest,
    ToolManifest,
)


@dataclass
class FullEpisode:
    """
    Complete reconstructed episode with all data for RL training.

    This contains EVERYTHING needed to train an RL model:
    - Input state (what agent saw)
    - Trajectory (what agent did)
    - Outcome (what happened)
    - Rewards (shaped rewards)
    """

    # Episode identifiers
    req_id: str
    exec_id: str
    plan_id: str

    # INPUT STATE (What agent saw)
    tier: str
    system_prompt: str  # Resolved from prompt_id
    user_input: str
    conversation_history: List[Dict[str, Any]]
    tools_available: List[Dict[str, Any]]  # Resolved from tool_manifest_id
    tool_count: int

    # PLAN (What agent planned to do)
    goal: str
    goal_type: str
    estimated_complexity: str
    success_criteria: str
    plan_steps: List[Dict[str, Any]]
    requires_tools: bool

    # TRAJECTORY (What agent actually did)
    steps_executed: List[Dict[str, Any]]  # Full execution steps
    tool_calls: int
    tool_failures: int
    llm_calls: int
    total_duration_ms: float

    # OUTCOME (What happened)
    goal_achieved: bool
    confidence: float
    gaps: List[str]
    evidence: List[str]
    final_response: str

    # REWARDS (For RL training)
    episode_reward: float
    step_rewards: List[Dict[str, Any]]  # Per-step rewards with classifications
    quality_notes: str

    # Metadata
    timestamp: str

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return {
            "req_id": self.req_id,
            "exec_id": self.exec_id,
            "plan_id": self.plan_id,
            "input_state": {
                "tier": self.tier,
                "system_prompt": self.system_prompt,
                "user_input": self.user_input,
                "conversation_history": self.conversation_history,
                "tools_available": self.tools_available,
                "tool_count": self.tool_count
            },
            "plan": {
                "goal": self.goal,
                "goal_type": self.goal_type,
                "estimated_complexity": self.estimated_complexity,
                "success_criteria": self.success_criteria,
                "plan_steps": self.plan_steps,
                "requires_tools": self.requires_tools
            },
            "trajectory": {
                "steps_executed": self.steps_executed,
                "tool_calls": self.tool_calls,
                "tool_failures": self.tool_failures,
                "llm_calls": self.llm_calls,
                "total_duration_ms": self.total_duration_ms
            },
            "outcome": {
                "goal_achieved": self.goal_achieved,
                "confidence": self.confidence,
                "gaps": self.gaps,
                "evidence": self.evidence,
                "final_response": self.final_response
            },
            "rewards": {
                "episode_reward": self.episode_reward,
                "step_rewards": self.step_rewards,
                "quality_notes": self.quality_notes
            },
            "timestamp": self.timestamp
        }

    def to_training_sample(self) -> Dict[str, Any]:
        """
        Convert to RL training sample format.

        This is the format needed for policy gradient, Q-learning, etc.

        Each step is a complete RL transition:
        - state: step_context (what model saw)
        - action: tool call (what model did)
        - reward: shaped reward
        - next_state: next step_context (for value functions)
        """
        # Build transitions (state, action, reward, next_state)
        transitions = []

        for i, step in enumerate(self.steps_executed):
            step_context = step.get("step_context", {})
            action_data = step.get("action", {})
            result_data = step.get("result", {})

            # Find matching reward
            step_num = step.get("step_num", i + 1)
            step_reward = next(
                (r for r in self.step_rewards if r.get("step_num") == step_num),
                {"reward": 0.0, "classification": "unknown"}
            )

            # Build state (what model saw)
            state = {
                "step_objective": step_context.get("step_objective"),
                "messages": step_context.get("messages", []),
                "available_tools": step_context.get("available_tools", []),
                "tool_hint": step_context.get("tool_hint"),
            }

            # Build action (what model did)
            action = {
                "type": action_data.get("type", "unknown"),
                "tool_name": action_data.get("tool_name"),
                "tool_args": action_data.get("tool_args", {}),
            }

            # Get next state (for bootstrapping in value functions)
            next_state = None
            if i + 1 < len(self.steps_executed):
                next_step = self.steps_executed[i + 1]
                next_context = next_step.get("step_context", {})
                next_state = {
                    "step_objective": next_context.get("step_objective"),
                    "messages": next_context.get("messages", []),
                    "available_tools": next_context.get("available_tools", []),
                    "tool_hint": next_context.get("tool_hint"),
                }

            # Build transition
            transition = {
                "step_num": step_num,
                "state": state,
                "action": action,
                "reward": step_reward["reward"],
                "next_state": next_state,
                "done": (i == len(self.steps_executed) - 1),  # Terminal step
                "classification": step_reward.get("classification"),
            }

            transitions.append(transition)

        return {
            # Episode metadata
            "exec_id": self.exec_id,
            "goal": self.goal,
            "goal_achieved": self.goal_achieved,
            "episode_reward": self.episode_reward,

            # Full trajectory (state, action, reward, next_state per step)
            "transitions": transitions,

            # Flat rewards for quick access
            "rewards": [t["reward"] for t in transitions],

            # Meta
            "tier": self.tier,
            "num_steps": len(transitions)
        }


class EpisodeReconstructor:
    """
    Reconstructs complete episodes from logs and manifests.

    Usage:
        reconstructor = EpisodeReconstructor()
        episode = reconstructor.reconstruct("abc-123-exec-0001")
        training_sample = episode.to_training_sample()
    """

    def __init__(
        self,
        execution_log_path: str = "logs/agent_execution.jsonl",
        rl_log_path: str = "logs/rl_training.jsonl"
    ):
        self.execution_log_path = Path(execution_log_path)
        self.rl_log_path = Path(rl_log_path)
        self.manifest_store = get_manifest_store()

        # Preload manifests for fast access
        self.manifest_store.preload_manifests()

    def _query_jsonl(
        self,
        log_path: Path,
        exec_id: str,
        svc: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Query JSONL log file by exec_id and optionally service"""
        if not log_path.exists():
            return []

        results = []
        with open(log_path) as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    if entry.get("exec_id") == exec_id:
                        if svc is None or entry.get("svc") == svc:
                            results.append(entry)
                except json.JSONDecodeError:
                    continue

        return results

    def reconstruct(self, exec_id: str) -> Optional[FullEpisode]:
        """
        Reconstruct complete episode from logs.

        Args:
            exec_id: Execution ID (e.g., "abc-123-exec-0001")

        Returns:
            FullEpisode with all data resolved, or None if not found
        """
        # 1. Query execution logs
        agent_context = self._query_jsonl(
            self.execution_log_path, exec_id, svc="agent_context"
        )
        planning = self._query_jsonl(
            self.execution_log_path, exec_id, svc="planning"
        )
        execution_contexts = self._query_jsonl(
            self.execution_log_path, exec_id, svc="execution_context"
        )
        execution_steps = self._query_jsonl(
            self.execution_log_path, exec_id, svc="execution_step"
        )
        episode_summary = self._query_jsonl(
            self.execution_log_path, exec_id, svc="episode_summary"
        )

        if not agent_context or not planning or not episode_summary:
            return None

        agent_context = agent_context[0]
        planning = planning[0]
        episode_summary = episode_summary[0]

        # 2. Query RL training log
        rl_logs = self._query_jsonl(self.rl_log_path, exec_id)
        if not rl_logs:
            return None
        rl_log = rl_logs[0]

        # 3. Resolve references
        context = agent_context.get("context", {})
        system_prompt_id = context.get("system_prompt_id", "tier_standard_v1")
        tool_manifest_id = context.get("tool_manifest_id", "default_tools_v1")

        # Get manifests
        system_prompt_manifest = self.manifest_store.get_system_prompt(system_prompt_id)
        tool_manifest = self.manifest_store.get_tool_manifest(tool_manifest_id)

        # Fallback if manifests not found
        system_prompt = system_prompt_manifest.prompt if system_prompt_manifest else context.get("system_prompt", "")
        tools_available = tool_manifest.tools if tool_manifest else context.get("tool_definitions", [])

        # 4. Extract plan data
        plan = planning.get("plan", {})

        # 5. Extract reflection data
        labels = episode_summary.get("labels", {})

        # 6. Join execution_contexts with execution_steps
        # Create a map of step_id -> context
        context_map = {ctx.get("step_id"): ctx.get("context", {}) for ctx in execution_contexts}

        # Enrich execution steps with their context (STATE per step)
        enriched_steps = []
        for step in execution_steps:
            step_id = step.get("step_id")
            step_context = context_map.get(step_id, {})

            # Build enriched step with embedded context
            enriched_step = {
                **step,  # Original step data (action, result, status, etc.)
                "step_context": {
                    "step_objective": step_context.get("step_objective"),
                    "messages": step_context.get("messages", []),
                    "available_tools": step_context.get("available_tools", []),
                    "tool_hint": step_context.get("tool_hint"),
                    "system_prompt_id": step_context.get("system_prompt_id"),
                    "tool_manifest_id": step_context.get("tool_manifest_id"),
                }
            }
            enriched_steps.append(enriched_step)

        # 7. Build FullEpisode
        full_episode = FullEpisode(
            # Identifiers
            req_id=agent_context.get("req_id", "unknown"),
            exec_id=exec_id,
            plan_id=f"{exec_id}-plan",

            # Input state
            tier=context.get("tier", "unknown"),
            system_prompt=system_prompt,
            user_input=agent_context.get("request", {}).get("user_input", ""),
            conversation_history=context.get("conversation_history", []),
            tools_available=tools_available,
            tool_count=context.get("tool_count", len(tools_available)),

            # Plan
            goal=plan.get("goal", ""),
            goal_type=plan.get("goal_type", "unknown"),
            estimated_complexity=plan.get("estimated_complexity", "unknown"),
            success_criteria=plan.get("success_criteria", ""),
            plan_steps=plan.get("steps", []),
            requires_tools=plan.get("requires_tools", False),

            # Trajectory (with embedded step contexts - STATE per step!)
            steps_executed=enriched_steps,
            tool_calls=episode_summary.get("stats", {}).get("tool_calls", 0),
            tool_failures=episode_summary.get("stats", {}).get("tool_failures", 0),
            llm_calls=0,  # Not currently logged, would need to add
            total_duration_ms=episode_summary.get("stats", {}).get("total_duration_ms", 0),

            # Outcome
            goal_achieved=labels.get("goal_achieved", False),
            confidence=labels.get("reflection_confidence", 0.0),
            gaps=labels.get("gaps", []),
            evidence=labels.get("evidence", []),
            final_response="",  # Not currently logged, would need to add

            # Rewards
            episode_reward=rl_log.get("episode", {}).get("episode_reward", 0.0),
            step_rewards=rl_log.get("steps", []),
            quality_notes=rl_log.get("episode", {}).get("quality_notes", ""),

            # Metadata
            timestamp=rl_log.get("timestamp", datetime.utcnow().isoformat())
        )

        return full_episode

    def batch_reconstruct(
        self,
        exec_ids: List[str],
        filter_successful: bool = False
    ) -> List[FullEpisode]:
        """
        Reconstruct multiple episodes efficiently.

        Args:
            exec_ids: List of execution IDs
            filter_successful: Only return episodes where goal was achieved

        Returns:
            List of FullEpisode objects
        """
        episodes = []

        for exec_id in exec_ids:
            episode = self.reconstruct(exec_id)
            if episode is None:
                continue

            if filter_successful and not episode.goal_achieved:
                continue

            episodes.append(episode)

        return episodes

    def reconstruct_to_file(
        self,
        exec_id: str,
        output_path: Optional[Path] = None
    ) -> Optional[Path]:
        """
        Reconstruct episode and save to JSON file.

        Args:
            exec_id: Execution ID
            output_path: Optional output path (default: logs/reconstructed/{exec_id}_full.json)

        Returns:
            Path to saved file, or None if reconstruction failed
        """
        episode = self.reconstruct(exec_id)
        if episode is None:
            return None

        if output_path is None:
            output_dir = Path("logs/reconstructed")
            output_dir.mkdir(parents=True, exist_ok=True)
            output_path = output_dir / f"{exec_id}_full.json"

        with open(output_path, 'w') as f:
            json.dump(episode.to_dict(), f, indent=2)

        return output_path


def generate_training_dataset(
    exec_ids: List[str],
    output_path: str = "logs/rl_training_dataset.jsonl",
    filter_successful: bool = True
) -> int:
    """
    Generate training dataset from episodes.

    Args:
        exec_ids: List of execution IDs to include
        output_path: Where to save training samples
        filter_successful: Only include successful episodes

    Returns:
        Number of samples generated
    """
    reconstructor = EpisodeReconstructor()
    episodes = reconstructor.batch_reconstruct(exec_ids, filter_successful=filter_successful)

    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    with open(output_file, 'w') as f:
        for episode in episodes:
            training_sample = episode.to_training_sample()
            f.write(json.dumps(training_sample) + "\n")

    return len(episodes)
