# Documentation

## Architecture Documents

### Step-Centric Execution
- **[step_centric_execution_design.md](step_centric_execution_design.md)** - Comprehensive design document for step-centric execution architecture
  - Problem statement and motivation
  - Proposed architecture with code examples
  - Implementation plan (6 phases)
  - Benefits and migration strategy

- **[step_centric_implementation_summary.md](step_centric_implementation_summary.md)** - Implementation summary
  - What was changed and why
  - New data structures and methods
  - Execution flow examples
  - Testing results
  - Future work

## Quick Reference

### What is Step-Centric Execution?

**Key Insight:** A step is a **unit of work** (sub-goal), not a single tool call.

**Before (Tool-Centric):**
```
Tool Call 1 → Step 1 done ❌  (wrong assumption: 1 tool call = 1 step)
Tool Call 2 → Step 2 done ❌
```

**After (Step-Centric):**
```
Step 1: "Fetch 5 log files"
  - Tool Call 1: list_directory
  - Tool Call 2: read_file (file1)
  - Tool Call 3: read_file (file2)
  - Tool Call 4: read_file (file3)
  - Tool Call 5: read_file (file4)
  - Tool Call 6: read_file (file5)
  - Validation: ✓ Have 5 files
  → Step 1 done ✓

Step 2: "Analyze for errors"
  - [Reasoning over Step 1 data]
  - Tool Call 7: analyze_patterns
  - Validation: ✓ Have error patterns
  → Step 2 done ✓
```

### Core Concepts

1. **StepContext** - Accumulates data across multiple tool calls within a step
2. **Validation** - Checks if step objective achieved (not just if tools succeeded)
3. **Dependencies** - Steps execute in order (Step 2 waits for Step 1)
4. **Boundaries** - Clear start/end via max_tool_calls and success criteria
5. **Guidance** - System message keeps LLM focused on current step's objective

### Testing

Run tests:
```bash
python3 test_step_execution.py
```

Tests verify:
- ✓ Steps accumulate multiple tool calls
- ✓ Steps have clear boundaries
- ✓ Validation checks success criteria
- ✓ Dependencies enforced
- ✓ Step guidance generated
- ✓ Complex multi-step plans work

## Related Files

- `harness/planner.py` - Main implementation (Planner, Executor, Reflector)
- `test_step_execution.py` - Test suite for step-centric execution
- `evals/` - Evaluation system that tests agent performance

## Questions?

- For design rationale: Read [step_centric_execution_design.md](step_centric_execution_design.md)
- For implementation details: Read [step_centric_implementation_summary.md](step_centric_implementation_summary.md)
- For usage examples: See `test_step_execution.py`
