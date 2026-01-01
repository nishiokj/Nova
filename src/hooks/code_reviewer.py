"""
CodeReviewer - Post-task automatic code review.

Runs after task completion to analyze:
1. Scope of work done
2. Where writes occurred
3. Critical bugs, missing implementation
4. Second-order effects (via graphd edge cache)
5. Backwards compatibility slop

This is triggered by the task.completed hook with trigger_code_review action.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol

from .models import TaskCompletionData


class GraphdClient(Protocol):
    """Protocol for graphd client."""
    def impact(self, payload: Dict[str, Any]) -> Dict[str, Any]: ...
    def symbol(self, path: str, line: int) -> Dict[str, Any]: ...


class Logger(Protocol):
    """Protocol for logger."""
    def info(self, msg: str, **kwargs) -> None: ...
    def debug(self, msg: str, **kwargs) -> None: ...
    def warning(self, msg: str, **kwargs) -> None: ...
    def error(self, msg: str, **kwargs) -> None: ...


def _log_config(logger: Optional[Logger], level: str, message: str) -> None:
    if not logger:
        return
    log_fn = getattr(logger, level, None)
    if log_fn:
        log_fn(message, component="hooks")


def _coerce_bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "yes", "1"):
            return True
        if lowered in ("false", "no", "0"):
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return None


@dataclass
class ReviewFinding:
    """A single finding from code review."""
    category: str  # scope, writes, bugs, effects, slop
    severity: str  # info, warning, critical
    file_path: Optional[str] = None
    line: Optional[int] = None
    message: str = ""
    suggestion: Optional[str] = None
    confidence: float = 0.5


@dataclass
class CodeReviewResult:
    """Complete code review result."""
    success: bool = True
    duration_ms: float = 0

    # Summary
    scope_summary: str = ""
    files_written_count: int = 0
    affected_count: int = 0

    # Findings by category
    findings: List[ReviewFinding] = field(default_factory=list)

    # Second-order effects
    callers_affected: List[str] = field(default_factory=list)
    importers_affected: List[str] = field(default_factory=list)
    tests_to_run: List[str] = field(default_factory=list)

    # Overall assessment
    risk_level: str = "low"  # low, medium, high, critical
    review_notes: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "duration_ms": self.duration_ms,
            "scope_summary": self.scope_summary,
            "files_written_count": self.files_written_count,
            "affected_count": self.affected_count,
            "findings": [
                {
                    "category": f.category,
                    "severity": f.severity,
                    "file_path": f.file_path,
                    "line": f.line,
                    "message": f.message,
                    "suggestion": f.suggestion,
                    "confidence": f.confidence,
                }
                for f in self.findings
            ],
            "callers_affected": self.callers_affected,
            "importers_affected": self.importers_affected,
            "tests_to_run": self.tests_to_run,
            "risk_level": self.risk_level,
            "review_notes": self.review_notes,
        }


@dataclass
class CodeReviewConfig:
    """Configuration for code review."""
    check_scope: bool = True
    check_writes: bool = True
    check_bugs: bool = True
    check_effects: bool = True
    check_slop: bool = True

    # Thresholds
    max_files_for_detailed_review: int = 20
    impact_budget: int = 30  # Max affected items to analyze

    # Slop patterns to detect
    slop_patterns: List[str] = field(default_factory=lambda: [
        r"_unused\w*",            # Renamed unused variables
        r"#\s*removed",           # Comments about removed code
        r"#\s*backwards.?compat", # Backwards compatibility comments
        r"#\s*TODO:?\s*remove",   # TODO remove comments
        r"#\s*legacy",            # Legacy markers
        r"#\s*deprecated",        # Deprecated markers
        r"re-?export",            # Re-exports for compatibility
        r"__all__\s*=",           # Explicit exports (may be slop)
    ])

    @classmethod
    def from_dict(
        cls,
        payload: Dict[str, Any],
        logger: Optional[Logger] = None,
    ) -> "CodeReviewConfig":
        if not isinstance(payload, dict):
            if payload is not None:
                _log_config(logger, "warning", "Code review config must be an object")
            return cls()

        allowed_fields = {field_def.name for field_def in fields(cls)}
        unknown_fields = sorted(set(payload.keys()) - allowed_fields)
        if unknown_fields:
            _log_config(
                logger,
                "warning",
                f"Unknown code review config fields: {', '.join(unknown_fields)}",
            )

        kwargs: Dict[str, Any] = {}
        for name in allowed_fields:
            if name not in payload:
                continue
            value = payload.get(name)
            if name.startswith("check_"):
                coerced = _coerce_bool(value)
                if coerced is None:
                    _log_config(logger, "warning", f"Invalid boolean for {name}: {value!r}")
                    continue
                kwargs[name] = coerced
                continue
            if name in ("max_files_for_detailed_review", "impact_budget"):
                try:
                    int_value = int(value)
                except (TypeError, ValueError):
                    _log_config(logger, "warning", f"Invalid integer for {name}: {value!r}")
                    continue
                if int_value < 0:
                    _log_config(logger, "warning", f"Negative value for {name}: {value!r}")
                    continue
                kwargs[name] = int_value
                continue
            if name == "slop_patterns":
                if isinstance(value, (list, tuple)):
                    patterns = [str(item) for item in value if isinstance(item, str) and item.strip()]
                    if patterns:
                        kwargs[name] = patterns
                    else:
                        _log_config(logger, "warning", "slop_patterns must contain non-empty strings")
                else:
                    _log_config(logger, "warning", f"slop_patterns must be a list, got {type(value).__name__}")
                continue

        return cls(**kwargs)


class CodeReviewer:
    """
    Automatic code reviewer that runs after task completion.

    Integrates with graphd to analyze second-order effects.
    """

    def __init__(
        self,
        graphd_client: Optional[GraphdClient] = None,
        config: Optional[CodeReviewConfig] = None,
        logger: Optional[Logger] = None,
    ):
        self.graphd = graphd_client
        self.config = config or CodeReviewConfig()
        self.logger = logger
        self._compiled_slop_patterns = [
            re.compile(p, re.IGNORECASE) for p in self.config.slop_patterns
        ]

    def _log(self, level: str, msg: str, **kwargs) -> None:
        if self.logger:
            fn = getattr(self.logger, level, None)
            if fn:
                fn(msg, component="code_reviewer", **kwargs)

    def _is_probably_text(self, path: Path, sample_size: int = 2048) -> bool:
        try:
            with path.open("rb") as handle:
                sample = handle.read(sample_size)
        except OSError:
            return False
        if not sample:
            return True
        return b"\x00" not in sample

    def review(self, completion_data: TaskCompletionData) -> CodeReviewResult:
        """
        Run full code review on task completion data.

        Args:
            completion_data: Data about the completed task

        Returns:
            CodeReviewResult with all findings
        """
        start_time = time.time()
        result = CodeReviewResult()
        result.files_written_count = len(completion_data.files_written)

        self._log("info", f"Starting code review: {len(completion_data.files_written)} files written")

        # 1. Scope analysis
        if self.config.check_scope:
            self._analyze_scope(completion_data, result)

        # 2. Write location review
        if self.config.check_writes:
            self._review_writes(completion_data, result)

        # 3. Bug detection (pattern-based)
        if self.config.check_bugs:
            self._check_for_bugs(completion_data, result)

        # 4. Second-order effects via graphd
        if self.config.check_effects and self.graphd:
            self._analyze_effects(completion_data, result)

        # 5. Backwards compatibility slop detection
        if self.config.check_slop:
            self._detect_slop(completion_data, result)

        # Calculate risk level
        result.risk_level = self._calculate_risk_level(result)

        # Build review notes
        result.review_notes = self._build_review_notes(completion_data, result)

        result.duration_ms = (time.time() - start_time) * 1000
        self._log(
            "info",
            f"Code review complete: {len(result.findings)} findings, "
            f"risk={result.risk_level}, duration={result.duration_ms:.0f}ms"
        )

        return result

    def _analyze_scope(
        self,
        data: TaskCompletionData,
        result: CodeReviewResult,
    ) -> None:
        """Analyze the scope of work done."""
        scope_parts = []

        # Summarize goal
        if data.goal:
            scope_parts.append(f"Goal: {data.goal[:100]}")

        # File counts
        if data.files_written:
            scope_parts.append(f"Files modified: {len(data.files_written)}")
        if data.files_read:
            scope_parts.append(f"Files read: {len(data.files_read)}")

        # Step summary
        total_steps = data.steps_completed + data.steps_failed + data.steps_skipped
        if total_steps > 0:
            scope_parts.append(
                f"Steps: {data.steps_completed} completed, "
                f"{data.steps_failed} failed, {data.steps_skipped} skipped"
            )

        # Tool usage
        if data.tools_used:
            unique_tools = list(set(data.tools_used))
            scope_parts.append(f"Tools: {', '.join(unique_tools[:5])}")
            if len(unique_tools) > 5:
                scope_parts.append(f"  (+{len(unique_tools) - 5} more)")

        result.scope_summary = "\n".join(scope_parts)

        # Flag scope concerns
        if len(data.files_written) > self.config.max_files_for_detailed_review:
            result.findings.append(ReviewFinding(
                category="scope",
                severity="warning",
                message=f"Large scope: {len(data.files_written)} files modified",
                suggestion="Consider breaking into smaller changes",
                confidence=0.8,
            ))

    def _review_writes(
        self,
        data: TaskCompletionData,
        result: CodeReviewResult,
    ) -> None:
        """Review where writes occurred."""
        for file_path in data.files_written:
            if not file_path:
                continue
            path = Path(file_path)

            # Check for sensitive file writes
            if path.name in (".env", ".env.local", "secrets.json", "credentials.json"):
                result.findings.append(ReviewFinding(
                    category="writes",
                    severity="critical",
                    file_path=file_path,
                    message="Write to sensitive file detected",
                    suggestion="Ensure no secrets are being committed",
                    confidence=0.95,
                ))

            # Check for config file changes
            if path.suffix in (".json", ".yaml", ".yml", ".toml") and "config" in str(path).lower():
                result.findings.append(ReviewFinding(
                    category="writes",
                    severity="info",
                    file_path=file_path,
                    message="Configuration file modified",
                    suggestion="Verify configuration changes are intentional",
                    confidence=0.7,
                ))

            # Check for test file changes
            if "test" in path.name.lower() or path.parent.name == "tests":
                result.findings.append(ReviewFinding(
                    category="writes",
                    severity="info",
                    file_path=file_path,
                    message="Test file modified",
                    suggestion="Ensure tests still pass",
                    confidence=0.6,
                ))

    def _check_for_bugs(
        self,
        data: TaskCompletionData,
        result: CodeReviewResult,
    ) -> None:
        """Pattern-based bug detection in written files."""
        bug_patterns = [
            (r"except\s*:", "Bare except clause", "Catch specific exceptions"),
            (r"# TODO", "TODO comment left in code", "Address or remove TODO"),
            (r"print\(", "Debug print statement", "Use proper logging"),
            (r"import\s+\*", "Wildcard import", "Use explicit imports"),
            (r"eval\(", "Use of eval()", "Avoid eval for security"),
            (r"exec\(", "Use of exec()", "Avoid exec for security"),
            (r"pass\s*$", "Empty pass statement", "Implement or remove placeholder"),
        ]

        for file_path in data.files_written:
            if not file_path:
                continue
            path = Path(file_path)
            if path.suffix != ".py":
                continue
            try:
                if not self._is_probably_text(path):
                    continue
                content = path.read_text(encoding="utf-8")
                lines = content.splitlines()

                for line_num, line in enumerate(lines, 1):
                    for pattern, message, suggestion in bug_patterns:
                        if re.search(pattern, line):
                            result.findings.append(ReviewFinding(
                                category="bugs",
                                severity="warning",
                                file_path=file_path,
                                line=line_num,
                                message=message,
                                suggestion=suggestion,
                                confidence=0.6,
                            ))
            except (OSError, IOError, UnicodeDecodeError):
                # File might not exist or be readable
                pass

    def _analyze_effects(
        self,
        data: TaskCompletionData,
        result: CodeReviewResult,
    ) -> None:
        """Analyze second-order effects using graphd."""
        if not self.graphd:
            return

        all_affected = set()

        for file_path in data.files_written:
            if not file_path:
                continue
            try:
                impact_response = self.graphd.impact({
                    "entity": {"type": "file", "path": file_path},
                    "change_type": "unknown",
                    "budget": self.config.impact_budget,
                })

                items = impact_response.get("items", [])
                for item in items:
                    target = item.get("target", "")
                    kind = item.get("kind", "")

                    if kind == "imports":
                        result.importers_affected.append(target)
                        all_affected.add(target)
                    elif kind == "callers":
                        result.callers_affected.append(target)
                        all_affected.add(target)
                    elif kind == "tests":
                        result.tests_to_run.append(target)
                        all_affected.add(target)

            except Exception as e:
                self._log("warning", f"Failed to get impact for {file_path}: {e}")

        result.affected_count = len(all_affected)

        # Flag high-impact changes
        if len(all_affected) > 10:
            result.findings.append(ReviewFinding(
                category="effects",
                severity="warning",
                message=f"High-impact change: {len(all_affected)} files affected",
                suggestion="Review affected callers and importers",
                confidence=0.75,
            ))

        # Suggest running tests
        if result.tests_to_run:
            result.findings.append(ReviewFinding(
                category="effects",
                severity="info",
                message=f"Tests to run: {len(result.tests_to_run)} test files affected",
                suggestion=f"Run: pytest {' '.join(result.tests_to_run[:3])}",
                confidence=0.8,
            ))

    def _detect_slop(
        self,
        data: TaskCompletionData,
        result: CodeReviewResult,
    ) -> None:
        """Detect backwards compatibility slop patterns."""
        for file_path in data.files_written:
            if not file_path:
                continue
            path = Path(file_path)
            if path.suffix != ".py":
                continue

            try:
                if not self._is_probably_text(path):
                    continue
                content = path.read_text(encoding="utf-8")
                lines = content.splitlines()

                for line_num, line in enumerate(lines, 1):
                    for pattern in self._compiled_slop_patterns:
                        if pattern.search(line):
                            result.findings.append(ReviewFinding(
                                category="slop",
                                severity="warning",
                                file_path=file_path,
                                line=line_num,
                                message=f"Potential backwards-compat slop: {pattern.pattern}",
                                suggestion="Remove if unused, or document why it's needed",
                                confidence=0.5,
                            ))
            except (OSError, IOError, UnicodeDecodeError):
                pass

        # Check for re-exports in __init__.py
        for file_path in data.files_written:
            if not file_path:
                continue
            if Path(file_path).name == "__init__.py":
                try:
                    content = Path(file_path).read_text()
                    # Look for "from X import Y" patterns that might be re-exports
                    if re.search(r"from\s+\.\w+\s+import\s+\w+", content):
                        result.findings.append(ReviewFinding(
                            category="slop",
                            severity="info",
                            file_path=file_path,
                            message="Re-exports in __init__.py",
                            suggestion="Verify re-exports are intentional API surface",
                            confidence=0.4,
                        ))
                except (OSError, IOError, UnicodeDecodeError):
                    pass

    def _calculate_risk_level(self, result: CodeReviewResult) -> str:
        """Calculate overall risk level from findings."""
        critical_count = sum(1 for f in result.findings if f.severity == "critical")
        warning_count = sum(1 for f in result.findings if f.severity == "warning")

        if critical_count > 0:
            return "critical"
        elif warning_count > 3 or result.affected_count > 20:
            return "high"
        elif warning_count > 0 or result.affected_count > 5:
            return "medium"
        else:
            return "low"

    def _build_review_notes(
        self,
        data: TaskCompletionData,
        result: CodeReviewResult,
    ) -> str:
        """Build human-readable review notes."""
        notes = []

        notes.append(f"## Code Review Summary")
        notes.append("")
        notes.append(f"**Risk Level**: {result.risk_level.upper()}")
        notes.append(f"**Files Modified**: {result.files_written_count}")
        notes.append(f"**Affected Files**: {result.affected_count}")
        notes.append("")

        if result.scope_summary:
            notes.append("### Scope")
            notes.append(result.scope_summary)
            notes.append("")

        # Group findings by category
        by_category: Dict[str, List[ReviewFinding]] = {}
        for finding in result.findings:
            if finding.category not in by_category:
                by_category[finding.category] = []
            by_category[finding.category].append(finding)

        if by_category:
            notes.append("### Findings")
            for category, findings in by_category.items():
                notes.append(f"\n**{category.title()}**:")
                for f in findings[:5]:  # Limit to 5 per category
                    severity_icon = {"critical": "🔴", "warning": "🟡", "info": "🔵"}.get(f.severity, "⚪")
                    loc = f"{f.file_path}:{f.line}" if f.file_path and f.line else (f.file_path or "")
                    notes.append(f"- {severity_icon} {f.message}")
                    if loc:
                        notes.append(f"  ({loc})")
                    if f.suggestion:
                        notes.append(f"  → {f.suggestion}")

        if result.tests_to_run:
            notes.append("")
            notes.append("### Recommended Tests")
            for test in result.tests_to_run[:5]:
                notes.append(f"- {test}")

        if result.callers_affected:
            notes.append("")
            notes.append("### Affected Callers")
            for caller in result.callers_affected[:5]:
                notes.append(f"- {caller}")
            if len(result.callers_affected) > 5:
                notes.append(f"- (+{len(result.callers_affected) - 5} more)")

        return "\n".join(notes)


def run_code_review(
    completion_data: TaskCompletionData,
    graphd_client: Optional[GraphdClient] = None,
    config: Optional[CodeReviewConfig] = None,
    logger: Optional[Logger] = None,
) -> CodeReviewResult:
    """
    Convenience function to run code review.

    Args:
        completion_data: Task completion data
        graphd_client: Optional graphd client for effect analysis
        config: Optional review configuration
        logger: Optional logger

    Returns:
        CodeReviewResult
    """
    reviewer = CodeReviewer(
        graphd_client=graphd_client,
        config=config,
        logger=logger,
    )
    return reviewer.review(completion_data)
