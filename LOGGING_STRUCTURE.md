# Three-Stage Logging Structure

## Overview

The agent logging in `logs/llm_requests.log` is now structured into three clearly labeled stages that correspond to the agent's execution flow:

1. **STAGE 1: AGENT CONTEXT** - What context is built and sent to the LLM
2. **STAGE 2: PLANNING RESULT** - What plan the LLM creates
3. **STAGE 3: EPISODE SUMMARY** - Execution results and reflection

## Planner Hot Path Analysis

From `src/harness/agent/agent.py` → Only one method is called:
- **`create_plan()`** at line 880

Internal hot path within Planner:
1. **`_try_simple_plan()`** - Fast pattern matching (always called)
2. **`_create_llm_plan()`** - Complex planning via LLM (if simple fails)
   - `_parse_plan_response()` - Parse LLM JSON
   - `_build_phase_steps()` - Convert to PlanStep objects
   - `_validate_plan_budget()` - Check budget constraints
   - `_finalize_plan()` - Add discovery steps if needed
   - `_resequence_steps()` - Order discovery before execution

## Log Format

### STAGE 1: AGENT CONTEXT (COMPLETE SERIALIZED PROMPT)
**When:** After context serialization, before planning
**Location:** `src/harness/agent/agent.py:970`
**LOGS:** The **COMPLETE** serialized context/prompt sent to the LLM with **NO TRUNCATION**

```
================================================================================
STAGE 1: AGENT CONTEXT (COMPLETE SERIALIZED PROMPT)
================================================================================
Timestamp: 2025-12-16 14:23:45
Request ID: tui_1_12345
Tier: standard
User Input: Create a simple Python script that prints "Hello, World!"

CONTEXT BUDGET ALLOCATION:
  Total Budget: 180,000 tokens
  Actual Tokens: 45,234 tokens
  Cache Hits: 2
  Cache Misses: 3
  Cache Strategy: conservative
  Estimated Cost: $0.0234

CONTEXT SECTIONS INCLUDED:
  - system_core: 1,234 tokens [CACHED]
  - tool_manifest: 5,678 tokens [CACHED]
  - execution_contract: 234 tokens
  - user_rules: 456 tokens
  - working_memory: 1,890 tokens
  - filesystem_context: 2,345 tokens

================================================================================
COMPLETE SERIALIZED CONTEXT (SENT TO LLM)
================================================================================

FORMAT: OpenAI Responses API

INSTRUCTIONS (COMPLETE):
--------------------------------------------------------------------------------
You are an expert personal CLI assistant for complex tasks. If you need to
understand the file system in which you were called from you should explore
this initially, but only if you think the request calls for this or mentions
a file or folder you are unaware of and that you were not also asked to create
yourself. This transcript could be from a voice command and thus you should be
aware of potential typos. Optimize for correctness and clarity.

Principles:
- Quickly outline the plan. This could be multiple steps and also could require
  discovery if called from an existing system. You are highly capable of
  multi-turn robust plans and should be very detail oriented for complex tasks.
  Use tools only where they add real evidence or fresh data.
- Discovery related tool calls are cheap and very important to serving your user,
  especially for multi-turn complex requests involving building applications, and
  especially for understanding the a current repository. Aggressively use 'ls'
  and file_reads to reduce uncertainty.
- Double-check critical facts; provide a crisp, helpful final answer.

Tooling guardrails:
- Always timebox bash commands. Prefer `timeout <seconds> ...` or short,
  single-shot commands chained with `set -euo pipefail && ...` so they complete
  quickly, and check command availability with `which <cmd>` before heavy
  operations.
- When authoring scripts or modifying files, keep commands idempotent and avoid
  leaving background servers running. Immediately run lightweight verification
  (formatters, linters, or targeted commands) after writing code.
- Before presenting new code, validate it by executing targeted tests (e.g.,
  `python -m py_compile file.py`, unit tests, `python_execute`) and report the
  results so syntax/runtime issues are caught early.

Available tools:
{tools}

[... COMPLETE INSTRUCTIONS - NO TRUNCATION ...]
--------------------------------------------------------------------------------

INPUT CONTEXT (COMPLETE):
--------------------------------------------------------------------------------

[Input Message 1 - Role: USER]
Create a simple Python script that prints "Hello, World!"

[... COMPLETE INPUT - NO TRUNCATION ...]
--------------------------------------------------------------------------------

================================================================================
END STAGE 1 (COMPLETE CONTEXT)
================================================================================
```

**Note:** STAGE 1 logs the **ENTIRE** serialized context that is sent to the LLM API.
This includes:
- Complete system prompts (Anthropic format) or instructions (OpenAI format)
- Complete input messages/context
- All sections fully rendered with NO truncation
- This is typically 10,000-50,000+ characters depending on context complexity

### STAGE 2: PLANNING RESULT
**When:** After planning completes, before execution
**Location:** `src/harness/agent/agent.py:1037`

```
================================================================================
STAGE 2: PLANNING RESULT
================================================================================
Timestamp: 2025-12-16 14:23:46
User Input: Create a simple Python script that prints "Hello, World!"
Tier: standard

PLAN OVERVIEW:
  Goal: Create a Python script that prints "Hello, World!"
  Goal Type: creation
  Estimated Complexity: standard
  Requires Tools: True
  Discovery Required: True
  Total Steps: 3
  Discovery Steps: 1
  Execution Steps: 2

SUCCESS CRITERIA:
  File created and verified to contain correct code

UNCERTAINTIES TO RESOLVE:
  - Where should the file be created? (location uncertainty)
  - What should the file be named? (naming uncertainty)
  Uncertainty Threshold: 0.2
  Current Uncertainty: 1.0

PRECONDITIONS:
  - Working directory must be writable

EXECUTION STEPS:
  1. [DISCOVERY] Inspect current directory structure → list_files
     Targets: location uncertainty, naming uncertainty
  2. [EXECUTION] Create Python script with "Hello, World!" code → file_write
     Preconditions: 1 items
     Postconditions: 1 items
  3. [EXECUTION] Verify file contents → file_read
     Preconditions: 1 items
     Postconditions: 1 items

ASSUMPTIONS:
  - Auto-added discovery plan to inspect repository context
  - User wants a standalone script

PLANNER REASONING:
  Task requires file creation (discovery needed to determine location and naming)

================================================================================
END STAGE 2
================================================================================
```

### STAGE 3: EPISODE SUMMARY
**When:** After execution and reflection complete
**Location:** `src/harness/agent/agent.py:1121`

```
================================================================================
STAGE 3: EPISODE SUMMARY
================================================================================
Timestamp: 2025-12-16 14:23:48
User Input: Create a simple Python script that prints "Hello, World!"
Tier: standard
Total Duration: 2345 ms

EXECUTION METRICS:
  LLM Calls: 3
  Tool Calls: 3
  Tool Failures: 0
  Steps Executed: 3/3
  All Steps Succeeded: True

STEP-BY-STEP EXECUTION:
  ✓ Step 1: completed (1 tools, 234ms)
      ✓ list_files: 234ms
  ✓ Step 2: completed (1 tools, 456ms)
      ✓ file_write: 456ms
  ✓ Step 3: completed (1 tools, 123ms)
      ✓ file_read: 123ms

REFLECTION:
  Goal Achieved: True
  Confidence: 0.95
  Evidence:
    - All planned steps completed
    - Files written: hello.py
    - File contents verified

RL LABELS:
  Reward: 1.00
  Plan Quality: 1.00
  Execution Quality: 0.95
  Response Quality: 0.85

FINAL RESPONSE:
  I've created a simple Python script called "hello.py" that prints "Hello, World!". The script is ready to run with `python hello.py`.

================================================================================
END STAGE 3
================================================================================
```

## Implementation Details

### Files Modified
- `src/harness/agent/agent.py`
  - Replaced `_log_full_llm_request()` with three new methods:
    - `_log_stage_1_agent_context()` (lines 221-293)
    - `_log_stage_2_planning_result()` (lines 295-383)
    - `_log_stage_3_episode_summary()` (lines 385-487)
  - Added logging calls at three key points:
    - After context serialization (line 970)
    - After planning (line 1037)
    - After reflection (line 1121)

### Log File Location
All three stages append to: `logs/llm_requests.log`

### Benefits
1. **Clear Separation:** Each stage is clearly labeled with headers/footers
2. **Chronological Order:** Stages appear in execution order
3. **Debugging:** Easy to identify where issues occur (context, planning, or execution)
4. **Completeness:** All critical information logged at appropriate stage
5. **Readability:** Structured format with consistent indentation

## Usage with TUI

When running `tui/simple_tui.py`, you can now monitor the agent's execution by:

```bash
# In one terminal, run the TUI
python tui/simple_tui.py

# In another terminal, tail the log
tail -f logs/llm_requests.log
```

You'll see the three stages appear sequentially for each request, making it easy to understand:
- What context was prepared (Stage 1)
- What plan was created (Stage 2)
- What actually happened during execution (Stage 3)
