# ContextWindow Migration Specification

## Executive Summary

This document specifies the complete migration from the legacy `ContextPack` + implicit message lists architecture to the new `ContextWindow` system. The migration introduces explicit, typed context management with built-in deduplication, token tracking, and Responses API readiness.

---

## Architectural Overview

### Before (Legacy)

```
ContextPackBuilder          Worker._build_initial_messages()
       ↓                              ↓
┌──────────────┐           ┌─────────────────────────────┐
│ ContextPack  │  ──────►  │ messages: List[Dict]        │
│ (frozen)     │           │ (implicit, untyped)         │
└──────────────┘           │ + 100 lines hardcoded rules │
                           └─────────────────────────────┘
```

**Problems:**
- Instructions split across 3 locations
- Behavioral rules hardcoded in Worker
- Context window implicit (just a list)
- No token tracking during mutation
- Dedup tracking scattered across Wizard

### After (New)

```
┌─────────────────────────────────────────────────────────────────┐
│                        ContextWindow                            │
│                                                                 │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │SystemPrompt │  │ BehavioralRules  │  │ Token Tracking   │   │
│  │(structured) │  │ (from .md file)  │  │ (real-time)      │   │
│  └─────────────┘  └──────────────────┘  └──────────────────┘   │
│                                                                 │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │   Files     │  │  Tool History    │  │  Conversation    │   │
│  │ (deduped)   │  │ (ToolExchange)   │  │  (turns)         │   │
│  └─────────────┘  └──────────────────┘  └──────────────────┘   │
│                                                                 │
│  Serialization: to_messages() | to_responses_input()           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase Breakdown

### Phase 1: Create ContextWindow Infrastructure ✅

**Status:** COMPLETE

**Deliverables:**
- `context_window.py` with all classes
- `behavioral_rules.md` with extracted rules

**Files Created:**
```
src/harness/agent/wizard/
├── context_window.py      # NEW: ContextWindow, SystemPrompt, BehavioralRules, etc.
└── behavioral_rules.md    # NEW: Extracted behavioral rules
```

**Classes Introduced:**
| Class | Purpose |
|-------|---------|
| `SystemPrompt` | Structured system-level instructions (goal, step, objective, constraints) |
| `BehavioralRules` | Loads rules from .md file, renders to string |
| `FileContent` | Tracks file path, content, truncation status |
| `ToolExchange` | Records tool call + result (replaces ToolCallRecord for v2) |
| `StreamBuffer` | Buffers streaming response chunks |
| `ContextWindow` | Main class - owns all context state |

**Key Design Decisions:**
1. ContextWindow owns file deduplication via `_already_read: Set[str]`
2. BehavioralRules loaded from `.md` file (not hardcoded)
3. Token tracking updated on every mutation
4. Designed for Responses API (placeholder `to_responses_input()`)

---

### Phase 2: Worker Integration ✅

**Status:** COMPLETE

**Deliverables:**
- `Worker.execute_v2()` using ContextWindow
- `Wizard.orchestrate()` updated to use ContextWindow

**Files Modified:**
```
src/harness/agent/wizard/
├── worker.py    # Added execute_v2(), _execute_loop_v2(), _process_tool_calls_v2()
├── wizard.py    # Uses ContextWindow.from_stores(), execute_v2()
└── __init__.py  # Exports new classes
```

**API Changes:**

```python
# OLD (deprecated)
outcome = worker.execute(context_pack, work_item)

# NEW (preferred)
context_window = ContextWindow.from_stores(
    plan_state, knowledge, ledger, step, work_item,
    already_read=self._read_files,
)
outcome = worker.execute_v2(context_window, work_item, plan_version)
```

**Dedup Flow:**
```
Wizard._read_files ──seed──► ContextWindow._already_read
                                      │
                    Worker execution loop
                                      │
                    ◄──update──  context_window.all_read_files
```

---

### Phase 3: Legacy Cleanup

**Status:** PENDING

**Objective:** Remove deprecated code now that Phase 2 is complete.

**Files to Modify:**

| File | Action | Lines Affected |
|------|--------|----------------|
| `worker.py` | Delete `execute()` | ~40 lines |
| `worker.py` | Delete `_execute_loop()` | ~200 lines |
| `worker.py` | Delete `_build_initial_messages()` | ~120 lines |
| `worker.py` | Delete `_append_tool_messages()` | ~50 lines |
| `worker.py` | Delete `_call_llm()` (use v2) | ~30 lines |
| `worker.py` | Delete `_call_llm_no_tools()` (use v2) | ~20 lines |
| `worker.py` | Delete `_process_tool_calls()` (use v2) | ~80 lines |
| `context_pack.py` | DELETE ENTIRE FILE | ~285 lines |
| `wizard.py` | Remove ContextPackBuilder import | 1 line |
| `wizard.py` | Remove _context_builder initialization | ~10 lines |
| `__init__.py` | Remove ContextPack exports | 5 lines |

**Estimated Removal:** ~640 lines of code

**Migration Checklist:**
- [ ] Search codebase for `ContextPack` references
- [ ] Search codebase for `execute(context_pack` calls
- [ ] Update any external callers to use `execute_v2()`
- [ ] Remove legacy methods from Worker
- [ ] Delete `context_pack.py`
- [ ] Update `__init__.py` exports
- [ ] Run full test suite

**Rename Operations:**
```python
# After legacy removal, rename v2 methods:
execute_v2()           → execute()
_execute_loop_v2()     → _execute_loop()
_call_llm_v2()         → _call_llm()
_call_llm_no_tools_v2() → _call_llm_no_tools()
_process_tool_calls_v2() → _process_tool_calls()
```

---

### Phase 4: Responses API Migration

**Status:** PENDING

**Objective:** Implement `to_responses_input()` and update LLM adapter to use Responses API.

**Background:**

The Responses API (OpenAI) differs from Chat Completions:
- Uses `input` instead of `messages`
- Supports `previous_response_id` for stateful conversations
- Different tool calling format
- Built-in conversation state management

**Deliverables:**

1. **ContextWindow.to_responses_input()**
```python
def to_responses_input(self) -> Dict[str, Any]:
    """
    Serialize for Responses API.

    Returns:
        {
            "model": "...",
            "input": [
                {"role": "system", "content": "..."},
                {"role": "user", "content": "..."},
                ...
            ],
            "tools": [...],
            "previous_response_id": "..." or None,
        }
    """
```

2. **LLM Adapter Update**
```python
class LLMAdapter:
    def respond_with_responses_api(
        self,
        context_window: ContextWindow,
        tools: List[Dict],
    ) -> ResponsesAPIResponse:
        """Use Responses API instead of Chat Completions."""
        input_data = context_window.to_responses_input()
        # Call responses API
        ...
```

3. **Response ID Tracking**
```python
class ContextWindow:
    _previous_response_id: Optional[str] = None

    def set_response_id(self, response_id: str) -> None:
        """Track response ID for stateful conversation."""
        self._previous_response_id = response_id
```

**Files to Modify:**
| File | Changes |
|------|---------|
| `context_window.py` | Implement `to_responses_input()`, add response ID tracking |
| `llm_adapter.py` (or equivalent) | Add `respond_with_responses_api()` method |
| `worker.py` | Update `_call_llm_v2()` to use Responses API when available |

**Migration Strategy:**
1. Implement `to_responses_input()` with feature flag
2. Add Responses API method to LLM adapter
3. A/B test: Chat Completions vs Responses API
4. Gradually roll out Responses API
5. Deprecate Chat Completions path

---

### Phase 5: Advanced Context Management

**Status:** PENDING

**Objective:** Implement intelligent context compaction, summarization, and optimization.

**Deliverables:**

1. **Smart Compaction**
```python
class ContextWindow:
    def compact(self, target_usage: float = 0.5) -> CompactionResult:
        """
        Intelligently reduce context size while preserving important information.

        Strategies (in order):
        1. Truncate old tool results (keep recent)
        2. Summarize file contents (keep structure, remove details)
        3. Compress conversation history (keep key turns)
        4. Evict lowest-confidence facts

        Returns:
            CompactionResult with stats on what was removed/summarized
        """
```

2. **Summarization Integration**
```python
class ContextWindow:
    def summarize_files(self, llm: LLMAdapter) -> None:
        """Replace full file contents with LLM-generated summaries."""

    def summarize_conversation(self, llm: LLMAdapter) -> None:
        """Compress conversation history into summary."""
```

3. **Priority-Based Eviction**
```python
@dataclass
class ContextItem:
    content: str
    priority: float  # 0.0-1.0, higher = keep longer
    added_at: datetime
    last_referenced: datetime

class ContextWindow:
    def evict_by_priority(self, target_tokens: int) -> List[ContextItem]:
        """Evict lowest-priority items until under target."""
```

4. **File Content Strategies**
```python
class FileLoadStrategy(Enum):
    FULL = "full"           # Load entire file
    TRUNCATED = "truncated" # Load first N chars
    SUMMARY = "summary"     # LLM-generated summary
    SKELETON = "skeleton"   # AST structure only (classes, functions)
    ON_DEMAND = "on_demand" # Load sections as needed

class ContextWindow:
    def add_file_with_strategy(
        self,
        path: str,
        content: str,
        strategy: FileLoadStrategy = FileLoadStrategy.FULL,
    ) -> bool:
        """Add file with specified loading strategy."""
```

5. **Context Window Metrics**
```python
@dataclass
class ContextMetrics:
    total_tokens: int
    tokens_by_section: Dict[str, int]  # system, files, tools, conversation
    file_count: int
    tool_call_count: int
    turn_count: int
    compression_ratio: float  # Original size / current size

class ContextWindow:
    def get_metrics(self) -> ContextMetrics:
        """Get detailed metrics about context composition."""
```

**Files to Create/Modify:**
| File | Changes |
|------|---------|
| `context_window.py` | Add compaction, summarization, metrics |
| `context_strategies.py` | NEW: File loading strategies |
| `context_summarizer.py` | NEW: LLM-based summarization |

---

## Testing Strategy

### Unit Tests

```python
# tests/test_context_window.py

def test_context_window_creation():
    """Test ContextWindow.from_stores() creates valid window."""

def test_file_deduplication():
    """Test add_file() returns False for already-read files."""

def test_token_tracking():
    """Test token count updates on mutations."""

def test_to_messages_format():
    """Test serialization produces valid message format."""

def test_behavioral_rules_loading():
    """Test BehavioralRules.default() loads .md file."""

def test_stream_buffer():
    """Test StreamBuffer accumulates and finalizes correctly."""
```

### Integration Tests

```python
# tests/test_wizard_integration.py

def test_wizard_uses_context_window():
    """Test Wizard creates ContextWindow and calls execute_v2()."""

def test_dedup_across_steps():
    """Test files read in step 1 are not re-read in step 2."""

def test_context_window_in_worker():
    """Test Worker uses ContextWindow for message management."""
```

### Performance Tests

```python
# tests/test_context_performance.py

def test_large_file_handling():
    """Test performance with files >50KB."""

def test_many_tool_calls():
    """Test performance with 50+ tool calls in history."""

def test_token_tracking_accuracy():
    """Test token estimates vs actual tokenizer."""
```

---

## Rollback Plan

If issues arise, rollback is straightforward:

1. **Wizard:** Change `execute_v2()` back to `execute()`
2. **Wizard:** Change `ContextWindow.from_stores()` back to `_context_builder.build()`
3. Legacy code remains intact until Phase 3

```python
# Rollback in wizard.py
# FROM:
context_window = ContextWindow.from_stores(...)
outcome = self._worker.execute_v2(context_window, work_item, plan_version)

# TO:
context_pack = self._context_builder.build(step, work_item, ...)
outcome = self._worker.execute(context_pack, work_item)
```

---

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Code reduction | -600 lines after Phase 3 | `wc -l` before/after |
| Token accuracy | <10% variance | Compare estimate vs tiktoken |
| Dedup effectiveness | 0 redundant file reads | Log analysis |
| Test coverage | >80% for context_window.py | pytest-cov |
| Responses API latency | <5% regression | Benchmark |

---

## Timeline Estimates

| Phase | Complexity | Dependencies |
|-------|------------|--------------|
| Phase 1 | Low | None |
| Phase 2 | Medium | Phase 1 |
| Phase 3 | Low | Phase 2 + external caller audit |
| Phase 4 | High | Phase 3 + LLM adapter changes |
| Phase 5 | High | Phase 4 + summarization infrastructure |

---

## Appendix: File Inventory

### New Files (Phases 1-2)
```
src/harness/agent/wizard/context_window.py    # 350 lines
src/harness/agent/wizard/behavioral_rules.md  # 80 lines
```

### Modified Files (Phases 1-2)
```
src/harness/agent/wizard/worker.py    # +400 lines (v2 methods)
src/harness/agent/wizard/wizard.py    # +20 lines, -10 lines
src/harness/agent/wizard/__init__.py  # +10 lines
```

### Files to Delete (Phase 3)
```
src/harness/agent/wizard/context_pack.py  # 285 lines
```

### Net Change After Phase 3
```
New code:     +450 lines (context_window.py + behavioral_rules.md)
Removed code: -925 lines (context_pack.py + legacy methods in worker.py)
Net:          -475 lines
```
