# Production Readiness Implementation Spec

**Package:** `rex` v0.1.0
**Target:** PyPI publication with separate `[audio]` extras
**Date:** 2024-12-31

---

## Table of Contents

1. [Overview](#overview)
2. [Phase 1: Dead Code Removal](#phase-1-dead-code-removal)
3. [Phase 2: Error Handling & Logging](#phase-2-error-handling--logging)
4. [Phase 3: Dependency Management & Lockfiles](#phase-3-dependency-management--lockfiles)
5. [Phase 4: Test Coverage Improvements](#phase-4-test-coverage-improvements)
6. [Phase 5: CI/CD Pipeline](#phase-5-cicd-pipeline)
7. [Phase 6: Performance & Profiling](#phase-6-performance--profiling)
8. [Phase 7: Documentation](#phase-7-documentation)
9. [Phase 8: Security Audit](#phase-8-security-audit)
10. [Phase 9: PyPI Publication](#phase-9-pypi-publication)
11. [Phase 10: Observability (Optional)](#phase-10-observability-optional)

---

## Overview

### Current State
- **Codebase:** 42,361 lines Python across 116 source files
- **Tests:** 388 tests across 26 test files
- **Logging:** 3-tier JSONL structured logging (`src/util/logger.py`)
- **Error Handling:** Circuit breaker + retry framework (`src/util/resilience.py`)
- **Architecture:** Layered (util → communication → services → harness → workers → app)

### Success Criteria
- [ ] All dead code removed
- [ ] Dependencies pinned with lockfile
- [ ] Test coverage ≥80%
- [ ] CI pipeline passing (lint, type check, security, tests)
- [ ] Performance benchmarks established
- [ ] Published to PyPI as `rex` with `[audio]` extras
- [ ] Documentation complete

---

## Phase 1: Dead Code Removal

### 1.1 Delete Empty/Malformed Files

**Task:** Remove files that serve no purpose.

| File | Issue | Action |
|------|-------|--------|
| `/Users/jevinnishioka/Desktop/jesus/run_single.py` | Empty (0 bytes) | Delete |
| `/Users/jevinnishioka/Desktop/jesus/config.json` | Malformed JSON | Delete |

**Commands:**
```bash
rm run_single.py
rm config.json
git add -A && git commit -m "chore: remove empty/malformed files"
```

**Acceptance Criteria:**
- [ ] `run_single.py` deleted
- [ ] `config.json` deleted
- [ ] No references to these files remain in codebase

---

### 1.2 Audit TODO/FIXME Markers

**Task:** Review each TODO and either implement, remove, or convert to GitHub issue.

**Files to audit:**

| File | Line | TODO Content | Resolution |
|------|------|--------------|------------|
| `src/evals/agent_adapter.py` | Multiple | Refactoring to use wizard | Implement or create issue |
| `src/harness/service_rep.py` | Multiple | Phase 5 advanced features | Create issue if not implementing |
| `src/workers/harness_worker.py` | - | Phase 8 migration | Create issue |
| `src/workers/tts_worker.py` | - | Phase 8 migration | Create issue |
| `src/communication/event_bus.py` | - | Phase 8 | Create issue |
| `src/evals/multiturn_runner.py` | - | Parallel execution | Create issue |
| `src/harness/agent/wizard/reflector.py` | - | Regex pattern | Review and resolve |

**Commands to find all TODOs:**
```bash
grep -rn "TODO\|FIXME\|XXX\|HACK" src/ --include="*.py"
```

**Acceptance Criteria:**
- [ ] Each TODO reviewed and documented
- [ ] Non-critical TODOs converted to GitHub issues
- [ ] Critical TODOs implemented or removed with explanation

---

### 1.3 Unused Code Detection

**Task:** Run static analysis to find unused code.

**Commands:**
```bash
# Install vulture
pip install vulture

# Run unused code detection
vulture src/ --min-confidence 80

# Also check with ruff
ruff check src/ --select F401,F841
```

**Files to specifically check:**
- All `__init__.py` files for unused exports
- All imports in each module
- Functions/classes with no callers

**Acceptance Criteria:**
- [ ] `vulture` reports zero high-confidence unused code
- [ ] All unused imports removed
- [ ] All unreachable code removed

---

## Phase 2: Error Handling & Logging

### 2.1 Create Centralized Exception Hierarchy

**Task:** Create a structured exception module for consistent error handling.

**Create file:** `src/util/exceptions.py`

```python
"""
Centralized exception hierarchy for rex.

Usage:
    from util.exceptions import AgentError, ToolExecutionError

    raise ToolExecutionError("tool_name", "Failed to execute", cause=original_error)
"""

from typing import Optional


class RexError(Exception):
    """Base exception for all rex errors."""

    def __init__(self, message: str, cause: Optional[Exception] = None):
        super().__init__(message)
        self.message = message
        self.cause = cause

    def __str__(self) -> str:
        if self.cause:
            return f"{self.message} (caused by: {self.cause})"
        return self.message


# === Configuration Errors ===

class ConfigurationError(RexError):
    """Error in configuration loading or validation."""
    pass


class MissingConfigError(ConfigurationError):
    """Required configuration key is missing."""

    def __init__(self, key: str, config_file: Optional[str] = None):
        msg = f"Missing required config key: {key}"
        if config_file:
            msg += f" in {config_file}"
        super().__init__(msg)
        self.key = key
        self.config_file = config_file


# === Agent Errors ===

class AgentError(RexError):
    """Base error for agent operations."""
    pass


class PlanningError(AgentError):
    """Error during plan creation."""
    pass


class ExecutionError(AgentError):
    """Error during plan execution."""
    pass


class ReflectionError(AgentError):
    """Error during reflection phase."""
    pass


# === Tool Errors ===

class ToolError(RexError):
    """Base error for tool operations."""
    pass


class ToolNotFoundError(ToolError):
    """Requested tool does not exist in registry."""

    def __init__(self, tool_name: str):
        super().__init__(f"Tool not found: {tool_name}")
        self.tool_name = tool_name


class ToolExecutionError(ToolError):
    """Error during tool execution."""

    def __init__(self, tool_name: str, message: str, cause: Optional[Exception] = None):
        super().__init__(f"Tool '{tool_name}' failed: {message}", cause)
        self.tool_name = tool_name


class ToolTimeoutError(ToolError):
    """Tool execution timed out."""

    def __init__(self, tool_name: str, timeout_seconds: float):
        super().__init__(f"Tool '{tool_name}' timed out after {timeout_seconds}s")
        self.tool_name = tool_name
        self.timeout_seconds = timeout_seconds


# === LLM Errors ===

class LLMError(RexError):
    """Base error for LLM operations."""
    pass


class LLMProviderError(LLMError):
    """Error from LLM provider (OpenAI, Anthropic, etc.)."""

    def __init__(self, provider: str, message: str, cause: Optional[Exception] = None):
        super().__init__(f"LLM provider '{provider}' error: {message}", cause)
        self.provider = provider


class LLMRateLimitError(LLMError):
    """Rate limit exceeded."""

    def __init__(self, provider: str, retry_after: Optional[float] = None):
        msg = f"Rate limit exceeded for {provider}"
        if retry_after:
            msg += f", retry after {retry_after}s"
        super().__init__(msg)
        self.provider = provider
        self.retry_after = retry_after


# === Communication Errors ===

class CommunicationError(RexError):
    """Base error for IPC/event bus operations."""
    pass


class ProcessNotFoundError(CommunicationError):
    """Target process does not exist."""

    def __init__(self, process_name: str):
        super().__init__(f"Process not found: {process_name}")
        self.process_name = process_name


class MessageDeliveryError(CommunicationError):
    """Failed to deliver message."""
    pass


# === Service Errors ===

class ServiceError(RexError):
    """Base error for service operations."""
    pass


class STTError(ServiceError):
    """Speech-to-text error."""
    pass


class TTSError(ServiceError):
    """Text-to-speech error."""
    pass


class AudioDeviceError(ServiceError):
    """Audio device not available or failed."""

    def __init__(self, device_name: Optional[str] = None, message: str = "Audio device error"):
        full_msg = message
        if device_name:
            full_msg = f"{message}: {device_name}"
        super().__init__(full_msg)
        self.device_name = device_name
```

**Acceptance Criteria:**
- [ ] File created at `src/util/exceptions.py`
- [ ] All exception classes have docstrings
- [ ] Exceptions are importable from `util.exceptions`
- [ ] At least 3 modules updated to use new exceptions

---

### 2.2 Add Top-Level Exception Handlers

**Task:** Ensure all entry points catch and log unhandled exceptions gracefully.

**Files to modify:**

| File | Function | Change |
|------|----------|--------|
| `src/app/cli.py` | `main()` | Wrap in try/except with structured logging |
| `run_tui.py` | `main()` | Wrap in try/except |
| `run_app.py` | `main()` | Wrap in try/except |
| `run_multi.py` | `main()` | Wrap in try/except |

**Example implementation for `src/app/cli.py`:**

```python
import sys
import traceback
from util.logger import get_logger
from util.exceptions import RexError

logger = get_logger(__name__)

def main():
    try:
        # existing main logic
        _run_cli()
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
        sys.exit(130)
    except RexError as e:
        logger.error(f"Application error: {e}", exc_info=True)
        sys.exit(1)
    except Exception as e:
        logger.critical(f"Unexpected error: {e}", exc_info=True)
        traceback.print_exc()
        sys.exit(1)
```

**Acceptance Criteria:**
- [ ] All 4 entry points have top-level exception handlers
- [ ] Exceptions are logged with full traceback
- [ ] Exit codes are appropriate (0=success, 1=error, 130=interrupt)
- [ ] No unhandled exceptions crash silently

---

### 2.3 Add Correlation IDs for Multi-Process Tracing

**Task:** Add request correlation IDs that propagate across process boundaries.

**Files to modify:**
- `src/util/logger.py` - Add correlation ID to log context
- `src/communication/event_bus.py` - Include correlation ID in messages

**Implementation:**

```python
# In src/util/logger.py, add to StructuredLogger:

import contextvars
import uuid

_correlation_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    'correlation_id', default=''
)

def set_correlation_id(cid: str) -> None:
    _correlation_id.set(cid)

def get_correlation_id() -> str:
    cid = _correlation_id.get()
    if not cid:
        cid = str(uuid.uuid4())[:8]
        _correlation_id.set(cid)
    return cid

# Update RequestLog to include correlation_id field
```

**Acceptance Criteria:**
- [ ] Correlation IDs generated at request entry points
- [ ] IDs propagate through event bus messages
- [ ] Logs include correlation ID for request tracing
- [ ] Can trace a single request across all processes

---

## Phase 3: Dependency Management & Lockfiles

### 3.1 Pin All Dependencies

**Task:** Update `pyproject.toml` to use version ranges with upper bounds.

**Current state (problematic):**
```toml
"anthropic>=0.20.0",  # Could break with 1.0.0
```

**Target state:**
```toml
"anthropic>=0.20.0,<1.0.0",  # Bounded range
```

**Full updated dependencies for `pyproject.toml`:**

```toml
[project]
dependencies = [
  # LLM Backends
  "anthropic>=0.20.0,<1.0.0",
  "openai>=1.0.0,<2.0.0",
  # Web/HTTP
  "aiohttp>=3.9.0,<4.0.0",
  "beautifulsoup4>=4.12.0,<5.0.0",
  "html2text>=2020.1.16,<2025.0.0",
  "httpx>=0.27.0,<1.0.0",
  "requests>=2.28.0,<3.0.0",
  # Data/Visualization
  "matplotlib>=3.7.0,<4.0.0",
  "numpy>=1.24.0,<2.3.0",
  "scipy>=1.10.0,<2.0.0",
  "seaborn>=0.12.0,<1.0.0",
  # Utilities
  "pytz>=2023.3",
  "typing_extensions>=4.0.0,<5.0.0",
]

[project.optional-dependencies]
dev = [
  "black>=24.0.0,<25.0.0",
  "isort>=5.13.0,<6.0.0",
  "mypy>=1.11.0,<2.0.0",
  "pip-tools>=7.4.0,<8.0.0",
  "pre-commit>=3.8.0,<4.0.0",
  "pytest>=8.0.0,<9.0.0",
  "pytest-cov>=5.0.0,<6.0.0",
  "pytest-randomly>=3.15.0,<4.0.0",
  "pytest-timeout>=2.3.0,<3.0.0",
  "pytest-xdist>=3.6.0,<4.0.0",
  "ruff>=0.7.0,<1.0.0",
  "vulture>=2.0.0,<3.0.0",
  "bandit>=1.7.0,<2.0.0",
  "pip-audit>=2.0.0,<3.0.0",
]

audio = [
  # Audio I/O
  "PyAudio>=0.2.14,<0.3.0",
  "pydub>=0.25.0,<1.0.0",
  "webrtcvad>=2.0.10,<3.0.0",
  # Speech Recognition
  "SpeechRecognition>=3.10.0,<4.0.0",
  "faster-whisper>=1.0.0,<2.0.0",
  # Text-to-Speech
  "pyttsx3>=2.90,<3.0.0",
]

# New: combined extras
all = [
  "rex[dev]",
  "rex[audio]",
]
```

**Acceptance Criteria:**
- [ ] All dependencies have upper bounds
- [ ] No exact pins except where necessary
- [ ] `[all]` extra added for convenience

---

### 3.2 Generate Lockfile

**Task:** Create reproducible lockfile using pip-tools.

**Commands:**
```bash
# Install pip-tools
pip install pip-tools

# Generate main lockfile
pip-compile pyproject.toml -o requirements.lock --generate-hashes

# Generate dev lockfile
pip-compile pyproject.toml --extra dev -o requirements-dev.lock --generate-hashes

# Generate audio lockfile (on macOS)
pip-compile pyproject.toml --extra audio -o requirements-audio.lock --generate-hashes
```

**Files to create:**
- `requirements.lock` - Production dependencies with hashes
- `requirements-dev.lock` - Dev dependencies with hashes
- `requirements-audio.lock` - Audio dependencies with hashes

**Update `.gitignore`:**
```gitignore
# Keep lockfiles in git (they should be committed)
!requirements.lock
!requirements-dev.lock
!requirements-audio.lock
```

**Acceptance Criteria:**
- [ ] `requirements.lock` generated with hashes
- [ ] Lockfiles committed to repository
- [ ] `pip install -r requirements.lock` works
- [ ] Old `requirements.txt` files removed or deprecated

---

### 3.3 Add Python Version Classifiers

**Task:** Update `pyproject.toml` with proper PyPI classifiers.

```toml
[project]
classifiers = [
  "Development Status :: 4 - Beta",
  "Environment :: Console",
  "Intended Audience :: Developers",
  "License :: OSI Approved :: MIT License",  # Update once license chosen
  "Operating System :: MacOS :: MacOS X",
  "Operating System :: POSIX :: Linux",
  "Programming Language :: Python :: 3",
  "Programming Language :: Python :: 3.9",
  "Programming Language :: Python :: 3.10",
  "Programming Language :: Python :: 3.11",
  "Programming Language :: Python :: 3.12",
  "Topic :: Scientific/Engineering :: Artificial Intelligence",
  "Topic :: Multimedia :: Sound/Audio :: Speech",
  "Typing :: Typed",
]

[project.urls]
Homepage = "https://github.com/your-org/rex"
Documentation = "https://github.com/your-org/rex#readme"
Repository = "https://github.com/your-org/rex.git"
Issues = "https://github.com/your-org/rex/issues"
Changelog = "https://github.com/your-org/rex/blob/main/CHANGELOG.md"
```

**Acceptance Criteria:**
- [ ] All classifiers added
- [ ] URLs point to actual repository
- [ ] License classifier matches LICENSE file

---

## Phase 4: Test Coverage Improvements

### 4.1 Add CLI Integration Tests

**Task:** Create tests for `src/app/cli.py` commands.

**Create file:** `tests/test_cli.py`

```python
"""
Integration tests for the CLI interface.
"""

import subprocess
import sys
import pytest


class TestCLI:
    """Test CLI commands."""

    def test_version(self):
        """Test --version flag."""
        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--version"],
            capture_output=True,
            text=True,
            cwd="src"
        )
        assert result.returncode == 0
        assert "0.1.0" in result.stdout or "rex" in result.stdout.lower()

    def test_help(self):
        """Test --help flag."""
        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "--help"],
            capture_output=True,
            text=True,
            cwd="src"
        )
        assert result.returncode == 0
        assert "usage" in result.stdout.lower() or "options" in result.stdout.lower()

    def test_list_devices_headless(self, monkeypatch):
        """Test list-devices in headless mode."""
        monkeypatch.setenv("VOICE_AGENT_HEADLESS", "1")
        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "list-devices"],
            capture_output=True,
            text=True,
            cwd="src",
            env={**subprocess.os.environ, "VOICE_AGENT_HEADLESS": "1"}
        )
        # Should not crash in headless mode
        assert result.returncode in (0, 1)

    def test_validate_config(self, tmp_path):
        """Test config validation."""
        # Create minimal valid config
        config_file = tmp_path / "test_config.json"
        config_file.write_text('{"key": "value"}')

        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "validate-config", str(config_file)],
            capture_output=True,
            text=True,
            cwd="src"
        )
        # Should complete without crashing
        assert result.returncode in (0, 1)

    def test_invalid_command(self):
        """Test invalid command shows error."""
        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "nonexistent-command"],
            capture_output=True,
            text=True,
            cwd="src"
        )
        assert result.returncode != 0


@pytest.mark.integration
class TestCLIIntegration:
    """Integration tests requiring more setup."""

    def test_health_check(self):
        """Test health-check command."""
        result = subprocess.run(
            [sys.executable, "-m", "app.cli", "health-check"],
            capture_output=True,
            text=True,
            cwd="src",
            timeout=30
        )
        # Health check should complete
        assert result.returncode in (0, 1)
```

**Acceptance Criteria:**
- [ ] CLI tests created
- [ ] Tests cover: version, help, list-devices, validate-config, health-check
- [ ] Tests pass in CI

---

### 4.2 Add Error Recovery Tests

**Task:** Add tests for failure scenarios and recovery.

**Create file:** `tests/test_error_recovery.py`

```python
"""
Tests for error recovery and resilience.
"""

import pytest
from unittest.mock import Mock, patch, MagicMock
from util.resilience import resilient_call, CircuitBreaker, CircuitBreakerOpenError


class TestCircuitBreakerRecovery:
    """Test circuit breaker state transitions."""

    def test_circuit_opens_after_failures(self):
        """Circuit should open after threshold failures."""
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=1.0)

        for _ in range(3):
            cb.record_failure()

        assert cb.state == "open"

    def test_circuit_half_open_after_timeout(self):
        """Circuit should transition to half-open after recovery timeout."""
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.1)
        cb.record_failure()

        import time
        time.sleep(0.2)

        # Should allow a test request
        assert cb.should_allow_request()

    def test_circuit_closes_on_success(self):
        """Circuit should close after successful request in half-open."""
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.1)
        cb.record_failure()

        import time
        time.sleep(0.2)

        cb.record_success()
        assert cb.state == "closed"


class TestResilientCall:
    """Test resilient_call decorator."""

    def test_retries_on_failure(self):
        """Should retry on transient failures."""
        call_count = 0

        def flaky_func():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise ConnectionError("Transient error")
            return "success"

        result = resilient_call(flaky_func, max_retries=3)
        assert result == "success"
        assert call_count == 3

    def test_gives_up_after_max_retries(self):
        """Should raise after exhausting retries."""
        def always_fails():
            raise ConnectionError("Permanent error")

        with pytest.raises(ConnectionError):
            resilient_call(always_fails, max_retries=3)


@pytest.mark.integration
class TestAgentErrorRecovery:
    """Test agent-level error recovery."""

    def test_agent_handles_tool_failure(self, tool_registry, mock_llm_config):
        """Agent should handle tool execution failures gracefully."""
        from harness.agent.agent import Agent

        # Register a failing tool
        def failing_tool(**kwargs):
            raise RuntimeError("Tool failed")

        tool_registry.register("failing_tool", failing_tool, "A tool that fails")

        agent = Agent(
            llm_config=mock_llm_config,
            tool_registry=tool_registry
        )

        # Agent should not crash, should reflect on failure
        # Implementation depends on agent behavior
        pass

    def test_agent_handles_llm_timeout(self, tool_registry, mock_llm_config):
        """Agent should handle LLM timeouts gracefully."""
        pass  # Implement based on agent structure
```

**Acceptance Criteria:**
- [ ] Circuit breaker tests pass
- [ ] Retry logic tests pass
- [ ] Agent error recovery tests pass
- [ ] No unhandled exceptions in failure scenarios

---

### 4.3 Add Coverage Threshold

**Task:** Configure pytest to enforce coverage threshold.

**Update `pytest.ini`:**

```ini
[pytest]
minversion = 8.0
testpaths = tests
python_files = test_*.py
python_functions = test_*
addopts =
    -v
    --tb=short
    --cov=src
    --cov-report=term-missing
    --cov-report=html
    --cov-fail-under=80
markers =
    slow: marks tests as slow
    integration: marks tests as integration tests
    unit: marks tests as unit tests
    requires_network: marks tests requiring network access
```

**Acceptance Criteria:**
- [ ] Coverage threshold set to 80%
- [ ] CI fails if coverage drops below threshold
- [ ] Coverage report generated in HTML format

---

## Phase 5: CI/CD Pipeline

### 5.1 Create GitHub Actions Workflow

**Task:** Create CI workflow for automated testing.

**Create file:** `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'
          cache: 'pip'

      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install ruff black isort mypy

      - name: Run ruff
        run: ruff check src/ tests/

      - name: Run black
        run: black --check src/ tests/

      - name: Run isort
        run: isort --check-only src/ tests/

      - name: Run mypy
        run: mypy src/ --ignore-missing-imports

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install security tools
        run: |
          pip install bandit pip-audit

      - name: Run bandit
        run: bandit -r src/ -ll

      - name: Run pip-audit
        run: |
          pip install -e .
          pip-audit

  test:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        python-version: ['3.9', '3.10', '3.11', '3.12']

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python ${{ matrix.python-version }}
        uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
          cache: 'pip'

      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install -e ".[dev]"

      - name: Run tests
        run: |
          pytest tests/ -v --cov=src --cov-report=xml
        env:
          VOICE_AGENT_HEADLESS: '1'

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage.xml
          fail_ci_if_error: true

  build:
    runs-on: ubuntu-latest
    needs: [lint, security, test]
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install build tools
        run: pip install build twine

      - name: Build package
        run: python -m build

      - name: Check package
        run: twine check dist/*

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
```

**Acceptance Criteria:**
- [ ] CI runs on push to main/develop
- [ ] CI runs on PRs to main
- [ ] All jobs pass (lint, security, test, build)
- [ ] Coverage uploaded to Codecov

---

### 5.2 Create Release Workflow

**Task:** Create workflow for PyPI releases.

**Create file:** `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      id-token: write  # Required for trusted publishing

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install build tools
        run: pip install build

      - name: Build package
        run: python -m build

      - name: Publish to PyPI
        uses: pypa/gh-action-pypi-publish@release/v1
        # Uses trusted publishing - no API token needed
        # Configure at: https://pypi.org/manage/project/rex/settings/publishing/
```

**Acceptance Criteria:**
- [ ] Release workflow triggers on version tags
- [ ] Package builds successfully
- [ ] Package publishes to PyPI

---

## Phase 6: Performance & Profiling

### 6.1 Create Benchmark Suite

**Task:** Create performance benchmarks for critical paths.

**Create directory:** `benchmarks/`

**Create file:** `benchmarks/conftest.py`

```python
"""
Benchmark configuration and fixtures.
"""

import pytest


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "benchmark: mark test as a benchmark"
    )


@pytest.fixture
def benchmark_llm_config():
    """LLM config for benchmarks (uses mock)."""
    from util.config import LLMConfig
    return LLMConfig(
        provider="mock",
        model="benchmark-model",
        max_tokens=1000
    )
```

**Create file:** `benchmarks/bench_agent.py`

```python
"""
Agent execution benchmarks.
"""

import pytest
import time
from statistics import mean, stdev


class TestAgentBenchmarks:
    """Benchmark agent operations."""

    @pytest.mark.benchmark
    def test_plan_creation_latency(self, benchmark_llm_config, tool_registry):
        """Measure plan creation time."""
        from harness.agent.planner import Planner

        planner = Planner(llm_config=benchmark_llm_config)

        times = []
        for _ in range(10):
            start = time.perf_counter()
            # Mock plan creation
            planner.create_plan("Test task", [])
            elapsed = time.perf_counter() - start
            times.append(elapsed * 1000)  # Convert to ms

        avg_ms = mean(times)
        std_ms = stdev(times) if len(times) > 1 else 0

        print(f"\nPlan creation: {avg_ms:.2f}ms avg (±{std_ms:.2f}ms)")

        # Assert reasonable performance
        assert avg_ms < 100, f"Plan creation too slow: {avg_ms}ms"

    @pytest.mark.benchmark
    def test_tool_dispatch_overhead(self, tool_registry):
        """Measure tool registry dispatch overhead."""
        # Register a no-op tool
        def noop_tool(**kwargs):
            return {"result": "ok"}

        tool_registry.register("noop", noop_tool, "No-op tool")

        times = []
        for _ in range(100):
            start = time.perf_counter()
            tool_registry.execute("noop", {})
            elapsed = time.perf_counter() - start
            times.append(elapsed * 1000)

        avg_ms = mean(times)

        print(f"\nTool dispatch: {avg_ms:.4f}ms avg")

        # Should be very fast
        assert avg_ms < 1, f"Tool dispatch too slow: {avg_ms}ms"


class TestEventBusBenchmarks:
    """Benchmark event bus operations."""

    @pytest.mark.benchmark
    def test_message_throughput(self):
        """Measure event bus message throughput."""
        from communication.event_bus import EventBus

        bus = EventBus()
        received = []

        def handler(msg):
            received.append(msg)

        bus.subscribe("test", handler)

        num_messages = 1000
        start = time.perf_counter()

        for i in range(num_messages):
            bus.publish("test", {"index": i})

        elapsed = time.perf_counter() - start
        throughput = num_messages / elapsed

        print(f"\nEvent bus: {throughput:.0f} msg/sec")

        assert len(received) == num_messages
        assert throughput > 10000, f"Throughput too low: {throughput} msg/sec"
```

**Create file:** `benchmarks/bench_graphd.py`

```python
"""
Graphd (repository graph) benchmarks.
"""

import pytest
import time
import tempfile
from pathlib import Path


class TestGraphdBenchmarks:
    """Benchmark graphd operations."""

    @pytest.fixture
    def temp_db(self):
        """Create temporary database."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield Path(tmpdir) / "test.db"

    @pytest.mark.benchmark
    def test_symbol_lookup_latency(self, temp_db):
        """Measure symbol lookup time."""
        from harness.graphd.graphd import Graphd

        graphd = Graphd(db_path=str(temp_db))

        # Insert test data
        for i in range(1000):
            graphd.add_symbol(f"symbol_{i}", f"file_{i % 100}.py", i)

        times = []
        for _ in range(100):
            start = time.perf_counter()
            graphd.lookup_symbol("symbol_500")
            elapsed = time.perf_counter() - start
            times.append(elapsed * 1000)

        from statistics import mean
        avg_ms = mean(times)

        print(f"\nSymbol lookup: {avg_ms:.4f}ms avg")

        assert avg_ms < 10, f"Lookup too slow: {avg_ms}ms"

    @pytest.mark.benchmark
    def test_file_indexing_speed(self, temp_db):
        """Measure file indexing throughput."""
        from harness.graphd.graphd import Graphd

        graphd = Graphd(db_path=str(temp_db))

        # Create test files
        test_content = "def test_func():\n    pass\n" * 100

        start = time.perf_counter()
        for i in range(100):
            graphd.index_file(f"test_{i}.py", test_content)
        elapsed = time.perf_counter() - start

        throughput = 100 / elapsed

        print(f"\nFile indexing: {throughput:.1f} files/sec")

        assert throughput > 10, f"Indexing too slow: {throughput} files/sec"
```

**Acceptance Criteria:**
- [ ] Benchmark suite created in `benchmarks/`
- [ ] Key operations benchmarked (agent, tools, event bus, graphd)
- [ ] Performance baselines documented
- [ ] CI can run benchmarks (optional, separate job)

---

### 6.2 Add Memory Profiling Support

**Task:** Add memory profiling capability.

**Create file:** `scripts/profile_memory.py`

```python
#!/usr/bin/env python3
"""
Memory profiling script for rex.

Usage:
    python scripts/profile_memory.py [component]

Components:
    agent - Profile agent execution
    graphd - Profile graphd operations
    all - Profile all components
"""

import sys
import tracemalloc
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


def profile_agent():
    """Profile agent memory usage."""
    tracemalloc.start()

    from harness.agent.agent import Agent
    from util.config import LLMConfig
    from harness.agent.tool_registry import ToolRegistry

    # Create agent
    config = LLMConfig(provider="mock", model="test")
    registry = ToolRegistry()
    agent = Agent(llm_config=config, tool_registry=registry)

    # Take snapshot
    snapshot = tracemalloc.take_snapshot()
    top_stats = snapshot.statistics('lineno')

    print("\n=== Agent Memory Profile ===")
    print(f"Top 10 memory allocations:")
    for stat in top_stats[:10]:
        print(f"  {stat}")

    current, peak = tracemalloc.get_traced_memory()
    print(f"\nCurrent: {current / 1024 / 1024:.2f} MB")
    print(f"Peak: {peak / 1024 / 1024:.2f} MB")

    tracemalloc.stop()


def profile_graphd():
    """Profile graphd memory usage."""
    import tempfile
    tracemalloc.start()

    from harness.graphd.graphd import Graphd

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        graphd = Graphd(db_path=str(db_path))

        # Add test data
        for i in range(10000):
            graphd.add_symbol(f"symbol_{i}", f"file_{i % 100}.py", i)

        snapshot = tracemalloc.take_snapshot()
        top_stats = snapshot.statistics('lineno')

        print("\n=== Graphd Memory Profile ===")
        print(f"Top 10 memory allocations:")
        for stat in top_stats[:10]:
            print(f"  {stat}")

        current, peak = tracemalloc.get_traced_memory()
        print(f"\nCurrent: {current / 1024 / 1024:.2f} MB")
        print(f"Peak: {peak / 1024 / 1024:.2f} MB")

    tracemalloc.stop()


def main():
    component = sys.argv[1] if len(sys.argv) > 1 else "all"

    if component in ("agent", "all"):
        profile_agent()

    if component in ("graphd", "all"):
        profile_graphd()


if __name__ == "__main__":
    main()
```

**Acceptance Criteria:**
- [ ] Memory profiling script created
- [ ] Can profile individual components
- [ ] Output shows memory allocations and peak usage

---

## Phase 7: Documentation

### 7.1 Create CHANGELOG.md

**Task:** Create changelog following Keep a Changelog format.

**Create file:** `CHANGELOG.md`

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Production readiness improvements
- Comprehensive test coverage
- CI/CD pipeline with GitHub Actions
- Performance benchmarks

### Changed
- Pinned all dependencies with upper bounds
- Updated error handling with custom exception hierarchy

### Removed
- Removed empty `run_single.py`
- Removed malformed `config.json`

### Fixed
- Fixed backspace bug in TypeScript TUI

## [0.1.0] - 2024-XX-XX

### Added
- Initial release
- Multi-process voice agent architecture
- Plan → Execute → Reflect agent loop
- STT support (Whisper, Google, Azure)
- TTS support (pyttsx3, ElevenLabs)
- Tool registry with 20+ built-in tools
- Wizard orchestration mode (experimental)
- Graphd repository graph daemon
- Evaluation framework with LLM-as-judge
- CLI interface with multiple commands
- TUI interfaces (Python curses, TypeScript Ink)
- Docker support
- Comprehensive configuration system

[Unreleased]: https://github.com/your-org/rex/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/your-org/rex/releases/tag/v0.1.0
```

**Acceptance Criteria:**
- [ ] CHANGELOG.md created
- [ ] Follows Keep a Changelog format
- [ ] Links to GitHub releases

---

### 7.2 Create CONTRIBUTING.md

**Task:** Create contributing guidelines.

**Create file:** `CONTRIBUTING.md`

```markdown
# Contributing to rex

Thank you for your interest in contributing to rex!

## Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/your-org/rex.git
   cd rex
   ```

2. Create virtual environment:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # or `.venv\Scripts\activate` on Windows
   ```

3. Install development dependencies:
   ```bash
   pip install -e ".[dev]"
   ```

4. Install pre-commit hooks:
   ```bash
   pre-commit install
   ```

## Running Tests

```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=src --cov-report=html

# Run specific test file
pytest tests/test_agent.py

# Run specific test
pytest tests/test_agent.py::test_agent_initialization
```

## Code Style

We use the following tools for code quality:

- **black** - Code formatting
- **isort** - Import sorting
- **ruff** - Linting
- **mypy** - Type checking

Run all checks:
```bash
black src/ tests/
isort src/ tests/
ruff check src/ tests/
mypy src/
```

## Pull Request Process

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and commit:
   ```bash
   git add .
   git commit -m "feat: add your feature"
   ```

3. Push and create a pull request:
   ```bash
   git push origin feature/your-feature-name
   ```

4. Ensure CI passes before requesting review.

## Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation
- `style:` - Formatting
- `refactor:` - Code restructuring
- `test:` - Tests
- `chore:` - Maintenance

## Reporting Issues

Please include:
- Python version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs/error messages

## Questions?

Open a discussion on GitHub or reach out to the maintainers.
```

**Acceptance Criteria:**
- [ ] CONTRIBUTING.md created
- [ ] Includes setup instructions
- [ ] Includes code style guidelines
- [ ] Includes PR process

---

### 7.3 Add LICENSE File

**Task:** Add appropriate license file.

**Create file:** `LICENSE`

Choose appropriate license (MIT shown as example):

```
MIT License

Copyright (c) 2024 [Your Name/Organization]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Also update `pyproject.toml`:**
```toml
license = { text = "MIT" }
```

**Acceptance Criteria:**
- [ ] LICENSE file created
- [ ] `pyproject.toml` license field updated
- [ ] License classifier in pyproject.toml matches

---

### 7.4 Update README.md

**Task:** Update README for PyPI publication.

**Add to top of README.md:**

```markdown
# rex

[![PyPI version](https://badge.fury.io/py/rex.svg)](https://badge.fury.io/py/rex)
[![CI](https://github.com/your-org/rex/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/rex/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/your-org/rex/branch/main/graph/badge.svg)](https://codecov.io/gh/your-org/rex)
[![Python 3.9+](https://img.shields.io/badge/python-3.9+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A multi-process voice agent with Plan → Execute → Reflect architecture.

## Installation

```bash
# Basic installation (no audio)
pip install rex

# With audio support (macOS)
pip install rex[audio]

# Development
pip install rex[dev]

# Everything
pip install rex[all]
```
```

**Acceptance Criteria:**
- [ ] Badges added to README
- [ ] Installation instructions updated
- [ ] PyPI package name confirmed available

---

## Phase 8: Security Audit

### 8.1 Run Security Scanners

**Task:** Run security analysis tools and fix findings.

**Commands:**
```bash
# Install security tools
pip install bandit pip-audit safety

# Run bandit (code security)
bandit -r src/ -ll -f json -o bandit-report.json

# Run pip-audit (dependency vulnerabilities)
pip-audit --format json > pip-audit-report.json

# Run safety (alternative dep scanner)
safety check --json > safety-report.json
```

**Review and fix:**
- All HIGH severity findings must be fixed
- MEDIUM severity should be fixed or documented
- LOW severity can be documented as accepted risk

**Acceptance Criteria:**
- [ ] No HIGH severity findings
- [ ] MEDIUM findings fixed or documented
- [ ] Security reports saved

---

### 8.2 Audit Secrets Handling

**Task:** Ensure API keys and secrets are handled securely.

**Files to audit:**
- `src/util/config.py` - Config loading
- `src/util/llm_adapter.py` - LLM API calls
- Any file using `os.environ`

**Checklist:**
- [ ] API keys only loaded from environment variables
- [ ] No hardcoded secrets in code
- [ ] No secrets in config files committed to git
- [ ] `.env` in `.gitignore`
- [ ] Example `.env.example` file provided

**Create file:** `.env.example`

```bash
# LLM API Keys (required for respective providers)
OPENAI_API_KEY=sk-your-key-here
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Optional: Custom LLM endpoint
CUSTOM_LLM_ENDPOINT=https://api.example.com/v1

# Voice Agent Settings
VOICE_AGENT_HEADLESS=0
STT_DEVICE=auto

# Logging
LOG_LEVEL=INFO
```

**Acceptance Criteria:**
- [ ] No secrets in committed code
- [ ] `.env.example` created
- [ ] Documentation on required environment variables

---

### 8.3 Review Subprocess Calls

**Task:** Audit all subprocess usage for command injection risks.

**Find all subprocess usage:**
```bash
grep -rn "subprocess\|os.system\|os.popen\|shell=True" src/
```

**For each finding, verify:**
- [ ] No user input passed directly to shell
- [ ] `shell=False` used where possible
- [ ] Input sanitization for any dynamic commands
- [ ] Absolute paths used for executables

**Acceptance Criteria:**
- [ ] All subprocess calls audited
- [ ] No command injection vulnerabilities
- [ ] Findings documented

---

## Phase 9: PyPI Publication

### 9.1 Pre-Publication Checklist

**Verify all requirements:**

- [ ] **Code Quality**
  - [ ] All tests passing
  - [ ] Coverage ≥80%
  - [ ] No lint errors
  - [ ] No type errors

- [ ] **Documentation**
  - [ ] README.md complete
  - [ ] CHANGELOG.md up to date
  - [ ] CONTRIBUTING.md present
  - [ ] LICENSE file present

- [ ] **Packaging**
  - [ ] `pyproject.toml` complete
  - [ ] Version number correct
  - [ ] All classifiers accurate
  - [ ] Entry points working

- [ ] **Security**
  - [ ] No HIGH vulnerabilities
  - [ ] Secrets properly handled
  - [ ] Dependencies audited

### 9.2 Test Package Build

**Commands:**
```bash
# Clean previous builds
rm -rf dist/ build/ *.egg-info

# Build package
python -m build

# Verify package contents
tar -tzf dist/rex-0.1.0.tar.gz

# Check package metadata
twine check dist/*
```

### 9.3 Test on TestPyPI

**Commands:**
```bash
# Upload to TestPyPI
twine upload --repository testpypi dist/*

# Test installation from TestPyPI
pip install --index-url https://test.pypi.org/simple/ rex

# Verify it works
python -c "import rex; print(rex.__version__)"
voice-agent --version
```

### 9.4 Publish to PyPI

**Commands:**
```bash
# Create git tag
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0

# Upload to PyPI (or let GitHub Actions do it)
twine upload dist/*
```

### 9.5 Post-Publication Verification

**Commands:**
```bash
# Install from PyPI
pip install rex

# Verify installation
voice-agent --version
python -c "from harness.agent.agent import Agent; print('OK')"

# Test with audio (macOS)
pip install rex[audio]
voice-agent list-devices
```

**Acceptance Criteria:**
- [ ] Package available on PyPI
- [ ] `pip install rex` works
- [ ] `pip install rex[audio]` works on macOS
- [ ] CLI commands functional
- [ ] Import paths work correctly

---

## Phase 10: Observability (Optional)

### 10.1 Add OpenTelemetry Integration

**Task:** Add distributed tracing support.

**Add to `pyproject.toml`:**
```toml
[project.optional-dependencies]
telemetry = [
  "opentelemetry-api>=1.20.0",
  "opentelemetry-sdk>=1.20.0",
  "opentelemetry-exporter-otlp>=1.20.0",
]
```

**Create file:** `src/util/telemetry.py`

```python
"""
OpenTelemetry integration for distributed tracing.
"""

from typing import Optional
import os

try:
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
    HAS_TELEMETRY = True
except ImportError:
    HAS_TELEMETRY = False


_tracer: Optional["trace.Tracer"] = None


def init_telemetry(service_name: str = "rex") -> None:
    """Initialize OpenTelemetry tracing."""
    global _tracer

    if not HAS_TELEMETRY:
        return

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return

    provider = TracerProvider()
    processor = BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint))
    provider.add_span_processor(processor)
    trace.set_tracer_provider(provider)

    _tracer = trace.get_tracer(service_name)


def get_tracer() -> Optional["trace.Tracer"]:
    """Get the configured tracer."""
    return _tracer


def trace_span(name: str):
    """Decorator to trace a function."""
    def decorator(func):
        if not HAS_TELEMETRY or _tracer is None:
            return func

        def wrapper(*args, **kwargs):
            with _tracer.start_as_current_span(name):
                return func(*args, **kwargs)
        return wrapper
    return decorator
```

**Acceptance Criteria:**
- [ ] OpenTelemetry optional dependency added
- [ ] Telemetry module created
- [ ] Key operations traced
- [ ] Works without telemetry installed

---

### 10.2 Add Prometheus Metrics

**Task:** Add metrics endpoint for monitoring.

**Add to `pyproject.toml`:**
```toml
[project.optional-dependencies]
metrics = [
  "prometheus-client>=0.17.0",
]
```

**Create file:** `src/util/metrics.py`

```python
"""
Prometheus metrics for rex.
"""

from typing import Optional

try:
    from prometheus_client import Counter, Histogram, Gauge, start_http_server
    HAS_METRICS = True
except ImportError:
    HAS_METRICS = False


# Counters
if HAS_METRICS:
    REQUESTS_TOTAL = Counter(
        'rex_requests_total',
        'Total number of requests',
        ['status']
    )

    TOOL_CALLS_TOTAL = Counter(
        'rex_tool_calls_total',
        'Total tool invocations',
        ['tool_name', 'status']
    )

    LLM_CALLS_TOTAL = Counter(
        'rex_llm_calls_total',
        'Total LLM API calls',
        ['provider', 'model', 'status']
    )

    # Histograms
    REQUEST_LATENCY = Histogram(
        'rex_request_latency_seconds',
        'Request latency in seconds',
        buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0]
    )

    TOOL_LATENCY = Histogram(
        'rex_tool_latency_seconds',
        'Tool execution latency',
        ['tool_name'],
        buckets=[0.01, 0.05, 0.1, 0.5, 1.0, 5.0]
    )

    # Gauges
    ACTIVE_AGENTS = Gauge(
        'rex_active_agents',
        'Number of active agent instances'
    )


def start_metrics_server(port: int = 8000) -> None:
    """Start Prometheus metrics HTTP server."""
    if HAS_METRICS:
        start_http_server(port)
```

**Acceptance Criteria:**
- [ ] Prometheus optional dependency added
- [ ] Metrics module created
- [ ] Key metrics defined
- [ ] Metrics server can be started

---

## Summary

| Phase | Priority | Effort | Status |
|-------|----------|--------|--------|
| Phase 1: Dead Code | High | Small | [ ] |
| Phase 2: Error Handling | High | Medium | [ ] |
| Phase 3: Dependencies | High | Small | [ ] |
| Phase 4: Tests | High | Medium | [ ] |
| Phase 5: CI/CD | High | Medium | [ ] |
| Phase 6: Performance | Medium | Medium | [ ] |
| Phase 7: Documentation | High | Small | [ ] |
| Phase 8: Security | High | Medium | [ ] |
| Phase 9: PyPI | High | Small | [ ] |
| Phase 10: Observability | Low | Large | [ ] |

**Estimated total effort:** 2-4 weeks depending on team size and priorities.

---

## Appendix: File Checklist

### Files to Create
- [ ] `src/util/exceptions.py`
- [ ] `.github/workflows/ci.yml`
- [ ] `.github/workflows/release.yml`
- [ ] `benchmarks/conftest.py`
- [ ] `benchmarks/bench_agent.py`
- [ ] `benchmarks/bench_graphd.py`
- [ ] `scripts/profile_memory.py`
- [ ] `tests/test_cli.py`
- [ ] `tests/test_error_recovery.py`
- [ ] `CHANGELOG.md`
- [ ] `CONTRIBUTING.md`
- [ ] `LICENSE`
- [ ] `.env.example`
- [ ] `requirements.lock`

### Files to Delete
- [ ] `run_single.py`
- [ ] `config.json`

### Files to Modify
- [ ] `pyproject.toml` - Dependencies, classifiers, URLs
- [ ] `README.md` - Badges, installation
- [ ] `pytest.ini` - Coverage threshold
- [ ] `src/app/cli.py` - Exception handling
- [ ] `run_tui.py` - Exception handling
- [ ] `run_app.py` - Exception handling
- [ ] `run_multi.py` - Exception handling
