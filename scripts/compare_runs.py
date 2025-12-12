#!/usr/bin/env python3
"""
CLI tool for comparing two evaluation runs.

Usage:
    python scripts/compare_runs.py run_20250110_143022.json run_20250110_150133.json
    python scripts/compare_runs.py run_a.json run_b.json --output comparison_report
"""

import argparse
import logging
import sys
import json
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from evals.eval_task import EvalRun
from evals.metrics import RunComparator
from evals.visualization import EvalVisualizer


# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Compare two evaluation runs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Compare two runs
  python scripts/compare_runs.py evals/results/run_20250110_143022.json \\
                                  evals/results/run_20250110_150133.json

  # Compare with custom output directory
  python scripts/compare_runs.py run_a.json run_b.json --output my_comparison

  # Skip visualization
  python scripts/compare_runs.py run_a.json run_b.json --no-viz
        """
    )

    parser.add_argument('run_a', type=str,
                       help='Path to first run JSON file or run ID')
    parser.add_argument('run_b', type=str,
                       help='Path to second run JSON file or run ID')
    parser.add_argument('--output', default='evals/results/comparisons',
                       help='Output directory for comparison results')
    parser.add_argument('--no-viz', action='store_true',
                       help='Skip visualization generation')

    return parser.parse_args()


def load_run(path_or_id: str, default_dir: str = 'evals/results') -> EvalRun:
    """
    Load an evaluation run from path or ID.

    Args:
        path_or_id: File path or run ID
        default_dir: Default directory to search for run files

    Returns:
        Loaded EvalRun

    Raises:
        FileNotFoundError: If run file not found
    """
    path = Path(path_or_id)

    # If not a file, try to find it in default directory
    if not path.exists():
        # Try as run ID
        potential_path = Path(default_dir) / f"{path_or_id}.json"
        if potential_path.exists():
            path = potential_path
        else:
            # Try with .json extension
            potential_path = Path(default_dir) / path_or_id
            if potential_path.exists():
                path = potential_path
            else:
                raise FileNotFoundError(f"Could not find run file: {path_or_id}")

    logger.info(f"Loading run from: {path}")
    return EvalRun.load(str(path))


def main():
    """Main entry point."""
    args = parse_args()

    logger.info("=" * 70)
    logger.info("EVALUATION RUN COMPARISON")
    logger.info("=" * 70)
    logger.info("")

    # Load runs
    try:
        run_a = load_run(args.run_a)
        run_b = load_run(args.run_b)
    except FileNotFoundError as e:
        logger.error(f"Error: {e}")
        logger.error("Please provide valid run file paths or run IDs")
        sys.exit(1)

    logger.info(f"Run A: {run_a.run_id}")
    logger.info(f"  Tasks: {run_a.total_tasks}")
    logger.info(f"  Pass Rate: {run_a.metrics['pass_rate']*100:.1f}%")
    logger.info(f"  Mean Score: {run_a.metrics['mean_score']:.1f}")
    logger.info("")

    logger.info(f"Run B: {run_b.run_id}")
    logger.info(f"  Tasks: {run_b.total_tasks}")
    logger.info(f"  Pass Rate: {run_b.metrics['pass_rate']*100:.1f}%")
    logger.info(f"  Mean Score: {run_b.metrics['mean_score']:.1f}")
    logger.info("")

    # Compare runs
    logger.info("Computing comparison...")
    comparator = RunComparator()
    comparison = comparator.compare_runs(run_a, run_b)

    # Print report
    report = comparator.generate_comparison_report(comparison)
    print("\n" + report + "\n")

    # Save comparison results
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    comparison_id = f"comparison_{run_a.run_id}_vs_{run_b.run_id}"
    json_path = output_dir / f"{comparison_id}.json"

    with open(json_path, 'w') as f:
        json.dump(comparison, f, indent=2)

    logger.info(f"Comparison saved to: {json_path}")

    # Generate visualization
    if not args.no_viz:
        logger.info("Generating comparison visualization...")
        viz = EvalVisualizer()
        viz_path = output_dir / f"{comparison_id}.png"
        viz.plot_comparison(comparison, viz_path)
        logger.info(f"Visualization saved to: {viz_path}")

    # Additional insights
    logger.info("")
    logger.info("KEY INSIGHTS:")
    logger.info("-" * 70)

    if comparison['is_significant']:
        logger.info(f"✓ Statistically significant difference detected (p={comparison['p_value']:.4f})")
        logger.info(f"  Winner: {comparison['winner_name']}")
        logger.info(f"  Effect size (Cohen's d): {comparison['cohens_d']:.3f}")
    else:
        logger.info(f"✗ No statistically significant difference (p={comparison['p_value']:.4f})")
        logger.info(f"  The observed differences could be due to chance")

    logger.info("")

    if comparison['regressions']:
        logger.info(f"⚠ {comparison['regression_count']} regressions detected:")
        for reg in comparison['regressions'][:5]:  # Show first 5
            logger.info(f"  - {reg['task_id']}: {reg['score_a']:.1f} → {reg['score_b']:.1f}")
        if comparison['regression_count'] > 5:
            logger.info(f"  ... and {comparison['regression_count'] - 5} more")

    if comparison['improvements']:
        logger.info(f"✓ {comparison['improvement_count']} improvements detected:")
        for imp in comparison['improvements'][:5]:  # Show first 5
            logger.info(f"  - {imp['task_id']}: {imp['score_a']:.1f} → {imp['score_b']:.1f}")
        if comparison['improvement_count'] > 5:
            logger.info(f"  ... and {comparison['improvement_count'] - 5} more")

    logger.info("")
    logger.info("=" * 70)


if __name__ == "__main__":
    main()
