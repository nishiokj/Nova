"""
Test step-centric execution architecture.

This test verifies that:
1. Steps are treated as units of work (not 1:1 with tool calls)
2. StepContext accumulates data across multiple tool calls within a step
3. Steps validate success criteria
4. Dependencies between steps are enforced
"""

import json
from harness.planner import (
    Plan, PlanStep, SuccessCriteria, StepContext, PlanStatus,
    ToolCallRecord, ValidationResult, Executor
)
from harness.llm_adapter import Message, MessageRole, LLMResponse, ToolCall
from harness.tool_registry import ToolResult, ToolStatus


def test_step_context_accumulation():
    """Test that StepContext accumulates multiple tool calls"""
    print("\n=== Test 1: StepContext Accumulation ===")

    context = StepContext()

    # Simulate multiple tool calls within one step
    for i in range(5):
        result = ToolResult(
            status=ToolStatus.SUCCESS,
            output=f"log_file_{i}.log content",
            error=None
        )
        record = ToolCallRecord(
            tool_name="read_file",
            arguments={"path": f"/logs/file_{i}.log"},
            result=result,
            duration_ms=50.0,
            timestamp=1234567890.0 + i
        )
        context.tool_calls_made.append(record)
        context.add_tool_result("read_file", result)

    # Verify accumulation
    assert len(context.tool_calls_made) == 5, "Should have 5 tool call records"
    assert "read_file_output" in context.accumulated_data, "Should accumulate outputs"
    assert len(context.accumulated_data["read_file_output"]) == 5, "Should have 5 outputs"

    print(f"✓ Accumulated {len(context.tool_calls_made)} tool calls in one step")
    print(f"✓ Context has {len(context.accumulated_data['read_file_output'])} items")


def test_step_boundaries():
    """Test that steps have clear boundaries"""
    print("\n=== Test 2: Step Boundaries ===")

    step1 = PlanStep(
        step_num=1,
        objective="Fetch 5 log files from /logs",
        success_criteria=SuccessCriteria(
            description="We have content for 5 log files",
            required_outputs=["log_files"],
            automated_checks={"min_items": 5}
        ),
        max_tool_calls=10
    )

    step2 = PlanStep(
        step_num=2,
        objective="Analyze logs for error patterns",
        depends_on=[1],  # Depends on step 1
        success_criteria=SuccessCriteria(
            description="We have identified 3 error categories",
            required_outputs=["error_patterns"],
            automated_checks={"min_items": 3}
        ),
        max_tool_calls=5
    )

    # Verify step structure
    assert step1.step_num == 1
    assert step2.depends_on == [1], "Step 2 should depend on step 1"
    assert step1.max_tool_calls == 10, "Each step has its own tool call limit"
    assert step2.max_tool_calls == 5

    print(f"✓ Step 1: {step1.objective}")
    print(f"  - Max tool calls: {step1.max_tool_calls}")
    print(f"  - Success criteria: {step1.success_criteria.description}")
    print(f"✓ Step 2: {step2.objective}")
    print(f"  - Depends on: Step {step2.depends_on}")
    print(f"  - Max tool calls: {step2.max_tool_calls}")


def test_validation():
    """Test step validation logic"""
    print("\n=== Test 3: Step Validation ===")

    # Create a step with success criteria
    step = PlanStep(
        step_num=1,
        objective="Collect data",
        success_criteria=SuccessCriteria(
            description="Must have at least 3 items",
            required_outputs=["data"],
            automated_checks={"min_items": 3}
        )
    )

    # Create context with insufficient data
    step.context = StepContext()
    step.context.accumulated_data = {
        "data": [1, 2]  # Only 2 items, need 3
    }

    # Create minimal executor just for validation
    from harness.llm_adapter import OpenAIAdapter
    from harness.tool_registry import ToolRegistry

    # Use mock objects
    class MockLLM:
        pass

    class MockRegistry:
        pass

    executor = Executor(MockLLM(), MockRegistry(), max_tool_calls=5)

    # Test validation failure
    validation = executor._validate_step(step)
    assert not validation.passed, "Should fail with insufficient data"
    print(f"✓ Validation correctly failed: {validation.details}")

    # Add more data
    step.context.accumulated_data["data"].append(3)

    # Test validation success
    validation = executor._validate_step(step)
    assert validation.passed, "Should pass with sufficient data"
    print(f"✓ Validation correctly passed: {validation.details}")


def test_dependency_checking():
    """Test step dependency enforcement"""
    print("\n=== Test 4: Dependency Checking ===")

    steps = [
        PlanStep(step_num=1, objective="Step 1", status=PlanStatus.PENDING),
        PlanStep(step_num=2, objective="Step 2", depends_on=[1], status=PlanStatus.PENDING),
        PlanStep(step_num=3, objective="Step 3", depends_on=[1, 2], status=PlanStatus.PENDING),
    ]

    # Mock executor
    class MockLLM:
        pass

    class MockRegistry:
        pass

    executor = Executor(MockLLM(), MockRegistry())

    # Test: Step 2 blocked when Step 1 pending
    assert not executor._dependencies_met(steps[1], steps), "Step 2 should be blocked"
    print("✓ Step 2 correctly blocked (Step 1 pending)")

    # Complete Step 1
    steps[0].status = PlanStatus.COMPLETED

    # Test: Step 2 unblocked when Step 1 complete
    assert executor._dependencies_met(steps[1], steps), "Step 2 should be unblocked"
    print("✓ Step 2 correctly unblocked (Step 1 completed)")

    # Test: Step 3 still blocked (needs both 1 and 2)
    assert not executor._dependencies_met(steps[2], steps), "Step 3 should be blocked"
    print("✓ Step 3 correctly blocked (needs Step 1 AND 2)")

    # Complete Step 2
    steps[1].status = PlanStatus.COMPLETED

    # Test: Step 3 unblocked
    assert executor._dependencies_met(steps[2], steps), "Step 3 should be unblocked"
    print("✓ Step 3 correctly unblocked (both Step 1 and 2 completed)")


def test_step_guidance():
    """Test step guidance generation"""
    print("\n=== Test 5: Step Guidance ===")

    step = PlanStep(
        step_num=2,
        objective="Read 5 log files",
        tool_hint="read_file",
        tool_args_hint={"path": "/logs/*.log"},
        success_criteria=SuccessCriteria(
            description="Have content for 5 files",
            required_outputs=["log_contents"]
        )
    )

    # Mock executor
    class MockLLM:
        pass

    class MockRegistry:
        pass

    executor = Executor(MockLLM(), MockRegistry())

    guidance = executor._create_step_guidance(step)

    # Verify guidance contains key elements
    assert "Step 2" in guidance
    assert step.objective in guidance
    assert step.success_criteria.description in guidance
    assert step.tool_hint in guidance
    assert "Focus ONLY on completing this step" in guidance

    print("✓ Step guidance generated:")
    print(guidance[:200] + "...")


def test_plan_structure():
    """Test complete plan with multiple steps"""
    print("\n=== Test 6: Complete Plan Structure ===")

    plan = Plan(
        goal="Analyze last 5 log files for errors",
        goal_type="task",
        steps=[
            PlanStep(
                step_num=1,
                objective="List log files in /logs directory",
                tool_hint="list_directory",
                success_criteria=SuccessCriteria(
                    description="Have list of log files",
                    required_outputs=["file_list"]
                ),
                max_tool_calls=2
            ),
            PlanStep(
                step_num=2,
                objective="Read content of last 5 log files",
                depends_on=[1],
                tool_hint="read_file",
                success_criteria=SuccessCriteria(
                    description="Have content for 5 files",
                    required_outputs=["log_contents"],
                    automated_checks={"min_items": 5}
                ),
                max_tool_calls=10  # list + 5 reads = 6, allow buffer
            ),
            PlanStep(
                step_num=3,
                objective="Identify top 3 error patterns",
                depends_on=[2],
                success_criteria=SuccessCriteria(
                    description="Have 3 error categories",
                    required_outputs=["error_patterns"],
                    automated_checks={"min_items": 3}
                ),
                max_tool_calls=5
            ),
        ],
        success_criteria=SuccessCriteria(
            description="User has error analysis report"
        ),
        estimated_complexity="standard",
        requires_tools=True,
        reasoning="Multi-step plan: list → read → analyze"
    )

    # Verify plan structure
    assert len(plan.steps) == 3, "Should have 3 steps"
    assert plan.steps[0].depends_on == [], "Step 1 has no dependencies"
    assert plan.steps[1].depends_on == [1], "Step 2 depends on 1"
    assert plan.steps[2].depends_on == [2], "Step 3 depends on 2"

    print(f"✓ Plan: {plan.goal}")
    print(f"  Complexity: {plan.estimated_complexity}")
    print(f"  Steps: {len(plan.steps)}")
    for step in plan.steps:
        deps = f"(depends on {step.depends_on})" if step.depends_on else ""
        print(f"    {step.step_num}. {step.objective} {deps}")
        print(f"       Max tool calls: {step.max_tool_calls}")


if __name__ == "__main__":
    print("=" * 60)
    print("STEP-CENTRIC EXECUTION ARCHITECTURE TEST")
    print("=" * 60)

    try:
        test_step_context_accumulation()
        test_step_boundaries()
        test_validation()
        test_dependency_checking()
        test_step_guidance()
        test_plan_structure()

        print("\n" + "=" * 60)
        print("✓ ALL TESTS PASSED")
        print("=" * 60)
        print("\nKey improvements verified:")
        print("  1. Steps accumulate multiple tool calls (not 1:1 mapping)")
        print("  2. Steps have clear boundaries with max_tool_calls limits")
        print("  3. Step validation checks success criteria")
        print("  4. Dependencies between steps are enforced")
        print("  5. Step guidance helps LLM focus on one sub-goal")
        print("  6. Plans can express complex multi-step workflows")

    except AssertionError as e:
        print(f"\n✗ TEST FAILED: {e}")
        raise
    except Exception as e:
        print(f"\n✗ ERROR: {e}")
        raise
