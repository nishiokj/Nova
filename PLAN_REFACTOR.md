# Two-Phase Planning Architecture (Epistemic → Instrumental)

## Problem
Current planning creates "fragile skeleton" plans that assume too much and break when reality doesn't match assumptions.

## Solution
Split planning into two explicit phases with uncertainty tracking:

### Phase A: Triage/Discovery (Epistemic)
**Goal**: Reduce entropy/uncertainty enough to make a robust execution plan
**Outputs**: Only observation steps (search, inspect, reproduce, identify constraints)
**Success**: Uncertainties reduced to acceptable threshold

### Phase B: Execution (Instrumental)
**Goal**: Execute minimal viable actions with verification gates
**Precondition**: Phase A complete, uncertainties below threshold
**Outputs**: Actions with pre/postconditions and verification

## Implementation Changes

### 1. Enhanced Plan Dataclass

```python
@dataclass
class Plan:
    # Existing fields...
    goal: str
    goal_type: str
    steps: List[PlanStep]
    success_criteria: SuccessCriteria
    estimated_complexity: str
    requires_tools: bool
    reasoning: str
    discovery_plan: List[PlanStep]
    execution_plan: List[PlanStep]
    discovery_required: bool
    assumptions: List[str]

    # NEW: Explicit uncertainty tracking
    user_intent: str = ""  # Explicitly modeled user intent
    uncertainties: List[str] = field(default_factory=list)  # What we don't know
    uncertainty_threshold: float = 0.2  # Max acceptable uncertainty (0.0-1.0)
    current_uncertainty: float = 1.0  # Current uncertainty level

    # NEW: Pre/postconditions
    preconditions: List[str] = field(default_factory=list)  # Must be true before execution
    postconditions: List[str] = field(default_factory=list)  # Will be true after completion

    # Phase tracking
    triage_complete: bool = False  # Has Phase A completed?
    triage_summary: Optional[str] = None  # What did we learn?
```

### 2. Enhanced PlanStep

```python
@dataclass
class PlanStep:
    # Existing fields...
    step_num: int
    objective: str
    tool_hint: Optional[str]
    tool_args_hint: Optional[Dict]
    success_criteria: Optional[SuccessCriteria]
    max_tool_calls: int
    depends_on: List[int]
    phase: PlanPhase

    # NEW: Uncertainty reduction tracking
    uncertainties_targeted: List[str] = field(default_factory=list)  # Which uncertainties does this reduce?
    expected_uncertainty_reduction: float = 0.0  # How much entropy reduction expected?
    actual_uncertainty_reduction: float = 0.0  # How much was actually reduced?

    # NEW: Pre/postconditions for this step
    preconditions: List[str] = field(default_factory=list)  # What must be true before this step
    postconditions: List[str] = field(default_factory=list)  # What will be true after this step

    # NEW: Verification
    verification_method: Optional[str] = None  # How to verify postconditions
```

### 3. Enhanced Planning Prompt

The planning prompt should MANDATE:

1. **User Intent Modeling**: "State what the user truly wants in one sentence"
2. **Uncertainty Listing**: "List all unknowns/assumptions that could affect success"
3. **Discovery Phase Design**: "What observations are needed to reduce each uncertainty?"
4. **Execution Phase Design**: "Given discovery results, what minimal actions are needed?"
5. **Pre/Postconditions**: "For each step, state what must be true before/after"

Example prompt structure:
```
You are a ruthless planning assistant obsessed with reducing uncertainty.

MANDATORY TWO-PHASE PLANNING:

Phase A (Triage/Discovery) - ALWAYS REQUIRED for non-trivial tasks:
- Purpose: Observe and measure to reduce uncertainty
- Tools: ONLY observation tools (read, search, inspect, list, reproduce)
- Success: Gather enough evidence to confidently plan execution
- NO modifications or actions in this phase

Phase B (Execution) - Only after Phase A:
- Purpose: Take minimal viable actions with verification
- Precondition: Discovery complete, uncertainties below threshold
- Tools: Action tools (write, run, build, deploy)
- Success: Postconditions verified

Required JSON structure:
{
  "user_intent": "Single clear statement of what user truly wants",
  "uncertainties": [
    "What we don't know that could affect success",
    "Assumptions that need verification"
  ],
  "uncertainty_threshold": 0.2,  // Max acceptable before execution

  "discovery_plan": [
    {
      "step_num": 1,
      "objective": "Concrete observation action",
      "tool_hint": "read|search|list|inspect",
      "uncertainties_targeted": ["Which uncertainties this reduces"],
      "expected_uncertainty_reduction": 0.3,
      "postconditions": ["What we'll know after this step"]
    }
  ],

  "execution_plan": [
    {
      "step_num": 1,
      "objective": "Concrete action leveraging discovery",
      "tool_hint": "write|run|build",
      "preconditions": ["What must be true before this step"],
      "postconditions": ["What will be true after this step"],
      "verification_method": "How to verify postconditions"
    }
  ],

  "assumptions": ["Explicit assumptions"],
  "preconditions": ["Must be true before ANY execution"],
  "postconditions": ["Will be true when COMPLETE"]
}
```

### 4. Execution Flow Changes

**In Executor**:

```python
def execute(self, plan: Plan, ...) -> ExecutionTrace:
    # PHASE A: Discovery/Triage (MANDATORY unless trivial)
    if plan.discovery_required and plan.discovery_plan:
        discovery_trace = self._execute_discovery_phase(plan)

        # Validate: Did we reduce uncertainty enough?
        if plan.current_uncertainty > plan.uncertainty_threshold:
            raise InsufficientDiscoveryError(
                f"Uncertainty still {plan.current_uncertainty:.2f} > threshold {plan.uncertainty_threshold:.2f}. "
                f"Unresolved uncertainties: {plan.uncertainties}"
            )

        # Update plan with discovery findings
        plan.triage_complete = True
        plan.triage_summary = self._summarize_discovery(discovery_trace)

    # PHASE B: Execution (only if discovery complete or not required)
    if not plan.discovery_required or plan.triage_complete:
        # Verify preconditions
        if not self._verify_preconditions(plan.preconditions):
            raise PreconditionViolationError("Preconditions not met")

        execution_trace = self._execute_execution_phase(plan)

        # Verify postconditions
        if not self._verify_postconditions(plan.postconditions):
            raise PostconditionViolationError("Postconditions not satisfied")

    return trace
```

### 5. Uncertainty Tracking

After each discovery step:
```python
def _update_uncertainty(self, plan: Plan, step_result: StepResult):
    """Update uncertainty based on discovery results"""
    step = next(s for s in plan.steps if s.step_num == step_result.step_num)

    # If step succeeded and targeted uncertainties
    if step_result.status == PlanStatus.COMPLETED:
        for uncertainty in step.uncertainties_targeted:
            if uncertainty in plan.uncertainties:
                plan.uncertainties.remove(uncertainty)
                plan.current_uncertainty -= step.expected_uncertainty_reduction

        step.actual_uncertainty_reduction = step.expected_uncertainty_reduction

    # Clamp to [0, 1]
    plan.current_uncertainty = max(0.0, min(1.0, plan.current_uncertainty))
```

## Benefits

1. **Explicit Uncertainty**: We track what we don't know and reduce it systematically
2. **Robust Plans**: Execution only happens after sufficient discovery
3. **Fail Fast**: If discovery shows task is impossible/different than expected, we stop
4. **Verification**: Pre/postconditions provide clear success criteria
5. **Traceable**: Know exactly why each step exists and what it accomplishes

## Example

**User Request**: "Fix the authentication bug in harness.py"

**Phase A Plan**:
```
User Intent: Fix authentication logic error in harness.py

Uncertainties:
- What is the authentication bug? (severity: high)
- Where in harness.py does it occur? (severity: high)
- What is the expected vs actual behavior? (severity: high)
- Are there existing tests? (severity: medium)

Discovery Plan:
1. Read harness.py to locate authentication code
   - Uncertainties targeted: [location]
   - Expected reduction: 0.3
   - Postcondition: Authentication code location known

2. Search for "auth" in codebase to find related files
   - Uncertainties targeted: [related files]
   - Expected reduction: 0.2
   - Postcondition: All auth-related files identified

3. Search for existing bug reports/issues
   - Uncertainties targeted: [bug nature, expected behavior]
   - Expected reduction: 0.3
   - Postcondition: Bug nature understood

4. Read tests to understand expected behavior
   - Uncertainties targeted: [expected behavior]
   - Expected reduction: 0.2
   - Postcondition: Expected behavior documented

Uncertainty Threshold: 0.2
```

**Phase B Plan** (only created after discovery):
```
Preconditions:
- Bug location identified
- Expected behavior understood
- Tests exist or test strategy defined

Execution Plan:
1. Fix the bug at identified location
   - Precondition: Bug location known
   - Postcondition: Code modified with fix
   - Verification: Code diff shows fix applied

2. Run existing tests
   - Precondition: Code modified
   - Postcondition: Tests pass
   - Verification: Test output shows "all passed"

Postconditions:
- Bug fixed
- Tests pass
- No regressions introduced
```

## Migration Path

1. ✅ Add new fields to Plan and PlanStep (backward compatible)
2. ✅ Update planning prompt to require uncertainty tracking
3. ✅ Add uncertainty update logic in Executor
4. ✅ Add pre/postcondition verification
5. ✅ Add discovery completion gate before execution
6. Test with real requests
7. Tune uncertainty thresholds

This preserves existing functionality while adding the robustness you're looking for.
