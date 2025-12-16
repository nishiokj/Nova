"""
ContextManager - Advanced context window management for agent executions.

This module provides structured, cacheable, and intelligent context management
for LLM agent executions. It implements:

- Multi-layer lifecycle: Session State → Request Build → Execution Plan
- 8 explicit context sections with different cache behaviors
- Token budget management with eviction policies
- Structured working memory with provenance tracking
- Deterministic filesystem context injection
- Addressable artifact storage
- Automatic context validation

Key classes:
- ContextState: Session-level persistent state
- ContextBuild: Request-level snapshot
- ContextPlan: Execution-level decision record
- WorkingMemoryStore: Structured fact storage
- ContextPlanner: Creates deterministic context plans
- ContextSerializer: Converts plans to API payloads
"""

from .state import ContextState, WorkingMemoryStore, WorkingMemoryEntry, MemorySource, UserRules, ConversationSummary, MemoryEntryStatus
from .build import ContextBuild, estimate_build_size
from .plan import ContextPlan, SectionPlan, PlanExecutionResult
from .sections import (
    ContextSection,
    SystemCoreSection,
    ToolManifestSection,
    ExecutionContractSection,
    UserRulesSection
)
from .planner import ContextPlanner
from .serializer import ContextSerializer
from .token_estimator import TokenEstimator, TokenBudgetTracker, TokenizerProvider
from .budget import BudgetAllocator, SectionBudget, EvictionPolicy
from .trace import ToolTraceSummary, TurnSummary, ToolCallSummary
from .artifacts import ArtifactRegistry, Artifact
from .filesystem import FilesystemContext, FileContext
from .cache import CacheValidator, CacheEntry, SectionHasher, CacheStrategy
from .policy import (
    MemoryWritePolicy,
    ConservativeWritePolicy,
    PermissiveWritePolicy,
    DefaultWritePolicy,
    WriteDecision
)

__all__ = [
    # Core lifecycle
    "ContextState",
    "ContextBuild",
    "ContextPlan",
    "estimate_build_size",

    # Working memory
    "WorkingMemoryStore",
    "WorkingMemoryEntry",
    "MemorySource",
    "MemoryEntryStatus",
    "UserRules",
    "ConversationSummary",

    # Sections
    "ContextSection",
    "SectionPlan",
    "SystemCoreSection",
    "ToolManifestSection",
    "ExecutionContractSection",
    "UserRulesSection",

    # Planning & execution
    "ContextPlanner",
    "ContextSerializer",
    "PlanExecutionResult",

    # Token management
    "TokenEstimator",
    "TokenBudgetTracker",
    "TokenizerProvider",
    "BudgetAllocator",
    "SectionBudget",
    "EvictionPolicy",

    # Tool trace
    "ToolTraceSummary",
    "TurnSummary",
    "ToolCallSummary",

    # Artifacts
    "ArtifactRegistry",
    "Artifact",

    # Filesystem
    "FilesystemContext",
    "FileContext",

    # Caching
    "CacheValidator",
    "CacheEntry",
    "SectionHasher",
    "CacheStrategy",

    # Policies
    "MemoryWritePolicy",
    "ConservativeWritePolicy",
    "PermissiveWritePolicy",
    "DefaultWritePolicy",
    "WriteDecision",
]
