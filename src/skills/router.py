from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional, Tuple

from util.config import SkillsConfig, LLMConfig
from util.logger import StructuredLogger
from util.llm_adapter import Message, MessageRole, create_adapter
from .models import SkillDefinition, TriggerDefinition
from .registry import SkillRegistry


@dataclass
class SkillMatch:
    skill: SkillDefinition
    score: float
    trigger_type: str
    trigger: TriggerDefinition


class SkillRouter:
    def __init__(
        self,
        registry: SkillRegistry,
        config: SkillsConfig,
        logger: Optional[StructuredLogger] = None,
        semantic_llm_config: Optional[LLMConfig] = None,
    ):
        self.registry = registry
        self.config = config
        self.logger = logger or StructuredLogger()
        self._semantic_adapter = None
        if config.semantic_enabled and semantic_llm_config:
            self._semantic_adapter = create_adapter(semantic_llm_config, logger=self.logger)

    def route(self, text: str, tier: str, session_key: Optional[str]) -> Optional[SkillMatch]:
        if not self.config.enabled:
            return None

        skills = sorted(self.registry.list_enabled(), key=lambda s: s.id)
        if not skills:
            return None

        regex_matches = self._match_regex(skills, text)
        if regex_matches:
            return self._select_match(regex_matches)

        keyword_matches = self._match_keywords(skills, text)
        if keyword_matches:
            return self._select_match(keyword_matches)

        if self.config.semantic_enabled:
            semantic_match = self._match_semantic(skills, text)
            if semantic_match:
                return semantic_match

        return None

    def _select_match(self, matches: List[SkillMatch]) -> SkillMatch:
        if self.config.match_policy == "first_match":
            return matches[0]
        best = max(matches, key=lambda m: m.score)
        return best

    def _match_regex(self, skills: List[SkillDefinition], text: str) -> List[SkillMatch]:
        matches: List[SkillMatch] = []
        for skill in skills:
            for trigger in skill.triggers:
                if trigger.type != "regex" or not trigger.pattern:
                    continue
                if re.search(trigger.pattern, text):
                    matches.append(SkillMatch(skill=skill, score=1.0, trigger_type="regex", trigger=trigger))
        return matches

    def _match_keywords(self, skills: List[SkillDefinition], text: str) -> List[SkillMatch]:
        matches: List[SkillMatch] = []
        text_lower = text.lower()
        for skill in skills:
            for trigger in skill.triggers:
                if trigger.type != "keyword" or not trigger.keywords:
                    continue
                keywords = [kw.lower() for kw in trigger.keywords]
                matched = [kw for kw in keywords if kw in text_lower]
                if matched:
                    score = len(matched) / max(len(keywords), 1)
                    matches.append(SkillMatch(skill=skill, score=score, trigger_type="keyword", trigger=trigger))
        return matches

    def _match_semantic(self, skills: List[SkillDefinition], text: str) -> Optional[SkillMatch]:
        if not self._semantic_adapter:
            return None

        candidates: List[Tuple[SkillDefinition, TriggerDefinition]] = []
        for skill in skills:
            for trigger in skill.triggers:
                if trigger.type == "semantic":
                    candidates.append((skill, trigger))
                    break

        if not candidates:
            return None

        limited = candidates[: self.config.max_candidates]
        listing_lines = []
        for skill, trigger in limited:
            hint = trigger.description or skill.description
            listing_lines.append(
                f"- id: {skill.id}\n  name: {skill.name}\n  description: {skill.description}\n  hint: {hint}"
            )

        min_conf = self.config.semantic_min_confidence
        system_prompt = (
            "You are a skill router. Choose the best matching skill id for the user input.\n"
            f"Only respond with a skill id if you are at least {min_conf:.2f} confident.\n"
            "Otherwise respond with: none\n"
            "Respond with only the id or 'none'."
        )
        user_prompt = "User input:\n" + text + "\n\nSkills:\n" + "\n".join(listing_lines)

        try:
            messages = [
                Message(role=MessageRole.SYSTEM, content=system_prompt),
                Message(role=MessageRole.USER, content=user_prompt),
            ]
            response = self._semantic_adapter.complete(messages, temperature=0.0, max_tokens=20)
            selected = response.content.strip().strip('"').strip().lower()
        except Exception as exc:
            self.logger.error(f"Semantic skill routing failed: {exc}", component="skills")
            return None

        if not selected or selected == "none":
            return None

        for skill, trigger in limited:
            if skill.id.lower() == selected:
                return SkillMatch(skill=skill, score=1.0, trigger_type="semantic", trigger=trigger)

        return None
