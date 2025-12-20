#!/usr/bin/env python3
"""Entry point for Voice Agent TUI.

Launcher for the robust text-based interface.
"""

import sys
import os

# Add tui directory to path
TUI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tui")
if TUI_DIR not in sys.path:
    sys.path.insert(0, TUI_DIR)

from robust_tui import main

if __name__ == "__main__":
    sys.exit(main())
