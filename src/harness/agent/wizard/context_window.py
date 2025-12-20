"""
ContextWindow: Explicit, typed representation of the LLM context window.

Replaces the implicit messages list with a structured, token-aware container.
Designed with Responses API migration in mind.

Lifecycle:
1. CREATED by Wizard via from_stores() factory
2. TRANSFERRED to Worker (ownership handoff)
3. MUTATED by Worker during execution loop
4. SERIALIZED for each LLM call
5. DISPOSED after Worker returns (ephemeral)

Key Responsibilities:
- Owns file deduplication (seeded with already_read from Wizard)
- Tracks token usage for compaction decisions
- Buffers streaming responses
- Serializes to messages format (Responses API ready)
- Supports prompt caching via stable cache keys
"""

import hashlib
import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, TYPE_CHECKING

from .knowledge_store import KnowledgeFact, FactSource

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from .plan_state import PlanState, StepState
    from .work_ledger import WorkLedger
    from .knowledge_store import KnowledgeStore
    from .work_item import WorkItem
    from ...graphd.client import GraphdClient


# ══════════════════════════════════════════════════════════════════════════════
# FILE LOADING STRATEGIES (Phase 5)
# ══════════════════════════════════════════════════════════════════════════════


class FileLoadStrategy(Enum):
    """Strategy for loading file content into context."""
    FULL = "full"           # Load entire file
    TRUNCATED = "truncated" # Load first N chars
    SUMMARY = "summary"     # LLM-generated summary
    SKELETON = "skeleton"   # AST structure only (future)
    ON_DEMAND = "on_demand" # Load sections as needed (future)


# ══════════════════════════════════════════════════════════════════════════════
# RESPONSES API INPUT (Phase 4)
# ══════════════════════════════════════════════════════════════════════════════


@dataclass
class ResponsesAPIInput:
    """
    Structured output for OpenAI Responses API.

    This is returned by ContextWindow.to_responses_input() and contains
    all the fields needed for an API call with prompt caching.
    """
    input: List[Dict[str, Any]]  # Message/item array
    instructions: str            # System prompt (separate from input)
    prompt_cache_key: Optional[str] = None
    prompt_cache_retention: Optional[str] = None  # "24h" for extended caching
    previous_response_id: Optional[str] = None


# ══════════════════════════════════════════════════════════════════════════════
# CONTEXT METRICS (Phase 5)
# ══════════════════════════════════════════════════════════════════════════════


@dataclass
class ContextMetrics:
    """
    Detailed metrics about context composition.

    Used for monitoring, debugging, and compaction decisions.
    """
    total_tokens: int
    tokens_by_section: Dict[str, int]  # system, files, tool_history, conversation
    file_count: int
    tool_call_count: int
    turn_count: int
    compression_ratio: float  # 1.0 = no compression, >1.0 = compressed
    cache_eligible_tokens: int  # Tokens in static parts (cacheable)


# ══════════════════════════════════════════════════════════════════════════════
# COMPACTION RESULT (Phase 5)
# ══════════════════════════════════════════════════════════════════════════════


@dataclass
class CompactionResult:
    """Result of context compaction operation."""
    tokens_before: int
    tokens_after: int
    files_truncated: int
    tool_results_truncated: int
    turns_removed: int
    compression_ratio: float  # tokens_before / tokens_after


# ══════════════════════════════════════════════════════════════════════════════
# SYSTEM PROMPT
# ══════════════════════════════════════════════════════════════════════════════


@dataclass
class SystemPrompt:
    """
    Structured system-level instructions.
    Renders to the system message content.
    """

    goal: str
    step_num: int
    objective: str
    role: str = "You are a Worker executing a bounded work item."
    constraints: List[str] = field(default_factory=list)
    tool_hint: Optional[str] = None

    def render(self) -> str:
        """Render to string for system message."""
        lines = [
            f"GOAL: {self.goal}",
            f"CURRENT STEP: {self.step_num}",
            f"OBJECTIVE: {self.objective}",
            "",
            self.role,
        ]

        if self.constraints:
            lines.append("")
            lines.append("CONSTRAINTS:")
            for c in self.constraints:
                lines.append(f"- {c}")

        if self.tool_hint:
            lines.append(f"\nSUGGESTED TOOL: {self.tool_hint}")

        return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════════════════
# BEHAVIORAL RULES
# ══════════════════════════════════════════════════════════════════════════════


@dataclass
class BehavioralRules:
    """
    Behavioral rules for the Worker.
    Loaded from a .md file. No fallback - the .md file is required.
    """

    content: str = ""

    @classmethod
    def from_file(cls, path: str) -> "BehavioralRules":
        """Load rules from a markdown file."""
        with open(path, "r") as f:
            return cls(content=f.read())

    @classmethod
    def default(cls) -> "BehavioralRules":
        """
        Load default behavioral rules from package directory.

        Raises:
            FileNotFoundError: If behavioral_rules.md is not found in package directory.
        """
        package_dir = Path(__file__).parent
        default_path = package_dir / "behavioral_rules.md"
        if not default_path.exists():
            raise FileNotFoundError(
                f"Required behavioral_rules.md not found at {default_path}. "
                "This file must be included in the wizard package."
            )
        return cls.from_file(str(default_path))

    def render(self) -> str:
        """Render rules content."""
        return self.content


# ══════════════════════════════════════════════════════════════════════════════
# FILE CONTENT
# ══════════════════════════════════════════════════════════════════════════════


@dataclass
class FileContent:
    """A file loaded into context."""

    path: str
    content: str
    truncated: bool = False
    original_chars: int = 0


# ══════════════════════════════════════════════════════════════════════════════
# TOOL EXCHANGE
# ══════════════════════════════════════════════════════════════════════════════


@dataclass
class ToolExchange:
    """A tool invocation and its result."""

    call_id: str
    tool_name: str
    arguments: Dict[str, Any]
    result_content: str = ""
    success: bool = True
    error: Optional[str] = None


# ══════════════════════════════════════════════════════════════════════════════
# STREAMING BUFFER
# ══════════════════════════════════════════════════════════════════════════════


@dataclass
class StreamBuffer:
    """Buffer for accumulating streaming response chunks."""

    chunks: List[str] = field(default_factory=list)
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    is_complete: bool = False

    def append_chunk(self, chunk: str) -> None:
        """Append a text chunk."""
        self.chunks.append(chunk)

    def append_tool_call(self, tool_call: Dict[str, Any]) -> None:
        """Append a tool call from streaming."""
        self.tool_calls.append(tool_call)

    def finalize(self) -> str:
        """Mark complete and return full content."""
        self.is_complete = True
        return "".join(self.chunks)

    @property
    def current_content(self) -> str:
        """Get current accumulated content."""
        return "".join(self.chunks)


# ══════════════════════════════════════════════════════════════════════════════
# CONTEXT WINDOW
# ══════════════════════════════════════════════════════════════════════════════


class ContextWindow:
    """
    Explicit, typed representation of the LLM context window.

    Owns:
    - File deduplication (via _already_read set)
    - Token tracking and compaction decisions
    - Message serialization

    Designed for Responses API migration:
    - to_messages() for current Chat Completions
    - to_responses_input() placeholder for Responses API
    """

    def __init__(
        self,
        system_prompt: SystemPrompt,
        behavioral_rules: BehavioralRules,
        token_budget: int = 100_000,
        already_read: Optional[Set[str]] = None,
    ):
        self._system_prompt = system_prompt
        self._behavioral_rules = behavioral_rules
        self._token_budget = token_budget

        # Dedup: files already read (seeded from Wizard, updated during execution)
        self._already_read: Set[str] = already_read.copy() if already_read else set()

        # Seeded from stores (immutable after creation)
        self._initial_knowledge: Tuple["KnowledgeFact", ...] = ()
        self._work_summary: str = ""

        # Mutable during Worker execution
        self._files: Dict[str, FileContent] = {}
        self._tool_history: List[ToolExchange] = []
        self._turns: List[Dict[str, Any]] = []

        # Streaming support
        self._stream_buffer: Optional[StreamBuffer] = None

        # Token tracking
        self._current_tokens: int = 0

        # Unique ID for this context window
        self._window_id: str = str(uuid.uuid4())[:8]

        # Responses API / Prompt Caching (Phase 4)
        self._previous_response_id: Optional[str] = None
        self._prompt_cache_key: Optional[str] = None
        self._prompt_cache_retention: str = "24h"  # Extended caching by default

        # Stateful conversation tracking (Phase 4 optimization)
        # Tracks how many turns have been sent to API, so we can send only deltas
        self._turns_sent: int = 0  # Number of turns already sent via previous_response_id
        self._files_sent: bool = False  # Whether initial files block was sent
        self._initial_sent: bool = False  # Whether initial context was sent

        # Compaction tracking (Phase 5)
        self._original_tokens: int = 0  # Set after initial build
        self._compression_ratio: float = 1.0

    # ══════════════════════════════════════════════════════════════════════════
    # FACTORY (called by Wizard)
    # ══════════════════════════════════════════════════════════════════════════

    @classmethod
    def from_stores(
        cls,
        plan_state: "PlanState",
        knowledge: "KnowledgeStore",
        ledger: "WorkLedger",
        step: "StepState",
        work_item: "WorkItem",
        token_budget: int = 100_000,
        already_read: Optional[Set[str]] = None,
        behavioral_rules: Optional[BehavioralRules] = None,
        graphd_client: Optional["GraphdClient"] = None,
    ) -> "ContextWindow":
        """
        Factory: Build ContextWindow from Wizard's persistent stores.

        This is the ONLY way Wizard should create a ContextWindow.
        After creation, ownership transfers to Worker.

        Args:
            plan_state: Current plan state (for goal)
            knowledge: KnowledgeStore (for facts snapshot)
            ledger: WorkLedger (for work summary)
            step: Current step being executed
            work_item: Work item with objective and bounds
            token_budget: Max tokens for this context
            already_read: Files already read in this orchestration (for dedup)
            behavioral_rules: Optional custom rules (defaults to .md file)
            graphd_client: Optional GraphDB client for code intelligence enrichment
        """
        # Enrich knowledge from GraphDB before building context
        if graphd_client and hasattr(step, 'target_paths') and step.target_paths:
            cls._enrich_from_graphdb(graphd_client, knowledge, step.target_paths)

        system_prompt = SystemPrompt(
            goal=plan_state.goal,
            step_num=step.step_num,
            objective=work_item.objective,
            constraints=[
                f"Max tool calls: {work_item.bounds.max_tool_calls}",
                f"Max duration: {work_item.bounds.max_duration_ms}ms",
            ],
            tool_hint=work_item.tool_hint,
        )

        rules = behavioral_rules or BehavioralRules.default()

        window = cls(
            system_prompt=system_prompt,
            behavioral_rules=rules,
            token_budget=token_budget,
            already_read=already_read,
        )

        # Seed from stores (snapshot, not live reference)
        window._initial_knowledge = tuple(knowledge.get_recent_facts(limit=20))
        window._work_summary = ledger.summarize_tail(n=5)
        window._update_token_count()

        # Track original token count for compression ratio
        window._original_tokens = window._current_tokens

        return window

    @staticmethod
    def _enrich_from_graphdb(
        graphd_client: "GraphdClient",
        knowledge: "KnowledgeStore",
        target_paths: List[str],
    ) -> None:
        """
        Query GraphDB for context about target files.

        Injects facts into KnowledgeStore with source=GRAPHDB:
        - graphdb:imports:<path> - Files that import this file
        - graphdb:callers:<path> - Functions that call into this file
        - graphdb:tests:<path> - Test files that cover this file

        Args:
            graphd_client: GraphDB client for queries
            knowledge: KnowledgeStore to inject facts into
            target_paths: Files to query context for
        """
        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]

        for path in target_paths[:3]:  # Limit to 3 files to avoid overhead
            try:
                # Query impact to get imports/callers/tests
                impact_result = graphd_client.impact({
                    "entity": {"type": "file", "path": path},
                    "change_type": "modify",
                    "budget": 10,  # Get up to 10 impact items
                })

                if impact_result and "error" in impact_result:
                    logger.warning(
                        "[%s] ContextWindow GraphDB impact error for %s: %s",
                        timestamp, path, impact_result["error"]
                    )
                elif impact_result:
                    impact_items = impact_result.get("impact_items", [])
                    if impact_items:
                        # Group by kind (imports, callers, tests, etc.)
                        by_kind: Dict[str, List[str]] = {}
                        for item in impact_items:
                            kind = item.get("kind", "unknown")
                            target = item.get("target", "")
                            if target:
                                by_kind.setdefault(kind, []).append(target)

                        # Store each kind as a separate fact
                        for kind, targets in by_kind.items():
                            fact_key = f"graphdb:{kind}:{path}"
                            fact_value = targets[:5]
                            knowledge.upsert(KnowledgeFact(
                                key=fact_key,
                                value=fact_value,
                                confidence=0.9,
                                source=FactSource.GRAPHDB,
                                ttl_seconds=300,  # 5 minute TTL
                            ))
                            logger.info(
                                "[%s] ContextWindow injecting GraphDB fact: %s = %s",
                                timestamp, fact_key, fact_value
                            )

            except Exception as e:
                logger.warning(
                    "[%s] ContextWindow GraphDB exception for %s: %s",
                    timestamp, path, str(e)[:100]
                )

    # ══════════════════════════════════════════════════════════════════════════
    # FILE MANAGEMENT (with dedup)
    # ══════════════════════════════════════════════════════════════════════════

    def add_file(self, path: str, content: str, max_chars: int = 500000) -> bool:
        """
        Add file to context.

        Returns False if:
        - File already in this window's _files
        - File in _already_read set (read in previous steps)

        Truncates content if over max_chars.
        """
        # Dedup check: already in this window
        if path in self._files:
            return False

        # Dedup check: read in previous steps
        if path in self._already_read:
            return False

        # Truncate if needed
        truncated = len(content) > max_chars
        stored_content = content[:max_chars] if truncated else content
        if truncated:
            stored_content += f"\n... [truncated, {len(content)} total chars]"

        self._files[path] = FileContent(
            path=path,
            content=stored_content,
            truncated=truncated,
            original_chars=len(content),
        )

        # Track as read
        self._already_read.add(path)
        self._update_token_count()
        return True

    def has_file(self, path: str) -> bool:
        """Check if file is in context or already read."""
        return path in self._files or path in self._already_read

    @property
    def loaded_files(self) -> List[str]:
        """Files loaded in THIS execution (for Wizard to track)."""
        return list(self._files.keys())

    @property
    def all_read_files(self) -> Set[str]:
        """All files read (includes previous steps). For Wizard dedup tracking."""
        return self._already_read.copy()

    # ══════════════════════════════════════════════════════════════════════════
    # TOOL HISTORY
    # ══════════════════════════════════════════════════════════════════════════

    def add_tool_result(self, exchange: ToolExchange) -> None:
        """Record a tool call and its result."""
        self._tool_history.append(exchange)
        self._update_token_count()

    def add_tool_results_batch(self, exchanges: List[ToolExchange]) -> None:
        """Record multiple tool results (from parallel execution)."""
        self._tool_history.extend(exchanges)
        self._update_token_count()

    @property
    def tool_count(self) -> int:
        """Number of tool calls made."""
        return len(self._tool_history)

    # ══════════════════════════════════════════════════════════════════════════
    # CONVERSATION TURNS
    # ══════════════════════════════════════════════════════════════════════════

    def add_assistant_turn(
        self, content: str, tool_calls: Optional[List[Dict[str, Any]]] = None
    ) -> None:
        """Record assistant response."""
        turn: Dict[str, Any] = {"role": "assistant"}
        if content:
            turn["content"] = content
        if tool_calls:
            turn["tool_calls"] = tool_calls
        self._turns.append(turn)
        self._update_token_count()

    def add_user_turn(self, content: str, is_system_injection: bool = False) -> None:
        """Record user message or system injection.

        Args:
            content: The message content
            is_system_injection: If True, marks this as an internal system prompt
                                 (not a real user message). These are excluded from
                                 persisted conversation history.
        """
        turn: Dict[str, Any] = {"role": "user", "content": content}
        if is_system_injection:
            turn["_internal"] = True
        self._turns.append(turn)
        self._update_token_count()

    def add_tool_result_turn(self, call_id: str, content: str) -> None:
        """Record tool result as a turn (for message history)."""
        self._turns.append({
            "role": "tool",
            "tool_call_id": call_id,
            "content": content,
        })
        self._update_token_count()

    # ══════════════════════════════════════════════════════════════════════════
    # STREAMING
    # ══════════════════════════════════════════════════════════════════════════

    def start_stream(self) -> StreamBuffer:
        """Start buffering a streaming response."""
        self._stream_buffer = StreamBuffer()
        return self._stream_buffer

    def finalize_stream(self) -> Optional[str]:
        """Finalize streaming and add to turns."""
        if not self._stream_buffer:
            return None

        content = self._stream_buffer.finalize()
        tool_calls = self._stream_buffer.tool_calls if self._stream_buffer.tool_calls else None
        self.add_assistant_turn(content, tool_calls)

        result = content
        self._stream_buffer = None
        return result

    # ══════════════════════════════════════════════════════════════════════════
    # TOKEN TRACKING
    # ══════════════════════════════════════════════════════════════════════════

    @property
    def token_usage(self) -> float:
        """Current usage as fraction of budget (0.0 - 1.0)."""
        if self._token_budget <= 0:
            return 0.0
        return min(1.0, self._current_tokens / self._token_budget)

    @property
    def tokens_used(self) -> int:
        """Estimated tokens currently used."""
        return self._current_tokens

    @property
    def tokens_remaining(self) -> int:
        """Estimated tokens remaining in budget."""
        return max(0, self._token_budget - self._current_tokens)

    @property
    def should_compact(self) -> bool:
        """True if over 60% budget."""
        return self.token_usage > 0.6

    def _update_token_count(self) -> None:
        """Recompute token estimate (~4 chars/token)."""
        total_chars = 0

        # System prompt + rules
        total_chars += len(self._system_prompt.render())
        total_chars += len(self._behavioral_rules.render())

        # Knowledge
        for fact in self._initial_knowledge:
            total_chars += len(str(fact.key)) + len(str(fact.value))

        # Work summary
        total_chars += len(self._work_summary)

        # Files
        for fc in self._files.values():
            total_chars += len(fc.content) + len(fc.path)

        # Tool history
        for ex in self._tool_history:
            total_chars += len(ex.result_content) + len(str(ex.arguments))

        # Turns (including tool_calls which can be significant)
        for turn in self._turns:
            content = turn.get("content", "")
            if isinstance(content, str):
                total_chars += len(content)
            # Count tool_calls in assistant turns
            tool_calls = turn.get("tool_calls")
            if tool_calls:
                for tc in tool_calls:
                    # Count function name and arguments
                    func = tc.get("function", {})
                    total_chars += len(str(func.get("name", "")))
                    total_chars += len(str(func.get("arguments", "")))
                    total_chars += len(str(tc.get("id", "")))

        # Rough token estimate (4 chars per token)
        self._current_tokens = total_chars // 4

    # ══════════════════════════════════════════════════════════════════════════
    # SERIALIZATION: CHAT MESSAGES FORMAT
    # ══════════════════════════════════════════════════════════════════════════

    def to_messages(self) -> List[Dict[str, Any]]:
        """
        Serialize to Chat Completions message format.

        Returns a list of messages ready for LLM API call.
        """
        messages: List[Dict[str, Any]] = []

        # 1. System message (includes objective as part of system instructions)
        messages.append({
            "role": "system",
            "content": self._render_system_content(),
        })

        # 2. Pre-loaded file contents (if any) - as context, not user input
        if self._files:
            messages.append({
                "role": "user",
                "content": self._render_files_block(),
            })

        # 4. Conversation history (turns include tool results)
        messages.extend(self._turns)

        return messages

    def _render_system_content(self) -> str:
        """Render full system prompt with rules and knowledge."""
        sections = [self._system_prompt.render()]

        # Behavioral rules
        rules_content = self._behavioral_rules.render()
        if rules_content:
            sections.append(rules_content)

        # Initial knowledge
        if self._initial_knowledge:
            facts_text = "\n".join(
                f"- {f.key}: {f.value}" for f in self._initial_knowledge
            )
            sections.append(f"KNOWN FACTS:\n{facts_text}")

        # Work summary
        if self._work_summary:
            sections.append(f"RECENT WORK:\n{self._work_summary}")

        return "\n\n".join(sections)

    def _render_files_block(self) -> str:
        """Render pre-loaded files as a context block."""
        lines = [
            "═══════════════════════════════════════════════════════════════",
            "TARGET FILES (pre-loaded, authoritative - do NOT re-read):",
            "═══════════════════════════════════════════════════════════════",
            "",
        ]

        for fc in self._files.values():
            lines.append(f"### {fc.path}")
            lines.append("```")
            lines.append(fc.content)
            lines.append("```")
            lines.append("")

        lines.extend([
            "═══════════════════════════════════════════════════════════════",
            "You have the file content above. Use it directly.",
            "DO NOT call file_read on these paths.",
            "═══════════════════════════════════════════════════════════════",
        ])

        return "\n".join(lines)

    # ══════════════════════════════════════════════════════════════════════════
    # SERIALIZATION: RESPONSES API (Phase 4)
    # ══════════════════════════════════════════════════════════════════════════

    def to_responses_input(
        self,
        include_cache: bool = True,
        cache_key_prefix: Optional[str] = None,
    ) -> ResponsesAPIInput:
        """
        Serialize for OpenAI Responses API.

        Args:
            include_cache: Whether to include prompt_cache_key for caching
            cache_key_prefix: Optional prefix for cache key (e.g., session_id, work_id)

        Returns:
            ResponsesAPIInput with all fields for Responses API call

        Note on Prompt Caching:
            The cache key is computed from stable parts of the context:
            - System prompt
            - Behavioral rules
            - Initial knowledge

            Tools don't affect the cache key. To make calls without tools
            while reusing the cache, pass the same cache key but set
            tool_choice="none" in the API call.
        """
        # Build instructions (system prompt - cached separately from input)
        instructions = self._render_system_content()

        # Build input items array (user/assistant turns + tool results)
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
        """
        Build input items for Responses API format.

        Converts the internal turn representation to the Responses API format:
        - User messages: {"role": "user", "content": [{"type": "input_text", "text": "..."}]}
        - Assistant messages: {"role": "assistant", "content": [{"type": "output_text", "text": "..."}]}
        - Tool calls: {"type": "function_call", "call_id": "...", "name": "...", "arguments": "..."}
        - Tool results: {"type": "function_call_output", "call_id": "...", "output": "..."}
        """
        items: List[Dict[str, Any]] = []

        # 1. Pre-loaded file contents (if any) - objective is in system instructions
        if self._files:
            items.append({
                "role": "user",
                "content": [{"type": "input_text", "text": self._render_files_block()}]
            })

        # 2. Conversation turns
        for turn in self._turns:
            role = turn.get("role", "user")

            if role == "assistant":
                # Handle assistant message content
                content = turn.get("content", "")
                tool_calls = turn.get("tool_calls", [])

                # If there's text content, add it as a message
                if content:
                    items.append({
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": content}]
                    })

                # Add any tool calls as separate function_call items
                for tc in tool_calls:
                    func = tc.get("function", {})
                    call_id = tc.get("id", "")
                    name = func.get("name", "")
                    arguments = func.get("arguments", {})

                    # Serialize arguments to JSON string if dict
                    if isinstance(arguments, dict):
                        arguments = json.dumps(arguments)

                    items.append({
                        "type": "function_call",
                        "call_id": call_id,
                        "name": name,
                        "arguments": arguments,
                    })

            elif role == "tool":
                # Tool result -> function_call_output
                items.append({
                    "type": "function_call_output",
                    "call_id": turn.get("tool_call_id", ""),
                    "output": turn.get("content", ""),
                })

            else:
                # User message
                items.append({
                    "role": "user",
                    "content": [{"type": "input_text", "text": turn.get("content", "")}]
                })

        return items

    def _generate_cache_key(self, prefix: Optional[str] = None) -> str:
        """
        Generate stable cache key for prompt caching.

        The cache key is computed from the stable parts of the context
        that don't change during the execution loop:
        - System prompt (goal, step, objective, constraints)
        - Behavioral rules
        - Initial knowledge facts

        This ensures the same prefix can be cached and reused across
        multiple LLM calls within the same work item execution.
        """
        # Hash the stable parts of context
        stable_parts = [
            self._system_prompt.render(),
            self._behavioral_rules.render(),
        ]

        # Include initial knowledge in hash
        for fact in self._initial_knowledge:
            stable_parts.append(f"{fact.key}:{fact.value}")

        # Include work summary if present
        if self._work_summary:
            stable_parts.append(self._work_summary)

        stable_content = "\n".join(stable_parts)
        content_hash = hashlib.sha256(stable_content.encode()).hexdigest()[:16]

        if prefix:
            return f"{prefix}:{content_hash}"
        return f"{self._window_id}:{content_hash}"

    def set_response_id(self, response_id: str) -> None:
        """
        Track response ID for stateful conversation continuation.

        When using Responses API with stateful mode, the response ID
        from a previous call can be used to continue the conversation
        without resending the full context.

        IMPORTANT: This also marks the current state as "sent", so subsequent
        calls to to_responses_delta() only return new items.
        """
        self._previous_response_id = response_id
        # Mark current state as sent
        self._turns_sent = len(self._turns)
        self._files_sent = bool(self._files)
        self._initial_sent = True

    def set_cache_retention(self, retention: str) -> None:
        """
        Set cache retention policy.

        Args:
            retention: Retention policy string (e.g., "24h" for 24-hour extended caching)
        """
        self._prompt_cache_retention = retention

    def clear_response_id(self) -> None:
        """Clear the previous response ID (start fresh conversation)."""
        self._previous_response_id = None
        # Reset sent tracking - next call will send full context
        self._turns_sent = 0
        self._files_sent = False
        self._initial_sent = False

    def to_responses_delta(self) -> ResponsesAPIInput:
        """
        Get only NEW items since last API call (for stateful continuation).

        This is the key optimization for stateful conversations:
        - First call: Returns full context (same as to_responses_input())
        - Subsequent calls: Returns only new turns added since set_response_id()

        Usage:
            # First call
            full = context.to_responses_input()
            response = llm.respond(input=full.input, instructions=full.instructions, ...)
            context.set_response_id(response.id)

            # ... add tool results, user messages ...

            # Subsequent call - only sends delta
            delta = context.to_responses_delta()
            response = llm.respond(
                input=delta.input,  # Only new items!
                previous_response_id=delta.previous_response_id,  # Continue from here
            )
            context.set_response_id(response.id)

        Returns:
            ResponsesAPIInput with:
            - input: Only new items (or full if no previous_response_id)
            - previous_response_id: Set if continuing conversation
            - instructions: Only included on first call (None for deltas)
        """
        # If no previous response, return full context
        if not self._previous_response_id or not self._initial_sent:
            return self.to_responses_input()

        # Build delta - only new turns
        delta_items: List[Dict[str, Any]] = []

        # Get turns added since last call
        new_turns = self._turns[self._turns_sent:]

        for turn in new_turns:
            role = turn.get("role", "user")

            if role == "assistant":
                content = turn.get("content", "")
                tool_calls = turn.get("tool_calls", [])

                if content:
                    delta_items.append({
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": content}]
                    })

                for tc in tool_calls:
                    func = tc.get("function", {})
                    call_id = tc.get("id", "")
                    name = func.get("name", "")
                    arguments = func.get("arguments", {})

                    if isinstance(arguments, dict):
                        arguments = json.dumps(arguments)

                    delta_items.append({
                        "type": "function_call",
                        "call_id": call_id,
                        "name": name,
                        "arguments": arguments,
                    })

            elif role == "tool":
                delta_items.append({
                    "type": "function_call_output",
                    "call_id": turn.get("tool_call_id", ""),
                    "output": turn.get("content", ""),
                })

            else:
                # User message
                delta_items.append({
                    "role": "user",
                    "content": [{"type": "input_text", "text": turn.get("content", "")}]
                })

        return ResponsesAPIInput(
            input=delta_items,
            instructions=None,  # Not needed for continuation
            prompt_cache_key=None,  # Not needed when using previous_response_id
            prompt_cache_retention=None,
            previous_response_id=self._previous_response_id,
        )

    @property
    def can_use_delta(self) -> bool:
        """Check if we can use delta mode (have a previous response ID)."""
        return self._previous_response_id is not None and self._initial_sent

    @property
    def pending_turns(self) -> int:
        """Number of turns not yet sent to API."""
        return len(self._turns) - self._turns_sent

    # ══════════════════════════════════════════════════════════════════════════
    # CONTEXT METRICS (Phase 5)
    # ══════════════════════════════════════════════════════════════════════════

    def get_metrics(self) -> ContextMetrics:
        """
        Get detailed metrics about context composition.

        Useful for:
        - Monitoring context usage
        - Debugging token budget issues
        - Deciding when to compact
        - Analyzing cache efficiency
        """
        # Calculate tokens by section
        system_content = self._render_system_content()
        system_tokens = self._estimate_tokens(system_content)

        file_tokens = sum(
            self._estimate_tokens(fc.content) + self._estimate_tokens(fc.path)
            for fc in self._files.values()
        )

        tool_tokens = sum(
            self._estimate_tokens(ex.result_content) + self._estimate_tokens(str(ex.arguments))
            for ex in self._tool_history
        )

        conversation_tokens = 0
        for turn in self._turns:
            content = turn.get("content", "")
            if isinstance(content, str):
                conversation_tokens += self._estimate_tokens(content)
            # Also count tool_calls in assistant turns
            tool_calls = turn.get("tool_calls", [])
            for tc in tool_calls:
                func = tc.get("function", {})
                conversation_tokens += self._estimate_tokens(str(func.get("name", "")))
                conversation_tokens += self._estimate_tokens(str(func.get("arguments", "")))

        tokens_by_section = {
            "system": system_tokens,
            "files": file_tokens,
            "tool_history": tool_tokens,
            "conversation": conversation_tokens,
        }

        # Cache-eligible tokens = stable parts (system prompt, rules, knowledge)
        cache_eligible_tokens = system_tokens

        # Compression ratio
        compression_ratio = self._compression_ratio
        if self._original_tokens > 0 and self._current_tokens > 0:
            compression_ratio = self._original_tokens / self._current_tokens

        return ContextMetrics(
            total_tokens=self._current_tokens,
            tokens_by_section=tokens_by_section,
            file_count=len(self._files),
            tool_call_count=len(self._tool_history),
            turn_count=len(self._turns),
            compression_ratio=compression_ratio,
            cache_eligible_tokens=cache_eligible_tokens,
        )

    def _estimate_tokens(self, text: str) -> int:
        """Estimate tokens for a string (~4 chars per token)."""
        return len(text) // 4 if text else 0

    # ══════════════════════════════════════════════════════════════════════════
    # FILE LOADING WITH STRATEGIES (Phase 5)
    # ══════════════════════════════════════════════════════════════════════════

    def add_file_with_strategy(
        self,
        path: str,
        content: str,
        strategy: FileLoadStrategy = FileLoadStrategy.FULL,
        max_chars: int = 1000000,
        summary: Optional[str] = None,
    ) -> bool:
        """
        Add file to context with specified loading strategy.

        Args:
            path: File path
            content: Full file content
            strategy: How to load the content (FULL, TRUNCATED, SUMMARY, etc.)
            max_chars: Max chars for TRUNCATED strategy
            summary: Pre-computed summary for SUMMARY strategy

        Returns:
            True if file was added, False if already present (dedup)
        """
        # Dedup check
        if path in self._files or path in self._already_read:
            return False

        original_chars = len(content)

        if strategy == FileLoadStrategy.FULL:
            stored_content = content
            truncated = False

        elif strategy == FileLoadStrategy.TRUNCATED:
            stored_content = content[:max_chars]
            truncated = len(content) > max_chars
            if truncated:
                stored_content += f"\n... [truncated, {original_chars} total chars]"

        elif strategy == FileLoadStrategy.SUMMARY:
            if summary:
                stored_content = f"[SUMMARY of {path}]\n{summary}"
                truncated = False
            else:
                # Fallback to truncated if no summary provided
                stored_content = content[:max_chars]
                truncated = len(content) > max_chars
                if truncated:
                    stored_content += f"\n... [truncated, {original_chars} total chars]"

        elif strategy == FileLoadStrategy.SKELETON:
            # TODO: Implement AST-based skeleton extraction
            # For now, fall back to truncated
            stored_content = content[:max_chars]
            truncated = len(content) > max_chars
            if truncated:
                stored_content += f"\n... [truncated, {original_chars} total chars]"

        else:
            # ON_DEMAND and other future strategies - fallback to truncated
            stored_content = content[:max_chars]
            truncated = len(content) > max_chars

        self._files[path] = FileContent(
            path=path,
            content=stored_content,
            truncated=truncated,
            original_chars=original_chars,
        )

        self._already_read.add(path)
        self._update_token_count()
        return True

    # ══════════════════════════════════════════════════════════════════════════
    # SMART COMPACTION (Phase 5)
    # ══════════════════════════════════════════════════════════════════════════

    def compact(self, target_usage: float = 0.5) -> CompactionResult:
        """
        Intelligently reduce context size while preserving important information.

        Compaction strategies are applied in order of least to most aggressive:
        1. Truncate old tool results (keep recent ones in full)
        2. Truncate large file contents
        3. Remove old conversation turns (keep recent)

        Args:
            target_usage: Target usage as fraction of budget (0.0-1.0)
                         Default 0.5 means compact until at 50% of budget

        Returns:
            CompactionResult with statistics about what was compacted

        Note:
            This method mutates the ContextWindow in place.
            The compression_ratio is updated to reflect the compaction.
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

        # Already under target? No compaction needed
        if self._current_tokens <= target_tokens:
            return result

        # Strategy 1: Truncate old tool results (keep last 3 in full)
        if self._current_tokens > target_tokens and self._tool_history:
            result.tool_results_truncated = self._compact_tool_results(
                keep_recent=3,
                max_chars_per_result=5000,
            )
            self._update_token_count()

        # Strategy 2: Truncate file contents
        if self._current_tokens > target_tokens and self._files:
            result.files_truncated = self._compact_files(max_chars=20000)
            self._update_token_count()

        # Strategy 3: Remove old conversation turns (keep last 6)
        if self._current_tokens > target_tokens and len(self._turns) > 6:
            result.turns_removed = self._compact_turns(keep_recent=6)
            self._update_token_count()

        result.tokens_after = self._current_tokens
        result.compression_ratio = tokens_before / max(1, result.tokens_after)

        # Update internal compression ratio tracking
        if self._original_tokens > 0:
            self._compression_ratio = self._original_tokens / max(1, self._current_tokens)

        logger.info(
            "ContextWindow compacted: %d -> %d tokens (%.2fx), "
            "files=%d, tools=%d, turns=%d",
            result.tokens_before,
            result.tokens_after,
            result.compression_ratio,
            result.files_truncated,
            result.tool_results_truncated,
            result.turns_removed,
        )

        return result

    def _compact_tool_results(self, keep_recent: int, max_chars_per_result: int) -> int:
        """
        Truncate old tool results.

        Args:
            keep_recent: Number of recent results to keep in full
            max_chars_per_result: Max chars for older results

        Returns:
            Number of results that were truncated
        """
        truncated_count = 0

        # Only compact older results (keep recent ones in full)
        for i, ex in enumerate(self._tool_history[:-keep_recent] if len(self._tool_history) > keep_recent else []):
            if len(ex.result_content) > max_chars_per_result:
                ex.result_content = ex.result_content[:max_chars_per_result] + "\n...[truncated for context limits]"
                truncated_count += 1

        return truncated_count

    def _compact_files(self, max_chars: int) -> int:
        """
        Truncate file contents.

        Args:
            max_chars: Maximum chars to keep per file

        Returns:
            Number of files that were truncated
        """
        truncated_count = 0

        for fc in self._files.values():
            if len(fc.content) > max_chars:
                fc.content = fc.content[:max_chars] + f"\n...[truncated from {fc.original_chars} chars]"
                fc.truncated = True
                truncated_count += 1

        return truncated_count

    def _compact_turns(self, keep_recent: int) -> int:
        """
        Remove old conversation turns.

        Args:
            keep_recent: Number of recent turns to keep

        Returns:
            Number of turns that were removed
        """
        if len(self._turns) <= keep_recent:
            return 0

        removed = len(self._turns) - keep_recent
        self._turns = self._turns[-keep_recent:]
        return removed

    def needs_compaction(self, threshold: float = 0.7) -> bool:
        """
        Check if context needs compaction.

        Args:
            threshold: Usage threshold above which compaction is recommended

        Returns:
            True if current usage exceeds threshold
        """
        return self.token_usage > threshold

    # ══════════════════════════════════════════════════════════════════════════
    # UTILITIES
    # ══════════════════════════════════════════════════════════════════════════

    @property
    def window_id(self) -> str:
        """Unique ID for this context window instance."""
        return self._window_id

    def get_persistable_turns(self) -> List[Dict[str, Any]]:
        """
        Get conversation turns suitable for persistence.

        Filters out internal system injections (marked with _internal=True)
        so only real user/assistant exchanges are persisted to session history.

        Returns:
            List of turns without internal system injections
        """
        return [
            turn for turn in self._turns
            if not turn.get("_internal", False)
        ]

    @property
    def has_real_user_turns(self) -> bool:
        """Check if there are any real (non-internal) user turns."""
        return any(
            turn.get("role") == "user" and not turn.get("_internal", False)
            for turn in self._turns
        )

    def __repr__(self) -> str:
        return (
            f"ContextWindow(id={self._window_id}, "
            f"tokens={self._current_tokens}/{self._token_budget}, "
            f"files={len(self._files)}, turns={len(self._turns)})"
        )

    # ══════════════════════════════════════════════════════════════════════════
    # SERIALIZATION FOR SESSION PERSISTENCE
    # ══════════════════════════════════════════════════════════════════════════

    def to_session_dict(self) -> Dict[str, Any]:
        """
        Serialize ContextWindow state for session persistence.

        This captures the essential state needed to restore context across requests:
        - Conversation turns (excluding internal system injections)
        - Files that have been read (for deduplication)
        - Tool history
        - Cache/continuation state

        Returns:
            Dict suitable for JSON serialization to graphd context_snapshots
        """
        return {
            "version": "1.0",
            "window_id": self._window_id,
            # Conversation history (persistable turns only)
            "turns": self.get_persistable_turns(),
            # Files read (paths only - content is re-read if needed)
            "already_read": list(self._already_read),
            # Tool history for context
            "tool_history": [
                {
                    "call_id": ex.call_id,
                    "tool_name": ex.tool_name,
                    "arguments": ex.arguments,
                    "result_content": ex.result_content[:5000] if ex.result_content else "",  # Truncate for storage
                    "success": ex.success,
                    "error": ex.error,
                }
                for ex in self._tool_history
            ],
            # Responses API state
            "previous_response_id": self._previous_response_id,
            "prompt_cache_key": self._prompt_cache_key,
            "prompt_cache_retention": self._prompt_cache_retention,
            # Token tracking
            "token_budget": self._token_budget,
            "current_tokens": self._current_tokens,
        }

    @classmethod
    def from_session_dict(
        cls,
        data: Dict[str, Any],
        system_prompt: SystemPrompt,
        behavioral_rules: Optional[BehavioralRules] = None,
    ) -> "ContextWindow":
        """
        Restore ContextWindow from session persistence data.

        This hydrates a ContextWindow with previous conversation state,
        enabling multi-turn conversations across requests.

        Args:
            data: Dict from to_session_dict()
            system_prompt: Current system prompt (may differ from stored)
            behavioral_rules: Optional rules (defaults to file-based)

        Returns:
            ContextWindow with restored state
        """
        rules = behavioral_rules or BehavioralRules.default()

        window = cls(
            system_prompt=system_prompt,
            behavioral_rules=rules,
            token_budget=data.get("token_budget", 100_000),
            already_read=set(data.get("already_read", [])),
        )

        # Restore window ID if present
        if data.get("window_id"):
            window._window_id = data["window_id"]

        # Restore conversation turns
        for turn in data.get("turns", []):
            window._turns.append(turn)

        # Restore tool history
        for ex_data in data.get("tool_history", []):
            window._tool_history.append(ToolExchange(
                call_id=ex_data.get("call_id", ""),
                tool_name=ex_data.get("tool_name", ""),
                arguments=ex_data.get("arguments", {}),
                result_content=ex_data.get("result_content", ""),
                success=ex_data.get("success", True),
                error=ex_data.get("error"),
            ))

        # Restore Responses API state
        window._previous_response_id = data.get("previous_response_id")
        window._prompt_cache_key = data.get("prompt_cache_key")
        if data.get("prompt_cache_retention"):
            window._prompt_cache_retention = data["prompt_cache_retention"]

        # Restore sent tracking if we have a previous_response_id
        if window._previous_response_id:
            window._turns_sent = len(window._turns)
            window._initial_sent = True

        # Update token count
        window._update_token_count()

        return window

    def hydrate_from_session(self, data: Dict[str, Any]) -> None:
        """
        Hydrate existing ContextWindow with session data (in-place).

        Use this when you already have a ContextWindow and want to add
        previous conversation context to it.

        Args:
            data: Dict from to_session_dict() or graphd context snapshot
        """
        # Add previously read files to dedup set
        for path in data.get("already_read", []):
            self._already_read.add(path)

        # Prepend previous turns to current turns
        previous_turns = data.get("turns", [])
        if previous_turns:
            self._turns = previous_turns + self._turns

        # Prepend previous tool history
        previous_tools = data.get("tool_history", [])
        if previous_tools:
            old_history = [
                ToolExchange(
                    call_id=ex.get("call_id", ""),
                    tool_name=ex.get("tool_name", ""),
                    arguments=ex.get("arguments", {}),
                    result_content=ex.get("result_content", ""),
                    success=ex.get("success", True),
                    error=ex.get("error"),
                )
                for ex in previous_tools
            ]
            self._tool_history = old_history + self._tool_history

        # Restore Responses API state if available
        if data.get("previous_response_id"):
            self._previous_response_id = data["previous_response_id"]
        if data.get("prompt_cache_key"):
            self._prompt_cache_key = data["prompt_cache_key"]

        # Update token count after hydration
        self._update_token_count()
