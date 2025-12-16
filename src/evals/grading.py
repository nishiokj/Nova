"""
LLM-as-judge grading system with focus on reproducibility.

Uses temperature=0 and binary yes/no questions to minimize scoring noise.
"""

import re
import json
import logging
from typing import Tuple, Dict, Any, List
from datetime import datetime
from pathlib import Path

from util.llm_adapter import LLMAdapter, Message, MessageRole
from evals.eval_task import EvalTask, GradingRubric, RubricCriterion, EvalResult


class LLMJudge:
    """
    LLM-as-judge grading system with focus on reproducibility.

    Uses Claude Opus 4.5 or similar strong model at temperature=0
    to evaluate agent responses against discrete rubrics.

    Key principles:
    1. Temperature 0 for deterministic outputs
    2. Binary yes/no questions wherever possible
    3. Evidence-based reasoning
    4. Multiple independent criteria
    5. Automated checks before LLM judgment
    """

    def __init__(self, judge_llm: LLMAdapter):
        """
        Initialize LLM judge.

        Args:
            judge_llm: LLMAdapter configured with temperature=0
        """
        self.llm = judge_llm
        self.logger = logging.getLogger(__name__)

    def ensure_ready(self) -> None:
        """
        Pre-warm the judge LLM to catch configuration issues early.
        """
        self.logger.info("Initializing judge LLM for grading")
        try:
            ready = self.llm.prewarm()
        except Exception as e:
            self.logger.error("Judge LLM prewarm failed: %s", e)
            raise RuntimeError("Judge LLM initialization failed") from e

        if not ready:
            raise RuntimeError("Judge LLM prewarm reported failure; please check credentials or network access")

    def grade_task(
        self,
        task: EvalTask,
        agent_response: Any
    ) -> EvalResult:
        """
        Grade a task execution.

        Process:
        1. Apply automated checks (exact match, regex, etc.)
        2. For criteria requiring judgment, query judge LLM
        3. Combine scores according to rubric weights
        4. Return detailed result with reasoning

        Args:
            task: The eval task that was executed
            agent_response: AgentResponse from agent execution

        Returns:
            EvalResult with scores and reasoning
        """
        if not task.rubric:
            raise ValueError(f"Task {task.task_id} has no rubric")

        criterion_scores = {}
        judge_reasoning_parts = []
        judge_raw_responses = []

        for criterion in task.rubric.criteria:
            if criterion.eval_type == "exact_match":
                score, reasoning = self._eval_exact_match(criterion, task, agent_response)
            elif criterion.eval_type == "contains":
                score, reasoning = self._eval_contains(criterion, task, agent_response)
            elif criterion.eval_type == "regex":
                score, reasoning = self._eval_regex(criterion, task, agent_response)
            elif criterion.eval_type == "file_exists":
                score, reasoning = self._eval_file_exists(criterion, task, agent_response)
            elif criterion.eval_type == "python_test":
                score, reasoning = self._eval_python_test(criterion, task, agent_response)
            elif criterion.eval_type == "llm_judge":
                score, reasoning, raw = self._eval_llm_judge(task, criterion, agent_response)
                judge_raw_responses.append(raw)
            else:
                raise ValueError(f"Unknown eval_type: {criterion.eval_type}")

            criterion_scores[criterion.criterion_id] = score
            judge_reasoning_parts.append(reasoning)

        # Calculate total score
        total_score = sum(criterion_scores.values())

        # Determine pass/fail
        passed = total_score >= task.rubric.pass_threshold

        # Determine failure mode if failed
        failure_mode = None
        if not passed:
            failure_mode = self._determine_failure_mode(agent_response, criterion_scores)

        return EvalResult(
            task_id=task.task_id,
            timestamp=datetime.utcnow().isoformat(),
            agent_response=agent_response,
            execution_time_ms=agent_response.total_duration_ms if agent_response else 0.0,
            tools_used=agent_response.tools_used if agent_response else [],
            score=total_score,
            criterion_scores=criterion_scores,
            passed=passed,
            judge_reasoning="\n\n".join(judge_reasoning_parts),
            judge_raw_response="\n\n===\n\n".join(judge_raw_responses),
            failure_mode=failure_mode,
            error=agent_response.error if agent_response and hasattr(agent_response, 'error') else None
        )

    def _eval_exact_match(
        self,
        criterion: RubricCriterion,
        task: EvalTask,
        agent_response: Any
    ) -> Tuple[float, str]:
        """
        Evaluate using exact string matching.

        Expected config:
            expected_value: str - The exact value to match
        """
        expected = criterion.eval_config.get("expected_value", "")
        actual = agent_response.content if agent_response else ""

        # Handle case sensitivity
        if not task.rubric.case_sensitive:
            expected = expected.lower()
            actual = actual.lower()

        match = expected.strip() == actual.strip()
        points = criterion.points if match else 0

        reasoning = f"[{criterion.criterion_id}] {'PASS' if match else 'FAIL'} - "
        reasoning += f"Expected exact match: '{expected}'"
        if not match:
            reasoning += f", got: '{actual[:100]}...'" if len(actual) > 100 else f", got: '{actual}'"

        return points, reasoning

    def _eval_contains(
        self,
        criterion: RubricCriterion,
        task: EvalTask,
        agent_response: Any
    ) -> Tuple[float, str]:
        """
        Evaluate by checking if response contains required strings.

        Expected config:
            required_strings: List[str] - All must be present
            OR
            required_tools: List[str] - Check if tools were used
        """
        actual = agent_response.content if agent_response else ""

        # Check for required strings
        if "required_strings" in criterion.eval_config:
            required = criterion.eval_config["required_strings"]
            case_sensitive = criterion.eval_config.get("case_sensitive", False)

            if not case_sensitive:
                actual_lower = actual.lower()
                missing = [s for s in required if s.lower() not in actual_lower]
            else:
                missing = [s for s in required if s not in actual]

            match = len(missing) == 0
            points = criterion.points if match else 0

            reasoning = f"[{criterion.criterion_id}] {'PASS' if match else 'FAIL'} - "
            reasoning += f"Required strings: {required}"
            if missing:
                reasoning += f", missing: {missing}"

            return points, reasoning

        # Check for required tools
        elif "required_tools" in criterion.eval_config:
            required_tools = criterion.eval_config["required_tools"]
            tools_used = agent_response.tools_used if agent_response else []

            missing_tools = [t for t in required_tools if t not in tools_used]
            match = len(missing_tools) == 0
            points = criterion.points if match else 0

            reasoning = f"[{criterion.criterion_id}] {'PASS' if match else 'FAIL'} - "
            reasoning += f"Required tools: {required_tools}, used: {tools_used}"
            if missing_tools:
                reasoning += f", missing: {missing_tools}"

            return points, reasoning

        else:
            return 0, f"[{criterion.criterion_id}] ERROR - No evaluation config"

    def _eval_regex(
        self,
        criterion: RubricCriterion,
        task: EvalTask,
        agent_response: Any
    ) -> Tuple[float, str]:
        """
        Evaluate using regular expression matching.

        Expected config:
            pattern: str - Regex pattern to match
        """
        pattern = criterion.eval_config.get("pattern", "")
        actual = agent_response.content if agent_response else ""

        try:
            match = re.search(pattern, actual, re.MULTILINE | re.DOTALL)
            points = criterion.points if match else 0

            reasoning = f"[{criterion.criterion_id}] {'PASS' if match else 'FAIL'} - "
            reasoning += f"Pattern: '{pattern}'"
            if match:
                reasoning += f", matched: '{match.group(0)[:50]}...'" if len(match.group(0)) > 50 else f", matched: '{match.group(0)}'"

            return points, reasoning

        except re.error as e:
            return 0, f"[{criterion.criterion_id}] ERROR - Invalid regex: {e}"

    def _eval_file_exists(
        self,
        criterion: RubricCriterion,
        task: EvalTask,
        agent_response: Any
    ) -> Tuple[float, str]:
        """
        Evaluate by checking if a file exists.

        Expected config:
            path: str - Path to file (relative to working directory)
        """
        filepath = criterion.eval_config.get("path", "")
        path = Path(filepath)

        candidate_paths = []
        if path.is_absolute():
            candidate_paths.append(path)
        else:
            candidate_paths.append(Path.cwd() / path)
            artifact_dir = None
            if agent_response and getattr(agent_response, "metadata", None):
                artifact_dir = agent_response.metadata.get("artifact_dir")
            if artifact_dir:
                candidate_paths.append(Path(artifact_dir) / path)

        matched_path = next((candidate for candidate in candidate_paths if candidate.exists()), None)
        exists = matched_path is not None
        points = criterion.points if exists else 0

        reasoning = f"[{criterion.criterion_id}] {'PASS' if exists else 'FAIL'} - "
        if exists:
            reasoning += f"File '{filepath}' exists at {matched_path}"
        else:
            reasoning += f"File '{filepath}' does not exist"

        # If file exists, optionally check content
        if exists and "content_contains" in criterion.eval_config:
            try:
                content = matched_path.read_text()
                required = criterion.eval_config["content_contains"]

                if isinstance(required, str):
                    has_content = required in content
                elif isinstance(required, list):
                    has_content = all(s in content for s in required)
                else:
                    has_content = False

                if not has_content:
                    points = 0
                    reasoning += f", but missing required content"
            except Exception as e:
                points = 0
                reasoning += f", but failed to read: {e}"

        return points, reasoning

    def _eval_python_test(
        self,
        criterion: RubricCriterion,
        task: EvalTask,
        agent_response: Any
    ) -> Tuple[float, str]:
        """
        Evaluate by running Python test cases.

        Expected config:
            test_file: str - Path to Python file with function to test
            tests: List[Tuple[str, Any]] - List of (expression, expected_result) pairs
        """
        test_file = criterion.eval_config.get("test_file", "")
        tests = criterion.eval_config.get("tests", [])

        if not Path(test_file).exists():
            return 0, f"[{criterion.criterion_id}] FAIL - Test file '{test_file}' not found"

        try:
            # Load the module
            import importlib.util
            spec = importlib.util.spec_from_file_location("test_module", test_file)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            # Run tests
            passed_tests = 0
            failed_tests = []

            for test_expr, expected in tests:
                try:
                    # Evaluate expression in module context
                    result = eval(test_expr, module.__dict__)
                    if result == expected:
                        passed_tests += 1
                    else:
                        failed_tests.append(f"{test_expr} -> {result} (expected {expected})")
                except Exception as e:
                    failed_tests.append(f"{test_expr} raised {type(e).__name__}: {e}")

            # Award points proportionally
            if tests:
                points = criterion.points * (passed_tests / len(tests))
            else:
                points = 0

            reasoning = f"[{criterion.criterion_id}] "
            reasoning += f"Passed {passed_tests}/{len(tests)} tests"
            if failed_tests:
                reasoning += f", failures: {failed_tests[:3]}"  # Limit to first 3

            return points, reasoning

        except Exception as e:
            return 0, f"[{criterion.criterion_id}] ERROR - Failed to run tests: {e}"

    def _eval_llm_judge(
        self,
        task: EvalTask,
        criterion: RubricCriterion,
        agent_response: Any
    ) -> Tuple[float, str, str]:
        """
        Use LLM judge for subjective criteria.

        Asks a binary yes/no question with evidence requirement.

        Returns:
            Tuple of (points, reasoning, raw_response)
        """
        # Build judge prompt
        prompt = self._build_judge_prompt(task, criterion, agent_response)

        messages = [
            Message(
                MessageRole.SYSTEM,
                "You are a precise evaluator. Output only the requested format. "
                "Be strict and objective. Only answer YES if the evidence clearly supports it."
            ),
            Message(MessageRole.USER, prompt)
        ]

        # Query judge LLM (temperature=0 for determinism)
        response = self.llm.complete(messages)

        # Parse response
        answer_data = self._parse_judge_answer(response.content)

        # Award points based on yes/no
        points = criterion.points if answer_data["answer"] == "YES" else 0

        reasoning = f"[{criterion.criterion_id}] {answer_data['answer']} "
        reasoning += f"({answer_data['confidence']}% confident) - {answer_data['evidence']}"

        return points, reasoning, response.content

    def _build_judge_prompt(
        self,
        task: EvalTask,
        criterion: RubricCriterion,
        agent_response: Any
    ) -> str:
        """Build the prompt for LLM judge."""
        # Summarize file operations
        file_ops_summary = self._summarize_file_ops(agent_response)
        tool_activity_summary = self._summarize_tool_activity(agent_response)
        metadata = getattr(agent_response, "metadata", {}) or {}
        artifact_dir = metadata.get("artifact_dir")
        tool_failures = metadata.get("tool_failures")
        tool_failure_line = tool_failures if tool_failures is not None else "unknown"

        # Get reflection evidence if available
        reflection_evidence = ""
        if agent_response and hasattr(agent_response, 'reflection') and agent_response.reflection:
            reflection = agent_response.reflection
            if hasattr(reflection, 'evidence'):
                reflection_evidence = '\n'.join(reflection.evidence) if isinstance(reflection.evidence, list) else str(reflection.evidence)

        prompt = f"""You are evaluating an AI agent's response to a task.

TASK: {task.prompt}

EXPECTED BEHAVIOR: {task.expected_behavior}

SUCCESS CRITERIA:
{chr(10).join(f'- {c}' for c in task.success_criteria)}

AGENT RESPONSE:
{agent_response.content if agent_response else '(No response)'}

AGENT ACTIONS TAKEN:
- Tools used: {', '.join(agent_response.tools_used) if agent_response and agent_response.tools_used else 'None'}
- Tool failures recorded: {tool_failure_line}
- Files created/modified: {file_ops_summary}
- Artifact directory: {artifact_dir or 'Not provided'}
- Artifact note: {"Sandbox paths referenced in tool output correspond to the artifact directory above." if artifact_dir else "Temporary sandbox paths may not persist beyond this evaluation."}
- Tool execution summary:
{tool_activity_summary}
- Goal achieved (self-assessment): {agent_response.goal_achieved if agent_response else 'N/A'}
- Execution reflection: {reflection_evidence if reflection_evidence else 'N/A'}

CRITERION TO EVALUATE:
{criterion.description}

QUESTION: {criterion.judge_question}

Respond with EXACTLY this format:
ANSWER: [YES or NO]
EVIDENCE: [Cite specific evidence from the agent's response that supports your answer]
CONFIDENCE: [0-100, how confident are you in this judgment]

Be strict and objective. Only answer YES if the evidence clearly supports it.
"""
        return prompt

    def _summarize_file_ops(self, agent_response: Any) -> str:
        """Summarize file operations from agent response."""
        if not agent_response or not hasattr(agent_response, 'metadata'):
            return "None"

        metadata = agent_response.metadata
        file_ops = metadata.get('file_operations', [])

        if not file_ops:
            return "None"

        # Group by action type
        created = [op['path'] for op in file_ops if op.get('action') == 'write']
        read = [op['path'] for op in file_ops if op.get('action') == 'read']

        summary_parts = []
        if created:
            summary_parts.append(f"Created: {', '.join(created[:5])}")
        if read:
            summary_parts.append(f"Read: {', '.join(read[:5])}")

        return '; '.join(summary_parts) if summary_parts else "None"

    def _summarize_tool_activity(self, agent_response: Any) -> str:
        """Summarize tool usage with success/failure snippets for the judge."""
        if not agent_response or not getattr(agent_response, "steps", None):
            return "  (no tool activity recorded)"

        lines: List[str] = []
        for step in agent_response.steps:
            tool_name = getattr(step, "tool_name", None)
            if not tool_name:
                continue
            status = "ERROR" if step.error else "OK"
            output = step.tool_output or step.error or ""
            snippet = self._truncate_text(str(output))
            lines.append(f"  - Step {step.step_number} [{tool_name}] {status}: {snippet}")
            if len(lines) >= 8:
                break

        return "\n".join(lines) if lines else "  (no tool activity recorded)"

    @staticmethod
    def _truncate_text(text: str, limit: int = 200) -> str:
        """Trim long outputs for prompt readability."""
        simplified = text.strip()
        if len(simplified) <= limit:
            return simplified or "(no output)"
        return simplified[: limit - 3] + "..."

    def _parse_judge_answer(self, response_content: str) -> Dict[str, Any]:
        """
        Parse judge response into structured format.

        Expected format:
            ANSWER: YES or NO
            EVIDENCE: <evidence text>
            CONFIDENCE: <0-100>
        """
        lines = response_content.strip().split('\n')

        answer = "NO"  # Default to NO if parsing fails
        evidence = ""
        confidence = 50  # Default to 50% confidence

        for line in lines:
            line = line.strip()

            if line.startswith("ANSWER:"):
                answer_text = line.split(":", 1)[1].strip().upper()
                if "YES" in answer_text:
                    answer = "YES"
                elif "NO" in answer_text:
                    answer = "NO"

            elif line.startswith("EVIDENCE:"):
                evidence = line.split(":", 1)[1].strip()

            elif line.startswith("CONFIDENCE:"):
                try:
                    conf_text = line.split(":", 1)[1].strip()
                    # Extract number
                    conf_match = re.search(r'\d+', conf_text)
                    if conf_match:
                        confidence = int(conf_match.group())
                except Exception:
                    confidence = 50

        return {
            "answer": answer,
            "evidence": evidence,
            "confidence": confidence
        }

    def _determine_failure_mode(
        self,
        agent_response: Any,
        criterion_scores: Dict[str, float]
    ) -> str:
        """
        Determine the failure mode based on response and scores.

        Categories:
        - timeout: Task exceeded time limit
        - no_tools: Required tools not used
        - wrong_output: Output doesn't match expected
        - incomplete: Partial completion
        - bad_reasoning: Logic errors
        """
        if not agent_response:
            return "no_response"

        # Check for timeout
        if hasattr(agent_response, 'metadata') and agent_response.metadata.get('timeout'):
            return "timeout"

        # Check for error
        if hasattr(agent_response, 'error') and agent_response.error:
            return "error"

        # Check if any criterion scored 0
        zero_criteria = [cid for cid, score in criterion_scores.items() if score == 0]

        if not zero_criteria:
            return "low_quality"  # Passed some but not enough

        # Categorize based on which criteria failed
        if any("tool" in cid.lower() for cid in zero_criteria):
            return "wrong_tools"

        if any("answer" in cid.lower() or "correct" in cid.lower() for cid in zero_criteria):
            return "wrong_answer"

        if any("reasoning" in cid.lower() for cid in zero_criteria):
            return "bad_reasoning"

        return "incomplete"
