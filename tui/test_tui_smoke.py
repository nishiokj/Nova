"""Basic smoke tests for the TUI layer.

These tests focus on importability and very shallow execution of key entry
points to ensure the TUI does not crash immediately when invoked. They do not
attempt to drive the interactive flows fully (which would require a more
complex harness or snapshot testing).

To run:
    pytest tui/test_tui_smoke.py
"""

from __future__ import annotations

import builtins
import importlib
from types import SimpleNamespace
from typing import List


def test_import_main_module() -> None:
    """The main TUI module should be importable without side effects."""

    mod = importlib.import_module("tui.main")
    assert hasattr(mod, "main"), "tui.main should expose a main() entrypoint"
    assert callable(mod.main)


def test_import_screens_module() -> None:
    """The screens module should import cleanly."""

    mod = importlib.import_module("tui.screens")
    assert hasattr(mod, "run_main_menu")


def test_run_tui_falls_back_without_curses(monkeypatch) -> None:
    """If curses is unavailable, run_tui should call the underlying CLI.

    We simulate an environment where importing curses fails and check that the
    CLI entrypoint wrapper is invoked with the given arguments.
    """

    tui_main = importlib.import_module("tui.main")

    # Force _try_import_curses to behave as though curses is missing
    monkeypatch.setattr(tui_main, "_try_import_curses", lambda: None)

    called = {}

    def fake_cli_main(argv: List[str] | None = None) -> int:
        called["argv"] = list(argv or [])
        return 0

    monkeypatch.setattr(tui_main, "cli_main", fake_cli_main)

    rc = tui_main.run_tui(["--mode", "multi-process"])

    assert rc == 0
    assert called["argv"] == ["--mode", "multi-process"]


def test_run_main_entry_parses_passthrough(monkeypatch) -> None:
    """The top-level main() should forward --passthrough args to run_tui."""

    tui_main = importlib.import_module("tui.main")

    captured = {}

    def fake_run_tui(argv):  # type: ignore[override]
        captured["argv"] = list(argv or [])
        return 0

    monkeypatch.setattr(tui_main, "run_tui", fake_run_tui)

    rc = tui_main.main(["--passthrough", "--mode", "single-process"])  # type: ignore[arg-type]

    assert rc == 0
    assert captured["argv"] == ["--mode", "single-process"]
