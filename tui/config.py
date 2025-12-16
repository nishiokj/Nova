"""TUI configuration loader and defaults.

Features:
- Loads defaults, then merges values from a config file and environment variables.
- Config file location follows XDG spec: $XDG_CONFIG_HOME/tui/config.json or ~/.config/tui/config.json
- Minimal, dependency-free JSON format for the config file.
- Exposes a simple get() API and helpers to save/update config programmatically.
- Provides helpers to apply CLI-parsed overrides (e.g., argparse.Namespace or dict).

Supported keys (defaults shown):
- log_level: "INFO"  # one of CRITICAL/ERROR/WARNING/INFO/DEBUG
- color: "auto"      # "auto"/"always"/"never"
- enable_file_logging: null  # None means auto-detect (non-interactive => True)
- keybindings: {}     # mapping of action -> key (strings)

Environment variables that override config file (all optional):
- TUI_LOG_LEVEL
- TUI_COLOR
- TUI_ENABLE_FILE_LOGGING (1/0/true/false)
- TUI_KEYBINDINGS (JSON string mapping actions to keys)

Example config file (JSON):
{
  "log_level": "DEBUG",
  "color": "always",
  "enable_file_logging": true,
  "keybindings": {
    "quit": "q",
    "help": "?",
    "next": "j",
    "prev": "k"
  }
}

This module is intentionally conservative: reading the config will never raise
on malformed user files -- errors are logged to stderr and defaults are used.
"""
from __future__ import annotations

import json
import os
import sys
import typing
from typing import Any, Dict, Optional

# Public API: load(), get(), save(), apply_cli_args(), update()

_DEFAULTS: Dict[str, Any] = {
    "log_level": "INFO",
    "color": "auto",  # auto/always/never
    "enable_file_logging": None,  # None = auto-detect
    "keybindings": {
        "quit": "q",
        "help": "?",
        "next": "j",
        "prev": "k",
    },
}

_CONFIG: Dict[str, Any] = {}
_config_loaded = False


def _config_paths() -> list[str]:
    """Return candidate config file paths to inspect (in priority order).

    Priority: XDG_CONFIG_HOME -> ~/.config
    """
    paths = []
    try:
        xdg = os.environ.get("XDG_CONFIG_HOME")
        if xdg:
            paths.append(os.path.join(xdg, "tui", "config.json"))
        home = os.path.expanduser("~")
        paths.append(os.path.join(home, ".config", "tui", "config.json"))
    except Exception:
        # Fall back to current directory
        paths.append(os.path.join(os.getcwd(), "tui-config.json"))
    return paths


def _read_json_file(path: str) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None
    except Exception:
        # Don't raise on malformed files; write a short note to stderr.
        try:
            sys.stderr.write(f"TUI: failed to read config file {path}\n")
        except Exception:
            pass
        return None


def _parse_bool(val: typing.Any) -> Optional[bool]:
    if val is None:
        return None
    if isinstance(val, bool):
        return val
    s = str(val).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    return None


def _parse_env_keybindings() -> Optional[dict]:
    s = os.environ.get("TUI_KEYBINDINGS")
    if not s:
        return None
    try:
        data = json.loads(s)
        if isinstance(data, dict):
            return data
    except Exception:
        try:
            sys.stderr.write("TUI: TUI_KEYBINDINGS is not valid JSON\n")
        except Exception:
            pass
    return None


def _merge_dict(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            out[k] = _merge_dict(base.get(k, {}), v)
        else:
            out[k] = v
    return out


def load() -> Dict[str, Any]:
    """Load configuration into module-level storage and return it.

    Merge order (lowest -> highest priority): defaults, config file, environment variables.
    """
    global _CONFIG, _config_loaded
    if _config_loaded:
        return _CONFIG

    cfg: Dict[str, Any] = dict(_DEFAULTS)

    # Try config files in order
    for p in _config_paths():
        data = _read_json_file(p)
        if data and isinstance(data, dict):
            cfg = _merge_dict(cfg, data)
            break

    # Environment overrides
    lvl = os.environ.get("TUI_LOG_LEVEL")
    if lvl:
        cfg["log_level"] = lvl

    color = os.environ.get("TUI_COLOR")
    if color:
        cfg["color"] = color

    efl = os.environ.get("TUI_ENABLE_FILE_LOGGING")
    b = _parse_bool(efl)
    if b is not None:
        cfg["enable_file_logging"] = b

    kb = _parse_env_keybindings()
    if kb is not None:
        # Merge keybindings into defaults
        cfg["keybindings"] = _merge_dict(cfg.get("keybindings", {}), kb)

    # Ensure types and defaults are sane
    try:
        # normalize log level
        cfg["log_level"] = str(cfg.get("log_level", "INFO")).upper()
    except Exception:
        cfg["log_level"] = "INFO"
    try:
        cfg["color"] = str(cfg.get("color", "auto"))
    except Exception:
        cfg["color"] = "auto"
    # keybindings must be a dict
    if not isinstance(cfg.get("keybindings"), dict):
        cfg["keybindings"] = dict(_DEFAULTS["keybindings"])

    _CONFIG = cfg
    _config_loaded = True
    return _CONFIG


def get(key: str, default: Any = None) -> Any:
    """Return a configuration value, loading config lazily if needed."""
    if not _config_loaded:
        load()
    return _CONFIG.get(key, default)


def update(updates: Dict[str, Any], save_to_file: Optional[str] = None) -> None:
    """Update the in-memory config and optionally persist to the active config file.

    This does not affect environment variables. save_to_file may be a path
    to write the merged configuration (creates parent directories if needed).
    """
    global _CONFIG, _config_loaded
    if not _config_loaded:
        load()
    _CONFIG = _merge_dict(_CONFIG, updates)
    _config_loaded = True
    if save_to_file:
        try:
            parent = os.path.dirname(save_to_file)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(save_to_file, "w", encoding="utf-8") as fh:
                json.dump(_CONFIG, fh, ensure_ascii=False, indent=2)
        except Exception:
            try:
                sys.stderr.write(f"TUI: failed to save config to {save_to_file}\n")
            except Exception:
                pass


def apply_cli_args(args: typing.Union[Dict[str, Any], typing.Any]) -> None:
    """Apply CLI-style overrides to the loaded config.

    Accepts either a dict or an object with attributes (like argparse.Namespace).
    Expected keys/attrs: log_level, color, enable_file_logging, keybindings (dict)
    """
    overrides: Dict[str, Any] = {}
    if isinstance(args, dict):
        overrides = args
    else:
        # try attribute access
        for name in ("log_level", "color", "enable_file_logging", "keybindings"):
            if hasattr(args, name):
                val = getattr(args, name)
                if val is not None:
                    overrides[name] = val
    if not overrides:
        return
    # Normalize enable_file_logging booleans
    if "enable_file_logging" in overrides:
        parsed = _parse_bool(overrides["enable_file_logging"])
        if parsed is not None:
            overrides["enable_file_logging"] = parsed
    update(overrides)


def save(path: Optional[str] = None) -> None:
    """Save current config to a file. If path is None, use the first candidate path.

    This will attempt to create parent directories.
    """
    if not _config_loaded:
        load()
    if path is None:
        paths = _config_paths()
        path = paths[-1]
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(_CONFIG, fh, ensure_ascii=False, indent=2)
    except Exception:
        try:
            sys.stderr.write(f"TUI: failed to write config to {path}\n")
        except Exception:
            pass


# Lightweight convenience function for consumers that just want common options.
def defaults_for_logging() -> Dict[str, Any]:
    """Return a subset of config relevant to logging: log_level and enable_file_logging."""
    return {"log_level": get("log_level", "INFO"), "enable_file_logging": get("enable_file_logging")}


# Auto-load config at import time to make simple use-cases straightforward.
try:
    load()
except Exception:
    try:
        sys.stderr.write("TUI: config.load() failed at import time\n")
    except Exception:
        pass
