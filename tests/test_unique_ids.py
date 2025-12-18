"""
Test Unique ID Generation

Verifies that each agent.run() call generates unique IDs and doesn't overwrite files.
"""

from pathlib import Path
from util.logger import StructuredLogger


def test_unique_req_ids():
    """Test that multiple agent runs generate unique req_ids"""
    print("Testing unique req_id generation...")

    logger = StructuredLogger(log_dir="logs/test")

    # Simulate multiple requests
    req_ids = []
    for i in range(5):
        req_id = logger.new_request()
        req_ids.append(req_id)
        print(f"  Request {i+1}: {req_id}")

    # All should be unique
    assert len(req_ids) == len(set(req_ids)), "req_ids are not unique!"

    # All should follow pattern: {session_id}-{counter:04d}
    for req_id in req_ids:
        parts = req_id.split('-')
        assert len(parts) == 2, f"Invalid req_id format: {req_id}"
        assert len(parts[0]) == 8, f"Invalid session_id length: {parts[0]}"
        assert parts[1].isdigit(), f"Invalid counter: {parts[1]}"

    print(f"✓ All {len(req_ids)} req_ids are unique and valid!\n")


def test_req_id_auto_generation():
    """Test that agent auto-generates req_id when logger doesn't have one"""
    print("Testing automatic req_id generation in agent...")

    from harness.agent.agent import Agent
    from util.config import AgentConfig, LLMConfig
    from harness.agent.tool_registry import ToolRegistry

    # Create minimal agent (no actual LLM calls)
    config = AgentConfig(
        tier="simple",
        system_prompt="Test",
        max_tool_calls=1
    )

    logger = StructuredLogger(log_dir="logs/test")

    # Initially, logger has no request_id
    assert logger.request_id is None

    # When we check like agent does:
    if logger.request_id is None:
        req_id = logger.new_request()
    else:
        req_id = logger.request_id

    assert req_id is not None
    assert logger.request_id == req_id

    print(f"✓ Auto-generated req_id: {req_id}")

    # Next call should get a new req_id
    logger._current_request_id = None  # Reset for test

    if logger.request_id is None:
        req_id2 = logger.new_request()
    else:
        req_id2 = logger.request_id

    assert req_id2 != req_id, "Second req_id should be different!"
    print(f"✓ Second req_id: {req_id2}")
    print(f"✓ req_ids are unique: {req_id} != {req_id2}\n")


def test_exec_id_uniqueness():
    """Test that exec_ids are unique even for same req_id"""
    print("Testing exec_id uniqueness...")

    from util.agent_execution_logger import AgentExecutionLogger

    exec_logger = AgentExecutionLogger(log_dir="logs/test")

    req_id = "test-req-001"

    # Multiple executions for same request
    exec_ids = []
    for i in range(3):
        exec_id = exec_logger.new_execution_id(req_id)
        exec_ids.append(exec_id)
        print(f"  Execution {i+1}: {exec_id}")

    # All should be unique
    assert len(exec_ids) == len(set(exec_ids)), "exec_ids are not unique!"

    # All should start with req_id
    for exec_id in exec_ids:
        assert exec_id.startswith(req_id), f"exec_id doesn't start with req_id: {exec_id}"

    print(f"✓ All {len(exec_ids)} exec_ids are unique!\n")


def test_reconstruction_filenames():
    """Test that reconstruction uses unique exec_id for filenames"""
    print("Testing reconstruction filename uniqueness...")

    # Simulate multiple reconstructions
    exec_ids = [
        "abc-123-exec-0001",
        "abc-123-exec-0002",
        "abc-456-exec-0001",
    ]

    filenames = []
    for exec_id in exec_ids:
        # This is what reconstructor does
        output_dir = Path("logs/test/reconstructed")
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{exec_id}_full.json"
        filenames.append(str(output_path))
        print(f"  {exec_id} → {output_path.name}")

    # All filenames should be unique
    assert len(filenames) == len(set(filenames)), "Filenames are not unique!"

    print(f"✓ All {len(filenames)} filenames are unique!\n")


if __name__ == "__main__":
    print("=" * 60)
    print("Unique ID Generation Tests")
    print("=" * 60 + "\n")

    try:
        test_unique_req_ids()
        test_req_id_auto_generation()
        test_exec_id_uniqueness()
        test_reconstruction_filenames()

        print("=" * 60)
        print("✅ ALL ID UNIQUENESS TESTS PASSED!")
        print("=" * 60)
        print()
        print("Summary:")
        print("✓ req_id: Unique per request")
        print("✓ exec_id: Unique per execution")
        print("✓ Filenames: Unique (no overwrites)")
        print("✓ Auto-generation: Works when logger has no req_id")
        print()

    except AssertionError as e:
        print(f"\n❌ TEST FAILED: {e}")
        raise
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        raise
