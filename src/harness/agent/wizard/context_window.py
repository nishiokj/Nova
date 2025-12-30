"""
ContextWindow: Literal LLM context window.

This module defines the minimal, transparent representation of the context
we send to the LLM. It contains ONLY messages (system/user/assistant/tool).
All metadata (dedup, cache keys, read tracking) lives outside this class.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple


@dataclass(frozen=True)
class SystemPrompt:
    """
    Structured system-level instructions.
    Rendered to a system message content string.
    """

    goal: str
    step_num: int
    objective: str
    role: str = "You are a Worker executing a bounded work item."
    constraints: List[str] = field(default_factory=list)
    tool_hint: Optional[str] = None

    def render(self) -> str:
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


@dataclass(frozen=True)
class BehavioralRules:
    """
    Behavioral rules for the Worker.
    Loaded from a .md file. No fallback - the .md file is required.
    """

    content: str = ""

    @classmethod
    def from_file(cls, path: str) -> "BehavioralRules":
        with open(path, "r") as f:
            return cls(content=f.read())

    @classmethod
    def default(cls) -> "BehavioralRules":
        package_dir = Path(__file__).parent
        default_path = package_dir / "behavioral_rules.md"
        if not default_path.exists():
            raise FileNotFoundError(
                f"Required behavioral_rules.md not found at {default_path}. "
                "This file must be included in the wizard package."
            )
        return cls.from_file(str(default_path))

    def render(self) -> str:
        return self.content


class ContextWindow:
    """
    Read-only container for literal LLM messages.

    This object is immutable by convention; callers should treat it as read-only.
    """

    def __init__(self, messages: Sequence[Dict[str, Any]]):
        self._messages = list(messages)

    @property
    def messages(self) -> Tuple[Dict[str, Any], ...]:
        return tuple(self._messages)

    def to_messages(self) -> List[Dict[str, Any]]:
        return list(self._messages)

    def __len__(self) -> int:
        return len(self._messages)

    def __repr__(self) -> str:
        return f"ContextWindow(messages={len(self._messages)})"


@dataclass
class ContextDelta:
    """
    Mutable context additions produced during Worker execution.

    The Worker appends messages here; Wizard merges persistable messages into
    the shared session context after execution.
    """

    messages: List[Dict[str, Any]] = field(default_factory=list)
    read_files: Set[str] = field(default_factory=set)

    def add_message(self, message: Dict[str, Any]) -> None:
        self.messages.append(message)

    def extend_messages(self, messages: Iterable[Dict[str, Any]]) -> None:
        self.messages.extend(messages)

    def merged_messages(
        self,
        base: ContextWindow,
        system_suffix: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        merged = list(base.messages)
        merged.extend(self.messages)
        if system_suffix:
            merged = _apply_system_suffix(merged, system_suffix)
        return merged


@dataclass
class SessionContext:
    """
    Persisted session context and meta state.

    messages:
        Conversation + tool messages (no system message). These are persisted verbatim.
    read_files:
        Dedup metadata for file reads (not part of LLM context).
    prompt_cache_id:
        Meta for LLM prompt caching (stable id used to build prompt_cache_key).
    """

    messages: List[Dict[str, Any]] = field(default_factory=list)
    read_files: Set[str] = field(default_factory=set)
    prompt_cache_id: Optional[str] = None

    def add_message(self, message: Dict[str, Any]) -> None:
        self.messages.append(message)

    def extend_messages(self, messages: Iterable[Dict[str, Any]]) -> None:
        self.messages.extend(messages)

    def to_session_dict(self) -> Dict[str, Any]:
        return {
            "version": "2.0",
            "messages": self.messages,
            "read_files": list(self.read_files),
            "prompt_cache_id": self.prompt_cache_id,
        }

    @classmethod
    def from_session_dict(cls, data: Dict[str, Any]) -> "SessionContext":
        return cls(
            messages=list(data.get("messages", [])),
            read_files=set(data.get("read_files", [])),
            prompt_cache_id=data.get("prompt_cache_id"),
        )


def build_system_message(
    system_prompt: SystemPrompt,
    behavioral_rules: BehavioralRules,
) -> Dict[str, Any]:
    content = system_prompt.render()
    rules_content = behavioral_rules.render()
    if rules_content:
        content = f"{content}\n\n{rules_content}"
    return {"role": "system", "content": content}


def build_files_message(files: Sequence[Tuple[str, str]]) -> Optional[Dict[str, Any]]:
    if not files:
        return None

    lines: List[str] = [
        "FILES (pre-loaded, authoritative - do NOT re-read):",
        "",
    ]

    for path, content in files:
        lines.append(f"### {path}")
        lines.append("```")
        lines.append(content)
        lines.append("```")
        lines.append("")

    lines.append("Do NOT call file_read on these paths.")

    return {"role": "user", "content": "\n".join(lines)}


def filter_persistable_messages(
    messages: Iterable[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    persistable: List[Dict[str, Any]] = []
    for msg in messages:
        if msg.get("role") == "system":
            continue
        if msg.get("_internal"):
            continue
        persistable.append(msg)
    return persistable


def _apply_system_suffix(
    messages: List[Dict[str, Any]],
    suffix: str,
) -> List[Dict[str, Any]]:
    if not messages:
        return [{"role": "system", "content": suffix}]

    first = messages[0]
    if first.get("role") == "system":
        updated = dict(first)
        base_content = updated.get("content", "")
        updated["content"] = f"{base_content}\n\n{suffix}".strip()
        return [updated] + messages[1:]

    return [{"role": "system", "content": suffix}] + messages
