from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from pydantic import ValidationError

from util.logger import StructuredLogger
from .models import SkillDefinition


def _now_rfc3339() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


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

    def _path_for(self, skill_id: str) -> Path:
        return self.base_dir / f"{skill_id}.json"

    def _load_file(self, path: Path) -> SkillDefinition:
        try:
            with path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
        except json.JSONDecodeError as exc:
            raise StoreError("Invalid JSON", details=[{"loc": ["json"], "msg": str(exc), "type": "json_decode"}]) from exc

        try:
            return SkillDefinition.model_validate(data)
        except ValidationError as exc:
            raise StoreError("Skill schema validation failed", details=_format_validation_errors(exc)) from exc

    def list(self) -> StoreListResult:
        items: List[SkillDefinition] = []
        errors: List[Dict[str, Any]] = []
        for path in sorted(self.base_dir.glob("*.json")):
            try:
                items.append(self._load_file(path))
            except StoreError as exc:
                errors.append({"path": str(path), "errors": exc.details, "message": str(exc)})
        return StoreListResult(items=items, errors=errors)

    def get(self, skill_id: str) -> SkillDefinition:
        path = self._path_for(skill_id)
        if not path.exists():
            raise StoreError(f"Skill '{skill_id}' not found", details=[{"loc": ["id"], "msg": "not found"}])
        return self._load_file(path)

    def create(self, definition: Union[SkillDefinition, Dict[str, Any]]) -> SkillDefinition:
        data = definition.model_dump() if isinstance(definition, SkillDefinition) else dict(definition)
        if "created_at" not in data:
            data["created_at"] = _now_rfc3339()
        if "updated_at" not in data:
            data["updated_at"] = data["created_at"]

        try:
            skill = SkillDefinition.model_validate(data)
        except ValidationError as exc:
            raise StoreError("Skill schema validation failed", details=_format_validation_errors(exc)) from exc

        path = self._path_for(skill.id)
        if path.exists():
            raise StoreError(f"Skill '{skill.id}' already exists", details=[{"loc": ["id"], "msg": "already exists"}])

        self._atomic_write(path, skill.model_dump())
        return skill

    def update(self, skill_id: str, definition: Union[SkillDefinition, Dict[str, Any]]) -> SkillDefinition:
        existing = self.get(skill_id)
        data = definition.model_dump() if isinstance(definition, SkillDefinition) else dict(definition)

        if data.get("id") and data["id"] != skill_id:
            raise StoreError("Skill id mismatch", details=[{"loc": ["id"], "msg": "does not match path id"}])

        data["id"] = skill_id
        data["created_at"] = existing.created_at
        data["updated_at"] = _now_rfc3339()

        try:
            skill = SkillDefinition.model_validate(data)
        except ValidationError as exc:
            raise StoreError("Skill schema validation failed", details=_format_validation_errors(exc)) from exc

        path = self._path_for(skill_id)
        self._atomic_write(path, skill.model_dump())
        return skill

    def delete(self, skill_id: str) -> bool:
        path = self._path_for(skill_id)
        if not path.exists():
            return False
        path.unlink()
        return True

    def _atomic_write(self, path: Path, payload: Dict[str, Any]) -> None:
        temp_dir = path.parent
        fd, tmp_path = tempfile.mkstemp(prefix=path.stem, suffix=".tmp", dir=temp_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, ensure_ascii=True)
            os.replace(tmp_path, path)
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
