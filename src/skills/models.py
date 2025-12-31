from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")


def _parse_rfc3339(value: str) -> None:
    if not isinstance(value, str):
        raise ValueError("timestamp must be a string")
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError("timestamp must be RFC3339") from exc


class TriggerDefinition(BaseModel):
    type: Literal["regex", "keyword", "semantic"]
    pattern: Optional[str] = None
    keywords: Optional[List[str]] = None
    threshold: Optional[float] = None
    description: Optional[str] = None

    @model_validator(mode="after")
    def validate_trigger(self) -> "TriggerDefinition":
        if self.type == "regex":
            if not self.pattern:
                raise ValueError("regex trigger requires pattern")
            try:
                re.compile(self.pattern)
            except re.error as exc:
                raise ValueError(f"invalid regex pattern: {exc}") from exc
        elif self.type == "keyword":
            if not self.keywords:
                raise ValueError("keyword trigger requires keywords")
            self.keywords = [kw for kw in self.keywords if kw]
            if not self.keywords:
                raise ValueError("keyword trigger requires non-empty keywords")
        elif self.type == "semantic":
            if not self.description:
                raise ValueError("semantic trigger requires description")
        return self


class SkillStep(BaseModel):
    name: str
    tool: str
    args: Dict[str, Any] = Field(default_factory=dict)


class ToolStep(BaseModel):
    name: str
    tool: str
    args: Dict[str, Any] = Field(default_factory=dict)


class SkillDefinition(BaseModel):
    id: str = Field(pattern=ID_PATTERN.pattern)
    name: str
    description: str
    version: str
    type: Literal["workflow", "tool_chain"]
    triggers: List[TriggerDefinition]
    input_schema: Dict[str, Any]
    output_schema: Optional[Dict[str, Any]] = None
    steps: Optional[List[SkillStep]] = None
    tool_chain: Optional[List[ToolStep]] = None
    allowed_tools: List[str]
    timeout_ms: int = 30000
    enabled: bool = True
    tags: List[str] = Field(default_factory=list)
    created_at: str
    updated_at: str

    @field_validator("created_at", "updated_at")
    @classmethod
    def validate_timestamps(cls, value: str) -> str:
        _parse_rfc3339(value)
        return value

    @field_validator("input_schema")
    @classmethod
    def validate_input_schema(cls, value: Dict[str, Any]) -> Dict[str, Any]:
        if value.get("type") != "object":
            raise ValueError("input_schema must be type object")
        return value

    @field_validator("allowed_tools")
    @classmethod
    def validate_allowed_tools(cls, value: List[str]) -> List[str]:
        if not value:
            raise ValueError("allowed_tools must not be empty")
        if "*" in value and len(value) > 1:
            raise ValueError("allowed_tools cannot mix '*' with explicit tools")
        return value

    @model_validator(mode="after")
    def validate_steps(self) -> "SkillDefinition":
        if not self.triggers:
            raise ValueError("skill requires at least one trigger")
        if self.type == "workflow":
            if not self.steps:
                raise ValueError("workflow skills require steps")
            if self.tool_chain:
                raise ValueError("workflow skills must not include tool_chain")
        elif self.type == "tool_chain":
            if not self.tool_chain:
                raise ValueError("tool_chain skills require tool_chain")
            if self.steps:
                raise ValueError("tool_chain skills must not include steps")
        return self
