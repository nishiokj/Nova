"""
Context Build - Request-level snapshot for context construction.

This module implements the middle layer of the context lifecycle:
ContextBuild represents an immutable snapshot of everything needed
to build context for a specific request.

Lifecycle:
1. ContextState (session) provides persistent state
2. ContextBuild.from_request() creates snapshot for this request
3. ContextPlanner.plan() uses ContextBuild to create execution plan

ContextBuild is immutable and captures:
- Reference to session state
- Current request
- Tool trace
- Artifacts
- Filesystem context
- Execution tier
"""

import time
import os
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any

from .state import ContextState
from .trace import ToolTraceSummary
from .artifacts import ArtifactRegistry
from .filesystem import FilesystemContext
from .token_estimator import TokenEstimator


@dataclass
class ContextBuild:
    """
    Request-level immutable snapshot for context construction.

    This captures everything needed to build context for one request,
    without modifying the underlying session state.
    """
    state: ContextState
    """Reference to session state"""

    request_id: str
    """Unique request identifier"""

    user_request: str
    """User's request text"""

    tier: str = "standard"
    """Agent tier for this request"""

    additional_context: Optional[str] = None
    """Optional additional context"""

    tool_trace: Optional[ToolTraceSummary] = None
    """Tool execution history"""

    artifacts: Optional[ArtifactRegistry] = None
    """Artifact registry"""

    filesystem_context: Optional[str] = None
    """Pre-built filesystem context"""

    working_dir: str = ""
    """Working directory"""

    recent_file_operations: List[Dict[str, Any]] = field(default_factory=list)
    """Recent file operations (for filesystem context)"""

    created_at: float = field(default_factory=time.time)
    """When this build was created"""

    metadata: Dict[str, Any] = field(default_factory=dict)
    """Additional metadata"""

    @classmethod
    def from_request(
        cls,
        state: ContextState,
        request_id: str,
        user_request: str,
        tier: str = "standard",
        additional_context: Optional[str] = None,
        tool_trace: Optional[ToolTraceSummary] = None,
        artifacts: Optional[ArtifactRegistry] = None,
        recent_file_operations: Optional[List[Dict[str, Any]]] = None,
        working_dir: Optional[str] = None,
        token_estimator: Optional[TokenEstimator] = None
    ) -> "ContextBuild":
        """
        Create ContextBuild from request parameters.

        Args:
            state: Session state
            request_id: Request identifier
            user_request: User's request text
            tier: Agent tier
            additional_context: Optional additional context
            tool_trace: Tool execution history
            artifacts: Artifact registry
            recent_file_operations: Recent file operations
            working_dir: Working directory
            token_estimator: Token estimator for filesystem context

        Returns:
            ContextBuild instance
        """
        # Use or create defaults
        tool_trace = tool_trace or ToolTraceSummary()
        artifacts = artifacts or ArtifactRegistry()
        recent_file_operations = recent_file_operations or []
        working_dir = working_dir or os.getcwd()

        # Build filesystem context if working_dir provided
        filesystem_context = None
        if working_dir and os.path.isdir(working_dir):
            fs_builder = FilesystemContext(working_dir, token_estimator)
            filesystem_context = fs_builder.build(
                user_request=user_request,
                recent_operations=recent_file_operations,
                budget_tokens=20_000  # Default budget
            )

        return cls(
            state=state,
            request_id=request_id,
            user_request=user_request,
            tier=tier,
            additional_context=additional_context,
            tool_trace=tool_trace,
            artifacts=artifacts,
            filesystem_context=filesystem_context,
            working_dir=working_dir,
            recent_file_operations=recent_file_operations
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for logging."""
        return {
            "request_id": self.request_id,
            "session_id": self.state.session_id,
            "tier": self.tier,
            "user_request_length": len(self.user_request),
            "has_additional_context": self.additional_context is not None,
            "tool_trace_stats": self.tool_trace.get_summary_stats() if self.tool_trace else None,
            "artifact_stats": self.artifacts.get_stats() if self.artifacts else None,
            "working_dir": self.working_dir,
            "created_at": self.created_at,
            "metadata": self.metadata
        }


def estimate_build_size(build: ContextBuild, token_estimator: TokenEstimator) -> Dict[str, int]:
    """
    Estimate token counts for each component of the build.

    Useful for planning and debugging.

    Args:
        build: ContextBuild to estimate
        token_estimator: Token estimator

    Returns:
        Dictionary mapping component to estimated tokens
    """
    sizes = {}

    # User request
    sizes["user_request"] = token_estimator.count_tokens(build.user_request)

    # Additional context
    if build.additional_context:
        sizes["additional_context"] = token_estimator.count_tokens(build.additional_context)
    else:
        sizes["additional_context"] = 0

    # Working memory
    if build.state.working_memory:
        memory_text = build.state.working_memory.to_bullets()
        sizes["working_memory"] = token_estimator.count_tokens(memory_text)
    else:
        sizes["working_memory"] = 0

    # Tool trace
    if build.tool_trace:
        trace_text = build.tool_trace.to_text()
        sizes["tool_trace"] = token_estimator.count_tokens(trace_text)
    else:
        sizes["tool_trace"] = 0

    # Artifacts
    if build.artifacts:
        artifact_text = build.artifacts.to_context_summary()
        sizes["artifacts"] = token_estimator.count_tokens(artifact_text)
    else:
        sizes["artifacts"] = 0

    # Filesystem context
    if build.filesystem_context:
        sizes["filesystem_context"] = token_estimator.count_tokens(build.filesystem_context)
    else:
        sizes["filesystem_context"] = 0

    # User rules
    if build.state.user_rules and build.state.user_rules.rules:
        rules_text = "\n".join(build.state.user_rules.rules)
        sizes["user_rules"] = token_estimator.count_tokens(rules_text)
    else:
        sizes["user_rules"] = 0

    # Total
    sizes["total"] = sum(sizes.values())

    return sizes
