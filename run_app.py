#!/usr/bin/env python3
"""Local wrapper that ensures src/ is on sys.path before invoking app.cli."""

import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from app.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
