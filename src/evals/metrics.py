"""
Metrics computation and run comparison.

Provides statistical analysis and A/B testing capabilities.
"""

import statistics
from typing import List, Dict, Any, Optional
from scipy import stats
import numpy as np

from evals.eval_task import EvalResult, EvalTask, EvalRun


class MetricsCalculator:
    """Compute metrics from evaluation results."""

    def calculate_metrics(self, results: List[EvalResult]) -> Dict[str, Any]:
        """
        Calculate comprehensive metrics from results.

        Args:
            results: List of evaluation results

        Returns:
            Dictionary with metrics
        """
        if not results:
            return {}

        scores = [r.score for r in results]
        passed = [r.passed for r in results]
        execution_times = [r.execution_time_ms for r in results]

        return {
            # Overall performance
            "pass_rate": sum(passed) / len(passed) if passed else 0,
            "total_tasks": len(results),
            "tasks_passed": sum(passed),
            "tasks_failed": len(passed) - sum(passed),

            # Score distribution
            "mean_score": statistics.mean(scores) if scores else 0,
            "median_score": statistics.median(scores) if scores else 0,
            "std_dev_score": statistics.stdev(scores) if len(scores) > 1 else 0,
            "min_score": min(scores) if scores else 0,
            "max_score": max(scores) if scores else 0,

            # Percentiles
            "p25_score": self._percentile(scores, 25),
            "p50_score": self._percentile(scores, 50),
            "p75_score": self._percentile(scores, 75),
            "p90_score": self._percentile(scores, 90),
            "p95_score": self._percentile(scores, 95),

            # Efficiency
            "mean_execution_time_ms": statistics.mean(execution_times) if execution_times else 0,
            "median_execution_time_ms": statistics.median(execution_times) if execution_times else 0,
            "total_execution_time_ms": sum(execution_times),

            # Failure analysis
            "failure_modes": self._analyze_failure_modes(results),

            # Tool usage
            "tool_usage_stats": self._analyze_tool_usage(results)
        }

    def calculate_category_metrics(
        self,
        results: List[EvalResult],
        tasks: List[EvalTask]
    ) -> Dict[str, Dict[str, Any]]:
        """
        Break down metrics by task category.

        Args:
            results: List of evaluation results
            tasks: List of tasks (for category lookup)

        Returns:
            Dictionary mapping category to metrics
        """
        task_map = {t.task_id: t for t in tasks}
        by_category = {}

        for result in results:
            task = task_map.get(result.task_id)
            if not task:
                continue

            category = task.category
            if category not in by_category:
                by_category[category] = []
            by_category[category].append(result)

        return {
            category: self.calculate_metrics(cat_results)
            for category, cat_results in by_category.items()
        }

    def calculate_difficulty_metrics(
        self,
        results: List[EvalResult],
        tasks: List[EvalTask]
    ) -> Dict[str, Dict[str, Any]]:
        """
        Break down metrics by difficulty level.

        Args:
            results: List of evaluation results
            tasks: List of tasks (for difficulty lookup)

        Returns:
            Dictionary mapping difficulty to metrics
        """
        task_map = {t.task_id: t for t in tasks}
        by_difficulty = {}

        for result in results:
            task = task_map.get(result.task_id)
            if not task:
                continue

            difficulty = task.difficulty
            if difficulty not in by_difficulty:
                by_difficulty[difficulty] = []
            by_difficulty[difficulty].append(result)

        return {
            difficulty: self.calculate_metrics(diff_results)
            for difficulty, diff_results in by_difficulty.items()
        }

    def _percentile(self, data: List[float], percentile: float) -> float:
        """Calculate percentile of data."""
        if not data:
            return 0
        return float(np.percentile(data, percentile))

    def _analyze_failure_modes(self, results: List[EvalResult]) -> Dict[str, int]:
        """Analyze failure modes across results."""
        failure_counts = {}

        for result in results:
            if not result.passed and result.failure_mode:
                mode = result.failure_mode
                failure_counts[mode] = failure_counts.get(mode, 0) + 1

        return failure_counts

    def _analyze_tool_usage(self, results: List[EvalResult]) -> Dict[str, Dict[str, Any]]:
        """Analyze tool usage patterns."""
        tool_stats = {}

        for result in results:
            for tool in result.tools_used:
                if tool not in tool_stats:
                    tool_stats[tool] = {
                        "total_uses": 0,
                        "successes": 0,
                        "failures": 0
                    }

                tool_stats[tool]["total_uses"] += 1
                if result.passed:
                    tool_stats[tool]["successes"] += 1
                else:
                    tool_stats[tool]["failures"] += 1

        # Calculate success rates
        for tool, stats in tool_stats.items():
            total = stats["total_uses"]
            stats["success_rate"] = stats["successes"] / total if total > 0 else 0

        return tool_stats


class RunComparator:
    """Compare two evaluation runs for A/B testing."""

    def compare_runs(self, run_a: EvalRun, run_b: EvalRun) -> Dict[str, Any]:
        """
        Compare two runs and compute statistical significance.

        Args:
            run_a: First evaluation run
            run_b: Second evaluation run

        Returns:
            Dictionary with comparison results including:
            - Score differences
            - Pass rate differences
            - Statistical significance (p-value)
            - Winner determination
            - Task-by-task comparison
        """
        # Align tasks (only compare tasks present in both runs)
        common_tasks = set(r.task_id for r in run_a.task_results) & \
                      set(r.task_id for r in run_b.task_results)

        if not common_tasks:
            return {
                "error": "No common tasks between runs",
                "run_a_id": run_a.run_id,
                "run_b_id": run_b.run_id
            }

        a_results = [r for r in run_a.task_results if r.task_id in common_tasks]
        b_results = [r for r in run_b.task_results if r.task_id in common_tasks]

        # Sort by task_id to ensure alignment
        a_results.sort(key=lambda r: r.task_id)
        b_results.sort(key=lambda r: r.task_id)

        a_scores = [r.score for r in a_results]
        b_scores = [r.score for r in b_results]

        # Statistical significance (paired t-test)
        if len(a_scores) > 1:
            t_stat, p_value = stats.ttest_rel(a_scores, b_scores)
        else:
            t_stat, p_value = 0, 1.0

        # Score differences
        score_deltas = [b - a for a, b in zip(a_scores, b_scores)]
        mean_score_diff = statistics.mean(score_deltas)
        median_score_diff = statistics.median(score_deltas)

        # Pass rate differences
        a_pass_rate = sum(r.passed for r in a_results) / len(a_results)
        b_pass_rate = sum(r.passed for r in b_results) / len(b_results)
        pass_rate_diff = b_pass_rate - a_pass_rate

        # Determine winner
        if p_value < 0.05:
            if mean_score_diff > 0:
                winner = "B"
                winner_name = run_b.run_id
            else:
                winner = "A"
                winner_name = run_a.run_id
        else:
            winner = "TIE"
            winner_name = "No significant difference"

        # Task-by-task comparison
        task_deltas = []
        regressions = []
        improvements = []

        for i in range(len(a_results)):
            a_result = a_results[i]
            b_result = b_results[i]

            delta = {
                "task_id": a_result.task_id,
                "score_a": a_result.score,
                "score_b": b_result.score,
                "score_diff": b_result.score - a_result.score,
                "passed_a": a_result.passed,
                "passed_b": b_result.passed,
                "both_passed": a_result.passed and b_result.passed
            }

            task_deltas.append(delta)

            # Identify regressions and improvements
            if a_result.passed and not b_result.passed:
                regressions.append(delta)
            elif not a_result.passed and b_result.passed:
                improvements.append(delta)

        return {
            "run_a_id": run_a.run_id,
            "run_b_id": run_b.run_id,
            "common_tasks": len(common_tasks),

            # Score comparison
            "mean_score_a": statistics.mean(a_scores),
            "mean_score_b": statistics.mean(b_scores),
            "mean_score_diff": mean_score_diff,
            "median_score_diff": median_score_diff,

            # Pass rate comparison
            "pass_rate_a": a_pass_rate,
            "pass_rate_b": b_pass_rate,
            "pass_rate_diff": pass_rate_diff,

            # Statistical significance
            "t_statistic": float(t_stat),
            "p_value": float(p_value),
            "is_significant": p_value < 0.05,
            "confidence_level": 1 - p_value,

            # Winner
            "winner": winner,
            "winner_name": winner_name,

            # Detailed comparisons
            "task_deltas": task_deltas,
            "regressions": regressions,
            "improvements": improvements,
            "regression_count": len(regressions),
            "improvement_count": len(improvements),

            # Effect size (Cohen's d)
            "cohens_d": self._calculate_cohens_d(a_scores, b_scores)
        }

    def _calculate_cohens_d(self, group1: List[float], group2: List[float]) -> float:
        """
        Calculate Cohen's d effect size.

        Interpretation:
        - Small: 0.2
        - Medium: 0.5
        - Large: 0.8
        """
        if not group1 or not group2 or len(group1) < 2 or len(group2) < 2:
            return 0.0

        n1, n2 = len(group1), len(group2)
        mean1, mean2 = statistics.mean(group1), statistics.mean(group2)
        var1, var2 = statistics.variance(group1), statistics.variance(group2)

        # Pooled standard deviation
        pooled_std = ((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2)
        pooled_std = pooled_std ** 0.5

        if pooled_std == 0:
            return 0.0

        return (mean2 - mean1) / pooled_std

    def generate_comparison_report(self, comparison: Dict[str, Any]) -> str:
        """
        Generate human-readable comparison report.

        Args:
            comparison: Comparison results from compare_runs()

        Returns:
            Formatted text report
        """
        report = []
        report.append("=" * 70)
        report.append("EVALUATION RUN COMPARISON")
        report.append("=" * 70)
        report.append("")
        report.append(f"Run A: {comparison['run_a_id']}")
        report.append(f"Run B: {comparison['run_b_id']}")
        report.append(f"Common Tasks: {comparison['common_tasks']}")
        report.append("")

        report.append("SCORE COMPARISON")
        report.append("-" * 70)
        report.append(f"Mean Score A:  {comparison['mean_score_a']:.2f}")
        report.append(f"Mean Score B:  {comparison['mean_score_b']:.2f}")
        report.append(f"Difference:    {comparison['mean_score_diff']:+.2f}")
        report.append("")

        report.append("PASS RATE COMPARISON")
        report.append("-" * 70)
        report.append(f"Pass Rate A:   {comparison['pass_rate_a']*100:.1f}%")
        report.append(f"Pass Rate B:   {comparison['pass_rate_b']*100:.1f}%")
        report.append(f"Difference:    {comparison['pass_rate_diff']*100:+.1f}%")
        report.append("")

        report.append("STATISTICAL SIGNIFICANCE")
        report.append("-" * 70)
        report.append(f"p-value:       {comparison['p_value']:.4f}")
        report.append(f"Significant:   {'YES' if comparison['is_significant'] else 'NO'} (α=0.05)")
        report.append(f"Cohen's d:     {comparison['cohens_d']:.3f}")

        # Interpret effect size
        d = abs(comparison['cohens_d'])
        if d < 0.2:
            effect = "negligible"
        elif d < 0.5:
            effect = "small"
        elif d < 0.8:
            effect = "medium"
        else:
            effect = "large"
        report.append(f"Effect Size:   {effect}")
        report.append("")

        report.append("WINNER")
        report.append("-" * 70)
        report.append(f"{comparison['winner']}: {comparison['winner_name']}")
        report.append("")

        if comparison['regressions']:
            report.append("REGRESSIONS (passed in A, failed in B)")
            report.append("-" * 70)
            for reg in comparison['regressions']:
                report.append(f"  - {reg['task_id']}: {reg['score_a']:.1f} → {reg['score_b']:.1f}")
            report.append("")

        if comparison['improvements']:
            report.append("IMPROVEMENTS (failed in A, passed in B)")
            report.append("-" * 70)
            for imp in comparison['improvements']:
                report.append(f"  - {imp['task_id']}: {imp['score_a']:.1f} → {imp['score_b']:.1f}")
            report.append("")

        report.append("=" * 70)

        return "\n".join(report)
