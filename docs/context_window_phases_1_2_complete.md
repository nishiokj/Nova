# ContextWindow Implementation: Phases 1 & 2 Complete

## Summary

Phases 1 and 2 of the ContextWindow migration are complete. This document details exactly what was implemented, the design decisions made, and how the new system integrates with the existing Wizard/Worker architecture.

---

## What Was Built

### Phase 1: ContextWindow Infrastructure

#### File: `src/harness/agent/wizard/context_window.py`

**350 lines of new code introducing:**

##### 1. SystemPrompt (dataclass)
```python
@dataclass
class SystemPrompt:
    goal: str
    step_num: int
    objective: str
    role: str = "You are a Worker executing a bounded work item."
    constraints: List[str] = field(default_factory=list)
    tool_hint: Optional[str] = None

    def render(self) -> str:
        """Renders to string for system message."""
```

**Purpose:** Structured representation of system-level instructions. Replaces the ad-hoc string building in `ContextPackBuilder._build_instructions()`.

##### 2. BehavioralRules (dataclass)
```python
@dataclass
class BehavioralRules:
    content: str = ""

    @classmethod
    def from_file(cls, path: str) -> "BehavioralRules": ...

    @classmethod
    def default(cls) -> "BehavioralRules":
        """Loads from behavioral_rules.md in package directory."""

    def render(self) -> str: ...
```

**Purpose:** Externalized behavioral rules. The 100+ lines of hardcoded rules in `Worker._build_initial_messages()` are now loaded from a `.md` file.

##### 3. FileContent (dataclass)
```python
@dataclass
class FileContent:
    path: str
    content: str
    truncated: bool = False
    original_chars: int = 0
```

**Purpose:** Typed representation of a file loaded into context. Tracks truncation status for debugging.

##### 4. ToolExchange (dataclass)
```python
@dataclass
class ToolExchange:
    call_id: str
    tool_name: str
    arguments: Dict[str, Any]
    result_content: str = ""
    success: bool = True
    error: Optional[str] = None
```

**Purpose:** Records a tool invocation and its result. Used by `_process_tool_calls_v2()` to track tool execution.

##### 5. StreamBuffer (dataclass)
```python
@dataclass
class StreamBuffer:
    chunks: List[str] = field(default_factory=list)
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    is_complete: bool = False

    def append_chunk(self, chunk: str) -> None: ...
    def append_tool_call(self, tool_call: Dict[str, Any]) -> None: ...
    def finalize(self) -> str: ...
    @property
    def current_content(self) -> str: ...
```

**Purpose:** Buffers streaming response chunks. Supports both text and tool call accumulation.

##### 6. ContextWindow (main class)
```python
class ContextWindow:
    """
    Explicit, typed representation of the LLM context window.

    Lifecycle:
    1. CREATED by Wizard via from_stores()
    2. TRANSFERRED to Worker (ownership handoff)
    3. MUTATED by Worker during execution loop
    4. SERIALIZED for each LLM call
    5. DISPOSED after Worker returns
    """
```

**Key Methods:**

| Method | Purpose |
|--------|---------|
| `from_stores(...)` | Factory: creates ContextWindow from Wizard's stores |
| `add_file(path, content)` | Add file with dedup check, returns False if already present |
| `add_tool_result(exchange)` | Record tool execution |
| `add_assistant_turn(content, tool_calls)` | Record assistant response |
| `add_user_turn(content)` | Record user/system message |
| `add_tool_result_turn(call_id, content)` | Record tool result message |
| `to_messages()` | Serialize to Chat Completions format |
| `to_responses_input()` | Placeholder for Responses API |
| `has_file(path)` | Check if file in context (dedup) |
| `loaded_files` | List of files loaded in this execution |
| `all_read_files` | All files read (includes previous steps) |
| `token_usage` | Current usage as fraction of budget |
| `should_compact` | True if over 60% budget |

**Key Properties:**

| Property | Type | Purpose |
|----------|------|---------|
| `_already_read` | `Set[str]` | Files from previous steps (seeded from Wizard) |
| `_files` | `Dict[str, FileContent]` | Files loaded in this execution |
| `_tool_history` | `List[ToolExchange]` | Tool calls made |
| `_turns` | `List[Dict]` | Conversation history |
| `_current_tokens` | `int` | Estimated token count |
| `_token_budget` | `int` | Max tokens allowed |

---

#### File: `src/harness/agent/wizard/behavioral_rules.md`

**80 lines of extracted behavioral rules:**

```markdown
═══════════════════════════════════════════════════════════════════════════════
                    PROGRESS & PIVOT RULES (MANDATORY)
═══════════════════════════════════════════════════════════════════════════════

A tool call ONLY counts as progress if it changes your next action.
...

═══════════════════════════════════════════════════════════════════════════════
                         FORBIDDEN BEHAVIOR
═══════════════════════════════════════════════════════════════════════════════

🚫 Calling the same tool with the same arguments...
...

═══════════════════════════════════════════════════════════════════════════════
                      ACTION MARKERS (REQUIRED)
═══════════════════════════════════════════════════════════════════════════════

[FINAL] ...
[NEED_CONTEXT] ...
[CONTINUE] ...
```

**Purpose:** Previously these 100+ lines were hardcoded in `Worker._build_initial_messages()`. Now they're:
1. Externalized to a `.md` file
2. Loaded via `BehavioralRules.default()`
3. Editable without code changes
4. Version-controllable separately

---

### Phase 2: Worker & Wizard Integration

#### File: `src/harness/agent/wizard/worker.py`

**+400 lines adding v2 methods:**

##### 1. execute_v2()
```python
def execute_v2(
    self,
    context_window: ContextWindow,
    work_item: WorkItem,
    plan_version: int = 0,
) -> WorkerOutcome:
    """
    Execute work item using ContextWindow (preferred API).
    """
    # ... setup ...
    self._execute_loop_v2(context_window, work_item, outcome, start_time)
    # ... cleanup ...

    # Transfer loaded files to outcome
    for path in context_window.loaded_files:
        if path not in outcome.entity_refs:
            outcome.entity_refs.append(path)

    return outcome
```

##### 2. _execute_loop_v2()
```python
def _execute_loop_v2(
    self,
    context_window: ContextWindow,
    work_item: WorkItem,
    outcome: WorkerOutcome,
    start_time: float,
) -> None:
    """Main execution loop using ContextWindow."""

    # Auto-read target files (with dedup via ContextWindow)
    for path in work_item.target_paths:
        if context_window.has_file(path):
            continue  # Dedup!
        # ... read file ...
        context_window.add_file(path, content)

    while True:
        # Get messages from ContextWindow
        messages = context_window.to_messages()

        # Call LLM
        response = self._call_llm_v2(messages, work_item, outcome)

        if self._has_tool_calls(response):
            # Process tools
            tool_exchanges = self._process_tool_calls_v2(response, outcome, work_item)

            # Update ContextWindow
            context_window.add_assistant_turn(content, tool_calls)
            for ex in tool_exchanges:
                context_window.add_tool_result_turn(ex.call_id, ex.result_content)

            # Synthesis step
            context_window.add_user_turn("SYNTHESIS REQUIRED: ...")
            synth_messages = context_window.to_messages()
            synth = self._call_llm_no_tools_v2(synth_messages, outcome)
            # ...
        else:
            # Text-only response
            context_window.add_assistant_turn(content)
            # ...
```

##### 3. _process_tool_calls_v2()
```python
def _process_tool_calls_v2(
    self,
    response: Any,
    outcome: WorkerOutcome,
    work_item: WorkItem,
) -> List[ToolExchange]:
    """Execute tool calls and return ToolExchange records."""
    exchanges = []
    for tool_call in response.tool_calls:
        exchange = ToolExchange(
            call_id=...,
            tool_name=...,
            arguments=...,
        )
        result = self.tool_registry.execute(...)
        exchange.result_content = str(result.output)[:50000]
        exchange.success = result.is_success
        exchanges.append(exchange)
    return exchanges
```

##### 4. _call_llm_v2() and _call_llm_no_tools_v2()
```python
def _call_llm_v2(self, messages, work_item, outcome) -> Optional[Any]:
    """Call LLM with tools using message list from ContextWindow."""
    tools = self.tool_registry.get_definitions(enabled_only=True)
    return self.llm.respond_with_messages(messages=messages, tools=tools)

def _call_llm_no_tools_v2(self, messages, outcome) -> Optional[Any]:
    """Call LLM without tools (synthesis step)."""
    return self.llm.respond_with_messages(messages=messages, tools=[])
```

---

#### File: `src/harness/agent/wizard/wizard.py`

**Changes to orchestrate():**

```python
# BEFORE (legacy):
context_pack = self._context_builder.build(step, work_item, ...)
outcome = self._worker.execute(context_pack, work_item)

# AFTER (new):
context_window = ContextWindow.from_stores(
    plan_state=self._plan_state,
    knowledge=self._knowledge,
    ledger=self._ledger,
    step=step,
    work_item=work_item,
    token_budget=self.config.context_budget_tokens,
    already_read=self._read_files,  # Seed dedup
)

outcome = self._worker.execute_v2(context_window, work_item, plan_version)

# Update dedup tracking from ContextWindow
self._read_files = context_window.all_read_files
```

**Removed from _ingest_outcome():**
```python
# REMOVED (now handled by ContextWindow):
for path in outcome.entity_refs:
    self._read_files.add(path)
```

---

#### File: `src/harness/agent/wizard/__init__.py`

**Added exports:**
```python
from .context_window import (
    ContextWindow,
    SystemPrompt,
    BehavioralRules,
    FileContent,
    ToolExchange,
    StreamBuffer,
)

__all__ = [
    # ... existing ...
    "ContextWindow",
    "SystemPrompt",
    "BehavioralRules",
    "FileContent",
    "ToolExchange",
    "StreamBuffer",
]
```

---

## Design Decisions

### 1. ContextWindow Owns Deduplication

**Decision:** ContextWindow tracks `_already_read` set, seeded from Wizard.

**Rationale:**
- Single source of truth for "what files have been read"
- Dedup checks happen at the right level (when adding files)
- Wizard just seeds and retrieves; doesn't manage internally

**Flow:**
```
Wizard._read_files ──seed──► ContextWindow._already_read
                                      │
                   [Worker execution]
                                      │
context_window.all_read_files ──update──► Wizard._read_files
```

### 2. Behavioral Rules from .md File

**Decision:** Load rules from `behavioral_rules.md`, not hardcoded.

**Rationale:**
- Rules are 100+ lines; embedding in code is unmaintainable
- Allows editing without code changes
- Can version-control rules separately
- Can swap rules per deployment or task type

**Loading:**
```python
BehavioralRules.default()  # Looks for behavioral_rules.md in package dir
BehavioralRules.from_file("/path/to/custom_rules.md")  # Custom rules
```

### 3. Keep Legacy Methods (For Now)

**Decision:** Added `execute_v2()` etc. instead of replacing `execute()`.

**Rationale:**
- Allows gradual migration
- Easy rollback if issues found
- External callers can migrate at their own pace
- Phase 3 will clean up legacy code

### 4. Token Tracking on Every Mutation

**Decision:** `_update_token_count()` called after every add operation.

**Rationale:**
- Always-accurate token estimate
- `should_compact` property immediately reflects state
- Small performance cost (string length calculation)

**Implementation:**
```python
def _update_token_count(self) -> None:
    total_chars = 0
    total_chars += len(self._system_prompt.render())
    total_chars += len(self._behavioral_rules.render())
    # ... add all content ...
    self._current_tokens = total_chars // 4  # ~4 chars/token
```

### 5. ToolExchange vs ToolCallRecord

**Decision:** Introduced `ToolExchange` for v2 methods.

**Rationale:**
- Cleaner dataclass (no `Optional[ToolResult]`)
- Contains rendered result_content (string)
- Doesn't depend on ToolResult protocol
- Used directly by ContextWindow

---

## Integration Points

### Wizard → ContextWindow

```python
# Creation (in orchestrate loop)
context_window = ContextWindow.from_stores(
    plan_state=self._plan_state,
    knowledge=self._knowledge,
    ledger=self._ledger,
    step=step,
    work_item=work_item,
    token_budget=self.config.context_budget_tokens,
    already_read=self._read_files,
)

# After Worker returns
self._read_files = context_window.all_read_files
```

### Worker → ContextWindow

```python
# File dedup check
if context_window.has_file(path):
    continue  # Skip

# Add file
context_window.add_file(path, content)

# Get messages for LLM
messages = context_window.to_messages()

# Add turns
context_window.add_assistant_turn(content, tool_calls)
context_window.add_tool_result_turn(call_id, result)
context_window.add_user_turn("SYNTHESIS REQUIRED: ...")
```

### ContextWindow → LLM

```python
# Serialize to messages
messages = context_window.to_messages()
# Returns:
# [
#   {"role": "system", "content": "..."},
#   {"role": "user", "content": "..."},
#   {"role": "assistant", "content": "...", "tool_calls": [...]},
#   {"role": "tool", "tool_call_id": "...", "content": "..."},
#   ...
# ]

# Call LLM
response = llm.respond_with_messages(messages=messages, tools=tools)
```

---

## Verification

### Compilation Test
```bash
PYTHONPATH=src python3 -c "
from harness.agent.wizard import ContextWindow, Worker, Wizard
print('✓ All imports successful')
"
# Output: ✓ All imports successful
```

### BehavioralRules Loading Test
```bash
PYTHONPATH=src python3 -c "
from harness.agent.wizard.context_window import BehavioralRules
rules = BehavioralRules.default()
print(f'Rules loaded: {len(rules.render())} chars')
print(f'Contains [FINAL]: {\"[FINAL]\" in rules.render()}')
"
# Output:
# Rules loaded: 4112 chars
# Contains [FINAL]: True
```

### ContextWindow Creation Test
```bash
PYTHONPATH=src python3 -c "
from harness.agent.wizard import ContextWindow, PlanState, KnowledgeStore, WorkLedger
from harness.agent.wizard import WorkItem, WorkBounds, WizardPlan, WizardStep, GoalType

plan = WizardPlan(goal='Test', goal_type=GoalType.TASK, steps=[WizardStep(step_num=1, objective='Test')])
plan_state = PlanState.from_wizard_plan(plan)
step = list(plan_state.steps.values())[0]
work_item = WorkItem.from_step_state(step, bounds=WorkBounds())

context_window = ContextWindow.from_stores(
    plan_state=plan_state,
    knowledge=KnowledgeStore(),
    ledger=WorkLedger(),
    step=step,
    work_item=work_item,
    already_read={'file1.py'},
)

print(f'✓ Created: {context_window}')
print(f'  Dedup test: add_file(file1.py) = {context_window.add_file(\"file1.py\", \"x\")}')
print(f'  New file: add_file(file2.py) = {context_window.add_file(\"file2.py\", \"x\")}')
"
# Output:
# ✓ Created: ContextWindow(id=..., tokens=1072/100000, files=0, turns=0)
#   Dedup test: add_file(file1.py) = False
#   New file: add_file(file2.py) = True
```

---

## What's Next (Phase 3)

### Code to Remove

| Location | Lines | Description |
|----------|-------|-------------|
| `worker.py:execute()` | ~40 | Legacy execute method |
| `worker.py:_execute_loop()` | ~200 | Legacy execution loop |
| `worker.py:_build_initial_messages()` | ~120 | Hardcoded message building |
| `worker.py:_append_tool_messages()` | ~50 | Legacy tool message handling |
| `worker.py:_call_llm()` | ~30 | Legacy LLM call |
| `worker.py:_call_llm_no_tools()` | ~20 | Legacy no-tools call |
| `worker.py:_process_tool_calls()` | ~80 | Legacy tool processing |
| `context_pack.py` | ~285 | ENTIRE FILE |

**Total removal:** ~825 lines

### Renames After Removal

```python
execute_v2()             → execute()
_execute_loop_v2()       → _execute_loop()
_call_llm_v2()           → _call_llm()
_call_llm_no_tools_v2()  → _call_llm_no_tools()
_process_tool_calls_v2() → _process_tool_calls()
```

---

## Files Changed Summary

| File | Status | Lines Changed |
|------|--------|---------------|
| `context_window.py` | NEW | +350 |
| `behavioral_rules.md` | NEW | +80 |
| `worker.py` | MODIFIED | +400 |
| `wizard.py` | MODIFIED | +20, -15 |
| `__init__.py` | MODIFIED | +10 |

**Net new code:** +845 lines (will be -475 after Phase 3 cleanup)
