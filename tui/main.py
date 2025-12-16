"""Text-based terminal UI entrypoint for the voice app.

This module wires a simple curses-style TUI to the existing CLI entrypoint
in src/app/cli.py. The goal is to provide a clean foundation we can iterate on
in later steps (multiple panes, streaming logs, configuration editor, etc.).

Design goals implemented in this patch:
- Zero-magic: plain Python, no external TUI deps.
- Safe fallback: if curses is unavailable or an error occurs, fall back to
  running the existing CLI (so the program remains usable in all environments).
- Simple, discoverable help and keyboard controls (q to quit, h for help,
  r to refresh, Enter to run default action).
- Defensive error handling: exceptions in the TUI are caught and reported,
  with a graceful fallback to CLI.
- Small, test-friendly functions and clear extension points.
"""

from __future__ import annotations

import os
import sys
import time
import traceback
from typing import Optional

# Project layout: make src/ available like the original project did
PROJECT_ROOT = os.path.dirname(os.path.abspath(os.path.join(__file__, "..")))
SRC_DIR = os.path.join(PROJECT_ROOT, "src")
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

try:
    from app.cli import main as cli_main
except Exception as exc:  # pragma: no cover - defensive guard
    def cli_main(argv: Optional[list[str]] = None) -> int:  # type: ignore[redefined-outer-name]
        print("Error: unable to import app.cli.main (", exc, ")", file=sys.stderr)
        return 1


def _import_curses():
    """Attempt to import curses and return the module or None.

    We keep the import isolated so environments without proper terminal support
    can still run the underlying CLI.
    """

    try:
        import curses  # type: ignore
        return curses
    except Exception:
        return None


def _draw_main_screen(stdscr, height: int, width: int, show_help: bool) -> None:
    """Render the main TUI. Kept simple and easy to extend.

    Args:
        stdscr: curses main window.
        height: terminal height in rows.
        width: terminal width in columns.
        show_help: whether to show the help pane.
    """
    stdscr.clear()
    title = "Voice Agent — TUI (experimental)"
    stdscr.addstr(0, max(0, (width - len(title)) // 2), title,)

    subtitle = "Press 'h' for help — 'q' to quit — Enter to run CLI"
    stdscr.addstr(2, 2, subtitle)

    # Example content area
    welcome = [
        "This lightweight TUI is a safe front-end to the existing CLI.",
        "It deliberately avoids heavy external dependencies so it can run in",
        "a wide range of terminals. Use it as a starting point for a richer",
        "text UI with panes, forms, and streaming logs.",
    ]

    for i, line in enumerate(welcome, start=4):
        if i >= height - 2:
            break
        stdscr.addstr(i, 4, line[: max(0, width - 8)])

    # Footer with basic runtime info
    footer = f"Size: {width}x{height} — {time.strftime('%Y-%m-%d %H:%M:%S')}"
    stdscr.addstr(height - 1, 2, footer[: max(0, width - 4)])

    # Optional help pane
    if show_help:
        help_lines = [
            "Help",
            "----",
            "q      Quit the TUI and exit",
            "h      Toggle this help screen",
            "Enter  Run the underlying CLI (safe fallback)",
            "r      Refresh the screen",
            "Esc    Close help / cancel",
        ]
        win_h = min(len(help_lines) + 2, height - 6)
        win_w = min(max(len(l) for l in help_lines) + 4, width - 8)
        start_y = 6
        start_x = width - win_w - 4
        try:
            # Draw a simple bordered help box
            stdscr.attron(0)
            for idx, hl in enumerate(help_lines, start=0):
                y = start_y + idx
                if y >= height - 2:
                    break
                stdscr.addstr(y, start_x, hl[:win_w - 2])
        except Exception:
            # Be extra defensive: terminal drawing can fail on weird terminals
            pass

    stdscr.refresh()


def run_tui(argv: Optional[list[str]] = None) -> int:
    """Try to run a minimal curses-based TUI.

    If curses is unavailable or an error happens, we fall back to calling the
    CLI entrypoint so the application remains usable in non-interactive
    environments (CI, dumb terminals, containers without termcap, etc.).

    Returns an exit code (0 success, non-zero error).
    """
    curses = _import_curses()
    if curses is None:
        print("Terminal UI not available in this environment — running CLI fallback.")
        return cli_main(argv)

    # Main loop state
    show_help = False

    def _curses_main(stdscr):
        nonlocal show_help
        # configure
        curses.curs_set(0)  # hide cursor where supported
        stdscr.nodelay(False)  # blocking getch — simple and robust
        stdscr.keypad(True)

        # Handle resize nicely
        try:
            height, width = stdscr.getmaxyx()
        except Exception:
            height, width = 24, 80

        _draw_main_screen(stdscr, height, width, show_help)

        while True:
            try:
                ch = stdscr.getch()
            except KeyboardInterrupt:
                return 0
            except Exception:
                # Drawing/input errors: fall back to CLI
                raise

            # Normalize key codes
            if ch in (ord("q"), ord("Q")):
                return 0
            if ch in (ord("h"), ord("H")):
                show_help = not show_help
                try:
                    height, width = stdscr.getmaxyx()
                except Exception:
                    height, width = 24, 80
                _draw_main_screen(stdscr, height, width, show_help)
                continue
            if ch in (ord("r"), ord("R")):
                try:
                    height, width = stdscr.getmaxyx()
                except Exception:
                    height, width = 24, 80
                _draw_main_screen(stdscr, height, width, show_help)
                continue
            if ch in (10, 13):  # Enter key
                # Run the CLI in the same process as a fallback action.
                # We leave the terminal in a sane state by ending curses first.
                return_code = None
                try:
                    curses.endwin()
                except Exception:
                    pass
                return cli_main(argv)

            # Any other key: ignore but keep the UI responsive
            # If help is visible and user presses Esc (27), close it
            if ch == 27 and show_help:
                show_help = False
                try:
                    height, width = stdscr.getmaxyx()
                except Exception:
                    height, width = 24, 80
                _draw_main_screen(stdscr, height, width, show_help)
                continue

            # No recognized key: small sleep to avoid busy loop
            time.sleep(0.01)

    try:
        # Use curses.wrapper which initializes and finalizes the terminal safely.
        curses.wrapper(_curses_main)
        return 0
    except Exception as exc:  # pragma: no cover - environment dependent
        # Ensure we don't leave the terminal in an unusable state
        try:
            if curses:
                curses.endwin()
        except Exception:
            pass

        # Print a concise error then fall back to CLI
        print("TUI failed: ", str(exc), file=sys.stderr)
        traceback.print_exc()
        print("Falling back to CLI...", file=sys.stderr)
        return cli_main(argv)


def main(argv: Optional[list[str]] = None) -> int:
    """Package-friendly entrypoint — keeps the same signature as the CLI.

    This function is intentionally small and easy to call from tests. It will
    attempt to run the TUI, and if that is not possible, run the CLI.
    """
    if argv is None:
        argv = sys.argv[1:]
    return run_tui(argv)
