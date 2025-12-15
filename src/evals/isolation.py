"""
Test isolation utilities for running eval tasks independently.

Provides context manager for isolated execution environments and
task executor with timeout handling.
"""

import os
import tempfile
import shutil
import signal
import logging
from pathlib import Path
from typing import Callable, Optional, Dict, Any
from contextlib import contextmanager
from dataclasses import dataclass

from evals.eval_task import EvalTask, EvalResult, create_error_result


logger = logging.getLogger(__name__)


class TimeoutError(Exception):
    """Raised when a task execution times out."""
    pass


def timeout_handler(signum, frame):
    """Signal handler for timeout."""
    raise TimeoutError("Task execution timed out")


@contextmanager
def timeout(seconds: int):
    """
    Context manager for enforcing execution timeout.

    Args:
        seconds: Maximum execution time

    Raises:
        TimeoutError: If execution exceeds timeout
    """
    # Set up signal handler
    old_handler = signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(seconds)

    try:
        yield
    finally:
        # Cancel alarm and restore old handler
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)


class IsolatedEnvironment:
    """
    Context manager for isolated task execution.

    Creates temporary directory, sets up files and environment variables,
    and cleans up afterward to ensure task independence.
    """

    def __init__(self, task: EvalTask):
        """
        Initialize isolated environment for a task.

        Args:
            task: The eval task to create environment for
        """
        self.task = task
        self.workdir: Optional[Path] = None
        self.original_env: Dict[str, Optional[str]] = {}
        self.original_cwd: Optional[str] = None

    def __enter__(self) -> 'IsolatedEnvironment':
        """Set up isolated environment."""
        # Create temp directory
        self.workdir = Path(tempfile.mkdtemp(prefix=f"eval_{self.task.task_id}_"))

        # Save current working directory
        self.original_cwd = os.getcwd()

        # Change to work directory
        os.chdir(self.workdir)

        # Set up any required files from task context
        if self.task.context and "files" in self.task.context:
            self._setup_context_files()

        # Set environment variables
        if self.task.context and "env" in self.task.context:
            self._setup_env_vars()

        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Clean up isolated environment."""
        # Restore original working directory
        if self.original_cwd:
            try:
                os.chdir(self.original_cwd)
            except Exception:
                pass

        # Clean up temp directory
        if self.workdir and self.workdir.exists():
            try:
                shutil.rmtree(self.workdir, ignore_errors=True)
            except Exception:
                pass

        # Restore environment variables
        for key, value in self.original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _setup_context_files(self):
        """Create files specified in task context."""
        files = self.task.context.get("files", {})

        for filepath, content in files.items():
            full_path = self.workdir / filepath

            # Create parent directories if needed
            full_path.parent.mkdir(parents=True, exist_ok=True)

            # Write file content
            with open(full_path, 'w', encoding='utf-8') as f:
                f.write(content)

    def _setup_env_vars(self):
        """Set environment variables specified in task context."""
        env_vars = self.task.context.get("env", {})

        for key, value in env_vars.items():
            # Save original value
            self.original_env[key] = os.environ.get(key)

            # Set new value
            if value is not None:
                os.environ[key] = str(value)
            else:
                os.environ.pop(key, None)

    def preserve_artifacts(self, destination: Path) -> Path:
        """
        Copy the entire working directory to a permanent destination.

        Args:
            destination: Directory where artifacts should be copied

        Returns:
            Path to the preserved artifact directory
        """
        if not self.workdir or not self.workdir.exists():
            raise RuntimeError("Cannot preserve artifacts; workdir is unavailable")

        # Convert destination to absolute path
        # This is critical because preserve_artifacts is called while CWD is the temp directory
        # If destination is relative, we must resolve it relative to the original CWD
        destination = Path(destination)
        if not destination.is_absolute():
            if self.original_cwd:
                destination = Path(self.original_cwd) / destination
            destination = destination.resolve()

        destination.parent.mkdir(parents=True, exist_ok=True)

        if destination.exists():
            shutil.rmtree(destination, ignore_errors=True)

        shutil.copytree(self.workdir, destination)
        return destination

    def get_context_string(self) -> str:
        """
        Get context string to pass to agent.

        Returns string describing the environment (working directory, files, etc.)
        """
        context_parts = []

        # Working directory info
        context_parts.append(f"Working directory: {self.workdir}")

        # List files if any were set up
        if self.task.context and "files" in self.task.context:
            files = list(self.task.context["files"].keys())
            if files:
                context_parts.append(f"Available files: {', '.join(files)}")

        # Environment variables
        if self.task.context and "env" in self.task.context:
            env_vars = list(self.task.context["env"].keys())
            if env_vars:
                context_parts.append(f"Environment variables: {', '.join(env_vars)}")

        return "\n".join(context_parts) if context_parts else ""


class TaskExecutor:
    """
    Executes eval tasks with proper isolation and cleanup.

    Key features:
    - Temporary working directories for each task
    - Timeout handling
    - Resource cleanup
    - Error capture

    IMPORTANT: The executor calls the agent's run() method with:
    - user_input: The task prompt (NEVER polluted with metadata)
    - context: Optional context string (file info, env vars) passed SEPARATELY

    This maintains a clean separation between the actual task and execution context.
    """

    def __init__(self, agent_factory: Callable):
        """
        Initialize task executor.

        Args:
            agent_factory: Callable that creates fresh agent instances
        """
        self.agent_factory = agent_factory

    def execute_task(self, task: EvalTask, artifact_dir: Optional[Path] = None) -> Any:
        """
        Execute a single task with isolation.

        Creates temporary directory, runs agent, captures result,
        cleans up resources.

        IMPORTANT: The task prompt is passed as-is to the agent.
        Working directory and file context are passed separately via the
        context parameter, NOT concatenated into the prompt.

        Args:
            task: The eval task to execute

        Returns:
            AgentResponse from the agent

        Raises:
            TimeoutError: If task exceeds timeout
            Exception: Any other execution error
        """
        # Create isolated environment
        response = None
        preserved_path: Optional[Path] = None

        with IsolatedEnvironment(task) as env:
            # Create fresh agent instance
            agent = self.agent_factory()

            # Set working directory for file operations if possible
            if hasattr(agent, 'tool_registry'):
                if hasattr(agent.tool_registry, 'set_default_working_dir'):
                    agent.tool_registry.set_default_working_dir(str(env.workdir))
                elif hasattr(agent.tool_registry, '_working_dir'):
                    agent.tool_registry._working_dir = str(env.workdir)

            # For wrapped agents (like RoutedAgentWrapper), try to set on inner agent
            if hasattr(agent, 'tiered_agent'):
                for tier_agent in getattr(agent.tiered_agent, '_agents', {}).values():
                    if hasattr(tier_agent, 'tool_registry'):
                        if hasattr(tier_agent.tool_registry, 'set_default_working_dir'):
                            tier_agent.tool_registry.set_default_working_dir(str(env.workdir))
                        elif hasattr(tier_agent.tool_registry, '_working_dir'):
                            tier_agent.tool_registry._working_dir = str(env.workdir)

            # CRITICAL: Pass prompt and context SEPARATELY
            # The prompt is the actual task - do NOT prepend working directory or metadata
            # Context is passed as a separate parameter for tasks that need file/env info
            user_input = task.prompt

            # Build context string for tasks that need it (file ops, etc.)
            # This is passed separately, not concatenated into the prompt
            context_str = None
            if task.context and ("files" in task.context or "env" in task.context):
                context_str = env.get_context_string()

            # Run with timeout using standardized interface
            try:
                with timeout(task.timeout_seconds):
                    # Call agent with clean separation of prompt and context
                    response = agent.run(user_input, context=context_str)
            except TimeoutError:
                # Create timeout response
                from harness.agent.agent import AgentResponse
                response = AgentResponse(
                    content="Task timed out",
                    success=False,
                    error=f"Timeout after {task.timeout_seconds}s",
                    goal_achieved=False,
                    total_duration_ms=task.timeout_seconds * 1000,
                    tools_used=[],
                    steps=[],
                    metadata={"timeout": True}
                )
            finally:
                if artifact_dir:
                    try:
                        preserved_path = env.preserve_artifacts(artifact_dir)
                    except Exception as exc:
                        preserved_path = None
                        logger.warning(
                            "Failed to preserve artifacts for task %s: %s",
                            task.task_id,
                            exc
                        )

        if response and preserved_path:
            response.metadata = dict(response.metadata or {})
            response.metadata["artifact_dir"] = str(preserved_path)

        return response

    def execute_task_with_retries(self, task: EvalTask, artifact_dir: Optional[Path] = None) -> Any:
        """
        Execute task with retry logic.

        Args:
            task: The eval task to execute

        Returns:
            AgentResponse from the agent
        """
        last_error = None

        for attempt in range(task.max_retries + 1):
            try:
                return self.execute_task(task, artifact_dir=artifact_dir)
            except Exception as e:
                last_error = e
                if attempt < task.max_retries:
                    # Retry
                    continue
                else:
                    # Max retries exceeded, raise
                    raise

        # Should not reach here
        raise last_error if last_error else RuntimeError("Task execution failed")
