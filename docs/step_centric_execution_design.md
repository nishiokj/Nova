# Step-Centric Execution Architecture Design

## Problem Statement

**Current Issue**: Execution conflates tool calls with logical work units.

```python
# Current approach (lines 543-628 in planner.py):
current_step_idx = 0
while response.has_tool_calls:
    for tool_call in response.tool_calls:
        # Execute tool
        result = self.tool_registry.execute(tool_call.name, **tool_call.arguments)

        # Try to match to step (WRONG - 1:1 mapping assumption)
        if current_step_idx < len(plan.steps):
            step = plan.steps[current_step_idx]
            step.status = COMPLETED if result.is_success else FAILED
            current_step_idx += 1
```

**Problems with current approach:**
1. **1:1 tool call to step mapping** - Assumes each tool call = 1 step
2. **No step boundaries** - Can't tell when step 1 ends and step 2 begins
3. **No step-level context** - Each tool call is isolated, no accumulated state
4. **No step validation** - Only checks if tool succeeded, not if step objective achieved
5. **Silent partial completion** - Step might need 3 tool calls, gets marked done after 1
6. **No dependency enforcement** - Step 2 might execute before Step 1 completes

## Correct Mental Model

**Step = Unit of Work** (not tool call)

```
Step 1: "Fetch the last 5 log files"
  ├─ Tool call: list_directory("logs/")
  ├─ Tool call: read_file("logs/file1.log")
  ├─ Tool call: read_file("logs/file2.log")
  ├─ Tool call: read_file("logs/file3.log")
  ├─ Tool call: read_file("logs/file4.log")
  ├─ Tool call: read_file("logs/file5.log")
  └─ Success check: "Do we have content for 5 log files?"

Step 2: "Identify top 3 error patterns"
  ├─ [Pure reasoning over accumulated context]
  ├─ Maybe tool call: analyze_logs(logs_content)
  └─ Success check: "Do we have 3 distinct error categories?"
```

Each step:
- Has an **objective** (sub-goal)
- Can trigger **0-N tool calls** (not 1)
- Accumulates **context** (tool results, reasoning)
- Has **success criteria** (how we know it worked)
- Has **dependencies** (which steps must complete first)

## Proposed Architecture

### 1. Enhanced Data Structures

```python
@dataclass
class StepContext:
    """Accumulated context during step execution"""
    tool_calls_made: List[ToolCallRecord] = field(default_factory=list)
    tool_results: Dict[str, Any] = field(default_factory=dict)  # name -> result
    intermediate_reasoning: List[str] = field(default_factory=list)
    validation_checks: Dict[str, bool] = field(default_factory=dict)
    accumulated_data: Dict[str, Any] = field(default_factory=dict)  # Step's working memory

    def add_tool_result(self, tool_name: str, result: ToolResult):
        """Store tool result and extract data"""
        self.tool_results[tool_name] = result
        # Could extract data into accumulated_data based on tool type

    def has_required_data(self, required: List[str]) -> bool:
        """Check if step has all required data"""
        return all(key in self.accumulated_data for key in required)


@dataclass
class ToolCallRecord:
    """Record of a tool call made during step execution"""
    tool_name: str
    arguments: Dict[str, Any]
    result: ToolResult
    duration_ms: float
    timestamp: float


@dataclass
class PlanStep:
    """Enhanced step definition"""
    step_num: int
    objective: str                        # What this step should accomplish

    # Guidance (not strict requirements)
    tool_hint: Optional[str] = None       # Suggested primary tool
    tool_args_hint: Optional[Dict] = None # Suggested arguments

    # Step boundaries and validation
    success_criteria: Optional[SuccessCriteria] = None
    max_tool_calls: int = 10              # Safety limit per step
    depends_on: List[int] = field(default_factory=list)

    # Execution state (filled during execution)
    status: PlanStatus = PlanStatus.PENDING
    context: Optional[StepContext] = None  # NEW - accumulated context
    error: Optional[str] = None
    duration_ms: float = 0
    started_at: Optional[float] = None
    completed_at: Optional[float] = None

    # Validation results
    validation_passed: bool = False
    validation_details: Optional[str] = None

    @property
    def result(self) -> Optional[Any]:
        """Convenience property - step's accumulated data"""
        return self.context.accumulated_data if self.context else None


@dataclass
class SuccessCriteria:
    """Enhanced success criteria with validation methods"""
    description: str

    # What must exist after step completes
    required_outputs: List[str] = field(default_factory=list)
    # e.g., ["log_files_content", "error_list"]

    # Validation hints
    validation_hints: List[str] = field(default_factory=list)
    # e.g., ["Must have at least 5 log entries", "Error list must be non-empty"]

    # Automated checks (if possible)
    automated_checks: Optional[Dict[str, Any]] = None
    # e.g., {"min_items": 5, "required_fields": ["timestamp", "level"]}
```

### 2. Step-Centric Execution Flow

```python
class Executor:
    def execute(self, plan: Plan, messages: List[Message], tools: List[Any]) -> ExecutionTrace:
        """Execute plan step-by-step (not tool-call-by-tool-call)"""
        trace = ExecutionTrace(plan=plan, steps_executed=[])

        for step in plan.steps:
            # Check dependencies
            if not self._dependencies_met(step, plan.steps):
                step.status = PlanStatus.FAILED
                step.error = "Dependencies not satisfied"
                continue

            # Execute step (might make multiple tool calls)
            step_result = self._execute_step(step, messages, tools, trace)

            # Validate step completed successfully
            if step.success_criteria:
                validation = self._validate_step(step)
                step.validation_passed = validation.passed
                step.validation_details = validation.details

                if not validation.passed:
                    step.status = PlanStatus.FAILED
                    step.error = f"Validation failed: {validation.details}"

            trace.steps_executed.append(step)

            # Stop if critical step failed
            if step.status == PlanStatus.FAILED and self._is_critical_step(step):
                break

        return trace

    def _execute_step(
        self,
        step: PlanStep,
        messages: List[Message],
        tools: List[Any],
        trace: ExecutionTrace
    ) -> StepContext:
        """Execute a single step (may involve multiple tool calls and LLM rounds)"""

        step.status = PlanStatus.IN_PROGRESS
        step.started_at = time.time()
        step.context = StepContext()

        # Add step-specific system message to guide LLM
        step_guidance = self._create_step_guidance(step)
        messages_with_guidance = messages + [Message(
            role=MessageRole.SYSTEM,
            content=step_guidance
        )]

        tool_calls_in_step = 0
        step_complete = False

        # Execute until step completes or hits limit
        while not step_complete and tool_calls_in_step < step.max_tool_calls:
            response = self.llm.complete(messages_with_guidance, tools=tools)
            trace.llm_calls += 1

            if not response.has_tool_calls:
                # LLM thinks step is done (no more tools needed)
                step_complete = True
                break

            # Process all tool calls in this LLM response
            for tool_call in response.tool_calls:
                if tool_calls_in_step >= step.max_tool_calls:
                    break

                # Execute tool
                start = time.time()
                result = self.tool_registry.execute(tool_call.name, **tool_call.arguments)
                duration_ms = (time.time() - start) * 1000

                # Record in step context
                record = ToolCallRecord(
                    tool_name=tool_call.name,
                    arguments=tool_call.arguments,
                    result=result,
                    duration_ms=duration_ms,
                    timestamp=time.time()
                )
                step.context.tool_calls_made.append(record)
                step.context.add_tool_result(tool_call.name, result)

                tool_calls_in_step += 1
                trace.tool_calls += 1

                if not result.is_success:
                    trace.tool_failures += 1

                # Add to conversation
                messages_with_guidance.append(Message(
                    role=MessageRole.ASSISTANT,
                    content=response.content or "",
                    tool_calls=[{
                        "id": tool_call.id,
                        "type": "function",
                        "function": {"name": tool_call.name, "arguments": json.dumps(tool_call.arguments)}
                    }]
                ))
                messages_with_guidance.append(Message(
                    role=MessageRole.TOOL,
                    content=str(result.output if result.is_success else f"Error: {result.error}")[:2000],
                    tool_call_id=tool_call.id,
                    name=tool_call.name
                ))

            # Check if step objective is met (could use LLM to evaluate)
            if self._should_end_step(step, response):
                step_complete = True

        step.completed_at = time.time()
        step.duration_ms = (step.completed_at - step.started_at) * 1000

        # Determine step status
        if step_complete:
            step.status = PlanStatus.COMPLETED
        elif tool_calls_in_step >= step.max_tool_calls:
            step.status = PlanStatus.PARTIAL
            step.error = "Max tool calls reached before step completion"
        else:
            step.status = PlanStatus.FAILED

        return step.context

    def _create_step_guidance(self, step: PlanStep) -> str:
        """Create system message to guide LLM for this specific step"""
        guidance = f"""
You are currently executing Step {step.step_num} of a multi-step plan.

STEP OBJECTIVE: {step.objective}

SUCCESS CRITERIA: {step.success_criteria.description if step.success_criteria else "Complete the objective"}

REQUIRED OUTPUTS: {', '.join(step.success_criteria.required_outputs) if step.success_criteria else "None specified"}

Focus ONLY on completing this step. Do not move ahead to other steps.
When you have accomplished this step's objective, provide a final response WITHOUT additional tool calls.
"""

        if step.tool_hint:
            guidance += f"\nSUGGESTED TOOL: {step.tool_hint}"
            if step.tool_args_hint:
                guidance += f"\nSUGGESTED ARGS: {json.dumps(step.tool_args_hint)}"

        return guidance

    def _validate_step(self, step: PlanStep) -> ValidationResult:
        """Validate if step achieved its success criteria"""
        if not step.success_criteria:
            return ValidationResult(passed=True, details="No criteria specified")

        criteria = step.success_criteria

        # Check required outputs exist
        missing_outputs = []
        for required in criteria.required_outputs:
            if not step.context or required not in step.context.accumulated_data:
                missing_outputs.append(required)

        if missing_outputs:
            return ValidationResult(
                passed=False,
                details=f"Missing required outputs: {missing_outputs}"
            )

        # Run automated checks if defined
        if criteria.automated_checks:
            for check_name, check_config in criteria.automated_checks.items():
                if check_name == "min_items":
                    # Example: check if accumulated data has minimum number of items
                    pass

        # Could use LLM to evaluate success criteria description
        # For now, basic validation
        return ValidationResult(
            passed=True,
            details="All required outputs present"
        )

    def _dependencies_met(self, step: PlanStep, all_steps: List[PlanStep]) -> bool:
        """Check if step's dependencies are completed"""
        if not step.depends_on:
            return True

        for dep_num in step.depends_on:
            dep_step = next((s for s in all_steps if s.step_num == dep_num), None)
            if not dep_step or dep_step.status != PlanStatus.COMPLETED:
                return False

        return True

    def _should_end_step(self, step: PlanStep, response: LLMResponse) -> bool:
        """Decide if step is complete based on LLM response and context"""

        # No more tool calls = LLM thinks it's done
        if not response.has_tool_calls:
            return True

        # Could add additional heuristics:
        # - Check if success criteria keywords appear in response
        # - Count tool calls and stop if seems excessive
        # - Ask LLM explicitly "Is step objective achieved?"

        return False


@dataclass
class ValidationResult:
    passed: bool
    details: str
    confidence: float = 1.0
```

### 3. Updated Planning to Create Better Steps

The Planner should create steps with clearer boundaries:

```python
# GOOD - Clear step boundaries
steps = [
    PlanStep(
        step_num=1,
        objective="Fetch content of the last 5 log files from logs/ directory",
        tool_hint="file_read",
        success_criteria=SuccessCriteria(
            description="We have in-memory content for 5 log files",
            required_outputs=["log_files_content"],
            validation_hints=["Must have exactly 5 log file contents"]
        ),
        max_tool_calls=10  # list + 5 reads = 6, allow buffer
    ),
    PlanStep(
        step_num=2,
        objective="Analyze logs to identify the top 3 recurring error patterns",
        depends_on=[1],  # Requires step 1
        success_criteria=SuccessCriteria(
            description="We have 3 distinct error categories with occurrence counts",
            required_outputs=["error_patterns"],
            validation_hints=["Must have 3 error categories", "Each must have count > 0"]
        ),
        max_tool_calls=3  # Mostly reasoning, maybe 1-2 tool calls
    ),
    PlanStep(
        step_num=3,
        objective="Provide root cause analysis and remediation steps",
        depends_on=[2],
        success_criteria=SuccessCriteria(
            description="User has actionable remediation plan",
            required_outputs=["root_cause", "remediation_steps"]
        ),
        max_tool_calls=2
    )
]
```

## Implementation Plan

### Phase 1: Data Structure Updates
1. Create `StepContext` dataclass with tool tracking and accumulated data
2. Create `ToolCallRecord` dataclass for granular tool call tracking
3. Add `context: Optional[StepContext]` to `PlanStep`
4. Add validation fields to `PlanStep` (validation_passed, validation_details)
5. Add timing fields (started_at, completed_at)
6. Create `ValidationResult` dataclass

### Phase 2: Executor Refactoring
1. Change `_execute_with_tools()` to `_execute_step()`
2. Remove `current_step_idx` counter (no more 1:1 mapping)
3. Add step guidance system message creation
4. Implement step-level tool call loop (not global loop)
5. Add step context accumulation logic
6. Implement `_validate_step()` method
7. Implement `_dependencies_met()` check
8. Implement `_should_end_step()` heuristics

### Phase 3: Planner Updates
1. Update planning prompt to create clearer step boundaries
2. Ensure each step has success_criteria
3. Set appropriate max_tool_calls per step
4. Add required_outputs to success criteria

### Phase 4: Logging Updates
1. Update execution logging to capture step context
2. Log all tool calls within a step (not just first)
3. Log validation results
4. Add step timing information

### Phase 5: Testing
1. Test with simple 1-step plans
2. Test with multi-step plans (3-5 steps)
3. Test with step dependencies
4. Test step validation (success/failure)
5. Test max_tool_calls limits per step

## Benefits

1. **Explicit boundaries** - Clear when step 1 ends and step 2 begins
2. **Step-level context** - Accumulated data persists across tool calls within step
3. **Proper validation** - Check if step objective achieved, not just if tool succeeded
4. **Better tracking** - Know exactly what happened in each step
5. **Dependency management** - Enforce step execution order
6. **Failure isolation** - Step 2 failure doesn't corrupt Step 1's work
7. **Debuggability** - Can examine step.context to see what happened
8. **Better logging** - Group tool calls by step in logs

## Migration Strategy

1. **Keep backward compatibility** - Make StepContext optional initially
2. **Gradual rollout** - Test with simple tasks first
3. **Parallel logging** - Log both old and new formats during transition
4. **Validation** - Compare old vs new execution on same tasks

## Example: Before vs After

### Before (Current - Tool-centric)
```
[Tool Call 1: list_directory] -> Step 1 done ❌ (wrong - only listed, didn't read)
[Tool Call 2: read_file] -> Step 2 done ❌ (wrong - still in Step 1)
[Tool Call 3: read_file] -> Step 3 done ❌ (wrong - still in Step 1)
...
```

### After (Proposed - Step-centric)
```
Step 1: "Fetch 5 log files"
  - Tool Call 1: list_directory -> [file1, file2, file3, file4, file5]
  - Tool Call 2: read_file(file1) -> content1
  - Tool Call 3: read_file(file2) -> content2
  - Tool Call 4: read_file(file3) -> content3
  - Tool Call 5: read_file(file4) -> content4
  - Tool Call 6: read_file(file5) -> content5
  - Validation: ✓ Have 5 file contents
  - Status: COMPLETED ✓

Step 2: "Identify 3 error patterns"
  - [Reasoning over accumulated log content]
  - Tool Call 7: analyze_patterns(logs)
  - Validation: ✓ Have 3 error categories
  - Status: COMPLETED ✓
```

## Key Insight

**Step = Sub-Goal**, not RPC call. The executor should work toward completing the step's objective, making as many tool calls as needed, until the success criteria are met or max_tool_calls is exhausted.
