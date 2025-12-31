# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a multi-process voice agent system ("rex") with STT, agent harness, TTS, and RL components. The core agent uses a **Plan → Execute → Reflect** architecture with tool execution capabilities.

## Common Commands

### Setup
```bash
# Create virtual environment and install
./scripts/setup_env.sh
source .venv/bin/activate
pip install -e ".[dev]"     # Dev dependencies
pip install -e ".[audio]"   # Audio dependencies (PyAudio, TTS)
```

### Running
```bash
# CLI entry point
voice-agent

# TUI interface
python run_tui.py

# With Docker
docker-compose up voice-agent
```

### Testing
```bash
pytest                                    # Run all tests
pytest tests/test_agent.py               # Single test file
pytest tests/test_agent.py::test_name    # Single test
pytest --cov=src                         # With coverage
PYTHONPATH=src python3 -m pytest         # If import issues
```

### Linting
```bash
black src/ tests/
isort src/ tests/
ruff check src/ tests/
```

### Evaluation Framework
```bash
python scripts/run_eval.py                          # Run all evals
python scripts/run_eval.py --categories search code # Specific categories
python scripts/run_eval.py --agent-config my_agent  # Custom agent
```

## Architecture

### Core Components

```
src/
├── harness/           # Agent orchestration layer
│   ├── agent/         # Plan→Execute→Reflect agent
│   │   ├── agent.py       # Main Agent class with tiered execution
│   │   ├── planner.py     # Creates execution plans
│   │   ├── executor.py    # Runs plans step-by-step
│   │   ├── reflector.py   # Evaluates goal achievement
│   │   ├── tool_registry.py # Tool management
│   │   └── wizard/        # Adaptive Wizard+Worker architecture (experimental)
│   ├── graphd/        # Repository graph daemon (SQLite-based)
│   ├── context_manager/   # Context window management
│   └── harness.py     # AgentHarness orchestrator
├── services/          # Audio, language, routing services
├── communication/     # Event bus, IPC, process management
├── workers/           # TTS, service rep, audio workers
├── evals/             # Evaluation framework with LLM-as-judge
├── rl/                # Reinforcement learning components
└── util/              # Config, logging, LLM adapters
```

### Agent Tiers
- **simple**: 1 tool call, 4096 tokens - quick responses
- **standard**: 15 tool calls, 16000 tokens - typical tasks
- **advanced**: 30 tool calls, 32000 tokens - complex multi-step

### Key Abstractions

**AgentHarness** (`src/harness/harness.py`): Main orchestrator that owns the agent lifecycle, provides control interface (stop/pause/inject_context), and emits progress via callbacks.

**Agent** (`src/harness/agent/agent.py`): Executes Plan→Execute→Reflect loop. Creates plans with success criteria, executes tools, and reflects on goal achievement.

**Wizard** (`src/harness/agent/wizard/`): Experimental adaptive orchestration layer with single-writer global state (PlanState, WorkLedger, KnowledgeStore) that dispatches bounded work to stateless Workers. Enable with `AGENT_USE_WIZARD=1`.

**Graphd** (`src/harness/graphd/`): Background daemon maintaining a two-tier repository graph:
- Tier A: Persistent SQLite (files, symbols, module edges)
- Tier B: Ephemeral derived edges (call sites, computed lazily)

**ToolRegistry**: Central registry for all tools. Tools have enable/disable, working directory context, and resilience features.

### Configuration

- `config/app_config.json` - Runtime and service configuration
- `config/harness_config.json` - Agent tier, tools, LLM settings
- `config/rules.md` - Default coding rules (overridable per-repo)

Environment variables for API keys:
```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

### LLM Providers

Configured in `src/util/config.py` via `LLMConfig`:
- `provider`: openai, anthropic, custom
- `model`: gpt-4o-mini (default), claude-sonnet, etc.
- Supports failover models, circuit breaker, retries

## Critical Development Rules

### No Dead Code or Hidden Features

**Every feature must be testable and actually executing.** When implementing a feature:

1. **Verify the code path is reachable**: Don't leave code behind flags that are always off, or integration points that are never called. If you add code, it must be exercised by the main execution path or explicitly tested.

2. **No orphaned implementations**: If you write a class or function, ensure it's actually instantiated and called somewhere. Check the import chain and call sites.

3. **Test that it runs, not just that it exists**: Write tests that verify the feature's behavior, not just that the code parses. Integration tests > unit tests for critical paths.

4. **Remove what you're replacing**: If refactoring, delete the old code. Don't leave it commented out or behind a flag "just in case."

5. **Avoid disabled-by-default flags**: If a feature needs a flag, document why and when it should be enabled. Prefer features that are on by default with tests proving they work.

**Before marking a feature complete**, verify:
- [ ] The code is called from a live execution path (not just importable)
- [ ] Tests exercise the actual behavior, not mocked-out stubs
- [ ] No `if False:`, `if NEVER_SET_FLAG:`, or similar dead branches
- [ ] The feature can be demonstrated working in `run_tui.py` or `voice-agent` CLI

## Code Conventions

- **Modular design**: Keep configuration separate from logic
- **pytest for Python testing** with `tests/conftest.py` for fixtures
- **Black + isort + ruff** for formatting/linting
- **Dataclasses** for structured data (AgentConfig, HarnessConfig, etc.)
- **Type hints** throughout the codebase
- Line length: 100 characters

### .gitignore Hygiene

**Always add generated/dependency directories to `.gitignore` when creating them:**
- `node_modules/` - Node.js dependencies
- `venv/`, `.venv/` - Python virtual environments
- `dist/`, `build/` - Build output directories
- `*.lock`, `bun.lockb`, `package-lock.json`, `yarn.lock` - Lock files (optional, but typically ignored in applications)
- `__pycache__/`, `*.pyc` - Python bytecode
- `.env` - Environment files with secrets

Before committing, run `git status` to verify no dependency directories or generated files are staged.

## Feature Flags

- `AGENT_USE_WIZARD=1`: Enable Wizard orchestration (experimental)
- `VOICE_AGENT_HEADLESS=1`: Run without audio devices
- `STT_DEVICE=cpu|cuda|mps|auto`: STT device selection
