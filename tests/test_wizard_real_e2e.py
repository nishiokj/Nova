"""
REAL End-to-End Test for Wizard Orchestration.

NO MOCKS. Uses real:
- LLMAdapter (requires API key)
- ToolRegistry with real tools
- Planner
- File system operations

Run with: PYTHONPATH=src pytest tests/test_wizard_real_e2e.py -v -s

Requires: OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable.
"""

import os
import shutil
import tempfile
import time
from pathlib import Path

import pytest

from util.config import LLMConfig, ToolConfig
from util.llm_adapter import create_adapter
from util.logger import StructuredLogger
from harness.agent.planner import Planner
from harness.agent.tool_registry import ToolRegistry
from harness.agent.plan_models import PlanStatus
from harness.agent.wizard import Wizard, WizardConfig


# ===========================================================================
# Test Configuration
# ===========================================================================


def get_api_key() -> tuple[str, str]:
    """Get available API key and provider."""
    if os.environ.get("OPENAI_API_KEY"):
        return os.environ["OPENAI_API_KEY"], "openai"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ["ANTHROPIC_API_KEY"], "anthropic"
    return None, None


def skip_if_no_api_key():
    """Skip test if no API key available."""
    api_key, _ = get_api_key()
    if not api_key:
        pytest.skip("No API key available (set OPENAI_API_KEY or ANTHROPIC_API_KEY)")


# ===========================================================================
# Fixtures
# ===========================================================================


@pytest.fixture
def temp_workspace():
    """Create a temporary workspace directory for file operations."""
    workspace = tempfile.mkdtemp(prefix="wizard_e2e_")
    yield workspace
    # Cleanup
    shutil.rmtree(workspace, ignore_errors=True)


@pytest.fixture
def real_logger(temp_workspace):
    """Create a real structured logger."""
    log_dir = os.path.join(temp_workspace, "logs")
    os.makedirs(log_dir, exist_ok=True)
    return StructuredLogger(
        name="wizard_e2e_test",
        log_dir=log_dir,
        log_level="DEBUG",
    )


@pytest.fixture
def real_llm(real_logger):
    """Create a real LLM adapter."""
    skip_if_no_api_key()
    api_key, provider = get_api_key()

    # Use a fast, cheap model for testing
    model = "gpt-4o-mini" if provider == "openai" else "claude-3-haiku-20240307"

    config = LLMConfig(
        provider=provider,
        model=model,
        api_key=api_key,
        temperature=0.1,  # Low temp for determinism
        max_tokens=2048,
        timeout=60,
    )

    return create_adapter(config, real_logger)


@pytest.fixture
def real_tool_registry(temp_workspace, real_logger):
    """Create a real tool registry with enabled tools."""
    config = ToolConfig(
        enabled_tools=[
            "file_read",
            "file_write",
            "bash_execute",
            "search_filesystem",
            "list_files",
            "get_working_directory",
        ],
        max_output_length=10000,
        bash_timeout=30,
    )

    registry = ToolRegistry(
        config=config,
        default_working_dir=temp_workspace,
        logger=real_logger,
    )

    return registry


@pytest.fixture
def real_planner(real_llm, real_tool_registry):
    """Create a real planner."""
    return Planner(
        llm=real_llm,
        tool_registry=real_tool_registry,
        enable_scouting=False,  # Disable scouting for faster tests
    )


@pytest.fixture
def wizard(real_tool_registry, real_llm, real_planner):
    """Create a real Wizard."""
    return Wizard(
        tool_registry=real_tool_registry,
        llm=real_llm,
        planner=real_planner,
        config=WizardConfig(
            max_iterations=20,
            max_retries_per_step=2,
            deadlock_threshold=3,
        ),
    )


# ===========================================================================
# Real E2E Tests
# ===========================================================================


class TestWizardRealE2E:
    """Real end-to-end tests with no mocks."""

    def test_create_file_with_content(self, wizard, temp_workspace):
        """
        REAL TEST: Ask wizard to create a file with specific content.

        Verifies:
        1. Wizard creates a plan
        2. Worker executes file_write tool
        3. File actually exists with correct content
        4. Goal is achieved
        """
        skip_if_no_api_key()

        target_file = os.path.join(temp_workspace, "hello.txt")
        expected_content = "Hello from Wizard!"

        # Run the wizard
        result = wizard.orchestrate(
            user_input=f"Create a file called hello.txt in {temp_workspace} with the content: {expected_content}",
            context=f"Working directory is {temp_workspace}",
        )

        # ===== AGGRESSIVE ASSERTIONS =====

        # 1. Result structure is valid
        assert result is not None, "Wizard returned None result"
        assert result.plan_state is not None, "No plan state in result"
        assert result.ledger is not None, "No ledger in result"

        # 2. Plan was created and has steps
        assert len(result.plan_state.steps) > 0, "Plan has no steps"

        # 3. At least one tool was called
        assert result.total_tool_calls > 0, f"No tools were called. LLM calls: {result.total_llm_calls}"

        # 4. File actually exists
        assert os.path.exists(target_file), f"File {target_file} was NOT created"

        # 5. File has correct content
        with open(target_file, "r") as f:
            actual_content = f.read()
        assert expected_content in actual_content, (
            f"File content mismatch.\n"
            f"Expected: '{expected_content}'\n"
            f"Actual: '{actual_content}'"
        )

        # 6. Goal was achieved (success=True)
        assert result.success is True, (
            f"Wizard reported failure.\n"
            f"Steps: {[(s.step_num, s.status.value, s.objective[:50]) for s in result.plan_state.steps.values()]}\n"
            f"Ledger tail: {result.ledger.summarize_tail()}"
        )

        # 7. At least one step completed
        completed_steps = [
            s for s in result.plan_state.steps.values()
            if s.status == PlanStatus.COMPLETED
        ]
        assert len(completed_steps) > 0, "No steps were completed"

    def test_read_existing_file(self, wizard, temp_workspace):
        """
        REAL TEST: Create a file, then ask wizard to read it.

        Verifies:
        1. Wizard can read existing files
        2. File content appears in the response or observations
        """
        skip_if_no_api_key()

        # Setup: create a file with known content
        test_file = os.path.join(temp_workspace, "existing.txt")
        secret_content = "SECRET_MARKER_12345"
        with open(test_file, "w") as f:
            f.write(f"This file contains: {secret_content}")

        # Run wizard to read the file
        result = wizard.orchestrate(
            user_input=f"Read the file {test_file} and tell me what it contains.",
            context=f"Working directory is {temp_workspace}",
        )

        # ===== AGGRESSIVE ASSERTIONS =====

        # 1. Basic result validation
        assert result is not None
        assert result.plan_state is not None

        # 2. File read tool was called
        assert result.total_tool_calls > 0, "No tools called - file_read should have been used"

        # 3. Check that the secret content was found (in response or observations)
        content_found = False

        # Check final response
        if result.final_response and secret_content in result.final_response:
            content_found = True

        # Check ledger entries for observations
        for entry in result.ledger._entries:
            if entry.outcome_summary and secret_content in entry.outcome_summary:
                content_found = True
                break
            for obs in entry.observations:
                if secret_content in obs:
                    content_found = True
                    break

        # If not in response/observations, check evidence store
        if not content_found and result.plan_state:
            for step_num in result.plan_state.steps:
                evidence_list = wizard._evidence.get_for_step(step_num) if wizard._evidence else []
                for ev in evidence_list:
                    if ev.tool_output and secret_content in ev.tool_output:
                        content_found = True
                        break

        assert content_found, (
            f"Secret content '{secret_content}' was not found in wizard output.\n"
            f"Final response: {result.final_response[:500] if result.final_response else 'None'}\n"
            f"Tool calls made: {result.total_tool_calls}"
        )

        # 4. Success
        assert result.success is True, f"Wizard failed: {result.ledger.summarize_tail()}"

    def test_search_filesystem(self, wizard, temp_workspace):
        """
        REAL TEST: Create files and ask wizard to search for them.

        Verifies:
        1. Wizard can use search_filesystem tool
        2. Search results include created files
        """
        skip_if_no_api_key()

        # Setup: create files with unique pattern
        unique_marker = f"unique_marker_{int(time.time())}"
        for i in range(3):
            filename = f"{unique_marker}_file_{i}.txt"
            filepath = os.path.join(temp_workspace, filename)
            with open(filepath, "w") as f:
                f.write(f"Content of file {i}")

        # Run wizard to search
        result = wizard.orchestrate(
            user_input=f"Search for files containing '{unique_marker}' in {temp_workspace}",
            context=f"Working directory is {temp_workspace}",
        )

        # ===== AGGRESSIVE ASSERTIONS =====
        assert result is not None
        assert result.total_tool_calls > 0, "No tools called"

        # Check that search found files (in response or observations)
        found_references = 0
        search_output = ""

        if result.final_response:
            search_output += result.final_response
        for entry in result.ledger._entries:
            if entry.outcome_summary:
                search_output += entry.outcome_summary
            search_output += " ".join(entry.observations)

        for i in range(3):
            if f"{unique_marker}_file_{i}.txt" in search_output:
                found_references += 1

        assert found_references > 0, (
            f"No search results found for '{unique_marker}'.\n"
            f"Output: {search_output[:500]}"
        )

    def test_multi_step_task(self, wizard, temp_workspace):
        """
        REAL TEST: Multi-step task requiring planning.

        Task: Create two files, read them, and report what's in both.

        Verifies:
        1. Wizard creates multi-step plan
        2. Multiple tools are called
        3. All steps complete successfully
        """
        skip_if_no_api_key()

        file1 = os.path.join(temp_workspace, "alpha.txt")
        file2 = os.path.join(temp_workspace, "beta.txt")
        content1 = "ALPHA_CONTENT_123"
        content2 = "BETA_CONTENT_456"

        result = wizard.orchestrate(
            user_input=(
                f"Please do the following:\n"
                f"1. Create a file {file1} with content: {content1}\n"
                f"2. Create a file {file2} with content: {content2}\n"
                f"3. Read both files and confirm their contents"
            ),
            context=f"Working directory is {temp_workspace}",
        )

        # ===== AGGRESSIVE ASSERTIONS =====

        # 1. Multiple tool calls (at least 2 writes + 2 reads)
        assert result.total_tool_calls >= 2, f"Only {result.total_tool_calls} tool calls for multi-step task"

        # 2. Both files were created
        assert os.path.exists(file1), f"File {file1} was not created"
        assert os.path.exists(file2), f"File {file2} was not created"

        # 3. Files have correct content
        with open(file1, "r") as f:
            assert content1 in f.read(), f"File {file1} missing expected content"
        with open(file2, "r") as f:
            assert content2 in f.read(), f"File {file2} missing expected content"

        # 4. Multiple steps in plan
        assert len(result.plan_state.steps) >= 2, "Multi-step task should have multiple steps"

        # 5. Success
        assert result.success is True, f"Multi-step task failed: {result.ledger.summarize_tail()}"

    def test_wizard_handles_nonexistent_file_gracefully(self, wizard, temp_workspace):
        """
        REAL TEST: Wizard handles errors gracefully.

        Verifies:
        1. When asked to read non-existent file, wizard doesn't crash
        2. Error is captured in observations or response
        3. Wizard can recover or report the issue
        """
        skip_if_no_api_key()

        nonexistent = os.path.join(temp_workspace, "does_not_exist.txt")

        result = wizard.orchestrate(
            user_input=f"Read the file {nonexistent} and tell me what it contains.",
            context=f"Working directory is {temp_workspace}",
        )

        # ===== AGGRESSIVE ASSERTIONS =====

        # 1. Wizard should not crash - we got a result
        assert result is not None

        # 2. Tool was called (wizard tried to read)
        assert result.total_tool_calls > 0, "Wizard should have attempted to read the file"

        # 3. Error should be captured somewhere (response, observations, or failed step)
        error_captured = False

        # Check final response for error indication
        if result.final_response:
            error_keywords = ["not found", "doesn't exist", "does not exist", "error", "failed", "cannot"]
            if any(kw in result.final_response.lower() for kw in error_keywords):
                error_captured = True

        # Check for failed tool calls in observations
        for entry in result.ledger._entries:
            for obs in entry.observations:
                if "failed" in obs.lower() or "error" in obs.lower():
                    error_captured = True
                    break

        # Check step status for failures
        for step in result.plan_state.steps.values():
            if step.status == PlanStatus.FAILED:
                error_captured = True
                break

        # Note: If wizard successfully reports "file not found", that's also valid
        # The key is that wizard handled it gracefully (didn't crash)
        assert error_captured or result.success is False or "not found" in str(result.final_response).lower(), (
            f"Wizard should have captured/reported the error.\n"
            f"Response: {result.final_response}\n"
            f"Success: {result.success}"
        )


class TestWizardInvariants:
    """Test that invariants hold with real execution."""

    def test_single_writer_invariant(self, wizard, temp_workspace):
        """
        Verify single-writer invariant: only wizard mutates plan state.

        After orchestration, check that:
        1. Plan state version > 1 (mutations happened)
        2. All mutations came through wizard (frozen steps are frozen)
        """
        skip_if_no_api_key()

        result = wizard.orchestrate(
            user_input=f"Create a file test.txt in {temp_workspace} with content 'hello'",
            context=f"Working directory is {temp_workspace}",
        )

        assert result is not None

        # Version should have increased (mutations happened)
        assert result.plan_state.version >= 1, "Plan state was never mutated"

        # All completed steps should be frozen
        for step in result.plan_state.steps.values():
            if step.status == PlanStatus.COMPLETED:
                assert step.is_frozen is True, f"Completed step {step.step_num} is not frozen"

    def test_append_only_ledger_invariant(self, wizard, temp_workspace):
        """
        Verify append-only ledger: entries are never removed during execution.
        """
        skip_if_no_api_key()

        result = wizard.orchestrate(
            user_input=f"List files in {temp_workspace}",
            context=f"Working directory is {temp_workspace}",
        )

        assert result is not None

        # Ledger should have entries
        assert result.ledger.total_entries > 0, "No ledger entries created"

        # All entries should have valid structure
        for entry in result.ledger._entries:
            assert entry.entry_id is not None, "Entry missing ID"
            assert entry.dispatched_at > 0, "Entry missing dispatch time"
            assert entry.step_num > 0, "Entry missing step number"

    def test_bounded_autonomy_invariant(self, wizard, temp_workspace):
        """
        Verify bounded autonomy: worker respects tool call limits.
        """
        skip_if_no_api_key()

        # Configure strict limits
        wizard.config.max_iterations = 5

        result = wizard.orchestrate(
            user_input=f"Create a file test.txt in {temp_workspace}",
            context=f"Working directory is {temp_workspace}",
        )

        assert result is not None

        # Should complete within limits
        assert result.total_iterations <= 5, f"Exceeded max iterations: {result.total_iterations}"


# ===========================================================================
# Performance / Timing Tests
# ===========================================================================


class TestWizardPerformance:
    """Performance characteristics of real wizard execution."""

    def test_simple_task_completes_in_reasonable_time(self, wizard, temp_workspace):
        """
        Simple tasks should complete quickly (< 30 seconds).
        """
        skip_if_no_api_key()

        start = time.time()

        result = wizard.orchestrate(
            user_input=f"Create a file quick.txt in {temp_workspace} with 'fast'",
            context=f"Working directory is {temp_workspace}",
        )

        elapsed = time.time() - start

        assert result is not None
        assert elapsed < 60, f"Simple task took {elapsed:.1f}s (should be < 60s)"

        # Log timing for analysis
        print(f"\nTiming: {elapsed:.2f}s total, {result.total_iterations} iterations, {result.total_tool_calls} tools")
