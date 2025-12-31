from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from util.logger import StructuredLogger
from .models import SkillDefinition
from .store import SkillStore


@dataclass
class RegistrySnapshot:
    files: Dict[str, float]


class SkillRegistry:
    def __init__(self, store: SkillStore, logger: Optional[StructuredLogger] = None):
        self.store = store
        self.logger = logger or StructuredLogger()
        self._skills: Dict[str, SkillDefinition] = {}
        self._snapshot = RegistrySnapshot(files={})

    def _scan_files(self) -> Dict[str, float]:
        snapshot: Dict[str, float] = {}
        for path in self.store.base_dir.glob("*.json"):
            try:
                snapshot[str(path)] = path.stat().st_mtime
            except OSError:
                continue
        return snapshot

    def reload_if_needed(self) -> bool:
        current = self._scan_files()
        if current == self._snapshot.files:
            return False

        result = self.store.list()
        if result.errors:
            for err in result.errors:
                self.logger.warning(
                    f"Skill load error: {err.get('message')}",
                    component="skills",
                    data={"path": err.get("path"), "errors": err.get("errors")},
                )

        self._skills = {skill.id: skill for skill in result.items}
        self._snapshot = RegistrySnapshot(files=current)
        return True

    def list_enabled(self) -> List[SkillDefinition]:
        self.reload_if_needed()
        return [skill for skill in self._skills.values() if skill.enabled]

    def get(self, skill_id: str) -> Optional[SkillDefinition]:
        self.reload_if_needed()
        return self._skills.get(skill_id)
