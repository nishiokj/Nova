"""
Tool Trace Summary - Compact execution history to prevent re-discovery.

This module implements the Tool Trace Summary section - a compressed history
of recent tool executions that prevents the agent from repeating work.

Key insight: The agent needs to know "I already tried X and got Y" without
replaying the full conversation history.

Structure:
- Recent N turns (default 3)
- Each turn: tools called, files changed, errors, discoveries
- Compressed: only key information, not full outputs
"""

import time
from dataclasses import dataclass, field, asdict
from typing import List, Optional, Dict, Any


@dataclass
class ToolCallSummary:
    """
    Compact summary of a single tool call.

    Records what was called, key arguments, status, and outcome.
    """
    tool_name: str
    """Tool that was called"""

    args_preview: str
    """Key arguments (truncated)"""

    status: str
    """Status: 'success', 'error', 'timeout'"""

    output_preview: str = ""
    """First 200 chars of output or summary"""

    artifact_ref: Optional[str] = None
    """Reference to artifact if output stored (e.g., artifact://abc123)"""

    duration_ms: float = 0.0
    """Execution duration in milliseconds"""

    error_message: Optional[str] = None
    """Error message if status='error'"""

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ToolCallSummary":
        """Create from dictionary."""
        return cls(**data)

    def to_bullet(self) -> str:
        """Render as single bullet for context."""
        status_icon = "✓" if self.status == "success" else "✗"
        output = self.output_preview if self.output_preview else "(no output)"

        if len(output) > 100:
            output = output[:100] + "..."

        parts = [f"{status_icon} {self.tool_name}({self.args_preview})"]

        if self.status == "success":
            if self.artifact_ref:
                parts.append(f" → {self.artifact_ref}")
            else:
                parts.append(f" → {output}")
        else:
            parts.append(f" → Error: {self.error_message or 'Unknown error'}")

        return "".join(parts)


@dataclass
class TurnSummary:
    """
    Summary of what happened in one agent turn.

    Captures the key events, decisions, and outcomes of a single turn.
    """
    turn_num: int
    """Turn number (0-indexed)"""

    user_input_preview: str
    """First 100 chars of user input"""

    tools_called: List[ToolCallSummary] = field(default_factory=list)
    """Tools that were called"""

    files_changed: List[str] = field(default_factory=list)
    """Files that were modified"""

    errors: List[str] = field(default_factory=list)
    """Errors encountered"""

    discoveries: List[str] = field(default_factory=list)
    """Key facts discovered (added to working memory)"""

    artifacts_created: List[str] = field(default_factory=list)
    """Artifact handles created (e.g., artifact://abc123)"""

    outcome: str = "success"
    """Overall outcome: 'success', 'error', 'timeout', 'partial'"""

    timestamp: float = field(default_factory=time.time)
    """When this turn occurred"""

    @property
    def tool_count(self) -> int:
        """Number of tools called."""
        return len(self.tools_called)

    @property
    def had_errors(self) -> bool:
        """Whether any errors occurred."""
        return len(self.errors) > 0 or any(
            tc.status == "error" for tc in self.tools_called
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "turn_num": self.turn_num,
            "user_input_preview": self.user_input_preview,
            "tools_called": [tc.to_dict() for tc in self.tools_called],
            "files_changed": self.files_changed,
            "errors": self.errors,
            "discoveries": self.discoveries,
            "artifacts_created": self.artifacts_created,
            "outcome": self.outcome,
            "timestamp": self.timestamp
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TurnSummary":
        """Create from dictionary."""
        data = data.copy()
        data["tools_called"] = [
            ToolCallSummary.from_dict(tc) for tc in data.get("tools_called", [])
        ]
        return cls(**data)

    def to_text(self, verbose: bool = False) -> str:
        """
        Render as text for LLM context.

        Args:
            verbose: Include full details vs compact summary
        """
        lines = [f"## Turn {self.turn_num}"]

        # User input
        lines.append(f"User: {self.user_input_preview}")

        # Tools called
        if self.tools_called:
            lines.append(f"Tools called ({len(self.tools_called)}):")
            for tc in self.tools_called:
                if verbose:
                    lines.append(f"  {tc.to_bullet()}")
                else:
                    # Compact: just tool names
                    lines.append(f"  - {tc.tool_name}")

        # Files changed
        if self.files_changed:
            lines.append(f"Files changed: {', '.join(self.files_changed)}")

        # Discoveries
        if self.discoveries:
            lines.append("Discoveries:")
            for discovery in self.discoveries:
                lines.append(f"  - {discovery}")

        # Errors
        if self.errors:
            lines.append("Errors:")
            for error in self.errors:
                lines.append(f"  - {error}")

        # Outcome
        lines.append(f"Outcome: {self.outcome}")

        return "\n".join(lines)


class ToolTraceSummary:
    """
    Compact summary of recent tool executions.

    Prevents re-discovery by showing agent what it already tried.
    Keeps only last N turns (default 3) to stay compact.
    """

    def __init__(self, max_turns: int = 3):
        """
        Initialize trace summary.

        Args:
            max_turns: Maximum number of turns to keep
        """
        self.recent_turns: List[TurnSummary] = []
        self.max_turns = max_turns
        self.total_turns: int = 0

    def add_turn(self, turn: TurnSummary):
        """
        Add a turn to the trace.

        Automatically manages capacity by dropping oldest.
        """
        self.recent_turns.append(turn)
        self.total_turns += 1

        # Keep only last N turns
        if len(self.recent_turns) > self.max_turns:
            self.recent_turns = self.recent_turns[-self.max_turns:]

    def get_recent_tools(self, n: int = 10) -> List[str]:
        """Get list of recently used tools."""
        tools = []
        for turn in reversed(self.recent_turns):
            for tc in turn.tools_called:
                tools.append(tc.tool_name)
                if len(tools) >= n:
                    return tools
        return tools

    def get_recent_files(self, n: int = 10) -> List[str]:
        """Get list of recently changed files."""
        files = []
        seen = set()
        for turn in reversed(self.recent_turns):
            for file in turn.files_changed:
                if file not in seen:
                    files.append(file)
                    seen.add(file)
                    if len(files) >= n:
                        return files
        return files

    def has_recent_error_with(self, tool_name: str) -> Optional[str]:
        """
        Check if tool recently failed.

        Args:
            tool_name: Tool to check

        Returns:
            Error message if found, None otherwise
        """
        for turn in reversed(self.recent_turns):
            for tc in turn.tools_called:
                if tc.tool_name == tool_name and tc.status == "error":
                    return tc.error_message
        return None

    def to_text(self, verbose: bool = False) -> str:
        """
        Render as text for LLM context.

        Args:
            verbose: Include full details vs compact summary
        """
        if not self.recent_turns:
            return "No recent execution history."

        lines = [
            f"# Tool Trace Summary",
            f"Recent {len(self.recent_turns)} of {self.total_turns} total turns",
            ""
        ]

        for turn in self.recent_turns:
            lines.append(turn.to_text(verbose=verbose))
            lines.append("")

        return "\n".join(lines)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "recent_turns": [turn.to_dict() for turn in self.recent_turns],
            "max_turns": self.max_turns,
            "total_turns": self.total_turns
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ToolTraceSummary":
        """Create from dictionary."""
        trace = cls(max_turns=data.get("max_turns", 3))
        trace.total_turns = data.get("total_turns", 0)
        trace.recent_turns = [
            TurnSummary.from_dict(turn_data)
            for turn_data in data.get("recent_turns", [])
        ]
        return trace

    def compact(self, target_turns: int) -> int:
        """
        Compact to target number of turns.

        Args:
            target_turns: Target number of turns to keep

        Returns:
            Number of turns removed
        """
        if len(self.recent_turns) <= target_turns:
            return 0

        removed = len(self.recent_turns) - target_turns
        self.recent_turns = self.recent_turns[-target_turns:]
        return removed

    def get_summary_stats(self) -> Dict[str, Any]:
        """Get summary statistics."""
        total_tools = sum(turn.tool_count for turn in self.recent_turns)
        total_errors = sum(len(turn.errors) for turn in self.recent_turns)
        total_discoveries = sum(len(turn.discoveries) for turn in self.recent_turns)

        return {
            "total_turns": self.total_turns,
            "recent_turns": len(self.recent_turns),
            "total_tools_called": total_tools,
            "total_errors": total_errors,
            "total_discoveries": total_discoveries,
            "average_tools_per_turn": total_tools / max(1, len(self.recent_turns))
        }
