#!/usr/bin/env python3
"""Entry point for Voice Agent TUI.

Prefers the Ink TypeScript TUI if built artifacts are present,
falls back to the Python robust TUI otherwise.
"""

import os
import shutil
import subprocess
import sys

# Add tui directory to path for Python fallback
TUI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tui")
if TUI_DIR not in sys.path:
    sys.path.insert(0, TUI_DIR)


def run_ink_tui(argv: list[str]) -> int | None:
    """Run the Ink TUI if bun and build artifacts are available."""
    bun = shutil.which("bun")
    entry = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tui-ts", "dist", "index.js")
    if not bun or not os.path.exists(entry):
        return None
    return subprocess.call([bun, entry, *argv])


def main() -> int:
    rc = run_ink_tui(sys.argv[1:])
    if rc is not None:
        return rc

    from robust_tui import main as fallback_main

    return fallback_main()


if __name__ == "__main__":
    sys.exit(main())
