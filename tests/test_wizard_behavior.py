import json

from harness.agent.tool_registry import ToolRegistry
from harness.agent.wizard.types import GoalType, WizardPlan, WizardStep
from harness.agent.wizard.wizard import Wizard, WizardConfig
from harness.agent.wizard.worker import WorkerOutcome, WorkerMetrics
from tests.test_helpers import MockLLMAdapter, MockLLMBehavior


class StubWorker:
    def __init__(self, outcome):
        self._outcome = outcome
        self._called = False

    def execute(self, _context, work_item, plan_version, _cache_params, read_files=None):
        if self._called:
            return self._outcome
        self._called = True
        self._outcome.step_num = work_item.step_num
        self._outcome.base_version = plan_version
        return self._outcome


def test_no_silent_failures():
    behavior = MockLLMBehavior(responses=[
        json.dumps({
            "verdict": "abort_step",
            "reasoning": "Not achievable",
            "confidence": 0.4,
            "abort_reason": "Failed repeatedly",
        })
    ])
    llm = MockLLMAdapter(behavior=behavior)
    wizard = Wizard(ToolRegistry(), llm, config=WizardConfig(max_iterations=3))
    wizard._worker = StubWorker(WorkerOutcome(
        work_id="work",
        step_num=0,
        base_version=1,
        success=False,
        error="Failure",
        termination_reason="exception",
        metrics=WorkerMetrics(tool_calls_made=0, llm_calls_made=0),
    ))

    plan = WizardPlan(
        goal="Failing plan",
        goal_type=GoalType.TASK,
        steps=[WizardStep(step_num=1, objective="Do impossible thing")],
    )

    result = wizard.orchestrate(plan=plan, user_input="Run failing plan")

    assert result.final_response
    assert "Completed processing:" not in result.final_response
