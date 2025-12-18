"""
Sandboxed workspace manager for evaluation isolation.

Addresses:
1. Multi-turn eval isolation not defined
2. Edge-case generator lacks sandboxing/cleanup
3. Session handling for multi-turn tasks

Each evaluation scenario runs in an isolated workspace:
- Fresh Agent/ContextState per scenario
- Clean working memory between scenarios
- Git tree reset between tasks
- Deterministic initial state
"""

import os
import shutil
import tempfile
import subprocess
from pathlib import Path
from typing import Optional, Dict, Any, List
from contextlib import contextmanager
from dataclasses import dataclass
import uuid

from .eval_models import ReproducibilityContext


@dataclass
class WorkspaceConfig:
    """Configuration for sandboxed workspace."""
    # Base settings
    base_path: Optional[Path] = None  # If None, use temp dir
    cleanup_on_exit: bool = True
    preserve_artifacts: bool = True

    # Git settings
    use_git: bool = True
    git_init_if_missing: bool = True
    reset_git_on_cleanup: bool = True

    # Isolation
    copy_env_vars: List[str] = None  # Which env vars to copy (default: safe subset)

    def __post_init__(self):
        if self.copy_env_vars is None:
            # Safe environment variables to copy
            self.copy_env_vars = [
                'PATH',
                'HOME',
                'USER',
                'LANG',
                'LC_ALL',
                'PYTHONPATH',
                'VIRTUAL_ENV',
            ]


class SandboxedWorkspace:
    """
    Manages an isolated workspace for evaluation.

    Usage:
        with SandboxedWorkspace(config) as workspace:
            workspace.initialize_git()
            workspace.create_file("test.py", "print('hello')")

            # Run agent in this workspace
            agent = workspace.create_isolated_agent()

            # Files are tracked, git diffs captured
            workspace.commit("After turn 1")

    Cleanup happens automatically on exit.
    """

    def __init__(self, config: Optional[WorkspaceConfig] = None):
        self.config = config or WorkspaceConfig()
        self.workspace_path: Optional[Path] = None
        self.artifacts_path: Optional[Path] = None
        self._temp_dir: Optional[tempfile.TemporaryDirectory] = None
        self._initial_commit: Optional[str] = None

    def __enter__(self):
        """Enter context: create workspace."""
        self._create_workspace()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Exit context: cleanup workspace."""
        if self.config.cleanup_on_exit:
            self._cleanup_workspace()

    def _create_workspace(self):
        """Create the isolated workspace."""
        if self.config.base_path:
            # Use specified path
            self.workspace_path = self.config.base_path

            # CRITICAL: Clear old contents to ensure isolation
            if self.workspace_path.exists():
                import shutil
                shutil.rmtree(self.workspace_path)

            self.workspace_path.mkdir(parents=True, exist_ok=True)
        else:
            # Use temporary directory (always clean)
            self._temp_dir = tempfile.TemporaryDirectory(prefix="eval_workspace_")
            self.workspace_path = Path(self._temp_dir.name)

        # Create artifacts directory
        self.artifacts_path = self.workspace_path / ".eval_artifacts"
        self.artifacts_path.mkdir(exist_ok=True)

    def _cleanup_workspace(self):
        """Clean up the workspace."""
        if self.config.reset_git_on_cleanup and self.config.use_git:
            self._reset_git()

        if self._temp_dir:
            self._temp_dir.cleanup()

    def initialize_git(self):
        """Initialize git repository if needed."""
        if not self.config.use_git:
            return

        git_dir = self.workspace_path / ".git"
        if not git_dir.exists():
            if not self.config.git_init_if_missing:
                raise RuntimeError(f"Git not initialized in {self.workspace_path}")

            # Initialize git
            subprocess.run(
                ['git', 'init'],
                cwd=self.workspace_path,
                check=True,
                capture_output=True
            )

            # Configure git
            subprocess.run(
                ['git', 'config', 'user.name', 'Eval Runner'],
                cwd=self.workspace_path,
                check=True
            )
            subprocess.run(
                ['git', 'config', 'user.email', 'eval@example.com'],
                cwd=self.workspace_path,
                check=True
            )

            # Initial commit
            self.commit("Initial commit")

        self._initial_commit = self._get_current_commit()

    def commit(self, message: str) -> str:
        """
        Commit current state.
        Returns commit hash.
        """
        if not self.config.use_git:
            return ""

        # Add all changes
        subprocess.run(
            ['git', 'add', '-A'],
            cwd=self.workspace_path,
            check=True,
            capture_output=True
        )

        # Commit
        result = subprocess.run(
            ['git', 'commit', '-m', message, '--allow-empty'],
            cwd=self.workspace_path,
            check=True,
            capture_output=True
        )

        return self._get_current_commit()

    def reset_to_initial(self):
        """Reset workspace to initial state."""
        if not self.config.use_git or not self._initial_commit:
            raise RuntimeError("Cannot reset: git not initialized")

        subprocess.run(
            ['git', 'reset', '--hard', self._initial_commit],
            cwd=self.workspace_path,
            check=True,
            capture_output=True
        )

        subprocess.run(
            ['git', 'clean', '-fdx'],
            cwd=self.workspace_path,
            check=True,
            capture_output=True
        )

    def get_diff(self, ref1: str = 'HEAD', ref2: Optional[str] = None) -> str:
        """Get git diff between commits."""
        if not self.config.use_git:
            return ""

        cmd = ['git', 'diff', ref1]
        if ref2:
            cmd.append(ref2)

        result = subprocess.run(
            cmd,
            cwd=self.workspace_path,
            capture_output=True,
            text=True
        )

        return result.stdout

    def create_file(self, relative_path: str, content: str):
        """Create a file in the workspace."""
        file_path = self.workspace_path / relative_path
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content)

    def read_file(self, relative_path: str) -> str:
        """Read a file from the workspace."""
        file_path = self.workspace_path / relative_path
        return file_path.read_text()

    def file_exists(self, relative_path: str) -> bool:
        """Check if file exists."""
        file_path = self.workspace_path / relative_path
        return file_path.exists()

    def get_env_vars(self) -> Dict[str, str]:
        """Get filtered environment variables for this workspace."""
        env = {}

        for var in self.config.copy_env_vars:
            if var in os.environ:
                env[var] = os.environ[var]

        # Add workspace-specific vars
        env['EVAL_WORKSPACE'] = str(self.workspace_path)
        env['EVAL_ARTIFACTS'] = str(self.artifacts_path)

        return env

    def get_repro_context(
        self,
        task_id: str,
        scenario_id: str,
        turn_number: int,
        request_id: str,
        execution_id: str,
        tier: str,
        model: str,
        temperature: float,
        max_tokens: int,
        random_seed: Optional[int] = None
    ) -> ReproducibilityContext:
        """Build reproducibility context for this workspace."""
        import sys

        return ReproducibilityContext(
            task_id=task_id,
            scenario_id=scenario_id,
            turn_number=turn_number,
            request_id=request_id,
            execution_id=execution_id,
            tier=tier,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            workspace_path=str(self.workspace_path),
            git_commit=self._get_current_commit() or "",
            git_branch=self._get_current_branch() or "",
            python_version=sys.version.split()[0],
            random_seed=random_seed,
            env_vars=self.get_env_vars()
        )

    def preserve_artifacts(self, artifacts_dir: Path):
        """Copy workspace artifacts to external directory."""
        if not self.config.preserve_artifacts:
            return

        # Copy entire workspace
        dest = artifacts_dir / "workspace"
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(self.workspace_path, dest, ignore=shutil.ignore_patterns('.git'))

    # ========================================================================
    # Private helpers
    # ========================================================================

    def _get_current_commit(self) -> Optional[str]:
        """Get current commit hash."""
        try:
            result = subprocess.run(
                ['git', 'rev-parse', 'HEAD'],
                cwd=self.workspace_path,
                capture_output=True,
                text=True,
                timeout=5
            )
            return result.stdout.strip() if result.returncode == 0 else None
        except Exception:
            return None

    def _get_current_branch(self) -> Optional[str]:
        """Get current branch name."""
        try:
            result = subprocess.run(
                ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
                cwd=self.workspace_path,
                capture_output=True,
                text=True,
                timeout=5
            )
            return result.stdout.strip() if result.returncode == 0 else None
        except Exception:
            return None

    def _reset_git(self):
        """Reset git to clean state."""
        try:
            subprocess.run(
                ['git', 'reset', '--hard', 'HEAD'],
                cwd=self.workspace_path,
                check=True,
                capture_output=True
            )
            subprocess.run(
                ['git', 'clean', '-fdx'],
                cwd=self.workspace_path,
                check=True,
                capture_output=True
            )
        except Exception as e:
            print(f"Warning: Failed to reset git: {e}")


class IsolatedAgentSession:
    """
    Manages isolated agent session for evaluation.

    Ensures:
    - Fresh Agent instance per scenario
    - Clean ContextState/working memory
    - No conversation leakage between tasks
    """

    def __init__(
        self,
        workspace: SandboxedWorkspace,
        tier: str = "standard",
        model: str = "claude-sonnet-4-5",
        temperature: float = 0.0,
        random_seed: Optional[int] = None,
        log_dir: Optional[Path] = None
    ):
        self.workspace = workspace
        self.tier = tier
        self.model = model
        self.temperature = temperature
        self.random_seed = random_seed
        self.log_dir = Path(log_dir) if log_dir else Path(self.workspace.workspace_path) / "logs"

        # Will be set on first use
        self._agent = None
        self._harness = None

    def get_agent(self):
        """
        Get agent instance for this session.
        Creates new instance if needed.
        """
        if self._agent is None:
            self._agent = self._create_agent()
        return self._agent

    def get_harness(self):
        """Get harness instance for this session."""
        if self._harness is None:
            self._harness = self._create_harness()
        return self._harness

    def reset(self):
        """Reset agent state (for new scenario in same session)."""
        self._agent = None
        self._harness = None

    def _create_agent(self):
        """Create fresh agent instance using config file."""
        import json
        from pathlib import Path
        from harness.agent.agent import TieredAgent
        from harness.agent.tool_registry import ToolRegistry
        from util.config import AgentConfig, ToolConfig, LLMConfig
        from util.logger import StructuredLogger
        from util.agent_execution_logger import AgentExecutionLogger

        # Load config from file
        config_path = Path(__file__).parent / "configs" / "agent_config.json"
        with open(config_path) as f:
            all_configs = json.load(f)

        # Find the agent config for this model/tier
        # First try to find by model name, then fall back to tier
        agent_config_data = None
        for name, cfg in all_configs.get("agents", {}).items():
            llm_cfg = cfg.get("llm_config", {})
            if llm_cfg.get("model") == self.model:
                agent_config_data = cfg
                break

        # Fall back to default if not found
        if not agent_config_data:
            agent_config_data = all_configs.get("default_agent", {})

        # Build LLM config from file
        llm_data = agent_config_data.get("llm_config", {})
        llm_config = LLMConfig(
            provider=llm_data.get("provider", "anthropic"),
            model=llm_data.get("model", self.model),
            temperature=llm_data.get("temperature", self.temperature),
            max_tokens=llm_data.get("max_tokens", 4096)
        )

        # Create tool config and registry
        tool_config_data = agent_config_data.get("tool_config", {})
        enabled_tools = tool_config_data.get("enabled_tools")
        if enabled_tools:
            tool_config = ToolConfig(enabled_tools=enabled_tools)
        else:
            tool_config = ToolConfig()  # Use defaults
        structured_logger = StructuredLogger(log_dir=str(self.log_dir))
        exec_logger = AgentExecutionLogger(log_dir=str(self.log_dir))

        tool_registry = ToolRegistry(tool_config, logger=structured_logger)

        # CRITICAL: Set tool registry's working directory to the sandbox workspace
        # Without this, file_write and other tools write to os.getcwd() instead of workspace
        tool_registry.set_default_working_dir(str(self.workspace.workspace_path))

        # Create agent config
        agent_config = AgentConfig(
            llm_config=llm_config,
            tier=agent_config_data.get("tier", self.tier)
        )

        # Create TieredAgent
        tiered_agent = TieredAgent(
            config=agent_config,
            tool_registry=tool_registry,
            tier_configs={self.tier: llm_config},
            logger=structured_logger,
            execution_logger=exec_logger
        )

        # Get the actual agent for this tier
        agent = tiered_agent._get_agent(self.tier)

        # Set working directory if the agent has context state
        if hasattr(agent, '_context_state') and agent._context_state:
            agent._context_state.working_directory = str(self.workspace.workspace_path)

        return agent

    def _create_harness(self):
        """Create fresh harness instance."""
        from harness.harness import AgentHarness
        from util.config import HarnessConfig

        config = HarnessConfig(
            tier=self.tier,
            model=self.model,
            temperature=self.temperature
        )

        harness = AgentHarness(config=config)
        return harness


# ============================================================================
# Convenience functions
# ============================================================================

@contextmanager
def isolated_eval_environment(
    task_id: str,
    base_path: Optional[Path] = None,
    use_git: bool = True
):
    """
    Convenience context manager for isolated eval environment.

    Usage:
        with isolated_eval_environment("task_001") as (workspace, session):
            agent = session.get_agent()
            response = agent.run("Create a Python file")

            # Workspace automatically cleaned up on exit
    """
    config = WorkspaceConfig(
        base_path=base_path,
        cleanup_on_exit=True,
        use_git=use_git
    )

    with SandboxedWorkspace(config) as workspace:
        if use_git:
            workspace.initialize_git()

        session = IsolatedAgentSession(workspace)

        yield workspace, session
