"""
Context Section Definitions - Explicit section taxonomy for context management.

This module defines the 8 explicit sections that make up a context window:

STATIC (rarely changes):
- SYSTEM_CORE: Core principles, persona, formatting rules

VERSIONED (change tracked by hash):
- TOOL_MANIFEST: Tool schemas, versioned by content hash

SEMI-STATIC (changes infrequently):
- USER_RULES: User preferences and rules
- WORKING_MEMORY: Discovered facts with provenance
- TOOL_TRACE_SUMMARY: Recent execution history

DYNAMIC (changes every request):
- EXECUTION_CONTRACT: Runtime behavior constraints
- ARTIFACTS: Large content stored with addressable handles
- FILESYSTEM_CONTEXT: Current working directory context

EPHEMERAL (never cached):
- USER_REQUEST: Current user input
"""

from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, Any, Dict, List


class ContextSection(Enum):
    """
    Explicit taxonomy of context sections.

    Each section has different lifecycle, caching, and budget characteristics.
    Order matters for serialization (typically static → dynamic).
    """

    # === STATIC (rarely changes) ===
    SYSTEM_CORE = "system_core"
    """Core system instructions: principles, persona, formatting, safety."""

    # === VERSIONED (change tracked by hash) ===
    TOOL_MANIFEST = "tool_manifest"
    """Tool definitions, versioned by content hash."""

    # === SEMI-STATIC (changes infrequently) ===
    USER_RULES = "user_rules"
    """User preferences and custom rules."""

    WORKING_MEMORY = "working_memory"
    """Structured discovered facts with provenance."""

    TOOL_TRACE_SUMMARY = "tool_trace"
    """Recent execution history to prevent re-discovery."""

    # === DYNAMIC (changes every request) ===
    EXECUTION_CONTRACT = "exec_contract"
    """Runtime constraints: budgets, tier behavior, allowed operations."""

    ARTIFACTS = "artifacts"
    """Large content stored as addressable artifacts (artifact://id)."""

    FILESYSTEM_CONTEXT = "filesystem"
    """Current working directory context with deterministic injection."""

    # === EPHEMERAL (never cached) ===
    USER_REQUEST = "user_request"
    """Current user input - always fresh."""

    @property
    def is_cacheable(self) -> bool:
        """Whether this section supports caching."""
        return self not in {
            ContextSection.EXECUTION_CONTRACT,
            ContextSection.USER_REQUEST
        }

    @property
    def cache_category(self) -> str:
        """Cache category for grouping."""
        if self == ContextSection.SYSTEM_CORE:
            return "static"
        elif self == ContextSection.TOOL_MANIFEST:
            return "versioned"
        elif self in {ContextSection.USER_RULES, ContextSection.WORKING_MEMORY, ContextSection.TOOL_TRACE_SUMMARY}:
            return "semi-static"
        elif self in {ContextSection.ARTIFACTS, ContextSection.FILESYSTEM_CONTEXT}:
            return "dynamic"
        else:
            return "ephemeral"


@dataclass
class SystemCoreSection:
    """
    Core system instructions - changes very rarely.

    This section defines the agent's fundamental behavior, voice, and constraints.
    Highly cacheable due to stability.
    """
    principles: str
    """Core behavioral principles (e.g., 'You are a helpful assistant...')"""

    formatting_rules: str
    """Output format expectations"""

    safety_guidelines: str
    """What to refuse or flag"""

    persona: str = ""
    """Voice and style characteristics"""

    cache_control: str = "ephemeral"
    """Cache control strategy"""

    cache_ttl_seconds: int = 3600
    """Cache TTL (1 hour default)"""

    content_hash: str = ""
    """SHA256 hash for cache validation"""

    def to_text(self) -> str:
        """Render as text for LLM context."""
        parts = [
            "# System Core Instructions\n",
            f"## Principles\n{self.principles}\n",
            f"## Formatting Rules\n{self.formatting_rules}\n",
        ]
        if self.safety_guidelines:
            parts.append(f"## Safety Guidelines\n{self.safety_guidelines}\n")
        if self.persona:
            parts.append(f"## Persona\n{self.persona}\n")
        return "\n".join(parts)


@dataclass
class ToolManifestSection:
    """
    Tool definitions - versioned by content hash.

    Tools change by tier, runtime config, and enabled connectors.
    Never cache with system core - cache separately with version.
    """
    tools: List[Any]  # List[ToolDefinition]
    """Tool definitions for this execution"""

    manifest_version: str = ""
    """SHA256 hash of canonical tool schemas"""

    tier: str = "standard"
    """Agent tier these tools are for"""

    enabled_connectors: List[str] = field(default_factory=list)
    """Enabled connector names"""

    cache_control: str = "ephemeral"
    """Cache control strategy"""

    cache_key: str = ""
    """Unique cache key: tools-{version}-{tier}"""

    def to_text(self) -> str:
        """Render as text for LLM context."""
        return f"# Tool Manifest (v{self.manifest_version[:8]})\n\n" + \
               f"Available tools: {len(self.tools)}\n" + \
               f"Tier: {self.tier}\n"


@dataclass
class ExecutionContractSection:
    """
    Runtime behavior expectations - changes per request.

    Defines the constraints and budgets for this specific execution.
    Not cached - always fresh.
    """
    tier: str
    """Agent tier (e.g., 'standard', 'advanced')"""

    max_tool_calls: int
    """Maximum tool executions allowed"""

    max_steps: int
    """Maximum reasoning steps"""

    max_tokens_available: int
    """Token budget for response"""

    timeout_ms: int
    """Execution timeout in milliseconds"""

    allowed_operations: List[str] = field(default_factory=list)
    """Allowed operation types (e.g., ['bash', 'file_write', 'web_search'])"""

    def to_text(self) -> str:
        """Render as text for LLM context."""
        return f"""# Execution Contract

Tier: {self.tier}
Max tool calls: {self.max_tool_calls}
Max steps: {self.max_steps}
Token budget: {self.max_tokens_available}
Timeout: {self.timeout_ms}ms
Allowed operations: {', '.join(self.allowed_operations)}
"""


@dataclass
class UserRulesSection:
    """
    User preferences and custom rules.

    Semi-static section that changes infrequently.
    Cacheable with moderate TTL.
    """
    rules: List[str] = field(default_factory=list)
    """List of user-defined rules"""

    preferences: Dict[str, Any] = field(default_factory=dict)
    """User preferences (e.g., {'language': 'python', 'style': 'concise'})"""

    def to_text(self) -> str:
        """Render as text for LLM context."""
        if not self.rules and not self.preferences:
            return ""

        parts = ["# User Rules and Preferences\n"]

        if self.rules:
            parts.append("## Rules")
            for rule in self.rules:
                parts.append(f"- {rule}")
            parts.append("")

        if self.preferences:
            parts.append("## Preferences")
            for key, value in self.preferences.items():
                parts.append(f"- {key}: {value}")

        return "\n".join(parts)


# Additional section dataclasses will be defined in separate modules
# to keep each focused and explicit:
# - WorkingMemorySection -> state.py (structured facts)
# - ToolTraceSummarySection -> trace.py (execution history)
# - ArtifactsSection -> artifacts.py (addressable content)
# - FilesystemContextSection -> filesystem.py (deterministic injection)
# - UserRequestSection -> build.py (current input)
