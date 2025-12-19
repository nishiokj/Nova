"""
Prompt templates for the agent Plan → Execute → Reflect components.
"""

from typing import Any, Dict


def _load_prompt_config() -> Dict[str, Any]:
    """Load prompt config from disk."""
    import json
    from pathlib import Path

    # Path: prompts.py -> agent/ -> harness/ -> src/ -> project_root/ -> config/
    config_path = Path(__file__).parent.parent.parent.parent / "config" / "prompts_config.json"
    try:
        with open(config_path, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def _select_prompt(
    stage_prompts: Dict[str, Any],
    planner_prompts: Dict[str, Any],
    keys: list
) -> str:
    for key in keys:
        value = stage_prompts.get(key)
        if isinstance(value, str) and value.strip():
            return value
        value = planner_prompts.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


class _SafeFormatDict(dict):
    def __missing__(self, key: str) -> str:
        return ""


def format_prompt(template: str, **kwargs: Any) -> str:
    """Safely format a prompt template without raising on missing keys."""
    if not template:
        return ""
    try:
        return template.format_map(_SafeFormatDict(kwargs))
    except Exception:
        return template


_PROMPT_CONFIG = _load_prompt_config()
_PLANNER_PROMPTS = _PROMPT_CONFIG.get("planner_prompts", {}) if isinstance(_PROMPT_CONFIG, dict) else {}
_STAGE_PROMPTS = _PROMPT_CONFIG.get("stage_prompts", {}) if isinstance(_PROMPT_CONFIG, dict) else {}
if not _STAGE_PROMPTS:
    _STAGE_PROMPTS = _PROMPT_CONFIG.get("agent_stage_prompts", {}) if isinstance(_PROMPT_CONFIG, dict) else {}

PLANNING_PROMPT = _select_prompt(_STAGE_PROMPTS, _PLANNER_PROMPTS, ["planning", "plan"])
EXECUTION_STEP_PROMPT = _select_prompt(
    _STAGE_PROMPTS,
    _PLANNER_PROMPTS,
    ["execution_step", "execution", "step"]
)
SYNTHESIS_PROMPT = _select_prompt(
    _STAGE_PROMPTS,
    _PLANNER_PROMPTS,
    ["synthesis", "synthesis_prompt", "summary"]
)
REFLECTION_PROMPT = _select_prompt(_STAGE_PROMPTS, _PLANNER_PROMPTS, ["reflection", "reflect"])


__all__ = [
    "PLANNING_PROMPT",
    "EXECUTION_STEP_PROMPT",
    "SYNTHESIS_PROMPT",
    "REFLECTION_PROMPT",
    "format_prompt",
]
