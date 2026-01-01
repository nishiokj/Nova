import json

from harness.agent.tool_registry import ToolRegistry
from harness.agent.wizard.types import GoalType, WizardPlan, WizardStep
from harness.agent.wizard.wizard import Wizard, WizardConfig
from harness.agent.wizard.worker import WorkerOutcome, WorkerMetrics
from harness.agent.wizard.reflection_types import ClarificationResponse
from tests.test_helpers import MockLLMAdapter, MockLLMBehavior


class StubWorker:
    def __init__(self, outcomes):
        self._outcomes = outcomes
        self._index = 0

    def execute(self, _context, work_item, plan_version, _cache_params, read_files=None):
        outcome = self._outcomes[self._index]
        self._index += 1
        outcome.step_num = work_item.step_num
        outcome.base_version = plan_version
        return outcome


class CapturingClarificationHandler:
    def __init__(self):
        self.request = None

    def request_clarification(self, request):
        self.request = request


def _success_outcome(response: str) -> WorkerOutcome:
    return WorkerOutcome(
        work_id="work",
        step_num=0,
        base_version=1,
        success=True,
        final_response=response,
        metrics=WorkerMetrics(tool_calls_made=0, llm_calls_made=0),
    )


def _failure_outcome(error: str, termination_reason: str) -> WorkerOutcome:
    return WorkerOutcome(
        work_id="work",
        step_num=0,
        base_version=1,
        success=False,
        error=error,
        termination_reason=termination_reason,
        metrics=WorkerMetrics(tool_calls_made=0, llm_calls_made=0),
    )


def test_full_orchestration_with_reflection():
    behavior = MockLLMBehavior(responses=[
        json.dumps({
            "verdict": "accept",
            "reasoning": "ok",
            "confidence": 0.8,
            "quality": {"overall_score": 0.8},
        }),
        json.dumps({
            "verdict": "accept",
            "reasoning": "ok",
            "confidence": 0.8,
            "quality": {"overall_score": 0.8},
        }),
    ])
    llm = MockLLMAdapter(behavior=behavior)
    wizard = Wizard(ToolRegistry(), llm, config=WizardConfig(max_iterations=5))
    wizard._worker = StubWorker([
        _success_outcome("Step one completed successfully."),
        _success_outcome("Step two completed successfully."),
    ])

    plan = WizardPlan(
        goal="Test plan",
        goal_type=GoalType.TASK,
        steps=[
            WizardStep(step_num=1, objective="Step 1"),
            WizardStep(step_num=2, objective="Step 2"),
        ],
    )

    result = wizard.orchestrate(plan=plan, user_input="Run test")

    assert result.success
    assert result.steps_completed == 2
    assert result.final_response


def test_clarification_flow():
    behavior = MockLLMBehavior(responses=[
        json.dumps({
            "verdict": "clarify_user",
            "reasoning": "Need input",
            "confidence": 0.6,
            "quality": {"overall_score": 0.7},
            "clarification": {
                "question": "Which database should be used?",
                "options": ["PostgreSQL", "SQLite"],
                "default_assumption": "PostgreSQL",
                "urgency": "medium",
            },
        }),
        json.dumps({
            "verdict": "accept",
            "reasoning": "ok",
            "confidence": 0.8,
            "quality": {"overall_score": 0.8},
        }),
    ])
    llm = MockLLMAdapter(behavior=behavior)
    wizard = Wizard(ToolRegistry(), llm, config=WizardConfig(max_iterations=5))
    wizard._worker = StubWorker([
        _failure_outcome("Need DB choice", "user_input"),
        _success_outcome("Configured database successfully."),
    ])

    plan = WizardPlan(
        goal="DB setup",
        goal_type=GoalType.TASK,
        steps=[WizardStep(step_num=1, objective="Configure database")],
    )

    handler = CapturingClarificationHandler()
    result = wizard.orchestrate(
        plan=plan,
        user_input="Set up database",
        clarification_handler=handler,
    )

    assert handler.request is not None
    assert result.paused
    assert not result.success

    wizard.receive_clarification_response(
        ClarificationResponse(
            request_id=handler.request.request_id,
            step_num=handler.request.step_num,
            selected_option="PostgreSQL",
        )
    )
    resumed = wizard.resume()
    assert resumed.success


def test_scaffolding_integration():
    behavior = MockLLMBehavior(responses=[
        json.dumps({
            "verdict": "accept",
            "reasoning": "ok",
            "confidence": 0.7,
            "quality": {"overall_score": 0.7},
        }),
        json.dumps({
            "verdict": "accept",
            "reasoning": "ok",
            "confidence": 0.7,
            "quality": {"overall_score": 0.7},
        }),
    ])
    llm = MockLLMAdapter(behavior=behavior)
    wizard = Wizard(ToolRegistry(), llm, config=WizardConfig(max_iterations=5))
    wizard._worker = StubWorker([
        _success_outcome("def calculate_tax(amount): return amount * 0.2"),
        _success_outcome("Added tests for calculate_tax."),
    ])

    plan = WizardPlan(
        goal="Add tax function",
        goal_type=GoalType.TASK,
        steps=[WizardStep(step_num=1, objective="Implement calculate_tax")],
    )

    result = wizard.orchestrate(plan=plan, user_input="Create tax function")

    assert result.steps_completed >= 2
