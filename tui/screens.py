"""Core TUI screens and flows for the voice agent system.

This module implements the first real user-facing flows for the terminal UI.

Design goals
-----------
- Map directly onto the main things a user wants to do:
  - See and tweak config before running the app.
  - Start/stop the voice app in single or multi-process mode.
  - Tail logs while the app is running.
- Keep implementation dependency-light (standard library only for now).
- Keep the architecture clear so we can later migrate to a richer TUI
  library (Textual, prompt_toolkit, etc.) without rewriting business logic.

Usage
-----
The main entrypoint that higher-level code should call is
:func:`run_main_menu`. It expects a ``run_app`` callable that encapsulates
starting the existing application (likely via :mod:`src/app/cli`).

The screen stack is intentionally simple: everything happens in a loop
inside ``run_main_menu`` for this MVP.
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass
from typing import Callable, Iterable, List, Optional


# Types ---------------------------------------------------------------------------

RunAppFn = Callable[[List[str]], int]


@dataclass
class MenuOption:
    key: str
    label: str
    help: str


# Utility functions ---------------------------------------------------------------


def _clear() -> None:
    """Clear the terminal screen in a cross-platform way."""

    if os.name == "nt":  # pragma: no cover - Windows only
        os.system("cls")
    else:  # Unix-ish
        os.system("clear")


def _prompt(line: str) -> str:
    """Prompt the user for a single line of input."""

    try:
        return input(line)
    except EOFError:  # pragma: no cover - non-interactive edge case
        return ""


def _press_enter_to_continue() -> None:
    _prompt("\nPress Enter to return to the main menu...")


def _print_header(title: str) -> None:
    term_width = max(40, os.get_terminal_size().columns if sys.stdout.isatty() else 80)
    print("=" * term_width)
    centered = f" {title} "
    padding = max(0, term_width - len(centered))
    left = padding // 2
    right = padding - left
    print("=" * left + centered + "=" * right)
    print("=" * term_width)


def _print_kv_table(rows: Iterable[tuple[str, str]]) -> None:
    rows = list(rows)
    if not rows:
        print("(no data)")
        return

    key_width = max(len(k) for k, _ in rows)
    for key, value in rows:
        print(f"{key.ljust(key_width)} : {value}")


# Configuration view --------------------------------------------------------------


def show_config_view(app_config_repr: str) -> None:
    """Display the current configuration in a readable way.

    ``app_config_repr`` is expected to be a pre-rendered string form of the
    configuration (e.g. the result of ``str(config)`` or a pretty-printed
    dict). The TUI deliberately does not depend on ``AppConfig`` directly so it
    can be reused in different environments.
    """

    _clear()
    _print_header("Current Configuration")
    print(app_config_repr)

    print("\nHints:")
    print("- Edit config files under ./config then restart the TUI.")
    print("- In a future version, this screen will support inline edits.")

    _press_enter_to_continue()


# Log tail view -------------------------------------------------------------------


def follow_log(log_path: str, run_until: Callable[[], bool]) -> None:
    """Stream logs to the terminal while ``run_until()`` returns True.

    This is a simple, line-by-line tail implementation that works on any
    platform where regular file I/O works. The caller is responsible for
    controlling when the loop should end by changing whatever
    :func:`run_until` closes over.
    """

    _clear()
    _print_header("Live Logs (read-only)")
    print("Press Ctrl+C to stop viewing logs. The app will keep running.\n")

    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            # Seek to the end so we only see new lines by default
            f.seek(0, os.SEEK_END)

            while run_until():
                line = f.readline()
                if not line:
                    time.sleep(0.2)
                    continue
                sys.stdout.write(line)
                sys.stdout.flush()
    except FileNotFoundError:
        print(f"No log file found at {log_path!r}.")
        _press_enter_to_continue()
    except KeyboardInterrupt:  # user stopped tailing
        pass


# App run flows -------------------------------------------------------------------


def run_app_interactive(run_app: RunAppFn, base_args: Optional[List[str]] = None) -> int:
    """Run the main app with a confirmation prompt.

    ``run_app`` should be a thin wrapper around the existing CLI entrypoint,
    e.g. something that internally calls ``app.cli.main``.
    """

    if base_args is None:
        base_args = []

    _clear()
    _print_header("Run Voice App")

    print("You're about to start the voice agent.")
    print("This will use the same pipeline as the normal CLI.")
    print("\nExample modes you can pass:")
    print("  --mode single-process")
    print("  --mode multi-process")

    extra = _prompt("\nAdditional CLI args (or leave blank): ")
    args = list(base_args)
    if extra.strip():
        # Very small shell-style split; we defer real parsing to the CLI.
        args.extend(extra.split())

    print("\nStarting app... (Ctrl+C to stop)\n")
    rc = run_app(args)

    print(f"\nApp exited with code {rc}.")
    _press_enter_to_continue()
    return rc


# Main menu -----------------------------------------------------------------------


def run_main_menu(
    *,
    run_app: RunAppFn,
    app_config_repr: str,
    log_path: Optional[str] = None,
) -> None:
    """Top-level menu loop for the TUI.

    Parameters
    ----------
    run_app:
        Function that starts the main application, usually a thin wrapper
        around ``app.cli.main`` that accepts a list of CLI-style arguments.
    app_config_repr:
        Human-readable string representation of the current configuration.
    log_path:
        Optional path to the main log file. If provided, users can view
        streaming logs from the menu.
    """

    log_path = log_path or os.path.join("logs", "app.log")

    options: List[MenuOption] = [
        MenuOption("1", "Run app", "Start the voice agent using the existing CLI"),
        MenuOption("2", "View config", "Show current configuration"),
        MenuOption("3", "View logs", "Tail the main log file"),
        MenuOption("q", "Quit", "Exit the TUI"),
    ]

    while True:
        _clear()
        _print_header("Voice Agent — Main Menu")

        for opt in options:
            print(f"[{opt.key}] {opt.label}")
        print("\nChoose an option and press Enter.")

        choice = _prompt("> ").strip().lower()

        if choice == "1":
            run_app_interactive(run_app)
        elif choice == "2":
            show_config_view(app_config_repr)
        elif choice == "3":
            # We run the log tailer in the foreground; user exits via Ctrl+C
            follow_log(log_path, run_until=lambda: True)
        elif choice in {"q", "quit", "exit"}:
            _clear()
            print("Goodbye.")
            break
        else:
            print("Unrecognized option. Please try again.")
            time.sleep(1.0)
