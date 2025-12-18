"""
AgentLogger - Async logging infrastructure for agent execution.

Extracted from agent.py to improve separation of concerns.
Handles 3-stage logging: context, planning, and episode summary.

IMPORTANT: This class requires a log_dir to be passed explicitly.
It should NEVER construct its own logger or use hardcoded paths.
The calling application (TUI, CLI, etc.) is responsible for:
1. Creating the log directory
2. Passing the log_dir path to this class
"""

import os
import time
import queue
import threading
import atexit
from pathlib import Path
from typing import Any, Dict, List, Optional

from util.logger import StructuredLogger


class AgentLogger:
    """
    Async logging system for agent execution.

    Stages:
    1. Agent context (complete serialized prompt)
    2. Planning result (plan structure and reasoning)
    3. Episode summary (execution trace and reflection)

    IMPORTANT: log_dir is REQUIRED. This class does not create default paths.
    """

    def __init__(self, log_dir: str, logger: Optional[StructuredLogger] = None):
        """
        Initialize AgentLogger.

        Args:
            log_dir: Directory where logs will be written. REQUIRED.
            logger: Optional StructuredLogger for internal logging. If not provided,
                    internal error logging will be suppressed.
        """
        if not log_dir:
            raise ValueError("log_dir is required - AgentLogger does not use default paths")

        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.logger = logger
        self._log_file = self.log_dir / "llm_requests.log"

        # ========== ASYNC LOGGING INFRASTRUCTURE ==========
        # Background thread for non-blocking file I/O
        self._log_queue: queue.Queue = queue.Queue()
        self._log_thread = threading.Thread(target=self._log_worker, daemon=True)
        self._log_thread.start()
        # Ensure queue is flushed on exit
        atexit.register(self._flush_log_queue)

    def _log_worker(self):
        """Background worker that processes log entries from the queue."""
        while True:
            try:
                log_entry = self._log_queue.get(timeout=1.0)
                if log_entry is None:  # Poison pill for shutdown
                    break
                stage, args = log_entry
                if stage == "stage_1":
                    self._log_stage_1_sync(*args)
                elif stage == "stage_2":
                    self._log_stage_2_sync(*args)
                elif stage == "stage_3":
                    self._log_stage_3_sync(*args)
                self._log_queue.task_done()
            except queue.Empty:
                continue
            except Exception as e:
                # Don't let logging errors crash the worker
                if self.logger:
                    try:
                        self.logger.error(f"Async log worker error: {e}", component="agent.logger")
                    except:
                        pass

    def _flush_log_queue(self):
        """Flush remaining log entries on shutdown."""
        try:
            self._log_queue.put(None)  # Signal shutdown
            self._log_thread.join(timeout=2.0)
        except:
            pass

    def log_stage_1_agent_context(
        self,
        serialization_result: Any,
        user_input: str,
        tier: str,
        context_plan: Any
    ):
        """
        STAGE 1: Queue async logging of agent context.
        Non-blocking - actual I/O happens in background thread.
        """
        self._log_queue.put(("stage_1", (serialization_result, user_input, tier, context_plan)))

    def _log_stage_1_sync(
        self,
        serialization_result: Any,
        user_input: str,
        tier: str,
        context_plan: Any
    ):
        """
        STAGE 1 (sync): Log the COMPLETE agent context sent to LLM.
        Called by background worker thread.
        """
        try:
            log_lines = [
                "\n" + "=" * 80,
                "STAGE 1: AGENT CONTEXT (COMPLETE SERIALIZED PROMPT)",
                "=" * 80,
                f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}",
                f"Request ID: {serialization_result.plan.request_id}",
                f"Tier: {tier}",
                f"User Input: {user_input}",
                "",
                "CONTEXT BUDGET ALLOCATION:",
                f"  Total Budget: {serialization_result.plan.total_budget:,} tokens",
                f"  Actual Tokens: {serialization_result.actual_tokens_sent:,} tokens",
                f"  Cache Hits: {serialization_result.cache_hits}",
                f"  Cache Misses: {serialization_result.cache_misses}",
                f"  Cache Strategy: {serialization_result.plan.cache_strategy}",
                f"  Estimated Cost: ${serialization_result.plan.estimated_cost:.4f}",
                "",
                "CONTEXT SECTIONS INCLUDED:",
            ]

            # Show which sections were included
            for section_plan in context_plan.sections:
                if section_plan.included:
                    cache_marker = " [CACHED]" if section_plan.cache_key else ""
                    log_lines.append(
                        f"  - {section_plan.section.value}: {section_plan.actual_tokens:,} tokens{cache_marker}"
                    )

            log_lines.append("")
            log_lines.append("=" * 80)
            log_lines.append("COMPLETE SERIALIZED CONTEXT (SENT TO LLM)")
            log_lines.append("=" * 80)

            # Log THE ENTIRE serialized context - NO TRUNCATION
            serialized = serialization_result.serialized_messages

            # OpenAI Responses API format
            if "instructions" in serialized:
                log_lines.append("")
                log_lines.append("FORMAT: OpenAI Responses API")
                log_lines.append("")
                log_lines.append("INSTRUCTIONS (COMPLETE):")
                log_lines.append("-" * 80)
                log_lines.append(serialized["instructions"])
                log_lines.append("-" * 80)

                log_lines.append("")
                log_lines.append("INPUT CONTEXT (COMPLETE):")
                log_lines.append("-" * 80)
                input_ctx = serialized.get("input", [])
                if isinstance(input_ctx, list):
                    for i, msg in enumerate(input_ctx):
                        role = msg.get("role", "unknown")
                        content = msg.get("content", "")
                        log_lines.append(f"\n[Input Message {i+1} - Role: {role.upper()}]")
                        log_lines.append(content)
                        log_lines.append("")
                else:
                    log_lines.append(str(input_ctx))
                log_lines.append("-" * 80)

            # Anthropic Messages API format
            elif "system" in serialized:
                log_lines.append("")
                log_lines.append("FORMAT: Anthropic Messages API")
                log_lines.append("")
                log_lines.append("SYSTEM BLOCKS (COMPLETE):")
                log_lines.append("-" * 80)
                for i, block in enumerate(serialized["system"]):
                    cache_info = ""
                    if "cache_control" in block:
                        cache_info = f" [CACHE: {block['cache_control']['type']}]"

                    log_lines.append(f"\n[System Block {i+1}{cache_info}]")
                    log_lines.append(block.get("text", ""))
                    log_lines.append("")
                log_lines.append("-" * 80)

                if "messages" in serialized:
                    log_lines.append("")
                    log_lines.append("MESSAGES (COMPLETE):")
                    log_lines.append("-" * 80)
                    for i, msg in enumerate(serialized["messages"]):
                        role = msg.get("role", "unknown")
                        content = msg.get("content", "")
                        log_lines.append(f"\n[Message {i+1} - Role: {role.upper()}]")
                        log_lines.append(content)
                        log_lines.append("")
                    log_lines.append("-" * 80)

            log_lines.append("")
            log_lines.append("=" * 80)
            log_lines.append("END STAGE 1 (COMPLETE CONTEXT)")
            log_lines.append("=" * 80 + "\n")

            # Write to file
            full_log = "\n".join(log_lines)
            with open(self._log_file, "a") as f:
                f.write(full_log + "\n\n")

        except Exception as e:
            if self.logger:
                self.logger.error(f"Failed to log stage 1: {e}", component="agent.logger")

    def log_stage_2_planning_result(
        self,
        plan: Any,
        user_input: str,
        tier: str
    ):
        """
        STAGE 2: Queue async logging of planning result.
        Non-blocking - actual I/O happens in background thread.
        """
        self._log_queue.put(("stage_2", (plan, user_input, tier)))

    def _log_stage_2_sync(
        self,
        plan: Any,
        user_input: str,
        tier: str
    ):
        """
        STAGE 2 (sync): Log the planning result.
        Called by background worker thread.
        """
        try:
            log_lines = [
                "\n" + "=" * 80,
                "STAGE 2: PLANNING RESULT",
                "=" * 80,
                f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}",
                f"User Input: {user_input[:200]}{'...' if len(user_input) > 200 else ''}",
                f"Tier: {tier}",
                "",
                "PLAN OVERVIEW:",
                f"  Goal: {plan.goal}",
                f"  Goal Type: {plan.goal_type}",
                f"  Estimated Complexity: {plan.estimated_complexity}",
                f"  Requires Tools: {plan.requires_tools}",
                f"  Discovery Required: {plan.discovery_required}",
                f"  Total Steps: {len(plan.steps)}",
                f"  Discovery Steps: {len(plan.discovery_plan)}",
                f"  Execution Steps: {len(plan.execution_plan)}",
                "",
                "SUCCESS CRITERIA:",
                f"  {plan.success_criteria.description}",
                "",
            ]

            # Show uncertainties and preconditions if present
            if plan.uncertainties:
                log_lines.append("UNCERTAINTIES TO RESOLVE:")
                for uncertainty in plan.uncertainties:
                    log_lines.append(f"  - {uncertainty}")
                log_lines.append(f"  Uncertainty Threshold: {plan.uncertainty_threshold}")
                log_lines.append(f"  Current Uncertainty: {plan.current_uncertainty}")
                log_lines.append("")

            if plan.preconditions:
                log_lines.append("PRECONDITIONS:")
                for precondition in plan.preconditions:
                    log_lines.append(f"  - {precondition}")
                log_lines.append("")

            # Show steps
            log_lines.append("EXECUTION STEPS:")
            for step in plan.steps:
                phase_marker = "[DISCOVERY]" if step.phase.value == "discovery" else "[EXECUTION]"
                tool_info = f" → {step.tool_hint}" if step.tool_hint else ""
                log_lines.append(f"  {step.step_num}. {phase_marker} {step.objective}{tool_info}")

                if step.uncertainties_targeted:
                    log_lines.append(f"     Targets: {', '.join(step.uncertainties_targeted)}")
                if step.preconditions:
                    log_lines.append(f"     Preconditions: {len(step.preconditions)} items")
                if step.postconditions:
                    log_lines.append(f"     Postconditions: {len(step.postconditions)} items")

            log_lines.append("")

            # Show assumptions and reasoning
            if plan.assumptions:
                log_lines.append("ASSUMPTIONS:")
                for assumption in plan.assumptions:
                    log_lines.append(f"  - {assumption}")
                log_lines.append("")

            log_lines.append("PLANNER REASONING:")
            log_lines.append(f"  {plan.reasoning}")

            log_lines.append("")
            log_lines.append("=" * 80)
            log_lines.append("END STAGE 2")
            log_lines.append("=" * 80 + "\n")

            # Write to file
            full_log = "\n".join(log_lines)
            with open(self._log_file, "a") as f:
                f.write(full_log + "\n\n")

        except Exception as e:
            if self.logger:
                self.logger.error(f"Failed to log stage 2: {e}", component="agent.logger")

    def log_stage_3_episode_summary(
        self,
        plan: Any,
        trace: Any,
        reflection: Any,
        user_input: str,
        tier: str,
        total_duration_ms: float
    ):
        """
        STAGE 3: Queue async logging of episode summary.
        Non-blocking - actual I/O happens in background thread.
        """
        self._log_queue.put(("stage_3", (plan, trace, reflection, user_input, tier, total_duration_ms)))

    def _log_stage_3_sync(
        self,
        plan: Any,
        trace: Any,
        reflection: Any,
        user_input: str,
        tier: str,
        total_duration_ms: float
    ):
        """
        STAGE 3 (sync): Log the final episode summary.
        Called by background worker thread.
        """
        try:
            log_lines = [
                "\n" + "=" * 80,
                "STAGE 3: EPISODE SUMMARY",
                "=" * 80,
                f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}",
                f"User Input: {user_input[:200]}{'...' if len(user_input) > 200 else ''}",
                f"Tier: {tier}",
                f"Total Duration: {total_duration_ms:.0f} ms",
                "",
                "EXECUTION METRICS:",
                f"  LLM Calls: {trace.llm_calls}",
                f"  Tool Calls: {trace.tool_calls}",
                f"  Tool Failures: {trace.tool_failures}",
                f"  Steps Executed: {len(trace.step_results)}/{len(plan.steps)}",
                f"  All Steps Succeeded: {trace.all_steps_succeeded}",
                "",
                "STEP-BY-STEP EXECUTION:",
            ]

            # Show each step's result
            for step_result in trace.step_results:
                status_marker = "✓" if step_result.status.value == "completed" else "✗"
                log_lines.append(
                    f"  {status_marker} Step {step_result.step_num}: {step_result.status.value} "
                    f"({len(step_result.tool_calls_made)} tools, {step_result.duration_ms:.0f}ms)"
                )

                # Show tool calls for this step
                for tool_record in step_result.tool_calls_made:
                    tool_status = "✓" if tool_record.result.is_success else "✗"
                    log_lines.append(
                        f"      {tool_status} {tool_record.tool_name}: "
                        f"{tool_record.duration_ms:.0f}ms"
                    )
                    if not tool_record.result.is_success:
                        log_lines.append(f"         Error: {tool_record.result.error}")

                if step_result.error:
                    log_lines.append(f"      Error: {step_result.error}")

            log_lines.append("")
            log_lines.append("REFLECTION:")
            log_lines.append(f"  Goal Achieved: {reflection.goal_achieved}")
            log_lines.append(f"  Confidence: {reflection.confidence:.2f}")

            if reflection.evidence:
                log_lines.append("  Evidence:")
                for evidence in reflection.evidence:
                    log_lines.append(f"    - {evidence}")

            if reflection.gaps:
                log_lines.append("  Gaps:")
                for gap in reflection.gaps:
                    log_lines.append(f"    - {gap}")

            if reflection.suggestions:
                log_lines.append("  Suggestions:")
                for suggestion in reflection.suggestions:
                    log_lines.append(f"    - {suggestion}")

            log_lines.append("")
            log_lines.append("RL LABELS:")
            log_lines.append(f"  Reward: {reflection.reward:.2f}")
            log_lines.append(f"  Plan Quality: {reflection.plan_quality:.2f}")
            log_lines.append(f"  Execution Quality: {reflection.execution_quality:.2f}")
            log_lines.append(f"  Response Quality: {reflection.response_quality:.2f}")

            log_lines.append("")
            log_lines.append("FINAL RESPONSE:")
            final_response = trace.final_response or "(no response)"
            if len(final_response) > 500:
                log_lines.append(f"  {final_response[:500]}...")
            else:
                log_lines.append(f"  {final_response}")

            log_lines.append("")
            log_lines.append("=" * 80)
            log_lines.append("END STAGE 3")
            log_lines.append("=" * 80 + "\n")

            # Write to file
            full_log = "\n".join(log_lines)
            with open(self._log_file, "a") as f:
                f.write(full_log + "\n\n")

        except Exception as e:
            if self.logger:
                self.logger.error(f"Failed to log stage 3: {e}", component="agent.logger")
