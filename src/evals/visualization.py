"""
Visualization and reporting for evaluation results.

Generates matplotlib charts for results analysis.
"""

import matplotlib
matplotlib.use('Agg')  # Use non-interactive backend
import matplotlib.pyplot as plt
import numpy as np
from pathlib import Path
from typing import Dict, Any, List
import seaborn as sns

from .eval_task import EvalRun, EvalResult


# Set style
sns.set_style("whitegrid")
plt.rcParams['figure.figsize'] = (12, 8)
plt.rcParams['font.size'] = 10


class EvalVisualizer:
    """Generate charts and visualizations for eval results."""

    def generate_full_report(self, run: EvalRun, output_dir: Path):
        """
        Generate complete visual report with all charts.

        Args:
            run: Evaluation run to visualize
            output_dir: Directory to save charts
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        # 1. Overall dashboard
        self.plot_dashboard(run, output_dir / "dashboard.png")

        # 2. Score distribution
        self.plot_score_distribution(run, output_dir / "score_distribution.png")

        # 3. Category performance
        self.plot_category_performance(run, output_dir / "category_performance.png")

        # 4. Execution time analysis
        self.plot_execution_times(run, output_dir / "execution_times.png")

        # 5. Failure mode breakdown
        self.plot_failure_modes(run, output_dir / "failure_analysis.png")

        # 6. Per-task results
        self.plot_task_results(run, output_dir / "task_results.png")

    def plot_dashboard(self, run: EvalRun, output_path: Path):
        """Create 2x2 dashboard with key metrics."""
        fig, ((ax1, ax2), (ax3, ax4)) = plt.subplots(2, 2, figsize=(14, 10))
        fig.suptitle(f"Evaluation Run: {run.run_id}", fontsize=16, fontweight='bold')

        # Top-left: Pass rate gauge
        pass_rate = run.metrics["pass_rate"] * 100
        color = 'green' if pass_rate >= 70 else 'orange' if pass_rate >= 50 else 'red'
        ax1.text(0.5, 0.5, f"{pass_rate:.1f}%",
                ha='center', va='center', fontsize=60, fontweight='bold', color=color)
        ax1.text(0.5, 0.25, "Pass Rate",
                ha='center', va='center', fontsize=18, color='gray')
        ax1.text(0.5, 0.15, f"{run.metrics['tasks_passed']}/{run.total_tasks} tasks",
                ha='center', va='center', fontsize=12, color='gray')
        ax1.set_xlim(0, 1)
        ax1.set_ylim(0, 1)
        ax1.axis('off')

        # Top-right: Score distribution
        scores = [r.score for r in run.task_results]
        ax2.hist(scores, bins=20, edgecolor='black', alpha=0.7, color='steelblue')
        ax2.axvline(run.metrics["mean_score"], color='red', linestyle='--',
                   linewidth=2, label=f'Mean: {run.metrics["mean_score"]:.1f}')
        ax2.axvline(run.metrics["median_score"], color='orange', linestyle='--',
                   linewidth=2, label=f'Median: {run.metrics["median_score"]:.1f}')
        ax2.set_xlabel('Score')
        ax2.set_ylabel('Count')
        ax2.set_title('Score Distribution')
        ax2.legend()
        ax2.grid(True, alpha=0.3)

        # Bottom-left: Category performance
        if run.category_metrics:
            categories = list(run.category_metrics.keys())
            pass_rates = [run.category_metrics[cat]["pass_rate"] * 100 for cat in categories]

            # Shorten category names
            short_names = [cat.replace('_', ' ').title() for cat in categories]

            bars = ax3.barh(short_names, pass_rates, color='steelblue')
            ax3.set_xlabel('Pass Rate (%)')
            ax3.set_title('Performance by Category')
            ax3.set_xlim(0, 100)
            ax3.grid(True, alpha=0.3, axis='x')

            # Color bars based on pass rate
            for bar, rate in zip(bars, pass_rates):
                if rate >= 70:
                    bar.set_color('green')
                elif rate >= 50:
                    bar.set_color('orange')
                else:
                    bar.set_color('red')

        # Bottom-right: Key stats table
        stats_text = f"""Tasks:     {run.total_tasks}
Passed:    {run.metrics['tasks_passed']}
Failed:    {run.metrics['tasks_failed']}

Mean:      {run.metrics['mean_score']:.1f}
Median:    {run.metrics['median_score']:.1f}
Std Dev:   {run.metrics['std_dev_score']:.1f}

P25:       {run.metrics['p25_score']:.1f}
P75:       {run.metrics['p75_score']:.1f}
P90:       {run.metrics['p90_score']:.1f}

Avg Time:  {run.metrics['mean_execution_time_ms']/1000:.2f}s
Total Time: {run.metrics['total_execution_time_ms']/1000/60:.1f} min"""

        ax4.text(0.1, 0.5, stats_text, fontsize=11, family='monospace',
                va='center', transform=ax4.transAxes)
        ax4.axis('off')

        plt.tight_layout()
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        plt.close()

    def plot_score_distribution(self, run: EvalRun, output_path: Path):
        """Plot detailed score distribution."""
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))

        scores = [r.score for r in run.task_results]

        # Histogram
        ax1.hist(scores, bins=20, edgecolor='black', alpha=0.7, color='steelblue')
        ax1.axvline(run.metrics["mean_score"], color='red', linestyle='--',
                   linewidth=2, label=f'Mean: {run.metrics["mean_score"]:.1f}')
        ax1.axvline(run.metrics["median_score"], color='orange', linestyle='--',
                   linewidth=2, label=f'Median: {run.metrics["median_score"]:.1f}')
        ax1.axvline(70, color='green', linestyle=':', linewidth=2, label='Pass Threshold: 70')
        ax1.set_xlabel('Score')
        ax1.set_ylabel('Frequency')
        ax1.set_title('Score Distribution')
        ax1.legend()
        ax1.grid(True, alpha=0.3)

        # Box plot
        ax2.boxplot(scores, vert=True)
        ax2.set_ylabel('Score')
        ax2.set_title('Score Box Plot')
        ax2.grid(True, alpha=0.3, axis='y')
        ax2.axhline(70, color='green', linestyle=':', linewidth=2, label='Pass Threshold')

        plt.tight_layout()
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        plt.close()

    def plot_category_performance(self, run: EvalRun, output_path: Path):
        """Plot performance breakdown by category."""
        if not run.category_metrics:
            return

        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))

        categories = list(run.category_metrics.keys())
        short_names = [cat.replace('_', ' ').title() for cat in categories]

        # Pass rates
        pass_rates = [run.category_metrics[cat]["pass_rate"] * 100 for cat in categories]
        bars = ax1.barh(short_names, pass_rates, color='steelblue')
        ax1.set_xlabel('Pass Rate (%)')
        ax1.set_title('Pass Rate by Category')
        ax1.set_xlim(0, 100)
        ax1.grid(True, alpha=0.3, axis='x')

        for bar, rate in zip(bars, pass_rates):
            if rate >= 70:
                bar.set_color('green')
            elif rate >= 50:
                bar.set_color('orange')
            else:
                bar.set_color('red')

        # Mean scores
        mean_scores = [run.category_metrics[cat]["mean_score"] for cat in categories]
        bars2 = ax2.barh(short_names, mean_scores, color='steelblue')
        ax2.set_xlabel('Mean Score')
        ax2.set_title('Mean Score by Category')
        ax2.set_xlim(0, 100)
        ax2.axvline(70, color='green', linestyle=':', linewidth=2)
        ax2.grid(True, alpha=0.3, axis='x')

        plt.tight_layout()
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        plt.close()

    def plot_execution_times(self, run: EvalRun, output_path: Path):
        """Plot execution time analysis."""
        if not run.category_metrics:
            # Simple histogram
            fig, ax = plt.subplots(1, 1, figsize=(12, 6))
            times = [r.execution_time_ms / 1000 for r in run.task_results]
            ax.hist(times, bins=20, edgecolor='black', alpha=0.7)
            ax.set_xlabel('Execution Time (seconds)')
            ax.set_ylabel('Frequency')
            ax.set_title('Execution Time Distribution')
            ax.grid(True, alpha=0.3)
            plt.tight_layout()
            plt.savefig(output_path, dpi=150, bbox_inches='tight')
            plt.close()
            return

        # Box plot by category
        fig, ax = plt.subplots(1, 1, figsize=(12, 6))

        categories = list(run.category_metrics.keys())
        short_names = [cat.replace('_', ' ').title() for cat in categories]

        # Group times by category
        from collections import defaultdict
        times_by_cat = defaultdict(list)
        task_to_cat = {}

        # Build task to category mapping
        # We need to infer this from results
        for i, cat in enumerate(categories):
            cat_results = [r for r in run.task_results if r.task_id.startswith(cat.split('_')[0])]
            for r in cat_results:
                times_by_cat[short_names[i]].append(r.execution_time_ms / 1000)

        # Create box plot
        data = [times_by_cat[name] for name in short_names if times_by_cat[name]]
        labels = [name for name in short_names if times_by_cat[name]]

        ax.boxplot(data, labels=labels)
        ax.set_ylabel('Execution Time (seconds)')
        ax.set_title('Execution Time by Category')
        ax.grid(True, alpha=0.3, axis='y')
        plt.xticks(rotation=45, ha='right')

        plt.tight_layout()
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        plt.close()

    def plot_failure_modes(self, run: EvalRun, output_path: Path):
        """Plot failure mode breakdown."""
        failure_modes = run.metrics.get("failure_modes", {})

        if not failure_modes:
            # Create empty chart
            fig, ax = plt.subplots(1, 1, figsize=(10, 6))
            ax.text(0.5, 0.5, "No failures detected", ha='center', va='center', fontsize=16)
            ax.axis('off')
            plt.savefig(output_path, dpi=150, bbox_inches='tight')
            plt.close()
            return

        fig, ax = plt.subplots(1, 1, figsize=(10, 6))

        modes = list(failure_modes.keys())
        counts = list(failure_modes.values())

        # Clean up mode names
        clean_modes = [m.replace('_', ' ').title() for m in modes]

        colors = plt.cm.Set3(range(len(modes)))
        wedges, texts, autotexts = ax.pie(counts, labels=clean_modes, autopct='%1.1f%%',
                                           colors=colors, startangle=90)

        for autotext in autotexts:
            autotext.set_color('white')
            autotext.set_fontweight('bold')

        ax.set_title('Failure Mode Distribution')

        plt.tight_layout()
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        plt.close()

    def plot_task_results(self, run: EvalRun, output_path: Path):
        """Plot detailed per-task results."""
        fig, ax = plt.subplots(1, 1, figsize=(14, max(8, len(run.task_results) * 0.3)))

        task_ids = [r.task_id for r in run.task_results]
        scores = [r.score for r in run.task_results]
        passed = [r.passed for r in run.task_results]

        # Sort by score
        sorted_indices = sorted(range(len(scores)), key=lambda i: scores[i])
        task_ids = [task_ids[i] for i in sorted_indices]
        scores = [scores[i] for i in sorted_indices]
        passed = [passed[i] for i in sorted_indices]

        colors = ['green' if p else 'red' for p in passed]

        bars = ax.barh(task_ids, scores, color=colors, alpha=0.7)
        ax.axvline(70, color='blue', linestyle='--', linewidth=2, label='Pass Threshold')
        ax.set_xlabel('Score')
        ax.set_title('Per-Task Results (sorted by score)')
        ax.set_xlim(0, 100)
        ax.legend()
        ax.grid(True, alpha=0.3, axis='x')

        plt.tight_layout()
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        plt.close()

    def plot_comparison(self, comparison: Dict[str, Any], output_path: Path):
        """
        Plot comparison between two runs.

        Args:
            comparison: Comparison results from RunComparator
            output_path: Where to save the plot
        """
        fig, ((ax1, ax2), (ax3, ax4)) = plt.subplots(2, 2, figsize=(14, 10))
        fig.suptitle(f"Run Comparison: {comparison['run_a_id']} vs {comparison['run_b_id']}",
                    fontsize=16, fontweight='bold')

        # Top-left: Score comparison
        scores_a = [d['score_a'] for d in comparison['task_deltas']]
        scores_b = [d['score_b'] for d in comparison['task_deltas']]

        ax1.scatter(scores_a, scores_b, alpha=0.6)
        ax1.plot([0, 100], [0, 100], 'r--', label='No change')
        ax1.set_xlabel(f'Run A Score')
        ax1.set_ylabel(f'Run B Score')
        ax1.set_title('Task Score Comparison')
        ax1.legend()
        ax1.grid(True, alpha=0.3)
        ax1.set_xlim(0, 100)
        ax1.set_ylim(0, 100)

        # Top-right: Score delta distribution
        deltas = [d['score_diff'] for d in comparison['task_deltas']]
        ax2.hist(deltas, bins=20, edgecolor='black', alpha=0.7)
        ax2.axvline(0, color='red', linestyle='--', linewidth=2, label='No change')
        ax2.axvline(comparison['mean_score_diff'], color='blue', linestyle='--',
                   linewidth=2, label=f'Mean: {comparison["mean_score_diff"]:+.1f}')
        ax2.set_xlabel('Score Difference (B - A)')
        ax2.set_ylabel('Frequency')
        ax2.set_title('Score Change Distribution')
        ax2.legend()
        ax2.grid(True, alpha=0.3)

        # Bottom-left: Pass rate comparison
        metrics = ['Pass Rate', 'Mean Score']
        a_values = [comparison['pass_rate_a'] * 100, comparison['mean_score_a']]
        b_values = [comparison['pass_rate_b'] * 100, comparison['mean_score_b']]

        x = np.arange(len(metrics))
        width = 0.35

        ax3.bar(x - width/2, a_values, width, label='Run A', color='steelblue')
        ax3.bar(x + width/2, b_values, width, label='Run B', color='orange')
        ax3.set_ylabel('Value')
        ax3.set_title('Overall Metrics Comparison')
        ax3.set_xticks(x)
        ax3.set_xticklabels(metrics)
        ax3.legend()
        ax3.grid(True, alpha=0.3, axis='y')

        # Bottom-right: Statistical summary
        summary_text = f"""Common Tasks:  {comparison['common_tasks']}

Score Difference:
  Mean:        {comparison['mean_score_diff']:+.2f}
  Median:      {comparison['median_score_diff']:+.2f}

Pass Rate Difference:
  {comparison['pass_rate_diff']*100:+.1f}%

Statistical Test:
  p-value:     {comparison['p_value']:.4f}
  Significant: {'YES' if comparison['is_significant'] else 'NO'}
  Cohen's d:   {comparison['cohens_d']:.3f}

Winner:        {comparison['winner']}

Changes:
  Regressions:  {comparison['regression_count']}
  Improvements: {comparison['improvement_count']}"""

        ax4.text(0.1, 0.5, summary_text, fontsize=11, family='monospace',
                va='center', transform=ax4.transAxes)
        ax4.axis('off')

        plt.tight_layout()
        plt.savefig(output_path, dpi=150, bbox_inches='tight')
        plt.close()
