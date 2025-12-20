# Wizard Patch Reasoning Overhaul - Implementation Plan

## Problem Analysis

### Current State Issues

1. **Workers have no formal mechanism to suggest patches**
   - `WorkerOutcome.patches` exists but is always empty
   - Workers receive no schema/instructions for suggesting patches
   - `behavioral_rules.md` has no mention of plan modification capabilities
   - The LLM isn't told it CAN suggest changes to the plan

2. **Wizard blindly applies patches without reasoning**
   - `_apply_patches()` only uses `PolicyGate` for mechanical checks:
     - Version mismatch
     - Modifying frozen steps
     - Rate limiting
     - Thrash detection
   - No semantic reasoning: "Is this patch actually useful?"
   - No duplicate step detection
   - No validation of patch justification quality

3. **Wizard cannot create patches itself**
   - Wizard is purely reactive - executes plan, ingests outcomes
   - No mechanism to dynamically adapt plan based on:
     - Overall progress patterns
     - Discovered information
     - Stagnation signals beyond simple skip

4. **Concurrent workers have no conflict reconciliation**
   - Workers take snapshots and never mutate directly (good)
   - But when multiple workers suggest conflicting patches, no resolution exists
   - Version checking is there but coarse-grained (rejects all stale patches)

---

## Proposed Architecture

### Core Principle: Patch Arbiter

Introduce a **PatchArbiter** that sits between workers/wizard and PlanState. All patches flow through it with semantic reasoning.

```
Worker ─┐                                    ┌─> PlanState.apply_patch()
        ├─> PatchProposal ─> PatchArbiter ─┼─> Rejected (with reason)
Wizard ─┘                                    └─> Deferred (conflict)
```

### Key Components

1. **PatchProposal** - Richer patch format with reasoning
2. **PatchArbiter** - LLM-powered semantic validation
3. **Worker Patch Instructions** - Formal schema in behavioral_rules.md
4. **Wizard Self-Patching** - Wizard generates patches based on observations
5. **Conflict Resolution** - Handle concurrent worker patches

---

## Implementation Plan

### Phase 1: Worker Patch Suggestion Formalization

**Goal:** Give workers a formal schema for suggesting patches and teach them when/how to do it.

#### 1.1 Create `PatchProposal` dataclass

**File:** `src/harness/agent/wizard/plan_patch.py`

```python
@dataclass
class PatchProposal:
    """
    A patch suggestion with full reasoning context.
    Workers create these; PatchArbiter evaluates them.
    """
    patch: PlanPatch

    # Reasoning (required for approval)
    trigger: str  # What observation triggered this suggestion
    reasoning: str  # Why this patch is necessary
    evidence: List[str]  # Concrete evidence supporting the patch

    # Context for validation
    current_step_num: int  # Step the worker is executing
    plan_snapshot: Dict[int, str]  # {step_num: status} at time of suggestion

    # Risk assessment by worker
    confidence: float  # 0.0-1.0 how confident worker is
    alternatives_considered: List[str]  # Other approaches rejected
```

#### 1.2 Update `behavioral_rules.md` with patch schema

Add a new section to behavioral_rules.md:

```markdown
═══════════════════════════════════════════════════════════════════════════════
                    PLAN ADAPTATION (USE SPARINGLY)
═══════════════════════════════════════════════════════════════════════════════

You are executing ONE step of a larger plan. The Wizard manages the overall plan.
However, you may SUGGEST plan modifications when your execution reveals:
  - A blocking issue that requires a NEW step to resolve
  - A step that is now UNNECESSARY based on what you discovered
  - A better TOOL choice for a pending step

WHEN TO SUGGEST A PATCH:
  - You discovered a prerequisite that wasn't in the plan
  - You completed work that makes a future step redundant
  - You found that a tool_hint is wrong for a pending step

WHEN NOT TO SUGGEST A PATCH:
  - The plan is fine, you're just uncertain about your current step
  - You want to change YOUR current step (you can't, just pivot)
  - You're speculating about what MIGHT be needed

PATCH FORMAT:
  End your response with a [SUGGEST_PATCH] block:

  [SUGGEST_PATCH]
  type: INSERT | REMOVE | REPLACE_TOOL
  target_step: <step_num or -1 for append>

  trigger: <what you observed that prompted this>
  reasoning: <why this change is necessary>
  evidence: <specific facts supporting this>
  confidence: <0.0-1.0>

  # For INSERT:
  new_objective: <objective for new step>
  new_tool_hint: <optional tool hint>
  insert_after: <step_num>

  # For REMOVE:
  remove_step: <step_num>

  # For REPLACE_TOOL:
  new_tool_hint: <corrected tool>
  [/SUGGEST_PATCH]

The Wizard will EVALUATE your suggestion. It may be:
  - APPROVED - patch applied
  - REJECTED - patch ignored with reason
  - DEFERRED - considered later

Do NOT assume your patch will be applied. Continue your current objective.
```

#### 1.3 Parse patches from worker responses

**File:** `src/harness/agent/wizard/worker.py`

Add `_extract_patch_proposals()` method:

```python
def _extract_patch_proposals(
    self,
    content: str,
    step_num: int,
    plan_version: int,
) -> List[PatchProposal]:
    """Extract [SUGGEST_PATCH] blocks from worker response."""
    # Parse structured blocks
    # Validate required fields
    # Create PatchProposal objects
    # Return list (usually 0-1, max 2)
```

Call this in `_execute_loop` after synthesis step and add to outcome.

---

### Phase 2: Patch Arbiter with LLM Reasoning

**Goal:** Wizard reasons about patches before applying them.

#### 2.1 Create `PatchArbiter` class

**File:** `src/harness/agent/wizard/patch_arbiter.py` (new)

```python
class PatchArbiter:
    """
    Semantic validation of patch proposals.
    Uses LLM to reason about patch quality and necessity.
    """

    def __init__(self, llm: Any, plan_state: PlanState, knowledge: KnowledgeStore):
        self.llm = llm
        self.plan_state = plan_state
        self.knowledge = knowledge

    def evaluate(self, proposal: PatchProposal) -> ArbiterDecision:
        """
        Evaluate a patch proposal with semantic reasoning.

        Checks:
        1. Is the trigger/reasoning sound?
        2. Is this a duplicate of existing/completed work?
        3. Does this conflict with overall plan trajectory?
        4. Is the worker's view of the plan stale/naive?

        Returns:
            ArbiterDecision with approved/rejected/deferred and reasoning
        """
```

#### 2.2 Define evaluation criteria

```python
class RejectionReason(Enum):
    DUPLICATE_STEP = "duplicate_step"  # Step already exists or completed
    ALREADY_ACCOMPLISHED = "already_accomplished"  # Work already done
    NAIVE_VIEW = "naive_view"  # Worker doesn't see full context
    WEAK_REASONING = "weak_reasoning"  # Justification unconvincing
    CONFLICTS_WITH_PLAN = "conflicts_with_plan"  # Contradicts goal trajectory
    LOW_CONFIDENCE = "low_confidence"  # Worker itself is uncertain
    STALE_CONTEXT = "stale_context"  # Plan changed since snapshot
```

#### 2.3 LLM evaluation prompt

```python
ARBITER_PROMPT = """
You are evaluating a plan modification suggestion from a Worker.

CURRENT PLAN:
{plan_summary}

COMPLETED STEPS:
{completed_steps}

PENDING STEPS:
{pending_steps}

WORKER'S PROPOSAL:
Type: {patch_type}
Trigger: {trigger}
Reasoning: {reasoning}
Evidence: {evidence}
Confidence: {confidence}

EVALUATION CRITERIA:
1. DUPLICATE CHECK: Does this step duplicate existing or completed work?
2. ACCOMPLISHMENT CHECK: Has this already been accomplished by another step?
3. NAIVETY CHECK: Is the worker missing context that invalidates this suggestion?
4. REASONING CHECK: Is the justification concrete and evidence-based?
5. TRAJECTORY CHECK: Does this align with the overall goal?

RESPOND WITH:
decision: APPROVE | REJECT | DEFER
reason: <concise explanation>
confidence: <0.0-1.0>
"""
```

#### 2.4 Integrate into Wizard

**File:** `src/harness/agent/wizard/wizard.py`

Replace simple `_apply_patches()` with:

```python
def _evaluate_and_apply_patches(self, outcome: WorkerOutcome) -> None:
    """
    Evaluate patches through PatchArbiter before application.
    """
    arbiter = PatchArbiter(self.llm, self._plan_state, self._knowledge)

    for proposal in outcome.patch_proposals:
        # Fast-path rejections (PolicyGate)
        policy_decision = self._policy_gate.evaluate(proposal.patch, self._plan_state)
        if not policy_decision.approved:
            self._ledger.record_patch_rejected(proposal, policy_decision.reason)
            continue

        # Semantic evaluation (LLM)
        arbiter_decision = arbiter.evaluate(proposal)

        self._ledger.record_patch_decision(
            proposal.patch.patch_id,
            approved=arbiter_decision.approved,
            rejection_reason=arbiter_decision.reason,
            arbiter_reasoning=arbiter_decision.reasoning,
        )

        if arbiter_decision.approved:
            applied = self._plan_state.apply_patch(proposal.patch)
            if applied:
                self._ledger.record_patch_applied(...)
```

---

### Phase 3: Wizard Self-Patching

**Goal:** Wizard proactively creates patches based on observations.

#### 3.1 Define Wizard observation triggers

```python
class WizardObservation(Enum):
    """Events that may trigger Wizard-generated patches."""
    STAGNATION = "stagnation"  # Same step failing repeatedly
    DISCOVERY = "discovery"  # Important fact discovered
    DEPENDENCY_SATISFIED = "dependency_satisfied"  # Enables optimization
    GOAL_CLARIFIED = "goal_clarified"  # Better understanding of goal
    REDUNDANCY_DETECTED = "redundancy_detected"  # Steps overlap
```

#### 3.2 Add `_consider_self_patches()` to Wizard

```python
def _consider_self_patches(self) -> List[PlanPatch]:
    """
    Wizard evaluates whether to modify the plan itself.
    Called after each iteration when there's capacity.

    Triggers:
    - 3+ failed attempts on a step -> consider removing/replacing
    - Discovery of blocking fact -> consider inserting prerequisite
    - Completion reveals redundancy -> consider removing pending step
    """
    patches = []

    # Check stagnation patterns
    for step in self._plan_state.steps.values():
        if step.attempt_count >= 3 and step.status == StepStatus.FAILED:
            patches.append(self._create_stagnation_patch(step))

    # Check knowledge for actionable facts
    blocking_facts = self._knowledge.get_facts_by_key_prefix("blocking:")
    for fact in blocking_facts:
        patch = self._create_discovery_patch(fact)
        if patch:
            patches.append(patch)

    return patches
```

#### 3.3 Self-patch evaluation (same arbiter)

Wizard-generated patches also go through PatchArbiter for consistency:

```python
def _apply_wizard_patches(self) -> None:
    """Apply Wizard-generated patches through the same arbiter."""
    patches = self._consider_self_patches()

    for patch in patches:
        # Create proposal with Wizard as source
        proposal = PatchProposal(
            patch=patch,
            trigger="wizard_observation",
            reasoning=patch.justification,
            evidence=[self._ledger.summarize_tail()],
            current_step_num=-1,  # Wizard, not worker
            plan_snapshot=self._get_plan_snapshot(),
            confidence=0.8,
            alternatives_considered=[],
        )

        decision = self._arbiter.evaluate(proposal)
        if decision.approved:
            self._plan_state.apply_patch(patch)
```

---

### Phase 4: Concurrent Worker Conflict Resolution

**Goal:** Handle patches from concurrent workers gracefully.

#### 4.1 Patch queue with deduplication

```python
@dataclass
class PatchQueue:
    """
    Ordered queue of patch proposals awaiting evaluation.
    Handles concurrent submissions with deduplication.
    """
    pending: List[PatchProposal] = field(default_factory=list)

    def submit(self, proposal: PatchProposal) -> bool:
        """
        Submit a proposal to the queue.
        Returns False if duplicate detected.
        """
        # Check for semantic duplicates
        for existing in self.pending:
            if self._is_duplicate(existing, proposal):
                return False
        self.pending.append(proposal)
        return True

    def _is_duplicate(self, a: PatchProposal, b: PatchProposal) -> bool:
        """Check if two proposals are semantically equivalent."""
        if a.patch.operations[0].type != b.patch.operations[0].type:
            return False
        # For INSERT: check if objectives are similar
        # For REMOVE: check if targeting same step
        # etc.
```

#### 4.2 Conflict detection

```python
class ConflictType(Enum):
    SAME_TARGET = "same_target"  # Both modifying same step
    CONTRADICTORY = "contradictory"  # One inserts what other removes
    ORDERING = "ordering"  # Both trying to insert at same position

def detect_conflicts(proposals: List[PatchProposal]) -> List[Tuple[PatchProposal, PatchProposal, ConflictType]]:
    """Identify conflicting proposals in the queue."""
```

#### 4.3 Resolution strategy

```python
def resolve_conflict(
    a: PatchProposal,
    b: PatchProposal,
    conflict: ConflictType
) -> PatchProposal:
    """
    Resolve conflict between two proposals.

    Strategies:
    - SAME_TARGET: Prefer higher confidence, or more recent
    - CONTRADICTORY: Evaluate both through arbiter, pick winner
    - ORDERING: Merge if compatible, else pick first
    """
```

---

### Phase 5: Enhanced Ledger Tracking

**Goal:** Full auditability of patch lifecycle.

#### 5.1 Extended `PatchRecord`

```python
@dataclass
class PatchRecord:
    # Existing fields...

    # New: Arbiter evaluation
    arbiter_evaluated: bool = False
    arbiter_decision: Optional[str] = None  # APPROVE/REJECT/DEFER
    arbiter_reasoning: Optional[str] = None
    arbiter_confidence: Optional[float] = None

    # New: Conflict resolution
    had_conflicts: bool = False
    conflict_resolution: Optional[str] = None
    superseded_by: Optional[str] = None  # patch_id that won conflict
```

#### 5.2 New ledger methods

```python
def record_arbiter_evaluation(
    self,
    patch_id: str,
    decision: str,
    reasoning: str,
    confidence: float,
) -> None:
    """Record arbiter's semantic evaluation."""

def record_conflict_resolution(
    self,
    winner_id: str,
    loser_id: str,
    conflict_type: str,
    resolution_reason: str,
) -> None:
    """Record conflict resolution between proposals."""
```

---

## File Changes Summary

### New Files
1. `src/harness/agent/wizard/patch_arbiter.py` - Semantic patch evaluation
2. `src/harness/agent/wizard/patch_queue.py` - Concurrent submission handling

### Modified Files
1. `src/harness/agent/wizard/plan_patch.py`
   - Add `PatchProposal` dataclass
   - Add `RejectionReason` enum

2. `src/harness/agent/wizard/behavioral_rules.md`
   - Add PLAN ADAPTATION section with schema

3. `src/harness/agent/wizard/worker.py`
   - Add `_extract_patch_proposals()` method
   - Update `WorkerOutcome` to include `patch_proposals: List[PatchProposal]`
   - Call extraction in `_execute_loop`

4. `src/harness/agent/wizard/wizard.py`
   - Replace `_apply_patches()` with `_evaluate_and_apply_patches()`
   - Add `_consider_self_patches()` for proactive patching
   - Add `_apply_wizard_patches()` call in orchestration loop
   - Integrate `PatchArbiter`

5. `src/harness/agent/wizard/work_ledger.py`
   - Extend `PatchRecord` with arbiter fields
   - Add `record_arbiter_evaluation()` method
   - Add `record_conflict_resolution()` method

6. `src/harness/agent/wizard/policy_gate.py`
   - Keep as fast-path mechanical checks
   - PolicyGate runs BEFORE arbiter (cheap rejection)

---

## Implementation Order

1. **Phase 1.1-1.3**: Worker patch suggestion (behavioral rules + parsing)
2. **Phase 2.1-2.3**: PatchArbiter class with LLM evaluation
3. **Phase 2.4**: Integrate arbiter into Wizard
4. **Phase 3**: Wizard self-patching
5. **Phase 4**: Concurrent conflict resolution
6. **Phase 5**: Enhanced ledger tracking

Each phase is independently testable. Phase 1 can be deployed with simple pass-through (no arbiter) to gather data on worker suggestions before adding LLM evaluation.

---

## Testing Strategy

### Unit Tests
- `test_patch_proposal_parsing.py` - Extract patches from LLM responses
- `test_patch_arbiter.py` - Semantic evaluation logic (mock LLM)
- `test_patch_queue.py` - Deduplication and conflict detection

### Integration Tests
- End-to-end with mock LLM: worker suggests -> arbiter evaluates -> applied/rejected
- Concurrent workers submitting conflicting patches
- Wizard self-patching on stagnation

### Manual Testing
- Run TUI with verbose logging on patch lifecycle
- Verify patches appear in ledger with full reasoning

---

## Configuration

Add to `WizardConfig`:

```python
@dataclass
class WizardConfig:
    # Existing...

    # Patch Arbiter
    enable_patch_arbiter: bool = True  # Use LLM for semantic evaluation
    arbiter_model: str = "gpt-4o-mini"  # Cheaper model for evaluation
    max_patches_per_step: int = 2  # Max patches a worker can suggest

    # Wizard Self-Patching
    enable_self_patching: bool = True
    self_patch_after_failures: int = 3  # Attempts before self-patch
```

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| LLM arbiter adds latency | Use cheap model (gpt-4o-mini), batch evaluations |
| Workers spam patches | Max 2 per step, rate limiting in PolicyGate |
| Arbiter hallucinates approvals | Require concrete evidence field, log for review |
| Conflict resolution wrong | Conservative: reject both on conflict, log for analysis |
| Wizard self-patches aggressively | High threshold (3+ failures), confidence checks |

---

## Answers to Your Questions

### 1. How do workers even suggest patches formally?

**Currently:** They don't. The `WorkerOutcome.patches` field exists but workers have no instructions on how to populate it. The `behavioral_rules.md` only covers action markers and tool usage, not plan modification.

**After this plan:** Workers will use a structured `[SUGGEST_PATCH]` block in their responses. The worker's `_extract_patch_proposals()` method parses this into `PatchProposal` objects with full reasoning context.

### 2. Should patches always be applied?

**Currently:** Yes, as long as they pass PolicyGate's mechanical checks (version, frozen steps, rate limit, thrash).

**After this plan:** No. The `PatchArbiter` will evaluate each patch proposal with semantic reasoning:
- Is the worker naive about the overall plan?
- Is this duplicating existing work?
- Is the step already accomplished?
- Does the reasoning justify the change?

### 3. Should Wizard create patches itself?

**After this plan:** Yes. `_consider_self_patches()` will generate patches based on:
- Stagnation patterns (3+ failures on a step)
- Discovered blocking facts
- Detected redundancy

These go through the same arbiter for consistency.

### 4. How do we handle concurrent worker patches?

**Currently:** Version checking rejects all stale patches, which is coarse.

**After this plan:** The `PatchQueue` handles:
- Deduplication (semantically equivalent patches merged)
- Conflict detection (same target, contradictory, ordering)
- Resolution strategies (prefer higher confidence, evaluate both, merge)
