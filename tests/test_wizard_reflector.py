import json

from harness.agent.wizard.reflector import WizardReflector
from harness.agent.wizard.reflection_types import (
    ReflectionContext,
    StepContext,
    WizardReflectionInput,
)
from harness.agent.wizard.types import GoalType
from harness.agent.wizard.types import ReflectionVerdict
from tests.test_helpers import MockLLMAdapter, MockLLMBehavior


def create_reflection_input(
    outcome_success=True,
    termination_reason="custom",
    final_response="Task completed successfully.",
    attempt_count=1,
    previous_errors=None,
):
    global_context = ReflectionContext(
        goal="Test goal",
        goal_type=GoalType.TASK,
        total_steps=1,
        completed_steps=0,
        failed_steps=0,
        remaining_steps=1,
        total_iterations=1,
        total_tool_calls=0,
        total_llm_calls=0,
        elapsed_ms=0.0,
    )
    step_context = StepContext(
        step_num=1,
        objective="Do something",
        tool_hint=None,
        phase="execution",
        attempt_count=attempt_count,
        depends_on=[],
        is_required=False,
        previous_errors=previous_errors or [],
    )
    outcome = {
        "success": outcome_success,
        "termination_reason": termination_reason,
        "final_response": final_response,
        "error": None if outcome_success else "Failure",
        "facts": [],
    }
    return WizardReflectionInput(
        global_context=global_context,
        step_context=step_context,
        outcome=outcome,
        all_steps=[],
        recent_outcomes=[],
    )


def test_accept_successful_outcome():
    behavior = MockLLMBehavior(responses=[
        json.dumps({
            "verdict": "accept",
            "reasoning": "Looks good",
            "confidence": 0.8,
            "quality": {
                "overall_score": 0.8,
                "completeness": 0.8,
                "correctness": 0.8,
                "clarity": 0.8,
                "maintainability": 0.8,
                "actionability": 0.8,
                "relevance": 0.8,
                "issues": [],
                "errors": [],
                "improvement_suggestions": [],
            },
            "user_message": "Done",
        })
    ])
    reflector = WizardReflector(MockLLMAdapter(behavior=behavior))
    input_data = create_reflection_input()

    output = reflector.reflect(input_data)

    assert output.verdict == ReflectionVerdict.ACCEPT
    assert output.confidence > 0.5


def test_redo_on_excuse_making():
    behavior = MockLLMBehavior(responses=[
        json.dumps({
            "verdict": "accept",
            "reasoning": "Sure",
            "confidence": 0.5,
            "quality": {"overall_score": 0.6},
            "user_message": "OK",
        })
    ])
    reflector = WizardReflector(MockLLMAdapter(behavior=behavior))
    input_data = create_reflection_input(
        outcome_success=False,
        termination_reason="need_context_no_tools",
        final_response="Which framework should I use?",
    )

    output = reflector.reflect(input_data)

    assert output.verdict == ReflectionVerdict.REDO
    assert output.redo_modifications is not None


def test_clarification_requires_default():
    behavior = MockLLMBehavior(responses=[
        json.dumps({
            "verdict": "clarify_user",
            "reasoning": "Need info",
            "confidence": 0.6,
            "clarification": {
                "question": "What API key should I use?",
            },
        })
    ])
    reflector = WizardReflector(MockLLMAdapter(behavior=behavior))
    input_data = create_reflection_input(outcome_success=False)

    output = reflector.reflect(input_data)

    assert output.verdict == ReflectionVerdict.REDO


def test_scaffold_for_missing_tests():
    behavior = MockLLMBehavior(responses=[
        json.dumps({
            "verdict": "accept",
            "reasoning": "Works",
            "confidence": 0.7,
            "quality": {"overall_score": 0.7},
        })
    ])
    reflector = WizardReflector(MockLLMAdapter(behavior=behavior))
    input_data = create_reflection_input(
        outcome_success=True,
        final_response="def login(user, password): return True",
    )

    output = reflector.reflect(input_data)

    assert output.verdict == ReflectionVerdict.ACCEPT_AND_EXTEND
    assert any("test" in s.objective.lower() for s in output.scaffolded_steps)


def test_abort_after_max_retries():
    behavior = MockLLMBehavior(responses=[
        json.dumps({
            "verdict": "redo",
            "reasoning": "Try again",
            "confidence": 0.4,
            "quality": {"overall_score": 0.3},
        })
    ])
    reflector = WizardReflector(MockLLMAdapter(behavior=behavior))
    input_data = create_reflection_input(
        outcome_success=False,
        termination_reason="exception",
        attempt_count=3,
        final_response="",
    )

    output = reflector.reflect(input_data)

    assert output.verdict == ReflectionVerdict.ABORT_STEP
