# Step-Centric Execution - Implementation Summary

## Overview

Successfully refactored execution from **tool-call-centric** to **step-centric** architecture. Steps are now units of work (sub-goals) that can involve 0-N tool calls, not 1:1 mappings.

## Problem Solved

**Before:**
```python
# Tool-call-centric (WRONG)
current_step_idx = 0
while has_tool_calls:
    for tool_call in response.tool_calls:
        execute_tool()
        # Assume 1 tool call = 1 step ❌
        step = plan.steps[current_step_idx]
        step.status = COMPLETED
        current_step_idx += 1
```

**Issues:**
- 1:1 tool call to step mapping assumption
- No step boundaries (can't tell when step ends)
- No accumulated context within step
- No step-level validation
- Silent partial completion

**After:**
```python
# Step-centric (CORRECT)
for step in plan.steps:
    # Check dependencies first
    if not dependencies_met(step):
        skip_step()

    # Execute step (may involve multiple tool calls)
    execute_step(step)  # 0-N tool calls within this step

    # Validate step completed its objective
    if step.success_criteria:
        validate_step(step)

    # Move to next step only after this one completes
```

**Benefits:**
- Steps have clear boundaries
- Accumulated context within step
- Validation checks if objective achieved
- Dependencies enforced
- Better failure isolation

## New Data Structures

### 1. StepContext
**Purpose:** Accumulate data during step execution (multiple tool calls)

```python
@dataclass
class StepContext:
    tool_calls_made: List[ToolCallRecord]        # All tool calls in this step
    tool_results: Dict[str, Any]                 # tool_name -> last result
    intermediate_reasoning: List[str]            # LLM reasoning
    validation_checks: Dict[str, bool]           # Check results
    accumulated_data: Dict[str, Any]             # Step's working memory
```

**Key method:**
```python
def add_tool_result(self, tool_name: str, result: ToolResult):
    """Store tool result and extract data to accumulated_data"""
```

### 2. ToolCallRecord
**Purpose:** Track individual tool calls within a step

```python
@dataclass
class ToolCallRecord:
    tool_name: str
    arguments: Dict[str, Any]
    result: ToolResult
    duration_ms: float
    timestamp: float
```

### 3. ValidationResult
**Purpose:** Result of validating step success criteria

```python
@dataclass
class ValidationResult:
    passed: bool
    details: str
    confidence: float = 1.0
```

### 4. Enhanced PlanStep
**Added fields:**
```python
@dataclass
class PlanStep:
    # New fields
    max_tool_calls: int = 10                     # Safety limit per step
    context: Optional[StepContext] = None         # Accumulated context
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    validation_passed: bool = False
    validation_details: Optional[str] = None

    @property
    def result(self) -> Optional[Any]:
        """Convenience - returns accumulated_data"""
        return self.context.accumulated_data if self.context else None
```

### 5. Enhanced SuccessCriteria
**Added field:**
```python
@dataclass
class SuccessCriteria:
    description: str
    required_outputs: List[str]
    validation_hints: List[str]
    automated_checks: Optional[Dict[str, Any]] = None  # NEW
```

## New Executor Methods

### 1. _execute_plan_stepwise()
**Purpose:** Main entry point - execute plan step-by-step

```python
def _execute_plan_stepwise(self, plan, messages, tools, trace, ...):
    for step in plan.steps:
        # Check dependencies
        if not self._dependencies_met(step, plan.steps):
            step.status = FAILED
            continue

        # Execute step (0-N tool calls)
        self._execute_step(step, messages, tools, trace, ...)

        # Stop if critical step failed
        if step.status == FAILED:
            break
```

**Key insight:** Iterates over **steps**, not tool calls. Each step execution is isolated.

### 2. _execute_step()
**Purpose:** Execute a single step (may involve multiple tool calls)

```python
def _execute_step(self, step, messages, tools, trace, ...):
    step.started_at = time.time()
    step.context = StepContext()

    # Add step guidance to focus LLM
    guidance = self._create_step_guidance(step)
    messages_with_guidance = messages + [system_message(guidance)]

    tool_calls_in_step = 0

    # Execute until step completes or hits limit
    while not step_complete and tool_calls_in_step < step.max_tool_calls:
        response = llm.complete(messages_with_guidance, tools)

        if not response.has_tool_calls:
            step_complete = True
            break

        # Process all tool calls in this response
        for tool_call in response.tool_calls:
            result = execute_tool(tool_call)

            # Record in step context
            record = ToolCallRecord(...)
            step.context.tool_calls_made.append(record)
            step.context.add_tool_result(tool_name, result)

            tool_calls_in_step += 1

    # Validate step
    if step.success_criteria:
        validation = self._validate_step(step)
        step.validation_passed = validation.passed
```

**Key features:**
- Tracks `tool_calls_in_step` (not global counter)
- Accumulates all tool results in `step.context`
- Step guidance helps LLM stay focused
- Validates after execution

### 3. _create_step_guidance()
**Purpose:** Generate system message to guide LLM for specific step

```python
def _create_step_guidance(self, step):
    return f"""
You are currently executing Step {step.step_num} of a multi-step plan.

STEP OBJECTIVE: {step.objective}

SUCCESS CRITERIA: {step.success_criteria.description}

REQUIRED OUTPUTS: {step.success_criteria.required_outputs}

Focus ONLY on completing this step. Do not move ahead to other steps.
When you have accomplished this step's objective, provide a final response WITHOUT additional tool calls.

SUGGESTED TOOL: {step.tool_hint}
"""
```

**Impact:** LLM knows exactly what this step should accomplish, reducing drift.

### 4. _validate_step()
**Purpose:** Check if step achieved its success criteria

```python
def _validate_step(self, step):
    if not step.success_criteria:
        return ValidationResult(passed=True)

    # Check required outputs exist
    if criteria.required_outputs:
        missing = [r for r in criteria.required_outputs
                   if r not in step.context.accumulated_data]
        if missing:
            return ValidationResult(passed=False, details=f"Missing: {missing}")

    # Run automated checks
    if criteria.automated_checks:
        for check_name, check_config in criteria.automated_checks.items():
            if check_name == "min_items":
                # Check accumulated data has minimum items
                ...

    return ValidationResult(passed=True)
```

**Key point:** Validates against step's **objective**, not just whether tools succeeded.

### 5. _dependencies_met()
**Purpose:** Check if step's dependencies are satisfied

```python
def _dependencies_met(self, step, all_steps):
    if not step.depends_on:
        return True

    for dep_num in step.depends_on:
        dep_step = find_step(all_steps, dep_num)
        if not dep_step or dep_step.status != COMPLETED:
            return False

    return True
```

**Impact:** Ensures Step 2 doesn't execute before Step 1 completes.

## Execution Flow Example

**Task:** "Analyze last 5 log files for errors"

**Plan:**
```python
Plan(
    goal="Analyze last 5 log files for errors",
    steps=[
        PlanStep(
            step_num=1,
            objective="List log files in /logs directory",
            success_criteria=SuccessCriteria(
                description="Have list of log files",
                required_outputs=["file_list"]
            ),
            max_tool_calls=2
        ),
        PlanStep(
            step_num=2,
            objective="Read content of last 5 log files",
            depends_on=[1],
            success_criteria=SuccessCriteria(
                description="Have content for 5 files",
                required_outputs=["log_contents"],
                automated_checks={"min_items": 5}
            ),
            max_tool_calls=10
        ),
        PlanStep(
            step_num=3,
            objective="Identify top 3 error patterns",
            depends_on=[2],
            success_criteria=SuccessCriteria(
                description="Have 3 error categories",
                required_outputs=["error_patterns"]
            ),
            max_tool_calls=5
        )
    ]
)
```

**Execution:**
```
Step 1: "List log files in /logs directory"
  - Guidance: "Focus ONLY on listing files. Need: file_list"
  - Tool Call 1: list_directory("/logs") → [file1, file2, file3, file4, file5]
  - Context accumulated: file_list = [file1, ..., file5]
  - Validation: ✓ Have file_list
  - Status: COMPLETED (1 tool call, 50ms)

Step 2: "Read content of last 5 log files"
  - Dependencies: Step 1 ✓
  - Guidance: "Focus ONLY on reading files. Need: log_contents (min 5)"
  - Tool Call 1: read_file("file1.log") → content1
  - Tool Call 2: read_file("file2.log") → content2
  - Tool Call 3: read_file("file3.log") → content3
  - Tool Call 4: read_file("file4.log") → content4
  - Tool Call 5: read_file("file5.log") → content5
  - Context accumulated: log_contents = [content1, ..., content5]
  - Validation: ✓ Have 5 items in log_contents
  - Status: COMPLETED (5 tool calls, 250ms)

Step 3: "Identify top 3 error patterns"
  - Dependencies: Step 2 ✓
  - Guidance: "Focus ONLY on finding patterns. Need: error_patterns"
  - [Reasoning over accumulated log contents from Step 2]
  - Tool Call 1: analyze_patterns(logs) → [pattern1, pattern2, pattern3]
  - Context accumulated: error_patterns = [pattern1, pattern2, pattern3]
  - Validation: ✓ Have error_patterns
  - Status: COMPLETED (1 tool call, 100ms)

Plan Status: COMPLETED (3 steps, 7 tool calls, 400ms total)
```

## Key Improvements

### 1. Explicit Boundaries
**Before:** No way to know when Step 1 ends and Step 2 begins
**After:** Step completes when LLM stops requesting tools OR max_tool_calls reached OR validation passes

### 2. Accumulated Context
**Before:** Each tool call isolated, no memory within step
**After:** `step.context.accumulated_data` persists across tool calls

Example:
```python
# Step 2 can reference Step 1's outputs
step1.context.accumulated_data["file_list"]  # From Step 1
step2.context.accumulated_data["log_contents"]  # From Step 2
```

### 3. Validation
**Before:** Only checked if tool succeeded (no error)
**After:** Checks if step **objective achieved** (has required outputs)

```python
# Step fails even if tool succeeded, if validation fails
step.status = COMPLETED  # Tool ran fine
validation = validate_step(step)
if not validation.passed:
    step.status = FAILED  # But objective not met
```

### 4. Better Logging
**Before:** Logged individual tool calls with confusing step assignment
**After:** Logs at step level with aggregated tool info

```
[Step 1 completed] List log files (1 tool call, 50ms)
[Step 2 completed] Read 5 log files (5 tool calls: read_file, read_file, read_file, read_file, read_file, 250ms)
[Step 3 completed] Analyze patterns (1 tool call, 100ms)
```

### 5. Dependency Management
**Before:** No enforcement, steps could execute out of order
**After:** Explicit dependency checking before execution

```python
Step 2: depends_on=[1]  # Won't start until Step 1 COMPLETED
Step 3: depends_on=[2]  # Won't start until Step 2 COMPLETED
```

### 6. Failure Isolation
**Before:** Tool failure in Step 2 could corrupt Step 1's tracking
**After:** Each step has isolated context, failures don't leak

```python
# Step 2 fails, but Step 1's context preserved
step1.context.accumulated_data["file_list"]  # Still accessible
step2.status = FAILED  # Isolated failure
step3.status = PENDING  # Never executed due to dependency
```

## Testing

Created `test_step_execution.py` with 6 tests:

1. **StepContext Accumulation** - Multiple tool calls in one step ✓
2. **Step Boundaries** - Clear start/end with max_tool_calls ✓
3. **Validation** - Success criteria checking ✓
4. **Dependency Checking** - Step execution order enforcement ✓
5. **Step Guidance** - LLM focus messages ✓
6. **Plan Structure** - Multi-step plans with dependencies ✓

All tests passing.

## Files Modified

1. **harness/planner.py** (major refactor, ~900 lines)
   - Added: `ToolCallRecord`, `StepContext`, `ValidationResult`
   - Enhanced: `PlanStep`, `SuccessCriteria`
   - Replaced: `_execute_with_tools()` → `_execute_plan_stepwise()` + `_execute_step()`
   - Added: `_create_step_guidance()`, `_validate_step()`, `_dependencies_met()`

2. **docs/step_centric_execution_design.md** (new, design document)
3. **docs/step_centric_implementation_summary.md** (new, this file)
4. **test_step_execution.py** (new, test suite)

## Next Steps (Future Work)

### 1. Improve Planner Prompts
Update planning prompt to create steps with:
- Clearer objectives
- Explicit success criteria
- Appropriate max_tool_calls limits
- Proper dependencies

### 2. LLM-Based Validation
For complex validation, use LLM to evaluate:
```python
if criteria.use_llm_validation:
    # Ask LLM: "Did step achieve: {objective}?"
    validation = llm_validate(step, criteria)
```

### 3. Step Timeout
Add per-step timeout (not just global):
```python
@dataclass
class PlanStep:
    timeout_seconds: int = 120  # Per-step timeout
```

### 4. Conditional Steps
Support conditional execution:
```python
@dataclass
class PlanStep:
    condition: Optional[str] = None  # "if step 1 found errors"
```

### 5. Parallel Steps
Allow steps without dependencies to run in parallel:
```python
# Step 2 and Step 3 don't depend on each other
steps = [
    PlanStep(step_num=1, ...),
    PlanStep(step_num=2, depends_on=[1]),  # Can run in parallel with 3
    PlanStep(step_num=3, depends_on=[1]),  # Can run in parallel with 2
]
```

### 6. Step Retry Logic
Add retry on failure:
```python
@dataclass
class PlanStep:
    max_retries: int = 0  # Retry failed steps
```

## Impact

This refactor fundamentally changes how we think about execution:

**Old model:** "Execute tool calls as LLM requests them"
- Reactive, tool-driven
- No clear work boundaries
- Hard to track progress
- Validation only at tool level

**New model:** "Execute steps to achieve sub-goals"
- Proactive, goal-driven
- Clear work units (steps)
- Easy to track progress (which step?)
- Validation at objective level

**Result:** More robust, trackable, and explicit execution that better matches the mental model: "Step = sub-goal to accomplish."
