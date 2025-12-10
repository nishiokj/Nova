# Agent Evaluation System

Comprehensive evaluation framework for testing agent performance across different models, prompts, and architectures.

## Overview

This evaluation system provides:
- **52 diverse tasks** covering multi-step reasoning, code operations, file operations, and search/synthesis
- **LLM-as-judge grading** with bullet-proof, discrete rubrics for reproducible scoring
- **Real tool execution** with proper isolation and cleanup
- **Batched grading** for efficient parallel processing
- **Statistical A/B testing** with significance testing
- **Rich visualizations** with matplotlib charts
- **Modular design** easily adaptable to different agents/LLMs

## Quick Start

### List Available Agent Configurations

```bash
python scripts/run_eval.py --list-agents
```

### Run Full Evaluation (52 tasks)

```bash
# Use default agent config
python scripts/run_eval.py

# Use specific agent config
python scripts/run_eval.py --agent-config tiered_advanced

# Override model from config
python scripts/run_eval.py --agent-config tiered_advanced --model gpt-4-turbo
```

### Quick Evaluation (10 representative tasks)

```bash
python scripts/run_eval.py --quick --num-tasks 10
```

### Test Specific Category

```bash
python scripts/run_eval.py --category code_ops --agent-config claude_sonnet
```

### Compare Two Runs

```bash
python scripts/compare_runs.py run_20250110_143022.json run_20250110_150133.json
```

## Task Distribution

**Total: 52 tasks**

- **Multi-Step Reasoning (15 tasks)**: Chain of calculations, research synthesis, trade-off analysis, decision-making
- **Code Operations (15 tasks)**: Function generation, debugging, algorithm implementation, data structures
- **File Operations (12 tasks)**: Directory structures, CSV/JSON processing, text manipulation, log parsing
- **Search & Synthesis (10 tasks)**: Current info lookup, fact checking, technical documentation, comparative research

**By Difficulty:**
- Simple: 8 tasks
- Standard: 25 tasks
- Advanced: 19 tasks

## Key Features

### 1. Standardized Scoring

**Zero-Noise Grading:**
- Temperature 0 for judge LLM (deterministic)
- Binary yes/no questions (no ambiguous "rate 1-10")
- Evidence-based reasoning required
- Automated checks before LLM judgment
- All rubrics sum to exactly 100 points

**Evaluation Methods:**
- `exact_match`: String matching
- `contains`: Substring/tool usage checking
- `regex`: Pattern matching
- `file_exists`: File system validation
- `python_test`: Test case execution
- `llm_judge`: Binary yes/no with evidence

### 2. Batched Grading

The system processes grading in parallel batches (default: 5 tasks at a time) for significant speedup:

```python
# Adjust batch size
python scripts/run_eval.py --batch-size 10 --model gpt-4o
```

Benefits:
- 5x faster grading with batch_size=5
- Efficient LLM API usage
- Configurable parallelism

### 3. Test Isolation

Each task executes in an isolated temporary directory:
- Clean environment per task
- No task interference
- Automatic cleanup
- Timeout enforcement

### 4. Comprehensive Metrics

**Overall Metrics:**
- Pass rate (% tasks ≥ 70 points)
- Score distribution (mean, median, std dev, percentiles)
- Execution time analysis
- Tool usage statistics
- Failure mode categorization

**Breakdown By:**
- Category (multi-step, code, file, search)
- Difficulty (simple, standard, advanced)
- Individual tasks

### 5. Statistical A/B Testing

Compare two runs with rigorous statistical analysis:
- Paired t-test for significance (α=0.05)
- Cohen's d effect size
- Regression detection
- Improvement tracking
- Task-by-task comparison

## Agent Configuration

The evaluation system uses **configuration files** to specify which agent to test, making it easy to swap between different agent implementations or models.

### Configuration File: `evals/configs/agent_config.json`

```json
{
  "default_agent": {
    "type": "TieredAgent",
    "module": "harness.agent",
    "class": "TieredAgent",
    "tier": "advanced",
    "llm_config": {
      "provider": "openai",
      "model": "gpt-4o",
      "temperature": 0.7
    }
  },
  "agents": {
    "claude_sonnet": {
      "type": "TieredAgent",
      "tier": "advanced",
      "llm_config": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-5",
        "temperature": 0.7
      }
    }
  }
}
```

### Using Agent Configs

```bash
# List all available agent configurations
python scripts/run_eval.py --list-agents

# Use default agent (from config file)
python scripts/run_eval.py --quick

# Use specific agent config
python scripts/run_eval.py --agent-config tiered_advanced

# Override model from config
python scripts/run_eval.py --agent-config tiered_simple --model gpt-4-turbo

# Override provider
python scripts/run_eval.py --agent-config default_agent --provider anthropic

# Override temperature
python scripts/run_eval.py --agent-config claude_sonnet --temperature 0.5
```

### Router-Based Agent (Dynamic Tier Selection)

The **routed_agent** configuration fully mimics your production system by using the Router to classify each task and dynamically select the appropriate tier:

```json
{
  "routed_agent": {
    "type": "RoutedAgent",
    "use_router": true,
    "router_config": {
      "enabled": true,
      "llm_config": {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "temperature": 0.1
      }
    },
    "tier_configs": {
      "simple": {"provider": "openai", "model": "gpt-4o-mini", "temperature": 0.5},
      "standard": {"provider": "openai", "model": "gpt-4o", "temperature": 0.7},
      "advanced": {"provider": "openai", "model": "gpt-4o", "temperature": 0.7}
    }
  }
}
```

**How it works:**
1. Router classifies each eval task (simple/standard/advanced)
2. Appropriate tier is selected based on classification
3. Task executes with tier-specific model and prompts

**Usage:**
```bash
# Use routed agent (mimics production system)
python scripts/run_eval.py --agent-config routed_agent --quick

# Test router with full eval suite
python scripts/run_eval.py --agent-config routed_agent
```

This is the **most realistic** evaluation mode as it tests your full routing + tiered execution pipeline.

### Adding Custom Agents

To test your own agent implementation:

1. **Add config to `agent_config.json`:**

```json
{
  "agents": {
    "my_custom_agent": {
      "type": "CustomAgent",
      "module": "my_module.agents",
      "class": "MyAgentClass",
      "init_params": {
        "custom_param": "value"
      },
      "llm_config": {
        "provider": "openai",
        "model": "gpt-4o",
        "temperature": 0.7
      }
    }
  }
}
```

2. **Run evaluation:**

```bash
python scripts/run_eval.py --agent-config my_custom_agent
```

The system will automatically import and instantiate your agent class!

## CLI Usage

### run_eval.py

```bash
# Full evaluation with default agent
python scripts/run_eval.py

# Use specific agent config
python scripts/run_eval.py --agent-config tiered_advanced

# Quick evaluation
python scripts/run_eval.py --quick --num-tasks 10

# Category filter
python scripts/run_eval.py --category code_ops

# Difficulty filter
python scripts/run_eval.py --difficulty advanced

# Specific tasks
python scripts/run_eval.py --task-ids multi_step_001 code_002

# Override model from config
python scripts/run_eval.py --agent-config default_agent --model gpt-4-turbo

# Parallel execution
python scripts/run_eval.py --parallel --max-workers 5

# Use a configured judge
python scripts/run_eval.py --judge-config default_judge

# List judge configs
python scripts/run_eval.py --list-judges

# Skip visualization
python scripts/run_eval.py --no-viz
```

**Options:**
- `--agent-config`: Agent config name (default: default_agent)
- `--list-agents`: List available agent configs and exit
- `--model`: Override model from config
- `--provider`: Override LLM provider
- `--temperature`: Override temperature
- `--quick`: Run quick evaluation
- `--num-tasks`: Number for quick eval (default: 10)
- `--category`: Filter by category
- `--difficulty`: Filter by difficulty
- `--task-ids`: Run specific tasks
- `--judge-config`: Judge config name from `evals/configs/judge_config.json` (default: default_judge)
- `--list-judges`: List available judge configs and exit
- `--judge-model`: Override judge model from selected config
- `--judge-provider`: Override judge provider from selected config
- `--judge-temperature`: Override judge temperature from selected config
- `--judge-max-tokens`: Override judge max_tokens from selected config
- `--batch-size`: Grading batch size (default: 5)
- `--parallel`: Execute tasks in parallel
- `--max-workers`: Parallel workers (default: 3)
- `--output`: Output directory
- `--no-viz`: Skip visualization

### compare_runs.py

```bash
# Compare two runs
python scripts/compare_runs.py RUN_A.json RUN_B.json

# Custom output
python scripts/compare_runs.py RUN_A.json RUN_B.json --output DIR

# Skip visualization
python scripts/compare_runs.py RUN_A.json RUN_B.json --no-viz
```

## Output Files

```
evals/results/
├── run_TIMESTAMP.json              # Full results with all data
└── run_TIMESTAMP/                  # Visualization directory
    ├── dashboard.png               # 2x2 overview dashboard
    ├── score_distribution.png      # Histogram and box plot
    ├── category_performance.png    # By category breakdown
    ├── execution_times.png         # Time analysis
    ├── failure_analysis.png        # Failure mode pie chart
    └── task_results.png            # Per-task bar chart
```

## Architecture

### Core Components

1. **eval_task.py**: Data structures (EvalTask, GradingRubric, EvalResult, EvalRun)
2. **grading.py**: LLM-as-judge implementation with 6 evaluation methods
3. **isolation.py**: IsolatedEnvironment and TaskExecutor for test isolation
4. **eval_runner.py**: Main orchestration with batched grading
5. **metrics.py**: MetricsCalculator and RunComparator for analysis
6. **visualization.py**: EvalVisualizer for matplotlib charts

### Task Organization

```
evals/tasks/
├── task_registry.py         # Central registry with all 52 tasks
├── multi_step_reasoning.py  # 15 reasoning tasks
├── code_operations.py       # 15 code tasks
├── file_operations.py       # 12 file tasks
└── search_synthesis.py      # 10 search tasks
```

### Rubrics

```
evals/rubrics/
├── category_rubrics.py      # Standardized rubrics for each category
└── rubric_templates.py      # Template utilities for custom rubrics
```

## Programmatic Usage

```python
from evals.eval_runner import EvalRunner
from evals.tasks.task_registry import get_all_tasks
from evals.judge_loader import load_judge_config
from harness.llm_adapter import LLMConfig, create_adapter

# Create agent factory
def agent_factory():
    return create_my_agent()

# Create judge LLM (temperature=0!) from the shared JSON config
judge_settings = load_judge_config()
judge_config = LLMConfig(
    provider=judge_settings["provider"],
    model=judge_settings["model"],
    temperature=judge_settings.get("temperature", 0),
    max_tokens=judge_settings.get("max_tokens", 4000)
)
judge_llm = create_adapter(judge_config)

# Run evaluation
runner = EvalRunner(
    agent_factory=agent_factory,
    judge_llm=judge_llm,
    output_dir="results",
    batch_size=5
)

tasks = get_all_tasks()
eval_run = runner.run_evaluation(tasks)

# Access results
print(f"Pass rate: {eval_run.metrics['pass_rate']}")
print(f"Mean score: {eval_run.metrics['mean_score']}")
```

## Adding Custom Tasks

```python
from evals.eval_task import EvalTask
from evals.rubrics.category_rubrics import CODE_GENERATION_RUBRIC

custom_task = EvalTask(
    task_id="custom_001",
    category="code_ops",
    difficulty="standard",
    prompt="Write a Python function that...",
    expected_behavior="Create working function with...",
    success_criteria=[
        "File created",
        "Function works correctly",
        "Handles edge cases"
    ],
    rubric=CODE_GENERATION_RUBRIC,
    timeout_seconds=120,
    requires_tools=["file_write", "python_execute"],
    tags=["custom", "python"]
)
```

## Configuration

### eval_config.json

```json
{
  "default_batch_size": 5,
  "default_timeout_seconds": 120,
  "quick_eval_task_count": 10,
  "parallel_execution": {
    "enabled": false,
    "max_workers": 3
  }
}
```

### judge_config.json

```json
{
  "default_judge": {
    "provider": "openai",
    "model": "gpt-5.1",
    "temperature": 0,
    "max_tokens": 4000,
    "note": "Temperature MUST be 0 for reproducible grading"
  },
  "alternative_judges": {
    "gpt4": {
      "provider": "openai",
      "model": "gpt-4-turbo",
      "temperature": 0,
      "max_tokens": 4000
    },
    "claude_sonnet": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "temperature": 0,
      "max_tokens": 4000
    }
  },
  "grading_parameters": {
    "require_evidence": true,
    "binary_questions_only": true,
    "temperature": 0,
    "deterministic_mode": true
  },
  "retry_policy": {
    "max_retries": 2,
    "retry_on_parse_failure": true,
    "retry_delay_seconds": 1
  }
}
```

Use `--judge-config` or `load_judge_config()` to select one of these entries (run `python scripts/run_eval.py --list-judges` to inspect the names).

## Design Principles

1. **Zero Noise**: Temperature 0, binary questions, discrete points
2. **Evidence-Based**: Judge must cite evidence, not subjective ratings
3. **Atomic Criteria**: Break complex judgments into simple yes/no
4. **Automated First**: Use pattern matching before LLM judge
5. **Real Execution**: No mocks - test with actual tools
6. **Isolation**: Each task in clean temp directory
7. **Modularity**: Factory pattern for easy agent swapping
8. **Transparency**: Full judge reasoning saved for debugging
9. **Statistical Rigor**: Proper significance testing for A/B
10. **Comprehensive Coverage**: Test all aspects (reasoning, code, files, search)

## Best Practices

### For Reliable Scores

1. Always use temperature=0 for judge
2. Run full evaluation (52 tasks) for reliable statistics
3. Use same judge model for A/B comparisons
4. Check for statistical significance (p < 0.05)
5. Look at Cohen's d for effect size

### For Quick Iteration

1. Use `--quick` flag with 10-15 tasks
2. Test specific categories during development
3. Use `--parallel` for faster execution
4. Increase `--batch-size` if you have API quota

### For A/B Testing

1. Run both configurations with identical tasks
2. Check regression count (tasks that failed in B)
3. Look at improvement count (tasks that passed in B)
4. Verify statistical significance
5. Consider effect size (small/medium/large)

## Troubleshooting

**Timeout Errors:**
- Increase `--timeout` for complex tasks
- Check if agent is stuck in infinite loop

**API Rate Limits:**
- Reduce `--batch-size`
- Add delays in eval_runner.py
- Use `--no-parallel` for execution

**Inconsistent Scores:**
- Verify judge temperature is 0
- Check rubric criteria sum to 100
- Look at judge_reasoning for specific tasks

**Installation:**
```bash
pip install scipy numpy matplotlib seaborn
```

## Example Workflows

### Test New Model

```bash
# Baseline
python scripts/run_eval.py --model gpt-4o --run-id baseline

# New model
python scripts/run_eval.py --model gpt-4-turbo --run-id new_model

# Compare
python scripts/compare_runs.py baseline.json new_model.json
```

### Test Prompt Changes

```bash
# Before
python scripts/run_eval.py --model gpt-4o --tier standard --run-id before_prompt

# After (modify prompts_config.json)
python scripts/run_eval.py --model gpt-4o --tier standard --run-id after_prompt

# Compare
python scripts/compare_runs.py before_prompt.json after_prompt.json
```

### Quick Sanity Check

```bash
# 10 tasks across categories
python scripts/run_eval.py --quick --num-tasks 10 --model gpt-4o
```

## License

MIT
