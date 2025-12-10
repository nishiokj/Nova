"""
Judge configuration helpers for eval scripts.

Loads the shared JSON config so run_eval and other tooling can stay aligned
with the curated judge list instead of hardcoding a single model.
"""

import copy
import json
from pathlib import Path
from typing import Dict, Any

JUDGE_CONFIG_PATH = Path(__file__).parent / "configs" / "judge_config.json"


def _load_raw_config() -> Dict[str, Any]:
    """Read the raw JSON once per call."""
    with open(JUDGE_CONFIG_PATH, "r") as f:
        return json.load(f)


def list_available_judges() -> Dict[str, Dict[str, Any]]:
    """
    Return all judge configs keyed by their canonical name.

    Includes the top-level `default_judge` plus every entry under
    `alternative_judges`.
    """
    data = _load_raw_config()
    configs: Dict[str, Dict[str, Any]] = {}

    default_cfg = data.get("default_judge")
    if isinstance(default_cfg, dict):
        configs["default_judge"] = copy.deepcopy(default_cfg)

    alternatives = data.get("alternative_judges")
    if isinstance(alternatives, dict):
        for name, cfg in alternatives.items():
            if isinstance(cfg, dict):
                configs[name] = copy.deepcopy(cfg)

    return configs


def load_judge_config(config_name: str = "default_judge") -> Dict[str, Any]:
    """
    Return the judge config for the given name.

    Raises:
        ValueError: if the requested config is not defined.
    """
    configs = list_available_judges()

    if config_name not in configs:
        available = ", ".join(configs.keys()) or "<none>"
        raise ValueError(f"Judge config not found: {config_name}. Available: {available}")

    return copy.deepcopy(configs[config_name])
