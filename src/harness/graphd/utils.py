"""Utility helpers for graphd."""

from __future__ import annotations

import hashlib
import os
from typing import Optional


def normalize_path(path: str, root: str) -> str:
    """Normalize paths to repo-relative, forward-slash format."""
    if not path:
        return ""
    root = os.path.abspath(root)
    if os.path.isabs(path):
        abs_path = os.path.abspath(path)
    else:
        abs_path = os.path.abspath(os.path.join(root, path))
    try:
        rel = os.path.relpath(abs_path, root)
    except ValueError:
        rel = abs_path
    return rel.replace(os.sep, "/")


def denormalize_path(path: str, root: str) -> str:
    """Convert repo-relative paths back to absolute paths."""
    if not path:
        return ""
    if os.path.isabs(path):
        return path
    root = os.path.abspath(root)
    return os.path.abspath(os.path.join(root, path))


def sha1_text(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def sha1_bytes(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


def make_symbol_id(path: str, kind: str, name: str, span_start: int, span_end: int) -> str:
    base = f"{path}:{kind}:{name}:{span_start}:{span_end}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def guess_language(path: str) -> str:
    _, ext = os.path.splitext(path.lower())
    if ext in {".py"}:
        return "python"
    if ext in {".js", ".jsx"}:
        return "javascript"
    if ext in {".ts", ".tsx"}:
        return "typescript"
    if ext in {".json"}:
        return "json"
    if ext in {".yml", ".yaml"}:
        return "yaml"
    if ext in {".toml"}:
        return "toml"
    if ext in {".md"}:
        return "markdown"
    return "unknown"


def is_test_path(path: str) -> bool:
    path_lower = path.replace("\\", "/").lower()
    if "/tests/" in path_lower or path_lower.startswith("tests/"):
        return True
    base = os.path.basename(path_lower)
    return base.startswith("test_") or base.endswith("_test.py") or base.endswith("_spec.py")


def safe_int(value: Optional[str], default: int = 0) -> int:
    try:
        return int(value) if value is not None else default
    except ValueError:
        return default
