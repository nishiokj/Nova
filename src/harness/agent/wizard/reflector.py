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

from .types import ReflectionVerdict, ClarificationUrgency, FailureCategory
from .reflection_types import (
    WizardReflectionInput,
    WizardReflectionOutput,
    QualityAssessment,
    ScaffoldedStep,
    RedoModifications,
    ClarificationRequest,
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

    # Clarification policy
    require_default_assumption: bool = True
    max_clarification_options: int = 4
    default_clarification_timeout: int = 60

    # LLM settings
    reflection_model: Optional[str] = None  # Override model for reflection
    max_reflection_tokens: int = 2000
    reflection_timeout_ms: int = 10_000


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
    (True, "completed"): ReflectionVerdict.ACCEPT,
    (True, "implicit_final"): ReflectionVerdict.ACCEPT,
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
  Examples:
  - Code written -> add tests
  - Function added -> add documentation
  - Feature implemented -> add error handling
  - Question answered -> add examples

**REDO** - Output is insufficient. Retry with modifications.
  Use when: Wrong approach, misunderstood objective, fixable errors.
  Provide: New objective, tool hint, or context to inject.

**CLARIFY_USER** - Genuinely need user input to proceed.
  Use when: Information is truly unknowable (user preferences, secrets, business decisions).
  MUST provide: default_assumption (what you'll do if user doesn't respond).
  DO NOT use for: Framework choices, library preferences, implementation approaches.

**ABORT_STEP** - This step is not achievable. Skip it.
  Use when: Step is genuinely impossible, not just difficult.

**ABORT_GOAL** - Fundamental blocker prevents achieving the goal.
  Use when: Missing required access, contradictory requirements.
  This is VERY RARE. Prefer scaffolding more steps.

======================================================================
ANTI-PATTERNS TO AVOID
======================================================================

DO NOT CLARIFY for assumable things (frameworks, libraries, approaches)
DO NOT ABORT because something is hard - scaffold more steps instead
DO NOT ACCEPT half-baked work - REDO or EXTEND for quality
DO NOT let "I need more info" be acceptable - Workers should gather info
DO NOT repeat the same REDO without modifications

======================================================================
RESPONSE FORMAT
======================================================================

Respond with JSON:
{{
    "verdict": "accept" | "accept_extend" | "redo" | "clarify_user" | "abort_step" | "abort_goal",
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

    "clarification": {{
        // For CLARIFY_USER only
        "question": "The question to ask the user",
        "options": ["Option 1", "Option 2"],
        "default_assumption": "REQUIRED - what we do if no response",
        "urgency": "low" | "medium" | "high" | "blocking",
        "context": "Additional context for the user"
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

        # Parse clarification request
        clarification_data = data.get("clarification")
        clarification = None
        if clarification_data and verdict == ReflectionVerdict.CLARIFY_USER:
            # Validate default assumption is present
            default = clarification_data.get("default_assumption", "")
            if not default and self.config.require_default_assumption:
                # Reject clarification without default
                self._log(
                    "warning",
                    "Clarification rejected: no default assumption"
                )
                # Convert to REDO with the default we invent
                verdict = ReflectionVerdict.REDO
                redo_modifications = RedoModifications(
                    injected_context="Make a reasonable assumption and proceed."
                )
            else:
                urgency_str = clarification_data.get("urgency", "medium")
                try:
                    urgency = ClarificationUrgency(urgency_str)
                except ValueError:
                    urgency = ClarificationUrgency.MEDIUM

                clarification = ClarificationRequest(
                    question=clarification_data.get("question", ""),
                    options=clarification_data.get("options", []),
                    default_assumption=default,
                    urgency=urgency,
                    context=clarification_data.get("context", ""),
                    step_num=input.step_context.step_num,
                )
                if clarification.timeout_seconds <= 0:
                    clarification.timeout_seconds = self.config.default_clarification_timeout
                is_valid, reason = self._validate_clarification_request(clarification)
                if not is_valid:
                    self._log("warning", f"Clarification rejected: {reason}")
                    verdict = ReflectionVerdict.REDO
                    redo_modifications = RedoModifications(
                        injected_context="Make a reasonable assumption and proceed."
                    )
                    clarification = None

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
            clarification=clarification,
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
            "clarify_user": ReflectionVerdict.CLARIFY_USER,
            "clarify": ReflectionVerdict.CLARIFY_USER,
            "abort_step": ReflectionVerdict.ABORT_STEP,
            "abort_goal": ReflectionVerdict.ABORT_GOAL,
        }
        return mapping.get(verdict_str.lower(), ReflectionVerdict.ACCEPT)

    def _validate_clarification_request(
        self,
        request: ClarificationRequest,
    ) -> tuple[bool, Optional[str]]:
        """Validate a clarification request."""
        if not request.question or len(request.question) < 10:
            return False, "Question too short or missing"

        if self.config.require_default_assumption and not request.default_assumption:
            return False, "Missing default assumption"

        if len(request.options) > self.config.max_clarification_options:
            return False, f"Too many options (max {self.config.max_clarification_options})"

        question_lower = request.question.lower()
        for pattern in ASSUMABLE_QUESTION_PATTERNS:
            if re.search(pattern, question_lower):
                return False, f"This can be assumed: {request.default_assumption}"

        return True, None

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

        if action == "clarify_or_abort":
            output.verdict = ReflectionVerdict.CLARIFY_USER
            output.clarification = ClarificationRequest(
                question=f"Please clarify the missing details for: {input.step_context.objective}",
                default_assumption="Proceed with reasonable defaults based on the goal.",
                timeout_seconds=self.config.default_clarification_timeout,
                urgency=ClarificationUrgency.MEDIUM,
                step_num=input.step_context.step_num,
            )
            return output

        if action == "abort_step":
            output.verdict = ReflectionVerdict.ABORT_STEP
            output.abort_reason = "Step failed repeatedly; aborting this step."
            return output

        return output

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
        if output.verdict == ReflectionVerdict.CLARIFY_USER and output.clarification:
            return f"Need clarification: {output.clarification.question}"
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
