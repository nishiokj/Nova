"""
Wizard Orchestration Layer

Replaces the rigid Plan→Execute→Reflect pipeline with an adaptive
Wizard (outer loop) + Workers (inner loop) architecture.

Key Principles:
1. Single-writer global state: Only Wizard mutates PlanState/Ledger/Stores
2. Append-only ledgers: No rewriting history
3. Versioned plan swaps: PlanPatches guarded by PolicyGate
4. Immutable step objectives: Replanning changes future steps only
5. Bounded autonomy: Workers propose, Wizard decides

This module is SELF-CONTAINED and does not depend on harness.agent.plan_models.
All types are defined in .types module.

Usage:
    from harness.agent.wizard import Wizard, WizardConfig, WizardPlan, WizardStep

    wizard = Wizard(tool_registry, llm, planner, config=WizardConfig())
    result = wizard.orchestrate(user_input, context)
    print(result.to_dict())
"""

# Core types (self-contained, no external dependencies)
from .types import (
    StepStatus,
    StepPhase,
    GoalType,
    DependencyType,
    StepDependency,
    SuccessCriteria,
    WizardStep,
    WizardPlan,
    WizardReflection,
    ToolCallRecord,
    convert_plan_to_wizard_plan,
)

# Plan state
from .plan_state import PlanState, StepState

# Work ledger
from .work_ledger import WorkLedger, LedgerEntry, EntryStatus, PatchRecord, PatchDecision

# Stores
from .knowledge_store import KnowledgeStore, KnowledgeFact, FactSource

# Work items
from .work_item import WorkItem, WorkBounds, WorkItemCriteria


# Context Window
from .context_window import (
    ContextWindow,
    SystemPrompt,
    BehavioralRules,
    FileContent,
    ToolExchange,
    StreamBuffer,
    # Phase 4: Responses API
    ResponsesAPIInput,
    # Phase 5: Advanced Context Management
    ContextMetrics,
    CompactionResult,
    FileLoadStrategy,
)

# Worker
from .worker import (
    Worker,
    WorkerConfig,
    WorkerOutcome,
  #  VerificationResult,
   # SuccessLevel,
    WorkerAction,
)

# Plan patches
from .plan_patch import PlanPatch, PatchOperation, PatchType

# Policy gate
from .policy_gate import PolicyGate, PolicyDecision, PolicyViolation

# Stagnation detection
from .stagnation import StagnationDetector, StagnationSignal

# Core orchestrator
from .wizard import Wizard, WizardConfig, WizardResult

__all__ = [
    # Core types (from types.py)
    "StepStatus",
    "StepPhase",
    "GoalType",
    "DependencyType",
    "StepDependency",
    "SuccessCriteria",
    "WizardStep",
    "WizardPlan",
    "WizardReflection",
    "ToolCallRecord",
    # Core orchestrator
    "Wizard",
    "WizardConfig",
    "WizardResult",
    # Plan state
    "PlanState",
    "StepState",
    # Work ledger
    "WorkLedger",
    "LedgerEntry",
    "EntryStatus",
    "PatchRecord",
    "PatchDecision",
    # Knowledge store
    "KnowledgeStore",
    "KnowledgeFact",
    "FactSource",
    # Work items
    "WorkItem",
    "WorkBounds",
    "WorkItemCriteria",
    # Context Window
    "ContextWindow",
    "SystemPrompt",
    "BehavioralRules",
    "FileContent",
    "ToolExchange",
    "StreamBuffer",
    # Phase 4: Responses API
    "ResponsesAPIInput",
    # Phase 5: Advanced Context Management
    "ContextMetrics",
    "CompactionResult",
    "FileLoadStrategy",
    # Worker
    "Worker",
    "WorkerConfig",
    "WorkerOutcome",
    "WorkerAction",
    # Plan patches
    "PlanPatch",
    "PatchOperation",
    "PatchType",
    # Policy gate
    "PolicyGate",
    "PolicyDecision",
    "PolicyViolation",
    # Stagnation detection
    "StagnationDetector",
    "StagnationSignal",
]
