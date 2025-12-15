#!/usr/bin/env python3
"""
CLI tool for running agent evaluations.

Usage:
    python scripts/run_eval.py --model gpt-4o --tier advanced
    python scripts/run_eval.py --quick --num-tasks 10
    python scripts/run_eval.py --category multi_step_reasoning
"""

import argparse
import logging
import sys
from dataclasses import fields
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from evals.eval_runner import EvalRunner, AgentFactory
from evals.tasks.task_registry import get_all_tasks, get_tasks_by_category
from evals.agent_loader import create_agent_from_config, list_available_agents, print_available_agents
from evals.judge_loader import load_judge_config, list_available_judges
from util.config import LLMConfig
from util.llm_adapter import create_adapter


# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

LLM_CONFIG_FIELD_NAMES = {field.name for field in fields(LLMConfig)}


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Run agent evaluation suite",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run full evaluation (52 tasks)
  python scripts/run_eval.py --model gpt-4o --tier advanced

  # Quick evaluation (10 tasks)
  python scripts/run_eval.py --quick --num-tasks 10 --model gpt-4o

  # Test specific category
  python scripts/run_eval.py --category code_ops --model claude-sonnet-4-5

  # Use custom judge config
  python scripts/run_eval.py --model gpt-4o --judge-config default_judge

  # List judge configs
  python scripts/run_eval.py --list-judges

  # Parallel execution
  python scripts/run_eval.py --parallel --max-workers 5 --model gpt-4o
        """
    )

    # Agent configuration
    parser.add_argument('--agent-config', default='default_agent',
                       help='Agent configuration name from agent_config.json (default: default_agent)')
    parser.add_argument('--list-agents', action='store_true',
                       help='List available agent configurations and exit')

    # Overrides for agent config
    parser.add_argument('--model',
                       help='Override model from config (e.g., gpt-4o, claude-sonnet-4-5)')
    parser.add_argument('--provider',
                       help='Override LLM provider (openai, anthropic)')
    parser.add_argument('--temperature', type=float,
                       help='Override LLM temperature')

    # Task selection
    parser.add_argument('--quick', action='store_true',
                       help='Run quick evaluation with subset of tasks')
    parser.add_argument('--num-tasks', type=int, default=10,
                       help='Number of tasks for quick evaluation (default: 10)')
    parser.add_argument('--category',
                       choices=['multi_step_reasoning', 'code_ops', 'file_ops', 'search_synthesis'],
                       help='Run only tasks from specific category')
    parser.add_argument('--difficulty',
                       choices=['simple', 'standard', 'advanced'],
                       help='Run only tasks of specific difficulty')
    parser.add_argument('--task-ids', nargs='+',
                       help='Run specific tasks by ID (e.g., multi_step_001 code_002)')

    # Judge configuration
    parser.add_argument('--judge-config', default='default_judge',
                       help='Judge config name from evals/configs/judge_config.json')
    parser.add_argument('--list-judges', action='store_true',
                       help='List configured judge models and exit')
    parser.add_argument('--judge-model',
                       help='Override judge model from selected config')
    parser.add_argument('--judge-provider',
                       help='Override judge provider from selected config')
    parser.add_argument('--judge-temperature', type=float,
                       help='Override judge temperature from selected config')
    parser.add_argument('--judge-max-tokens', type=int,
                       help='Override judge max_tokens from selected config')
    parser.add_argument('--batch-size', type=int, default=5,
                       help='Batch size for grading (default: 5)')

    # Execution options
    parser.add_argument('--parallel', action='store_true',
                       help='Execute tasks in parallel')
    parser.add_argument('--max-workers', type=int, default=3,
                       help='Max parallel workers for execution (default: 3)')

    # Output options
    parser.add_argument('--output', default='evals/results',
                       help='Output directory (default: evals/results)')
    parser.add_argument('--run-id',
                       help='Custom run ID (default: auto-generated)')
    parser.add_argument('--no-viz', action='store_true',
                       help='Skip visualization generation')

    return parser.parse_args()


def create_agent_factory(args):
    """Create agent factory from configuration."""
    # Load agent from config with optional overrides
    factory = create_agent_from_config(
        config_name=args.agent_config,
        override_model=args.model,
        override_provider=args.provider,
        override_temperature=args.temperature
    )

    return factory


def select_tasks(args):
    """Select tasks based on arguments."""
    from evals.tasks.task_registry import get_all_tasks, get_tasks_by_category, get_tasks_by_difficulty, get_task_by_id

    # Specific task IDs
    if args.task_ids:
        tasks = []
        for task_id in args.task_ids:
            task = get_task_by_id(task_id)
            if task:
                tasks.append(task)
            else:
                logger.warning(f"Task not found: {task_id}")
        return tasks

    # Category filter
    if args.category:
        tasks = get_tasks_by_category(args.category)
        logger.info(f"Selected {len(tasks)} tasks from category: {args.category}")
        return tasks

    # Difficulty filter
    if args.difficulty:
        tasks = get_tasks_by_difficulty(args.difficulty)
        logger.info(f"Selected {len(tasks)} tasks with difficulty: {args.difficulty}")
        return tasks

    # All tasks
    return get_all_tasks()


def _print_available_judges() -> None:
    """Print configured judge options."""
    judges = list_available_judges()
    print("=" * 70)
    print("AVAILABLE JUDGE CONFIGURATIONS")
    print("=" * 70)
    if not judges:
        print("No judge configs defined.")
        print()
        return

    for name, cfg in judges.items():
        provider = cfg.get("provider", "unknown")
        model = cfg.get("model", "unknown")
        temperature = cfg.get("temperature", "n/a")
        max_tokens = cfg.get("max_tokens")
        print(f"[{name}] {provider}:{model} (temperature={temperature})")
        if max_tokens is not None:
            print(f"  max_tokens: {max_tokens}")
    print()



def main():
    """Main entry point."""
    args = parse_args()

    if args.list_agents:
        print_available_agents()
        return

    if args.list_judges:
        _print_available_judges()
        return

    logger.info("=" * 70)
    logger.info("AGENT EVALUATION")
    logger.info("=" * 70)
    logger.info(f"Agent Config: {args.agent_config}")
    if args.model:
        logger.info(f"Model Override: {args.model}")
    if args.provider:
        logger.info(f"Provider Override: {args.provider}")
    logger.info(f"Judge Config: {args.judge_config}")
    if args.judge_model:
        logger.info(f"Judge Model Override: {args.judge_model}")
    if args.judge_provider:
        logger.info(f"Judge Provider Override: {args.judge_provider}")
    if args.judge_temperature is not None:
        logger.info(f"Judge Temperature Override: {args.judge_temperature}")
    if args.judge_max_tokens is not None:
        logger.info(f"Judge max_tokens override: {args.judge_max_tokens}")
    logger.info("")

    # Create agent factory
    logger.info(f"Loading agent from config: {args.agent_config}")
    agent_factory = create_agent_factory(args)

    agent_metadata = agent_factory.config if hasattr(agent_factory, 'config') else {}
    if agent_metadata:
        logger.info(f"Agent: {agent_metadata.get('agent_type', 'Unknown')}")
        logger.info(f"Model: {agent_metadata.get('model', 'Unknown')}")
        logger.info(f"Provider: {agent_metadata.get('provider', 'Unknown')}")
        if 'tier' in agent_metadata:
            logger.info(f"Tier: {agent_metadata['tier']}")
        logger.info("")

    try:
        judge_settings = load_judge_config(args.judge_config)
    except ValueError as exc:
        logger.error(str(exc))
        sys.exit(1)

    overrides = {
        "model": args.judge_model,
        "provider": args.judge_provider,
        "temperature": args.judge_temperature,
        "max_tokens": args.judge_max_tokens
    }
    for key, value in overrides.items():
        if value is not None:
            judge_settings[key] = value

    llm_kwargs = {k: v for k, v in judge_settings.items() if k in LLM_CONFIG_FIELD_NAMES}
    missing = [field for field in ("provider", "model") if field not in llm_kwargs]
    if missing:
        logger.error(f"Judge config '{args.judge_config}' missing required field(s): {', '.join(missing)}")
        sys.exit(1)

    llm_kwargs.setdefault("temperature", 0.0)
    judge_llm_config = LLMConfig(**llm_kwargs)

    logger.info("Creating judge LLM...")
    logger.info(f"  Provider: {judge_llm_config.provider}")
    logger.info(f"  Model: {judge_llm_config.model}")
    logger.info(f"  Temperature: {judge_llm_config.temperature}")
    if judge_llm_config.max_tokens:
        logger.info(f"  Max tokens: {judge_llm_config.max_tokens}")
    judge_llm = create_adapter(judge_llm_config)

    logger.info(f"Creating eval runner (batch size: {args.batch_size})...")
    runner = EvalRunner(
        agent_factory=agent_factory,
        judge_llm=judge_llm,
        output_dir=Path(args.output),
        batch_size=args.batch_size
    )

    base_metadata = {
        "agent_config": args.agent_config,
        "judge_config": args.judge_config,
        "judge_model": judge_llm_config.model,
        "judge_provider": judge_llm_config.provider,
        "judge_temperature": judge_llm_config.temperature,
        "judge_max_tokens": judge_llm_config.max_tokens,
        "batch_size": args.batch_size,
        **agent_metadata
    }

    # Run evaluation
    if args.quick:
        logger.info(f"Running QUICK evaluation ({args.num_tasks} tasks)...")

        eval_run = runner.run_quick_evaluation(
            num_tasks=args.num_tasks,
            run_id=args.run_id,
            config={
                **base_metadata,
                "mode": "quick",
                "quick_num_tasks": args.num_tasks
            }
        )
    else:
        tasks = select_tasks(args)
        logger.info(f"Running evaluation with {len(tasks)} tasks...")

        eval_run = runner.run_evaluation(
            tasks=tasks,
            run_id=args.run_id,
            config={
                **base_metadata,
                "category_filter": args.category,
                "difficulty_filter": args.difficulty
            },
            parallel_execution=args.parallel,
            max_workers=args.max_workers
        )

    # Generate visualizations
    if not args.no_viz:
        logger.info("Generating visualizations...")
        from evals.visualization import EvalVisualizer
        viz = EvalVisualizer()
        viz_dir = Path(args.output) / eval_run.run_id
        viz.generate_full_report(eval_run, viz_dir)
        logger.info(f"Visualizations saved to: {viz_dir}")

    # Print summary
    logger.info("")
    logger.info("=" * 70)
    logger.info("EVALUATION COMPLETE")
    logger.info("=" * 70)
    logger.info(f"Run ID: {eval_run.run_id}")
    logger.info(f"Total Tasks: {eval_run.total_tasks}")
    logger.info(f"Pass Rate: {eval_run.metrics['pass_rate']*100:.1f}%")
    logger.info(f"Mean Score: {eval_run.metrics['mean_score']:.1f}/100")
    logger.info(f"Median Score: {eval_run.metrics['median_score']:.1f}/100")
    logger.info(f"Std Dev: {eval_run.metrics['std_dev_score']:.1f}")
    logger.info("")
    logger.info("Category Performance:")
    for category, metrics in eval_run.category_metrics.items():
        logger.info(f"  {category:25s}: {metrics['pass_rate']*100:5.1f}% pass rate, "
                   f"{metrics['mean_score']:5.1f} mean score")
    logger.info("")
    logger.info(f"Results saved to: {Path(args.output) / eval_run.run_id}.json")
    logger.info("=" * 70)


if __name__ == "__main__":
    main()
