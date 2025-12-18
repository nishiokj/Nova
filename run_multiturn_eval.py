#!/usr/bin/env python3
"""
Multi-Turn Evaluation Runner CLI

Usage:
    python 
      --task-file src/evals/example_multiturn_tasks.json --output-dir evals/results/run1

Features:
- Runs multi-turn evaluation tasks
- Complete isolation and state tracking
- Generates human-reviewable HTML reports
- Captures full prompts, tool traces, and latency metrics
- Handles edge cases robustly

Example:
    # Run all tasks
    python run_multiturn_eval.py --task-file src/evals/example_multiturn_tasks.json

    # Run specific task
    python run_multiturn_eval.py --task-file src/evals/example_multiturn_tasks.json --task-id multiturn_code_dev_001

    # Use different model/tier
    python run_multiturn_eval.py --task-file src/evals/example_multiturn_tasks.json --tier advanced --model claude-opus-4-5
"""

import argparse
import json
import sys
from pathlib import Path
from datetime import datetime

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from evals.multiturn_runner import MultiTurnEvalRunner, load_multiturn_tasks
from evals.redaction import RedactionLevel


def load_agent_config(config_path: Path, agent_name: str = None) -> dict:
    """Load agent configuration from JSON file."""
    with open(config_path) as f:
        all_configs = json.load(f)

    # If agent name specified, use that config
    if agent_name and agent_name in all_configs.get("agents", {}):
        return all_configs["agents"][agent_name]

    # Otherwise use default
    return all_configs.get("default_agent", {})


def main():
    parser = argparse.ArgumentParser(
        description="Run multi-turn agent evaluations with human-reviewable output"
    )

    # Required
    parser.add_argument(
        "--task-file",
        type=Path,
        required=True,
        help="Path to JSON file containing multi-turn tasks"
    )

    # Config file option
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("src/evals/configs/agent_config.json"),
        help="Path to agent config JSON file (default: src/evals/configs/agent_config.json)"
    )

    parser.add_argument(
        "--agent",
        type=str,
        default=None,
        help="Agent name from config file (e.g., 'claude_sonnet', 'tiered_standard'). Uses default if not specified."
    )

    # Optional
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Output directory for results (default: evals/results/run_TIMESTAMP)"
    )

    parser.add_argument(
        "--task-id",
        type=str,
        default=None,
        help="Run only this specific task ID"
    )

    parser.add_argument(
        "--tier",
        type=str,
        default=None,
        help="Override agent tier (simple/standard/advanced)"
    )

    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Override model (e.g., claude-sonnet-4-5)"
    )

    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="Temperature for generation (0.0 for deterministic)"
    )

    parser.add_argument(
        "--random-seed",
        type=int,
        default=None,
        help="Random seed for reproducibility"
    )

    parser.add_argument(
        "--redaction-level",
        type=str,
        default="standard",
        choices=["minimal", "standard", "strict"],
        help="Level of redaction for sensitive info"
    )

    parser.add_argument(
        "--no-redact",
        action="store_true",
        help="Disable redaction (WARNING: may expose secrets)"
    )

    parser.add_argument(
        "--no-html",
        action="store_true",
        help="Skip HTML export"
    )

    args = parser.parse_args()

    # Validate task file
    if not args.task_file.exists():
        print(f"Error: Task file not found: {args.task_file}")
        sys.exit(1)

    # Load agent config from file
    if args.config.exists():
        agent_config = load_agent_config(args.config, args.agent)
        llm_config = agent_config.get("llm_config", {})

        # Use config file values as defaults, CLI args override
        if args.tier is None:
            args.tier = agent_config.get("tier", "standard")
        if args.model is None:
            args.model = llm_config.get("model", "gpt-4o")
        if args.temperature == 0.0:  # Default value
            args.temperature = llm_config.get("temperature", 0.0)

        config_source = f"Config: {args.config}"
        if args.agent:
            config_source += f" (agent: {args.agent})"
    else:
        print(f"Warning: Config file not found: {args.config}")
        # Fall back to hardcoded defaults
        if args.tier is None:
            args.tier = "standard"
        if args.model is None:
            args.model = "gpt-4o"
        config_source = "Defaults (config file not found)"

    # Set output directory
    if args.output_dir is None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        args.output_dir = Path(f"evals/results/multiturn_run_{timestamp}")

    print(f"""
{'='*70}
Multi-Turn Evaluation Runner
{'='*70}

Configuration:
  {config_source}
  Task file:       {args.task_file}
  Output dir:      {args.output_dir}
  Tier:            {args.tier}
  Model:           {args.model}
  Temperature:     {args.temperature}
  Random seed:     {args.random_seed}
  Redaction:       {args.redaction_level if not args.no_redact else 'disabled'}

{'='*70}
""")

    # Load tasks
    print("Loading tasks...")
    try:
        all_tasks = load_multiturn_tasks(args.task_file)
        print(f"Loaded {len(all_tasks)} tasks")
    except Exception as e:
        print(f"Error loading tasks: {e}")
        sys.exit(1)

    # Filter by task ID if specified
    if args.task_id:
        all_tasks = [t for t in all_tasks if t.task_id == args.task_id]
        if not all_tasks:
            print(f"Error: Task ID '{args.task_id}' not found")
            sys.exit(1)
        print(f"Running only task: {args.task_id}")

    # Create runner
    redaction_level = (
        RedactionLevel.MINIMAL if args.no_redact
        else RedactionLevel[args.redaction_level.upper()]
    )

    runner = MultiTurnEvalRunner(
        output_dir=str(args.output_dir),
        tier=args.tier,
        model=args.model,
        temperature=args.temperature,
        random_seed=args.random_seed,
        redaction_level=redaction_level,
        preserve_artifacts=True
    )

    # Run tasks
    results = []
    failed = []

    for i, task in enumerate(all_tasks, 1):
        print(f"\n{'='*70}")
        print(f"Task {i}/{len(all_tasks)}: {task.name}")
        print(f"{'='*70}\n")

        try:
            result = runner.run_task(task)
            results.append(result)

            # Export HTML
            if not args.no_html:
                print("\nExporting HTML...")
                html_path = runner.export_html(
                    result,
                    redact=not args.no_redact
                )
                print(f"✓ HTML report: {html_path}")

            if result.scenario.scenario_passed:
                print(f"✓ Task PASSED")
            else:
                print(f"✗ Task FAILED")
                failed.append(task.task_id)

        except Exception as e:
            print(f"✗ Error running task: {e}")
            import traceback
            traceback.print_exc()
            failed.append(task.task_id)

    # Summary
    print(f"\n{'='*70}")
    print("EVALUATION SUMMARY")
    print(f"{'='*70}")
    passed_count = sum(1 for r in results if r.scenario.scenario_passed)
    failed_task_ids = {t.task_id for t in all_tasks} - {r.scenario.task_id for r in results if r.scenario.scenario_passed}
    failed_count = len(all_tasks) - passed_count

    print(f"Total tasks:     {len(all_tasks)}")
    print(f"Passed:          {passed_count}")
    print(f"Failed:          {failed_count}")
    print(f"\nResults saved to: {args.output_dir}")

    if not args.no_html:
        html_dir = args.output_dir / "html"
        print(f"\nHTML reports:     {html_dir}")
        print("\nOpen HTML files in your browser to review results manually.")

    if failed or failed_task_ids:
        print(f"\nFailed tasks:")
        for task_id in sorted(set(failed) | failed_task_ids):
            print(f"  - {task_id}")

    print(f"{'='*70}\n")


if __name__ == "__main__":
    main()
