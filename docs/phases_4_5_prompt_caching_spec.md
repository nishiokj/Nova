# Phases 4-5: Responses API Migration & Prompt Caching Implementation

## Overview

This document specifies the implementation of:
1. **Phase 4**: Responses API migration with `to_responses_input()`
2. **Phase 5**: Advanced context management (compaction, summarization)
3. **Prompt Caching**: Integration with OpenAI's `prompt_cache_key` system

---

## Key Design Decisions

### Prompt Caching Strategy

**Problem**: We have LLM calls with and without tools. We want to maximize cache hits.

**Solution**: Use a **stable cache key prefix** that includes:
- System prompt (instructions)
- Behavioral rules
- Initial knowledge/context

The cache key **excludes** tools because:
1. OpenAI caches the `input` + `instructions` prefix regardless of tools
2. We can use `tool_choice: "none"` to reuse cached context for no-tool calls
3. Tools are sent separately and don't invalidate the prefix cache

**Cache Key Structure**:
```python
prompt_cache_key = f"{session_id}:{context_hash[:16]}"
```

Where `context_hash` = hash of (system_prompt + behavioral_rules + initial_knowledge)

---

## Phase 4: Responses API Implementation

### 4.1 ContextWindow.to_responses_input()

```python
@dataclass
class ResponsesAPIInput:
    """Structured output for Responses API."""
    input: List[Dict[str, Any]]  # Message array
    instructions: str            # System prompt (separate from input)
    prompt_cache_key: Optional[str] = None
    prompt_cache_retention: Optional[str] = None  # "24h" for extended caching
    previous_response_id: Optional[str] = None

class ContextWindow:
    # New fields for Responses API
    _previous_response_id: Optional[str] = None
    _prompt_cache_key: Optional[str] = None
    _prompt_cache_retention: str = "24h"  # Extended caching by default

    def to_responses_input(
        self,
        include_cache: bool = True,
        cache_key_prefix: Optional[str] = None,
    ) -> ResponsesAPIInput:
        """
        Serialize for OpenAI Responses API.

        Args:
            include_cache: Whether to include prompt_cache_key
            cache_key_prefix: Optional prefix for cache key (e.g., session_id)

        Returns:
            ResponsesAPIInput with all fields for API call
        """
        # Build instructions (system prompt only - cached separately)
        instructions = self._render_system_content()

        # Build input array (user/assistant turns)
        input_items = self._build_responses_input_items()

        # Generate cache key if requested
        cache_key = None
        if include_cache:
            cache_key = self._generate_cache_key(cache_key_prefix)

        return ResponsesAPIInput(
            input=input_items,
            instructions=instructions,
            prompt_cache_key=cache_key,
            prompt_cache_retention=self._prompt_cache_retention,
            previous_response_id=self._previous_response_id,
        )

    def _build_responses_input_items(self) -> List[Dict[str, Any]]:
        """Build input items for Responses API format."""
        items = []

        # Initial user message (objective)
        items.append({
            "role": "user",
            "content": [{"type": "input_text", "text": self._system_prompt.objective}]
        })

        # Pre-loaded file contents
        if self._files:
            items.append({
                "role": "user",
                "content": [{"type": "input_text", "text": self._render_files_block()}]
            })

        # Conversation turns
        for turn in self._turns:
            role = turn.get("role", "user")

            if role == "assistant":
                # Assistant message with optional tool calls
                item = {"role": "assistant"}
                content = turn.get("content", "")
                if content:
                    item["content"] = [{"type": "output_text", "text": content}]

                tool_calls = turn.get("tool_calls", [])
                if tool_calls:
                    # Convert to Responses API function_call format
                    for tc in tool_calls:
                        items.append({
                            "type": "function_call",
                            "call_id": tc.get("id", ""),
                            "name": tc.get("function", {}).get("name", ""),
                            "arguments": json.dumps(tc.get("function", {}).get("arguments", {}))
                        })
                else:
                    items.append(item)

            elif role == "tool":
                # Tool result -> function_call_output
                items.append({
                    "type": "function_call_output",
                    "call_id": turn.get("tool_call_id", ""),
                    "output": turn.get("content", "")
                })

            else:
                # User message
                items.append({
                    "role": "user",
                    "content": [{"type": "input_text", "text": turn.get("content", "")}]
                })

        return items

    def _generate_cache_key(self, prefix: Optional[str] = None) -> str:
        """Generate stable cache key for prompt caching."""
        import hashlib

        # Hash the stable parts of context
        stable_content = (
            self._system_prompt.render() +
            self._behavioral_rules.render() +
            "".join(f.key + str(f.value) for f in self._initial_knowledge)
        )

        content_hash = hashlib.sha256(stable_content.encode()).hexdigest()[:16]

        if prefix:
            return f"{prefix}:{content_hash}"
        return content_hash

    def set_response_id(self, response_id: str) -> None:
        """Track response ID for stateful continuation."""
        self._previous_response_id = response_id

    def set_cache_retention(self, retention: str) -> None:
        """Set cache retention policy (e.g., '24h')."""
        self._prompt_cache_retention = retention
```

### 4.2 LLMAdapter Updates

```python
# In llm_adapter.py

class OpenAIAdapter(LLMAdapter):

    def respond(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,       # NEW
        prompt_cache_retention: Optional[str] = None, # NEW
        **kwargs
    ) -> LLMResponse:
        """
        Synchronous response using OpenAI Responses API.

        Prompt Caching:
            - Set prompt_cache_key to enable caching
            - Set prompt_cache_retention="24h" for extended retention
            - Tools don't affect cache key - use tool_choice="none" for no-tool calls
        """
        # ... existing setup ...

        params = {
            "model": self.config.model,
            "input": self._normalize_responses_input(input),
        }

        if instructions:
            params["instructions"] = instructions

        # Prompt caching parameters
        if prompt_cache_key:
            params["prompt_cache_key"] = prompt_cache_key
        if prompt_cache_retention:
            params["prompt_cache_retention"] = prompt_cache_retention

        # ... rest of method ...
```

### 4.3 Worker Integration

```python
# In worker.py

class Worker:

    def _call_llm(
        self,
        context_window: ContextWindow,
        work_item: WorkItem,
        outcome: WorkerOutcome,
        use_tools: bool = True,
    ) -> Optional[Any]:
        """
        Call LLM using Responses API format.

        Args:
            context_window: Context to serialize
            work_item: Current work item
            outcome: Outcome to update on error
            use_tools: Whether to enable tool calling
        """
        try:
            # Get Responses API input
            responses_input = context_window.to_responses_input(
                include_cache=True,
                cache_key_prefix=work_item.work_id,
            )

            # Get tools (or empty for synthesis calls)
            tools = []
            tool_choice = "none"
            if use_tools:
                tools = self.tool_registry.get_definitions(enabled_only=True)
                tool_choice = "auto"  # or "required" for reasoning models

            # Convert tools to Responses API format
            tools_formatted = [
                t.to_responses_format() if hasattr(t, 'to_responses_format') else t
                for t in tools
            ]

            response = self.llm.respond(
                input=responses_input.input,
                instructions=responses_input.instructions,
                tools=tools_formatted if use_tools else None,
                tool_choice=tool_choice,
                prompt_cache_key=responses_input.prompt_cache_key,
                prompt_cache_retention=responses_input.prompt_cache_retention,
            )

            # Track response ID for continuation
            if hasattr(response, 'raw_response'):
                response_id = getattr(response.raw_response, 'id', None)
                if response_id:
                    context_window.set_response_id(response_id)

            return response

        except Exception as exc:
            outcome.error = f"LLM call failed: {type(exc).__name__}: {str(exc)[:200]}"
            self._log("error", outcome.error)
            return None
```

---

## Phase 5: Advanced Context Management

### 5.1 Context Metrics

```python
@dataclass
class ContextMetrics:
    """Detailed metrics about context composition."""
    total_tokens: int
    tokens_by_section: Dict[str, int]  # system, files, tools, conversation
    file_count: int
    tool_call_count: int
    turn_count: int
    compression_ratio: float  # 1.0 = no compression
    cache_eligible_tokens: int  # Tokens that can be cached (static parts)

class ContextWindow:

    def get_metrics(self) -> ContextMetrics:
        """Get detailed metrics about context composition."""
        tokens_by_section = {
            "system": self._estimate_tokens(self._render_system_content()),
            "files": sum(self._estimate_tokens(fc.content) for fc in self._files.values()),
            "tool_history": sum(self._estimate_tokens(ex.result_content) for ex in self._tool_history),
            "conversation": sum(self._estimate_tokens(str(t.get("content", ""))) for t in self._turns),
        }

        # Cache-eligible = system + behavioral rules + initial knowledge
        cache_eligible = tokens_by_section["system"]

        return ContextMetrics(
            total_tokens=self._current_tokens,
            tokens_by_section=tokens_by_section,
            file_count=len(self._files),
            tool_call_count=len(self._tool_history),
            turn_count=len(self._turns),
            compression_ratio=1.0,  # Updated when compaction applied
            cache_eligible_tokens=cache_eligible,
        )

    def _estimate_tokens(self, text: str) -> int:
        """Estimate tokens (4 chars per token)."""
        return len(text) // 4
```

### 5.2 File Loading Strategies

```python
from enum import Enum

class FileLoadStrategy(Enum):
    """Strategy for loading file content into context."""
    FULL = "full"           # Load entire file
    TRUNCATED = "truncated" # Load first N chars
    SUMMARY = "summary"     # LLM-generated summary (future)
    SKELETON = "skeleton"   # AST structure only (future)
    ON_DEMAND = "on_demand" # Load sections as needed (future)

class ContextWindow:

    def add_file_with_strategy(
        self,
        path: str,
        content: str,
        strategy: FileLoadStrategy = FileLoadStrategy.FULL,
        max_chars: int = 50000,
        summary: Optional[str] = None,
    ) -> bool:
        """
        Add file with specified loading strategy.

        Args:
            path: File path
            content: Full file content
            strategy: How to load the content
            max_chars: Max chars for TRUNCATED strategy
            summary: Pre-computed summary for SUMMARY strategy
        """
        # Dedup check
        if path in self._files or path in self._already_read:
            return False

        if strategy == FileLoadStrategy.FULL:
            stored_content = content
            truncated = False
        elif strategy == FileLoadStrategy.TRUNCATED:
            stored_content = content[:max_chars]
            truncated = len(content) > max_chars
            if truncated:
                stored_content += f"\n... [truncated, {len(content)} total chars]"
        elif strategy == FileLoadStrategy.SUMMARY:
            if summary:
                stored_content = f"[SUMMARY of {path}]\n{summary}"
            else:
                stored_content = content[:max_chars]  # Fallback
            truncated = False
        else:
            stored_content = content[:max_chars]
            truncated = len(content) > max_chars

        self._files[path] = FileContent(
            path=path,
            content=stored_content,
            truncated=truncated,
            original_chars=len(content),
        )

        self._already_read.add(path)
        self._update_token_count()
        return True
```

### 5.3 Smart Compaction

```python
@dataclass
class CompactionResult:
    """Result of context compaction."""
    tokens_before: int
    tokens_after: int
    files_truncated: int
    tool_results_truncated: int
    turns_removed: int
    compression_ratio: float

class ContextWindow:

    def compact(self, target_usage: float = 0.5) -> CompactionResult:
        """
        Intelligently reduce context size while preserving important information.

        Strategies (in order of application):
        1. Truncate old tool results (keep recent)
        2. Truncate file contents (keep imports/key sections)
        3. Remove old conversation turns (keep recent)
        4. Summarize if still over budget (future)

        Args:
            target_usage: Target usage as fraction of budget (0.0-1.0)

        Returns:
            CompactionResult with stats
        """
        tokens_before = self._current_tokens
        target_tokens = int(self._token_budget * target_usage)

        result = CompactionResult(
            tokens_before=tokens_before,
            tokens_after=tokens_before,
            files_truncated=0,
            tool_results_truncated=0,
            turns_removed=0,
            compression_ratio=1.0,
        )

        # Strategy 1: Truncate old tool results
        if self._current_tokens > target_tokens and self._tool_history:
            result.tool_results_truncated = self._truncate_tool_results(
                keep_recent=3,
                max_chars_per_result=5000,
            )
            self._update_token_count()

        # Strategy 2: Truncate file contents
        if self._current_tokens > target_tokens and self._files:
            result.files_truncated = self._truncate_files(max_chars=20000)
            self._update_token_count()

        # Strategy 3: Remove old conversation turns
        if self._current_tokens > target_tokens and len(self._turns) > 6:
            result.turns_removed = self._remove_old_turns(keep_recent=6)
            self._update_token_count()

        result.tokens_after = self._current_tokens
        result.compression_ratio = tokens_before / max(1, result.tokens_after)

        return result

    def _truncate_tool_results(self, keep_recent: int, max_chars_per_result: int) -> int:
        """Truncate old tool results. Returns count truncated."""
        truncated = 0
        for i, ex in enumerate(self._tool_history[:-keep_recent]):
            if len(ex.result_content) > max_chars_per_result:
                ex.result_content = ex.result_content[:max_chars_per_result] + "\n...[truncated]"
                truncated += 1
        return truncated

    def _truncate_files(self, max_chars: int) -> int:
        """Truncate file contents. Returns count truncated."""
        truncated = 0
        for fc in self._files.values():
            if len(fc.content) > max_chars:
                fc.content = fc.content[:max_chars] + f"\n...[truncated from {fc.original_chars} chars]"
                fc.truncated = True
                truncated += 1
        return truncated

    def _remove_old_turns(self, keep_recent: int) -> int:
        """Remove old conversation turns. Returns count removed."""
        if len(self._turns) <= keep_recent:
            return 0
        removed = len(self._turns) - keep_recent
        self._turns = self._turns[-keep_recent:]
        return removed
```

---

## Integration Plan

### Step 1: Update ContextWindow (context_window.py)

1. Add `_previous_response_id` and cache-related fields
2. Implement `to_responses_input()` with proper item building
3. Add `_generate_cache_key()` for stable cache keys
4. Add `ResponsesAPIInput` dataclass
5. Implement `get_metrics()` for context analysis
6. Add `compact()` method for intelligent compaction
7. Add `FileLoadStrategy` enum and `add_file_with_strategy()`

### Step 2: Update LLMAdapter (llm_adapter.py)

1. Add `prompt_cache_key` and `prompt_cache_retention` to `respond()` params
2. Add `prompt_cache_key` and `prompt_cache_retention` to `stream()` params
3. Pass cache params through to API call
4. Update `FailoverLLMAdapter` to pass through cache params

### Step 3: Update Worker (worker.py)

1. Update `_call_llm()` to use `to_responses_input()`
2. Add `use_tools` parameter for synthesis calls
3. Track response IDs for stateful continuation
4. Use cache key based on work_item.work_id

### Step 4: Testing

1. Unit tests for `to_responses_input()` format
2. Unit tests for cache key generation stability
3. Integration tests for prompt caching behavior
4. Tests for compaction strategies

---

## Cache Key Strategy Details

### What Gets Cached

The Responses API caches based on:
1. **`prompt_cache_key`**: Explicit key you provide
2. **Input prefix**: Common prefix of `input` array
3. **Instructions**: System prompt

### Maximizing Cache Hits

```python
# Call 1: With tools
response1 = llm.respond(
    input=context.to_responses_input().input,
    instructions=instructions,
    tools=tool_definitions,
    tool_choice="auto",
    prompt_cache_key="session123:abc123",
)

# Call 2: Without tools (synthesis) - REUSES CACHE
response2 = llm.respond(
    input=context.to_responses_input().input,  # Same input
    instructions=instructions,                  # Same instructions
    tools=tool_definitions,                     # Same tools (for cache)
    tool_choice="none",                         # But don't use them
    prompt_cache_key="session123:abc123",       # Same cache key
)
```

**Key insight**: By including tools but setting `tool_choice: "none"`, we:
1. Keep the same cache key
2. Benefit from cached prefix
3. Get a response without tool calls

### Extended Retention

```python
params["prompt_cache_retention"] = "24h"  # Keep cache for 24 hours
```

This is useful for:
- Long-running sessions
- Multi-step plans where context is reused
- Reducing costs on repeated similar queries

---

## Stateful Conversations (Delta Mode)

### The Real Optimization

While prompt caching reduces OpenAI's processing time, **stateful conversations**
reduce payload size entirely. Using `previous_response_id`, we only send NEW items.

### Implementation

```python
# First call: Send full context
full = context.to_responses_input()
response = llm.respond(
    input=full.input,                    # Full conversation
    instructions=full.instructions,       # System prompt
    tools=tool_definitions,
    prompt_cache_key=full.prompt_cache_key,
)

# Track response ID and mark state as sent
context.set_response_id(response.raw_response.id)

# ... user adds tool results, messages ...
context.add_tool_result_turn(call_id, result)
context.add_user_turn("synthesis prompt")

# Subsequent calls: Send ONLY new items
delta = context.to_responses_delta()
response = llm.respond(
    input=delta.input,                   # Just the new turns!
    previous_response_id=delta.previous_response_id,  # Continue from here
    tools=tool_definitions,
    # No instructions needed - OpenAI has them from previous
)
context.set_response_id(response.raw_response.id)
```

### Key Methods

| Method | Purpose |
|--------|---------|
| `to_responses_input()` | Full context (first call or fresh start) |
| `to_responses_delta()` | Only new items since last `set_response_id()` |
| `set_response_id(id)` | Mark current state as sent, enable delta mode |
| `clear_response_id()` | Reset - next call sends full context |
| `can_use_delta` | Property: True if previous_response_id is set |
| `pending_turns` | Property: Number of turns not yet sent |

### Benefits

1. **Reduced payload size**: Only send new tool results and messages
2. **Lower latency**: Less data to transmit
3. **Lower costs**: Fewer input tokens billed
4. **Maintained context**: OpenAI tracks the full conversation state

---

## File Structure After Implementation

```
src/harness/agent/wizard/
├── context_window.py      # Updated with Phases 4-5
│   ├── ResponsesAPIInput  # NEW dataclass
│   ├── ContextMetrics     # NEW dataclass
│   ├── FileLoadStrategy   # NEW enum
│   ├── CompactionResult   # NEW dataclass
│   └── ContextWindow      # Updated class
│       ├── to_responses_input()  # IMPLEMENTED
│       ├── get_metrics()         # NEW
│       ├── compact()             # NEW
│       └── add_file_with_strategy()  # NEW
├── behavioral_rules.md
└── worker.py             # Updated to use to_responses_input()

src/util/
└── llm_adapter.py        # Updated with prompt caching params
```

---

## Migration Checklist

- [ ] Add ResponsesAPIInput dataclass to context_window.py
- [ ] Implement to_responses_input() in ContextWindow
- [ ] Add _generate_cache_key() method
- [ ] Add prompt_cache_key/retention to OpenAIAdapter.respond()
- [ ] Add prompt_cache_key/retention to OpenAIAdapter.stream()
- [ ] Update Worker._call_llm() to use new format
- [ ] Add ContextMetrics dataclass
- [ ] Implement get_metrics() method
- [ ] Add FileLoadStrategy enum
- [ ] Implement add_file_with_strategy()
- [ ] Add CompactionResult dataclass
- [ ] Implement compact() method
- [ ] Update FailoverLLMAdapter to pass through cache params
- [ ] Write unit tests for to_responses_input()
- [ ] Write integration tests for prompt caching
- [ ] Document cache key strategy
