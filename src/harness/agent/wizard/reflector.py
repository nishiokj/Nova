"""
WizardReflector - The intelligence layer of the Wizard.

This component reasons about Worker outcomes and decides what to do next.
It is called after EVERY step outcome, not just failures.

Design Principles:
1. Bias toward action - prefer ACCEPT/EXTEND over CLARIFY
2. Quality enforcement - catch errors, incomplete work
3. Excellence scaffolding - add steps to do great work
4. Explicit outcomes - never silently fail
"""

import json
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Protocol

from .types import ReflectionVerdict, FailureCategory
from .reflection_types import (
    WizardReflectionInput,
    WizardReflectionOutput,
    QualityAssessment,
    ScaffoldedStep,
    RedoModifications,
)


class Logger(Protocol):
    """Protocol for logger - allows any compatible implementation."""
    def info(self, msg: str, **kwargs) -> None: ...
    def debug(self, msg: str, **kwargs) -> None: ...
    def warning(self, msg: str, **kwargs) -> None: ...
    def error(self, msg: str, **kwargs) -> None: ...


@dataclass
class ReflectorConfig:
    """Configuration for the WizardReflector."""

    # Quality thresholds
    min_accept_quality: float = 0.6      # Below this, consider REDO
    excellence_threshold: float = 0.85    # Above this, don't scaffold
    redo_quality_threshold: float = 0.4   # Below this, trigger REDO
    abort_quality_threshold: float = 0.2  # Below this after retries, abort

    # Behavior tuning
    max_redo_attempts: int = 2           # Max REDOs before escalating
    scaffold_aggressiveness: float = 0.5  # 0=minimal, 1=aggressive scaffolding

    # LLM settings
    reflection_model: Optional[str] = None  # Override model for reflection
    max_reflection_tokens: int = 2000
    reflection_timeout_ms: int = 10_000

    # Clarification policy (passed through from WizardConfig)
    default_clarification_timeout: int = 60
    max_clarification_options: int = 4
    require_default_assumption: bool = True


ERROR_PATTERNS = {
    "syntax_error": [
        r"SyntaxError:",
        r"IndentationError:",
        r"unexpected token",
    ],
    "runtime_error": [
        r"TypeError:",
        r"AttributeError:",
        r"NameError:",
        r"KeyError:",
    ],
    "incomplete_code": [
        r"# TODO",
        r"pass\s*$",
        r"raise NotImplementedError",
        r"\.\.\.",
    ],
    "hardcoded_values": [
        r"localhost",
        r"127\.0\.0\.1",
        r"password\s*=\s*['\"]",
        r"api_key\s*=\s*['\"]",
    ],
}

ASSUMABLE_QUESTION_PATTERNS = [
    r"which (framework|library|tool)",
    r"what (language|version)",
    r"(should|would) (i|you|we) use",
    r"prefer(red)?",
]

REFLECTION_CACHE_PATTERNS = {
    # NOTE: We intentionally DO NOT cache implicit_final!
    # The fast-path was causing refusals to be accepted as success.
    # Only explicit [FINAL] markers with success=True should be fast-pathed.
    (True, "completed"): ReflectionVerdict.ACCEPT,
    # (True, "implicit_final"): REMOVED - must be evaluated by full reflection
    (False, "exception"): ReflectionVerdict.REDO,
}

RECOVERY_MATRIX = {
    "exception": {
        1: "retry",
        2: "retry",
        3: "abort_step",
    },
    "llm_error": {
        1: "retry",
        2: "retry",
        3: "abort_step",
    },
    "need_context_no_tools": {
        1: "redo_with_hints",
        2: "scaffold_discovery",
        3: "clarify_or_abort",
    },
    "need_context_no_prompt": {
        1: "redo_explicit",
        2: "redo_with_hints",
        3: "abort_step",
    },
    "tool_requested_user": {
        1: "redo_explicit",
        2: "redo_with_hints",
        3: "abort_step",
    },
    "max_continues": {
        1: "redo_simplified",
        2: "scaffold_substeps",
        3: "abort_step",
    },
    "no_action": {
        1: "redo_explicit",
        2: "redo_explicit",
        3: "abort_step",
    },
    # NEW: Handle refusals - LLM said "I can't do this"
    # This is THE critical case that triggers scaffolding
    "refusal": {
        1: "scaffold_decompose",  # First attempt: decompose into sub-steps
        2: "scaffold_decompose",  # Second attempt: try again with different decomposition
        3: "abort_step",          # Give up after 3 attempts
    },
    # NEW: Handle implicit_final without evidence - likely incomplete work
    "implicit_final": {
        1: "redo_with_hints",
        2: "scaffold_substeps",
        3: "abort_step",
    },
}


class WizardReflector:
    """
    The reasoning core of the Wizard.

    Called after every Worker outcome to:
    1. Assess quality of the output
    2. Detect errors or issues
    3. Decide the appropriate action
    4. Format user-facing messages
    """

    def __init__(
        self,
        llm: Any,
        config: Optional[ReflectorConfig] = None,
        logger: Optional[Logger] = None,
    ):
        self.llm = llm
        self.config = config or ReflectorConfig()
        self.logger = logger

    def reflect(
        self,
        input: WizardReflectionInput,
    ) -> WizardReflectionOutput:
        """
        Reflect on a Worker outcome and decide next action.

        This is the core intelligence of the Wizard.

        Args:
            input: Complete reflection context

        Returns:
            ReflectionOutput with verdict and associated data
        """
        start_time = time.time()

        cached = self._check_reflection_cache(input)
        if cached:
            cached.reflection_duration_ms = (time.time() - start_time) * 1000
            return cached

        # Build the reflection prompt
        prompt = self._build_reflection_prompt(input)

        # Call LLM for reflection
        try:
            # Build messages for LLM
            messages = [
                {"role": "user", "content": prompt}
            ]

            # Call LLM with JSON response format
            llm_kwargs = {
                "max_tokens": self.config.max_reflection_tokens,
            }
            if self.config.reflection_model:
                llm_kwargs["model"] = self.config.reflection_model
            if self.config.reflection_timeout_ms > 0:
                llm_kwargs["timeout"] = self.config.reflection_timeout_ms / 1000

            response = self.llm.respond(
                messages,
                **llm_kwargs,
            )

            # Extract content from response
            content = self._extract_llm_content(response)
            output = self._parse_response(content, input)
            output = self._enforce_quality_and_policy(input, output)

        except Exception as e:
            # Fallback: accept with low confidence
            self._log("error", f"Reflection failed: {e}")
            output = self._create_fallback_output(input, str(e))

        output.reflection_duration_ms = (time.time() - start_time) * 1000

        self._log(
            "debug",
            f"Reflection complete: verdict={output.verdict.value}, "
            f"confidence={output.confidence:.2f}, "
            f"duration={output.reflection_duration_ms:.0f}ms"
        )

        return output

    def _extract_llm_content(self, response: Any) -> str:
        """Extract text content from LLM response."""
        if isinstance(response, str):
            return response
        if isinstance(response, dict):
            # Handle OpenAI-style response
            if "choices" in response:
                return response["choices"][0]["message"]["content"]
            if "content" in response:
                return response["content"]
        # Handle object with content attribute
        if hasattr(response, "content"):
            return response.content
        return str(response)

    def _build_reflection_prompt(self, input: WizardReflectionInput) -> str:
        """Build the reflection prompt with full context."""

        # Format step status summary
        step_summary = self._format_step_summary(input.all_steps)

        # Format knowledge facts
        facts_summary = self._format_facts(input.global_context.key_facts)

        # Format worker output
        worker_output = self._format_worker_output(input.outcome)

        # Format previous attempts if any
        previous_attempts = self._format_previous_attempts(
            input.step_context.previous_errors
        )

        goal_type_value = (
            input.global_context.goal_type.value
            if hasattr(input.global_context.goal_type, "value")
            else str(input.global_context.goal_type)
        )

        base_prompt = f"""You are the Wizard - the orchestrating intelligence ensuring maximum user utility.

A Worker just completed execution. Analyze the outcome and decide the next action.

======================================================================
GLOBAL CONTEXT
======================================================================

**User's Goal:** {input.global_context.goal}
**Goal Type:** {goal_type_value}
**Goal Success Criteria:** {input.global_context.goal_success_criteria or "(none)"}

**Plan Progress:**
- Total Steps: {input.global_context.total_steps}
- Completed: {input.global_context.completed_steps}
- Failed: {input.global_context.failed_steps}
- Skipped: {input.global_context.skipped_steps}
- Remaining: {input.global_context.remaining_steps}

**Execution Metrics:**
- Iterations: {input.global_context.total_iterations}
- Tool Calls: {input.global_context.total_tool_calls}
- LLM Calls: {input.global_context.total_llm_calls}
- Elapsed: {input.global_context.elapsed_ms:.0f}ms

**Key Facts Accumulated:**
{facts_summary}

**Step Status:**
{step_summary}

======================================================================
CURRENT STEP OUTCOME
======================================================================

**Step {input.step_context.step_num}:** {input.step_context.objective}
**Phase:** {input.step_context.phase}
**Tool Hint:** {input.step_context.tool_hint or "(none)"}
**Attempt:** {input.step_context.attempt_count}
**Required:** {"Yes" if input.step_context.is_required else "No"}

**Worker Success:** {input.outcome.get("success", False)}
**Termination Reason:** {input.outcome.get("termination_reason", "unknown")}
**Error:** {input.outcome.get("error") or "(none)"}

{previous_attempts}

**Worker Output:**
{worker_output}

======================================================================
YOUR TASK
======================================================================

Analyze this outcome and decide the next action. Consider:

1. **QUALITY**: Does the output fully address the objective? Is it correct?
2. **COMPLETENESS**: Is there more work needed for excellence?
3. **ERRORS**: Did the Worker make mistakes? Are there bugs?
4. **PROGRESS**: Are we making progress toward the goal?
5. **BLOCKERS**: Is there something fundamentally blocking progress?

======================================================================
DECISION OPTIONS (in order of preference)
======================================================================

**ACCEPT** - The work is sufficient. Proceed to next step.
  Use when: Output addresses objective, quality is acceptable.

**ACCEPT_EXTEND** - Work is good, but scaffold additional steps for excellence.
  Use when: Core work done, but obvious improvements possible.
  CRITICAL: This is the PRIMARY strategy for complex tasks!
  Examples:
  - Code written -> add tests
  - Function added -> add documentation
  - Feature implemented -> add error handling
  - Question answered -> add examples
  - Task partially done -> scaffold remaining work
  - Worker made progress but didn't finish -> scaffold continuation

**REDO** - Output is insufficient. Retry with modifications.
  Use when: Wrong approach, misunderstood objective, fixable errors.
  Provide: New objective, tool hint, or context to inject.

**ABORT_STEP** - This step is not achievable. Skip it.
  Use when: Step is genuinely impossible, not just difficult.
  RARELY USE THIS - prefer ACCEPT_EXTEND to scaffold smaller steps.

**ABORT_GOAL** - Fundamental blocker prevents achieving the goal.
  Use when: Missing required access, contradictory requirements.
  This is VERY RARE. Prefer scaffolding more steps.

======================================================================
SCAFFOLDING IS YOUR PRIMARY TOOL
======================================================================

When a task seems too large or complex, your FIRST instinct should be
to scaffold it into smaller steps using ACCEPT_EXTEND.

NEVER accept a refusal like "task too complex" or "exceeds budget".
Instead, scaffold the task into smaller, achievable steps:

1. Discovery step: Understand current state
2. Planning step: Identify specific changes needed
3. Implementation steps: One concrete change each
4. Verification step: Ensure changes work

Example: "Improve the dashboard significantly" should become:
  Step 1: Read current dashboard implementation
  Step 2: Identify data sources and hydration points
  Step 3: Implement first improvement (e.g., connect to sessions DB)
  Step 4: Implement second improvement (e.g., better styling)
  Step 5: Verify all changes work together

======================================================================
ANTI-PATTERNS TO AVOID
======================================================================

DO NOT ABORT because something is hard - scaffold more steps instead
DO NOT ACCEPT half-baked work - REDO or EXTEND for quality
DO NOT let "I need more info" be acceptable - Workers should gather info
DO NOT repeat the same REDO without modifications
DO NOT accept "task too complex/big" - ALWAYS scaffold into sub-steps
DO NOT accept refusals - decompose and scaffold instead

======================================================================
RESPONSE FORMAT
======================================================================

Respond with JSON:
{{
    "verdict": "accept" | "accept_extend" | "redo" | "abort_step" | "abort_goal",
    "reasoning": "Your detailed reasoning for this decision",
    "confidence": 0.0-1.0,

    "quality": {{
        "overall_score": 0.0-1.0,
        "completeness": 0.0-1.0,
        "correctness": 0.0-1.0,
        "clarity": 0.0-1.0,
        "maintainability": 0.0-1.0,
        "actionability": 0.0-1.0,
        "relevance": 0.0-1.0,
        "issues": ["List of issues detected"],
        "errors": ["List of errors detected"],
        "improvement_suggestions": ["Suggestions for improvement"]
    }},

    "scaffolded_steps": [
        // For ACCEPT_EXTEND only
        {{
            "objective": "What this step should accomplish",
            "tool_hint": "Suggested tool (optional)",
            "phase": "execution" | "verification",
            "rationale": "Why this step is needed"
        }}
    ],

    "redo_modifications": {{
        // For REDO only
        "new_objective": "Clearer/modified objective (optional)",
        "new_tool_hint": "Different tool to try (optional)",
        "injected_context": "Additional context to provide (optional)",
        "avoid_patterns": ["Things the Worker should NOT do this time"]
    }},

    "abort_reason": "For ABORT_STEP/ABORT_GOAL - why we're giving up",

    "user_message": "A well-formatted message to show the user about progress"
}}
"""
        return self._adjust_prompt_for_context(base_prompt, input)

    def _format_step_summary(self, steps: List[Dict[str, Any]]) -> str:
        """Format step status for the prompt."""
        if not steps:
            return "  (no steps)"

        lines = []
        status_icons = {
            "pending": "[ ]",
            "in_progress": "[~]",
            "completed": "[x]",
            "failed": "[!]",
            "skipped": "[-]",
            "awaiting_user": "[?]",
        }

        for step in steps:
            status = step.get("status", "pending")
            if hasattr(status, "value"):
                status = status.value
            icon = status_icons.get(status, "?")
            step_num = step.get("step_num", 0)
            objective = step.get("objective", "")[:60]
            lines.append(f"  {icon} Step {step_num}: {objective}")

        return "\n".join(lines)

    def _format_facts(self, facts: List[Dict[str, Any]]) -> str:
        """Format knowledge facts for the prompt."""
        if not facts:
            return "  (no facts accumulated)"

        lines = []
        for fact in facts[:10]:  # Limit to 10 most relevant
            key = fact.get("key", "unknown")
            value = str(fact.get("value", ""))[:100]
            lines.append(f"  - {key}: {value}")
        return "\n".join(lines)

    def _format_worker_output(self, outcome: Dict[str, Any]) -> str:
        """Format worker output for the prompt."""
        parts = []

        # Final response
        final_response = outcome.get("final_response")
        if final_response:
            parts.append(f"**Response:**\n{str(final_response)[:2000]}")

        # Tool results from facts
        facts = outcome.get("facts", [])
        tool_results = []
        for fact in facts:
            tool_name = fact.get("tool_name")
            if tool_name:
                value = str(fact.get("value", ""))[:300]
                tool_results.append(f"  - {tool_name}: {value}")

        if tool_results:
            parts.append("**Tool Results:**\n" + "\n".join(tool_results[:5]))

        return "\n\n".join(parts) if parts else "(no output)"

    def _format_previous_attempts(self, errors: List[str]) -> str:
        """Format previous attempt errors."""
        if not errors:
            return ""

        lines = ["**Previous Attempt Errors:**"]
        for i, error in enumerate(errors[-3:], 1):  # Last 3 attempts
            lines.append(f"  Attempt {i}: {error[:200]}")
        return "\n".join(lines)

    def _check_reflection_cache(
        self,
        input: WizardReflectionInput,
    ) -> Optional[WizardReflectionOutput]:
        """Check if we can use cached reflection for common patterns."""
        key = (
            bool(input.outcome.get("success", False)),
            input.outcome.get("termination_reason"),
        )
        if key in REFLECTION_CACHE_PATTERNS:
            cached_verdict = REFLECTION_CACHE_PATTERNS[key]
            if cached_verdict == ReflectionVerdict.ACCEPT and input.outcome.get("success"):
                return WizardReflectionOutput(
                    verdict=cached_verdict,
                    reasoning="Fast path: successful completion",
                    confidence=0.8,
                    user_message=input.outcome.get("final_response") or "Step completed.",
                )
            if cached_verdict == ReflectionVerdict.REDO and input.step_context.attempt_count <= 1:
                return WizardReflectionOutput(
                    verdict=cached_verdict,
                    reasoning="Fast path: retryable failure",
                    confidence=0.6,
                    redo_modifications=RedoModifications(
                        injected_context="Retry after exception with a simpler approach."
                    ),
                    user_message="Retrying step due to infrastructure error.",
                )

        return None

    def _adjust_prompt_for_context(
        self,
        base_prompt: str,
        input: WizardReflectionInput,
    ) -> str:
        """Adjust prompt based on context."""
        adjustments = []

        if input.step_context.attempt_count > 1:
            adjustments.append(
                "This step has been attempted before. "
                "If choosing REDO, ensure modifications are DIFFERENT from previous attempts."
            )

        if input.global_context.total_steps:
            completion_pct = (
                input.global_context.completed_steps /
                input.global_context.total_steps
            )
            if completion_pct > 0.8:
                adjustments.append(
                    "We are near completion. Bias toward ACCEPT unless quality is clearly insufficient."
                )

        if input.global_context.failed_steps > 2:
            adjustments.append(
                "Several steps have failed. Consider if the goal is achievable. "
                "Be pragmatic about what can be accomplished."
            )

        if adjustments:
            adjustment_text = "\n\n**CONTEXTUAL GUIDANCE:**\n" + "\n".join(
                f"- {a}" for a in adjustments
            )
            return base_prompt + adjustment_text

        return base_prompt

    def _parse_response(
        self,
        response: str,
        input: WizardReflectionInput
    ) -> WizardReflectionOutput:
        """Parse LLM response into structured output."""
        try:
            data = json.loads(response)
        except json.JSONDecodeError as e:
            self._log("warning", f"Failed to parse reflection JSON: {e}")
            return self._create_fallback_output(input, f"JSON parse error: {e}")

        # Parse verdict
        verdict = self._parse_verdict(data.get("verdict", "accept"))

        # Parse quality assessment
        quality_data = data.get("quality", {})
        quality = QualityAssessment(
            overall_score=quality_data.get("overall_score", 0.5),
            completeness=quality_data.get("completeness", 0.5),
            correctness=quality_data.get("correctness", 0.5),
            clarity=quality_data.get("clarity", 0.5),
            maintainability=quality_data.get("maintainability", 0.5),
            actionability=quality_data.get("actionability", 0.5),
            relevance=quality_data.get("relevance", 0.5),
            issues=quality_data.get("issues", []),
            errors=quality_data.get("errors", []),
            improvement_suggestions=quality_data.get("improvement_suggestions", []),
        )

        # Parse scaffolded steps
        scaffolded_steps = []
        for step_data in data.get("scaffolded_steps", []):
            scaffolded_steps.append(ScaffoldedStep(
                objective=step_data.get("objective", ""),
                tool_hint=step_data.get("tool_hint"),
                phase=step_data.get("phase", "execution"),
                rationale=step_data.get("rationale", ""),
            ))

        # Parse redo modifications
        redo_data = data.get("redo_modifications")
        redo_modifications = None
        if redo_data and verdict == ReflectionVerdict.REDO:
            redo_modifications = RedoModifications(
                new_objective=redo_data.get("new_objective"),
                new_tool_hint=redo_data.get("new_tool_hint"),
                injected_context=redo_data.get("injected_context"),
                avoid_patterns=redo_data.get("avoid_patterns", []),
            )

        # Parse abort category if present
        abort_category = None
        abort_category_str = data.get("abort_category")
        if abort_category_str:
            try:
                abort_category = FailureCategory(abort_category_str)
            except ValueError:
                pass

        return WizardReflectionOutput(
            verdict=verdict,
            reasoning=data.get("reasoning", ""),
            confidence=data.get("confidence", 0.5),
            quality=quality,
            scaffolded_steps=scaffolded_steps,
            redo_modifications=redo_modifications,
            abort_reason=data.get("abort_reason"),
            abort_category=abort_category,
            user_message=data.get("user_message", ""),
        )

    def _parse_verdict(self, verdict_str: str) -> ReflectionVerdict:
        """Parse verdict string to enum."""
        mapping = {
            "accept": ReflectionVerdict.ACCEPT,
            "accept_extend": ReflectionVerdict.ACCEPT_AND_EXTEND,
            "extend": ReflectionVerdict.ACCEPT_AND_EXTEND,
            "redo": ReflectionVerdict.REDO,
            "abort_step": ReflectionVerdict.ABORT_STEP,
            "abort_goal": ReflectionVerdict.ABORT_GOAL,
        }
        return mapping.get(verdict_str.lower(), ReflectionVerdict.ACCEPT)

    def _create_fallback_output(
        self,
        input: WizardReflectionInput,
        error: str
    ) -> WizardReflectionOutput:
        """Create fallback output when reflection fails."""
        # If worker succeeded, accept; otherwise, retry
        if input.outcome.get("success", False):
            verdict = ReflectionVerdict.ACCEPT
            user_message = input.outcome.get("final_response") or "Step completed."
        else:
            if input.step_context.attempt_count < self.config.max_redo_attempts:
                verdict = ReflectionVerdict.REDO
                user_message = "Retrying step due to reflection error."
            else:
                verdict = ReflectionVerdict.ABORT_STEP
                user_message = "Step failed repeatedly; aborting."

        return WizardReflectionOutput(
            verdict=verdict,
            reasoning=f"Fallback due to reflection error: {error}",
            confidence=0.3,
            quality=QualityAssessment(overall_score=0.5),
            user_message=user_message,
        )

    def _enforce_quality_and_policy(
        self,
        input: WizardReflectionInput,
        output: WizardReflectionOutput,
    ) -> WizardReflectionOutput:
        """Apply quality enforcement and recovery policy overrides."""
        output.quality = self._merge_quality_assessment(input, output.quality)
        output = self._apply_quality_to_verdict(input, output)
        output = self._apply_recovery_policy(input, output)
        output.user_message = self._ensure_user_message(input, output)
        return output

    def _merge_quality_assessment(
        self,
        input: WizardReflectionInput,
        quality: QualityAssessment,
    ) -> QualityAssessment:
        """Augment quality assessment with heuristic checks."""
        issues, errors, suggestions, flags = self._detect_quality_issues(input)

        quality.issues.extend([i for i in issues if i not in quality.issues])
        quality.errors.extend([e for e in errors if e not in quality.errors])
        quality.improvement_suggestions.extend(
            [s for s in suggestions if s not in quality.improvement_suggestions]
        )

        if errors:
            quality.correctness = min(quality.correctness, 0.3)
        if issues:
            quality.completeness = min(quality.completeness, 0.5)
        if flags.get("missing_tests"):
            quality.maintainability = min(quality.maintainability, 0.4)
        if flags.get("missing_docs"):
            quality.clarity = min(quality.clarity, 0.5)
        if flags.get("missing_verification"):
            quality.correctness = min(quality.correctness, 0.6)

        scores = [
            quality.completeness,
            quality.correctness,
            quality.clarity,
            quality.maintainability,
            quality.actionability,
            quality.relevance,
        ]
        quality.overall_score = max(0.0, min(1.0, sum(scores) / len(scores)))
        return quality

    def _detect_quality_issues(
        self,
        input: WizardReflectionInput,
    ) -> tuple[list[str], list[str], list[str], dict[str, bool]]:
        """Detect quality issues from the outcome text."""
        text = "\n".join(
            str(v) for v in [
                input.outcome.get("final_response"),
                input.outcome.get("error"),
            ]
            if v
        )

        issues: list[str] = []
        errors: list[str] = []
        suggestions: list[str] = []
        flags = {
            "missing_tests": False,
            "missing_docs": False,
            "missing_verification": False,
        }

        for category, patterns in ERROR_PATTERNS.items():
            for pattern in patterns:
                if re.search(pattern, text):
                    if category in ("syntax_error", "runtime_error"):
                        errors.append(f"Detected {category.replace('_', ' ')}")
                    else:
                        issues.append(f"Detected {category.replace('_', ' ')}")
                    break

        has_code = bool(re.search(r"\b(def|class)\b|```", text))
        has_tests = bool(re.search(r"\btest(s)?\b|pytest|unittest|jest", text, re.IGNORECASE))
        if has_code and not has_tests:
            issues.append("Missing tests for implemented code")
            suggestions.append("Add tests to validate the implementation")
            flags["missing_tests"] = True

        has_docs = bool(re.search(r"\bdocstring\b|README|documentation", text, re.IGNORECASE))
        if has_code and not has_docs:
            issues.append("Missing documentation for new code")
            suggestions.append("Add docstrings or README updates")
            flags["missing_docs"] = True

        if input.outcome.get("success") and not re.search(r"\bverify|validated|tested\b", text, re.IGNORECASE):
            flags["missing_verification"] = True

        return issues, errors, suggestions, flags

    def _apply_quality_to_verdict(
        self,
        input: WizardReflectionInput,
        output: WizardReflectionOutput,
    ) -> WizardReflectionOutput:
        """Adjust verdict based on quality signals."""
        if (
            output.quality.overall_score < self.config.abort_quality_threshold and
            input.step_context.attempt_count >= self.config.max_redo_attempts
        ):
            output.verdict = ReflectionVerdict.ABORT_STEP
            output.abort_reason = "Quality too low after repeated attempts."
            return output

        if output.verdict in (ReflectionVerdict.ACCEPT, ReflectionVerdict.ACCEPT_AND_EXTEND):
            if output.quality.overall_score < self.config.redo_quality_threshold:
                output.verdict = ReflectionVerdict.REDO
                output.redo_modifications = output.redo_modifications or RedoModifications(
                    injected_context="Quality far below threshold; take a different approach."
                )
                return output
            if output.quality.overall_score < self.config.min_accept_quality:
                output.verdict = ReflectionVerdict.REDO
                output.redo_modifications = output.redo_modifications or RedoModifications(
                    injected_context="Quality below threshold; improve completeness and correctness."
                )
                return output

        scaffold_steps = self._scaffold_steps_from_quality(input)
        if scaffold_steps:
            if output.verdict == ReflectionVerdict.ACCEPT:
                output.verdict = ReflectionVerdict.ACCEPT_AND_EXTEND
            if output.verdict == ReflectionVerdict.ACCEPT_AND_EXTEND:
                output.scaffolded_steps.extend(scaffold_steps)

        if output.quality.overall_score >= self.config.excellence_threshold:
            if output.verdict == ReflectionVerdict.ACCEPT_AND_EXTEND and not scaffold_steps:
                output.verdict = ReflectionVerdict.ACCEPT
                output.scaffolded_steps = []

        return output

    def _scaffold_steps_from_quality(
        self,
        input: WizardReflectionInput,
    ) -> list[ScaffoldedStep]:
        """Generate scaffold steps for common quality gaps."""
        steps: list[ScaffoldedStep] = []
        text = str(input.outcome.get("final_response") or "")
        has_code = bool(re.search(r"\b(def|class)\b|```", text))
        has_tests = bool(re.search(r"\btest(s)?\b|pytest|unittest|jest", text, re.IGNORECASE))
        has_docs = bool(re.search(r"\bdocstring\b|README|documentation", text, re.IGNORECASE))

        if has_code and not has_tests:
            steps.append(ScaffoldedStep(
                objective="Write tests for the new/updated code",
                tool_hint="file_write",
                phase="verification",
                rationale="Code changes should include tests for reliability",
            ))

        if has_code and not has_docs:
            steps.append(ScaffoldedStep(
                objective="Add documentation or docstrings for the new code",
                tool_hint="file_write",
                phase="execution",
                rationale="Documentation improves maintainability",
            ))

        if input.outcome.get("success") and not re.search(r"\bverify|validated|tested\b", text, re.IGNORECASE):
            steps.append(ScaffoldedStep(
                objective="Verify the implementation and report results",
                tool_hint="bash_execute",
                phase="verification",
                rationale="Verification ensures correctness",
            ))

        return steps

    def _apply_recovery_policy(
        self,
        input: WizardReflectionInput,
        output: WizardReflectionOutput,
    ) -> WizardReflectionOutput:
        """Override verdicts based on termination reason and attempts."""
        if output.verdict in (ReflectionVerdict.ABORT_STEP, ReflectionVerdict.ABORT_GOAL):
            return output

        reason = input.outcome.get("termination_reason")
        attempt = input.step_context.attempt_count
        actions = RECOVERY_MATRIX.get(reason, {})
        action = actions.get(attempt)
        if action is None and actions:
            action = actions.get(max(actions.keys()))
        if not action:
            return output

        if action in ("retry", "redo_with_hints", "redo_explicit", "redo_simplified"):
            output.verdict = ReflectionVerdict.REDO
            injected = {
                "retry": "Retry with a simpler approach.",
                "redo_with_hints": "Use tools to gather missing context before acting.",
                "redo_explicit": "Follow the objective explicitly and avoid questions.",
                "redo_simplified": "Simplify the approach and focus on core requirements.",
            }[action]
            output.redo_modifications = RedoModifications(injected_context=injected)
            return output

        if action in ("scaffold_discovery", "scaffold_substeps"):
            output.verdict = ReflectionVerdict.REDO
            injected = "Break the work into smaller steps and gather missing context with tools."
            output.redo_modifications = RedoModifications(injected_context=injected)
            return output

        # NEW: Handle scaffold_decompose - task was too big, need to break it down
        if action == "scaffold_decompose":
            self._log("info", f"Triggering scaffold_decompose for step {input.step_context.step_num}")
            output.verdict = ReflectionVerdict.ACCEPT_AND_EXTEND
            # Generate scaffolded steps to break down the task
            scaffolded = self._generate_decomposition_steps(input)
            output.scaffolded_steps = scaffolded
            output.user_message = (
                f"The task '{input.step_context.objective[:50]}...' was too complex for a single step. "
                f"Breaking it down into {len(scaffolded)} sub-steps."
            )
            # Mark original step as skipped (it was a refusal, not actual work)
            # The scaffolded steps will do the actual work
            return output

        if action == "clarify_or_abort" or action == "abort_step":
            output.verdict = ReflectionVerdict.ABORT_STEP
            output.abort_reason = "Step failed repeatedly; aborting this step."
            return output

        return output

    def _generate_decomposition_steps(
        self,
        input: WizardReflectionInput,
    ) -> List[ScaffoldedStep]:
        """
        Generate scaffolded steps to decompose a task that was too complex.

        This is triggered when the Worker refuses to attempt work, indicating
        the task needs to be broken into smaller pieces.
        """
        objective = input.step_context.objective
        goal = input.global_context.goal

        # Generate decomposition steps based on common patterns
        steps: List[ScaffoldedStep] = []

        # Step 1: Discovery/Investigation
        steps.append(ScaffoldedStep(
            objective=f"Investigate and understand the current state for: {objective[:80]}",
            tool_hint="file_read",
            phase="discovery",
            rationale="Need to understand current implementation before making changes",
            required=True,
        ))

        # Step 2: Identify specific changes needed
        steps.append(ScaffoldedStep(
            objective=f"Identify specific files and changes needed for: {objective[:60]}",
            tool_hint="search_filesystem",
            phase="discovery",
            rationale="Locate all relevant files that need modification",
            required=True,
        ))

        # Step 3: Implement core changes (first part)
        steps.append(ScaffoldedStep(
            objective=f"Implement the first concrete change for: {objective[:60]}",
            tool_hint="file_write",
            phase="execution",
            rationale="Break implementation into incremental changes",
            required=True,
        ))

        # Step 4: Verification
        steps.append(ScaffoldedStep(
            objective=f"Verify changes work correctly for: {objective[:60]}",
            tool_hint="bash_execute",
            phase="verification",
            rationale="Ensure changes don't break existing functionality",
            required=False,
        ))

        self._log(
            "info",
            f"Generated {len(steps)} decomposition steps for: {objective[:50]}..."
        )

        return steps

    def _ensure_user_message(
        self,
        input: WizardReflectionInput,
        output: WizardReflectionOutput,
    ) -> str:
        """Ensure a user-facing message is always present."""
        if output.user_message:
            return output.user_message

        if output.verdict in (ReflectionVerdict.ACCEPT, ReflectionVerdict.ACCEPT_AND_EXTEND):
            return input.outcome.get("final_response") or "Step completed."
        if output.verdict == ReflectionVerdict.REDO:
            return "Retrying the step with adjustments."
        if output.verdict == ReflectionVerdict.ABORT_STEP:
            return output.abort_reason or "Step aborted."
        if output.verdict == ReflectionVerdict.ABORT_GOAL:
            return output.abort_reason or "Goal aborted."

        return "Continuing."

    def _log(self, level: str, msg: str, **kwargs) -> None:
        """Log with optional logger."""
        if self.logger:
            log_fn = getattr(self.logger, level, None)
            if log_fn:
                log_fn(msg, component="reflector", **kwargs)
