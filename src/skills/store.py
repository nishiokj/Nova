from __future__ import annotations

import os
import re
import tempfile
import yaml
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from pydantic import ValidationError

from util.logger import StructuredLogger
from .models import SkillDefinition, TriggerDefinition

_ALLOWED_TOOL_ALIASES = {
    "read": "file_read",
    "write": "file_write",
    "bash": "bash_execute",
    "glob": "search_filesystem",
}


def _normalize_allowed_tools(tools: List[Any], logger: StructuredLogger) -> List[str]:
    normalized: List[str] = []
    for tool in tools:
        if not isinstance(tool, str):
            continue
        key = tool.strip()
        if not key:
            continue
        mapped = _ALLOWED_TOOL_ALIASES.get(key.lower(), key)
        normalized.append(mapped)
        if mapped != key:
            logger.warning(
                f"Normalized skill tool alias '{key}' to '{mapped}'",
                component="skills",
            )
    return normalized or ["*"]


def _now_rfc3339() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


FRONTMATTER_PATTERN = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def _parse_frontmatter(content: str) -> Tuple[Dict[str, Any], str]:
    """Parse YAML frontmatter from markdown content.

    Returns:
        Tuple of (frontmatter dict, body content)
    """
    match = FRONTMATTER_PATTERN.match(content)
    if not match:
        return {}, content

    frontmatter_text = match.group(1)
    body = content[match.end():]

    try:
        frontmatter = yaml.safe_load(frontmatter_text) or {}
    except yaml.YAMLError:
        frontmatter = {}

    return frontmatter, body.strip()


def _format_validation_errors(exc: ValidationError) -> List[Dict[str, Any]]:
    return [
        {"loc": list(err.get("loc", [])), "msg": err.get("msg"), "type": err.get("type")}
        for err in exc.errors()
    ]


@dataclass
class StoreListResult:
    items: List[SkillDefinition]
    errors: List[Dict[str, Any]] = field(default_factory=list)


class StoreError(Exception):
    def __init__(self, message: str, details: Optional[List[Dict[str, Any]]] = None):
        super().__init__(message)
        self.details = details or []


class SkillStore:
    def __init__(self, base_dir: str, logger: Optional[StructuredLogger] = None):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.logger = logger or StructuredLogger()

    def _load_skill_md(self, path: Path) -> SkillDefinition:
        """Load a SKILL.md file with YAML frontmatter + markdown body as instructions."""
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise StoreError(f"Failed to read {path}", details=[{"loc": ["file"], "msg": str(exc)}]) from exc

        frontmatter, body = _parse_frontmatter(content)

        # Derive skill ID from directory name
        skill_id = path.parent.name
        if not skill_id or skill_id == ".":
            skill_id = path.stem.lower().replace(" ", "-")

        # Build triggers from frontmatter
        triggers = []
        if "triggers" in frontmatter:
            for t in frontmatter["triggers"]:
                triggers.append(TriggerDefinition(**t))
        else:
            # Default semantic trigger using description
            description = frontmatter.get("description", f"Skill: {frontmatter.get('name', skill_id)}")
            triggers.append(TriggerDefinition(type="semantic", description=description))

        now = _now_rfc3339()
        allowed_tools = frontmatter.get("allowed_tools", frontmatter.get("allowed-tools", ["*"]))
        if not isinstance(allowed_tools, list):
            allowed_tools = [allowed_tools]
        allowed_tools = _normalize_allowed_tools(allowed_tools, self.logger)
        data = {
            "id": frontmatter.get("id", skill_id),
            "name": frontmatter.get("name", skill_id.replace("-", " ").title()),
            "description": frontmatter.get("description", ""),
            "version": frontmatter.get("version", "1.0.0"),
            "type": "instructions",
            "triggers": [t.model_dump() for t in triggers],
            "instructions": body,
            "allowed_tools": allowed_tools,
            "timeout_ms": frontmatter.get("timeout_ms", frontmatter.get("timeout-ms", 60000)),
            "enabled": frontmatter.get("enabled", True),
            "tags": frontmatter.get("tags", []),
            "created_at": now,
            "updated_at": now,
        }

        try:
            return SkillDefinition.model_validate(data)
        except ValidationError as exc:
            raise StoreError(f"SKILL.md validation failed: {path}", details=_format_validation_errors(exc)) from exc

    def list(self) -> StoreListResult:
        items: List[SkillDefinition] = []
        errors: List[Dict[str, Any]] = []
        seen_ids: set = set()

        # Load SKILL.md files from subdirectories (Claude Code format)
        for skill_md in sorted(self.base_dir.glob("*/SKILL.md")):
            try:
                skill = self._load_skill_md(skill_md)
                if skill.id not in seen_ids:
                    items.append(skill)
                    seen_ids.add(skill.id)
            except StoreError as exc:
                errors.append({"path": str(skill_md), "errors": exc.details, "message": str(exc)})

        return StoreListResult(items=items, errors=errors)

    def get(self, skill_id: str) -> SkillDefinition:
        skill_md_path = self.base_dir / skill_id / "SKILL.md"
        if skill_md_path.exists():
            return self._load_skill_md(skill_md_path)

        raise StoreError(f"Skill '{skill_id}' not found", details=[{"loc": ["id"], "msg": "not found"}])

    def create(self, definition: Union[SkillDefinition, Dict[str, Any]]) -> SkillDefinition:
        data = definition.model_dump() if isinstance(definition, SkillDefinition) else dict(definition)
        if "created_at" not in data:
            data["created_at"] = _now_rfc3339()
        if "updated_at" not in data:
            data["updated_at"] = data["created_at"]
        if "allowed_tools" in data:
            tools = data.get("allowed_tools") or []
            tools_list = tools if isinstance(tools, list) else [tools]
            data["allowed_tools"] = _normalize_allowed_tools(tools_list, self.logger)

        try:
            skill = SkillDefinition.model_validate(data)
        except ValidationError as exc:
            raise StoreError("Skill schema validation failed", details=_format_validation_errors(exc)) from exc

        path = self.base_dir / skill.id / "SKILL.md"
        if path.exists():
            raise StoreError(f"Skill '{skill.id}' already exists", details=[{"loc": ["id"], "msg": "already exists"}])

        self._atomic_write(path, _serialize_skill_md(skill))
        return skill

    def update(self, skill_id: str, definition: Union[SkillDefinition, Dict[str, Any]]) -> SkillDefinition:
        existing = self.get(skill_id)
        data = definition.model_dump() if isinstance(definition, SkillDefinition) else dict(definition)

        if data.get("id") and data["id"] != skill_id:
            raise StoreError("Skill id mismatch", details=[{"loc": ["id"], "msg": "does not match path id"}])

        data["id"] = skill_id
        data["created_at"] = existing.created_at
        data["updated_at"] = _now_rfc3339()
        if "allowed_tools" in data:
            tools = data.get("allowed_tools") or []
            tools_list = tools if isinstance(tools, list) else [tools]
            data["allowed_tools"] = _normalize_allowed_tools(tools_list, self.logger)

        try:
            skill = SkillDefinition.model_validate(data)
        except ValidationError as exc:
            raise StoreError("Skill schema validation failed", details=_format_validation_errors(exc)) from exc

        path = self.base_dir / skill_id / "SKILL.md"
        self._atomic_write(path, _serialize_skill_md(skill))
        return skill

    def delete(self, skill_id: str) -> bool:
        path = self.base_dir / skill_id / "SKILL.md"
        if not path.exists():
            return False
        path.unlink()
        try:
            path.parent.rmdir()
        except OSError:
            pass
        return True

    def _atomic_write(self, path: Path, payload: str) -> None:
        temp_dir = path.parent
        temp_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(prefix=path.stem, suffix=".tmp", dir=temp_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
            os.replace(tmp_path, path)
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)


def _serialize_skill_md(skill: SkillDefinition) -> str:
    frontmatter = {
        "id": skill.id,
        "name": skill.name,
        "description": skill.description,
        "version": skill.version,
        "allowed-tools": skill.allowed_tools,
        "triggers": [t.model_dump() for t in skill.triggers],
        "timeout-ms": skill.timeout_ms,
        "enabled": skill.enabled,
        "tags": skill.tags,
    }
    header = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=False).strip()
    body = (skill.instructions or "").strip()
    return f"---\n{header}\n---\n\n{body}\n"
