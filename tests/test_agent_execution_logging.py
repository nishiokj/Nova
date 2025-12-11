#!/usr/bin/env python3
"""
Test agent execution logging functionality.
Verifies that agent_execution.jsonl is created with proper structure.
"""

import json
import sys
from pathlib import Path


def test_agent_execution_logger():
    """Test agent execution logger instantiation and structure"""
    print("Testing agent execution logger...")

    try:
        from harness.agent_execution_logger import AgentExecutionLogger

        logger = AgentExecutionLogger(log_dir="logs_test")

        # Generate test execution ID
        req_id = "test-req-001"
        exec_id = logger.new_execution_id(req_id)

        print(f"  ✅ Created exec_id: {exec_id}")

        # Test log_agent_context
        logger.log_agent_context(
            req_id=req_id,
            exec_id=exec_id,
            user_input="Test query",
            tier="standard",
            system_prompt="You are a test assistant",
            conversation_history=[],
            tool_definitions=[
                {"name": "test_tool", "description": "A test tool"}
            ],
            additional_context={"test": "context"}
        )
        print("  ✅ Logged agent context")

        # Test log_planning_result
        logger.log_planning_result(
            req_id=req_id,
            exec_id=exec_id,
            goal="Answer test query",
            goal_type="question",
            requires_tools=False,
            steps=[
                {
                    "step_num": 1,
                    "objective": "Answer from knowledge",
                    "tool_hint": None,
                    "tool_args_hint": None,
                    "success_criteria": "Accurate answer",
                    "depends_on": [],
                    "status": "pending"
                }
            ],
            success_criteria="Query answered accurately",
            estimated_complexity="simple",
            reasoning="Direct knowledge retrieval"
        )
        print("  ✅ Logged planning result")

        # Test log_execution_context
        logger.log_execution_context(
            req_id=req_id,
            exec_id=exec_id,
            step_id="step-1",
            step_num=1,
            step_objective="Answer from knowledge",
            tool_hint=None,
            messages=[
                {"role": "system", "content": "You are a test assistant"},
                {"role": "user", "content": "Test query"}
            ],
            available_tools=[]
        )
        print("  ✅ Logged execution context")

        # Test log_execution_step (success)
        logger.log_execution_step(
            req_id=req_id,
            exec_id=exec_id,
            step_id="step-1",
            step_num=1,
            status="completed",
            step_objective="Answer from knowledge",
            tool_used=None,
            tool_result="Test answer",
            duration_ms=123.45
        )
        print("  ✅ Logged execution step (success)")

        # Test log_execution_step (failure)
        logger.log_execution_step(
            req_id=req_id,
            exec_id=exec_id,
            step_id="step-2",
            step_num=2,
            status="failed",
            step_objective="Test tool execution",
            tool_used="test_tool",
            error="Tool not found",
            failure_mode="tool_disabled",
            substeps_failed=["Initialize tool"],
            duration_ms=50.0
        )
        print("  ✅ Logged execution step (failure)")

        # Verify log file was created
        log_file = Path("logs_test/agent_execution.jsonl")
        if not log_file.exists():
            print(f"  ❌ FAILED: Log file not created at {log_file}")
            return False

        print(f"  ✅ Log file created: {log_file}")

        # Read and validate log entries
        with open(log_file, 'r') as f:
            lines = f.readlines()

        if len(lines) < 5:
            print(f"  ❌ FAILED: Expected at least 5 log entries, got {len(lines)}")
            return False

        print(f"  ✅ Found {len(lines)} log entries")

        # Validate each entry is valid JSON
        for i, line in enumerate(lines):
            try:
                entry = json.loads(line)
                required_fields = ["ts", "lvl", "svc", "req_id", "exec_id"]
                for field in required_fields:
                    if field not in entry:
                        print(f"  ❌ FAILED: Entry {i+1} missing field '{field}'")
                        return False
            except json.JSONDecodeError as e:
                print(f"  ❌ FAILED: Entry {i+1} is not valid JSON: {e}")
                return False

        print("  ✅ All entries have required fields")

        # Validate service names
        expected_services = ["agent_context", "planning", "execution_context", "execution_step", "execution_step"]
        for i, (line, expected_svc) in enumerate(zip(lines, expected_services)):
            entry = json.loads(line)
            if entry["svc"] != expected_svc:
                print(f"  ❌ FAILED: Entry {i+1} has svc='{entry['svc']}', expected '{expected_svc}'")
                return False

        print("  ✅ All service names correct")

        # Validate structure of specific entries
        context_entry = json.loads(lines[0])
        if "context" not in context_entry or "request" not in context_entry:
            print("  ❌ FAILED: Context entry missing 'context' or 'request' fields")
            return False

        planning_entry = json.loads(lines[1])
        if "plan" not in planning_entry or "steps" not in planning_entry["plan"]:
            print("  ❌ FAILED: Planning entry missing 'plan' or 'steps' fields")
            return False

        exec_context_entry = json.loads(lines[2])
        if "step_id" not in exec_context_entry or "context" not in exec_context_entry:
            print("  ❌ FAILED: Execution context entry missing fields")
            return False

        exec_step_entry = json.loads(lines[3])
        if "step_id" not in exec_step_entry or "status" not in exec_step_entry:
            print("  ❌ FAILED: Execution step entry missing fields")
            return False

        print("  ✅ Entry structures validated")

        # Clean up test log directory
        import shutil
        shutil.rmtree("logs_test")
        print("  ✅ Cleaned up test logs")

        print("  ✅ PASSED: Agent execution logger")
        return True

    except Exception as e:
        print(f"  ❌ FAILED: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    print("=" * 60)
    print("AGENT EXECUTION LOGGING TEST")
    print("=" * 60)
    print()

    result = test_agent_execution_logger()

    print()
    print("=" * 60)
    if result:
        print("TEST PASSED! ✅")
        print("Agent execution logging is working correctly")
        return 0
    else:
        print("TEST FAILED! ❌")
        return 1


if __name__ == "__main__":
    sys.exit(main())
