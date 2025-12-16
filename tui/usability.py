"""Usability and help/UX refinements for the TUI.

This module centralizes small but important UX details for the terminal UI so
that screens remain focused on flow logic. It provides:

- A structured help screen with keyboard shortcuts.
- Standard status / error message helpers.
- Simple input validation helpers.
- Safe wrappers for operations that might fail (config or log access).

All utilities are dependency-free (standard library only) and can be reused
across multiple screens.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Iterable, List, Optional


# ---------------------------------------------------------------------------
# Core message / status helpers
# ---------------------------------------------------------------------------


@dataclass
class StatusMessage:
    """Represents a status or error message to show in the TUI."""

    text: str
    level: str = "info"  # "info" | "warning" | "error" | "success"

    def format(self) -> str:
        prefix = {
            "info": "[i] ",
            "warning": "[!] ",
            "error": "[x] ",
            "success": "[✓] ",
        }.get(self.level, "")
        return f"{prefix}{self.text}"


def print_status(msg: StatusMessage) -> None:
    """Print a formatted status line.

    This keeps messaging consistent across screens.
    """

    # In the future we might colorize output based on `msg.level`.
    print(msg.format())


def print_error(text: str) -> None:
    print_status(StatusMessage(text=text, level="error"))


def print_warning(text: str) -> None:
    print_status(StatusMessage(text=text, level="warning"))


def print_success(text: str) -> None:
    print_status(StatusMessage(text=text, level="success"))


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def validate_log_path(path: str) -> Optional[str]:
    """Return a human-friendly error string if the log path looks invalid.

    We only perform lightweight checks here so we don't accidentally reject
    valid-but-unusual setups.
    """

    if not path:
        return "Log path is empty. Configure a valid log file path."

    # If the directory doesn't exist, it's almost certainly a configuration
    # error, but we don't auto-create the directory from the TUI.
    parent = os.path.dirname(path) or "."
    if not os.path.isdir(parent):
        return f"Log directory {parent!r} does not exist. Check your config."

    return None


def validate_config_path(path: str) -> Optional[str]:
    """Return a human-friendly error string if the config path is invalid."""

    if not path:
        return "Config path is empty. Use --config or create a default config."

    if not os.path.exists(path):
        return f"Config file {path!r} does not exist."

    if not os.path.isfile(path):
        return f"Config path {path!r} is not a file."

    return None


# ---------------------------------------------------------------------------
# Help / shortcuts
# ---------------------------------------------------------------------------


HELP_TEXT = """Voice Agent — Help & Shortcuts

Global conventions
------------------
- Menus: type the number/letter shown in brackets and press Enter.
- Quit: use 'q' or 'quit' from menus to exit the TUI cleanly.
- Interrupt: Ctrl+C generally cancels the current operation but keeps the
  overall TUI running where possible.

Main menu shortcuts
-------------------
[1] Run app
    - Starts the voice agent with the same options as the CLI.
    - You can provide additional CLI flags (e.g. --mode multi-process).

[2] View config
    - Shows the currently loaded configuration as text.
    - To change values, edit the JSON/TOML/YAML files under ./config
      (depending on your set-up) and restart the TUI.

[3] View logs
    - Tails the main log file (defaults to ./logs/app.log).
    - Use Ctrl+C to stop viewing logs and return to the menu.

Error handling
--------------
- If the underlying CLI or config loading fails, errors are printed with
  an [x] prefix along with any message from the application.
- When a path (config or log) is misconfigured, the TUI will tell you
  exactly what looks wrong and how to fix it.

Tips
----
- Run in a reasonably large terminal window so menus and logs are readable.
- If your terminal does not support advanced capabilities (like colors or
  curses), the TUI degrades to simple text I/O.
"""


def show_help() -> None:
    """Render the help text with a simple header.

    This is designed to be called from a "Help" menu option.
    """

    width = max(60, os.get_terminal_size().columns if sys.stdout.isatty() else 80)
    print("=" * width)
    title = " Voice Agent — Help "
    pad = max(0, width - len(title))
    left = pad // 2
    right = pad - left
    print("=" * left + title + "=" * right)
    print("=" * width)
    print()
    print(HELP_TEXT)


# ---------------------------------------------------------------------------
# Safe wrappers around potentially fragile operations
# ---------------------------------------------------------------------------


def safe_read_file(path: str, max_bytes: int = 64_000) -> Optional[str]:
    """Read a file defensively.

    Returns the contents as a string, or ``None`` if something goes wrong.
    Any error is printed in a user-friendly way instead of raising.
    """

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(max_bytes)
    except FileNotFoundError:
        print_error(f"File not found: {path!r}")
    except PermissionError:
        print_error(f"Permission denied when reading: {path!r}")
    except OSError as exc:
        print_error(f"Could not read {path!r}: {exc}")
    return None


def summarize_config(raw_config: str, max_lines: int = 80) -> str:
    """Provide a readable, possibly-truncated config summary.

    This is used when the full configuration is very long and would flood
    the terminal. It preserves the opening lines and appends an indicator
    when truncation occurs.
    """

    lines = raw_config.splitlines()
    if len(lines) <= max_lines:
        return raw_config

    head = "\n".join(lines[:max_lines])
    omitted = len(lines) - max_lines
    return f"{head}\n\n... ({omitted} more lines omitted)"


__all__ = [
    "StatusMessage",
    "print_status",
    "print_error",
    "print_warning",
    "print_success",
    "validate_log_path",
    "validate_config_path",
    "HELP_TEXT",
    "show_help",
    "safe_read_file",
    "summarize_config",
]
