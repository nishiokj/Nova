# install signal handlers and save state on exit
# Provides graceful shutdown behavior for the TUI: handles SIGINT/SIGTERM,
# persists a small JSON state atomically, and attempts to restore terminal
# state (for curses-like TUIs) to avoid partial terminal corruption.

from __future__ import annotations

import atexit
import errno
import json
import os
import signal
import sys
import tempfile
import threading
import traceback
from typing import Any, Dict, Optional

# Configurable path for persisted state. Honors XDG_STATE_HOME if present.
def _default_state_path() -> str:
    try:
        base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
        d = os.path.join(base, "tui")
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, "state.json")
    except Exception:
        return os.path.join(os.getcwd(), "tui-state.json")

_STATE_PATH = _default_state_path()
_state_lock = threading.RLock()
_state: Dict[str, Any] = {}
_state_dirty = False
_handlers_installed = False


def load_state(path: Optional[str] = None) -> Dict[str, Any]:
    """Load persisted state from disk. Returns an empty dict on any error."""
    p = path or _STATE_PATH
    try:
        with open(p, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            if isinstance(data, dict):
                global _state
                with _state_lock:
                    _state = data
                return data
    except FileNotFoundError:
        return {}
    except Exception:
        # Never let errors here bubble out; callers expect resilience.
        try:
            sys.stderr.write("TUI: failed to load state: " + traceback.format_exc())
        except Exception:
            pass
        return {}


def save_state(path: Optional[str] = None) -> None:
    """Persist the in-memory state to disk atomically.

    Uses a temporary file and os.replace to avoid partial files being visible to
    external observers. Swallows errors but logs to stderr for operator visibility.
    """
    p = path or _STATE_PATH
    temp_dir = None
    try:
        with _state_lock:
            data = _state.copy()
        # Ensure parent dir exists
        parent = os.path.dirname(p)
        if parent:
            os.makedirs(parent, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix="tui-state-", dir=parent or None)
        temp_dir = tmp
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
                fh.flush()
                os.fsync(fh.fileno())
            # Atomic replace
            os.replace(tmp, p)
        finally:
            # If os.replace failed and temp remains, try to remove it quietly
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except Exception:
                pass
    except Exception:
        try:
            sys.stderr.write("TUI: failed to save state: " + traceback.format_exc())
        except Exception:
            pass


def update_state(key: str, value: Any) -> None:
    """Update a key in the persistent state and mark it dirty.

    Should be used by TUI components to record minimal information required to resume
    user sessions (last-view, cursor positions, last commands, etc.).
    """
    global _state_dirty
    with _state_lock:
        _state[key] = value
        _state_dirty = True


def get_state(key: str, default: Any = None) -> Any:
    with _state_lock:
        return _state.get(key, default)


def _restore_terminal_state() -> None:
    """Attempt to restore terminal state to sane defaults to avoid corruption.

    This tries a best-effort approach that is safe to call even if curses is not
    in use. It avoids importing heavy terminal libraries unless present.
    """
    try:
        # If the application used curses, ensure we end it cleanly.
        import curses

        try:
            curses.nocbreak()
            curses.echo()
            try:
                curses.endwin()
            except Exception:
                # endwin may fail if not initialized; ignore.
                pass
        except Exception:
            pass
    except Exception:
        # Not a curses environment; try to ensure stdout/stderr are flushed and
        # terminal echo is enabled via stty if available.
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        try:
            # Try a conservative stty restore; ignore failures.
            import subprocess

            subprocess.run(["/bin/stty", "sane"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass


def _shutdown_handler(signum: int, frame) -> None:
    """Main signal handler for clean shutdown.

    Saves state, restores terminal, and exits the process. Designed to be tolerant of
    errors so it's safe to invoke from signal context and repeated signals.
    """
    try:
        # Try to make shutdown idempotent.
        global _handlers_installed
        if not _handlers_installed:
            # If handlers were removed already, just exit.
            try:
                sys.exit(0)
            except SystemExit:
                os._exit(0)

        # Prevent re-entrance into this handler
        _handlers_installed = False

        try:
            # Persist any in-memory state. It's fine if this blocks briefly.
            save_state()
        except Exception:
            pass

        try:
            _restore_terminal_state()
        except Exception:
            pass

        # Exit cleanly
        try:
            sys.exit(0)
        except SystemExit:
            # In rare signal contexts sys.exit may be ignored; force exit.
            os._exit(0)
    except Exception:
        # Last-resort: if even our shutdown failed, force immediate exit.
        try:
            os._exit(1)
        except Exception:
            pass


def install(path: Optional[str] = None) -> None:
    """Install signal handlers and register atexit persistence.

    Call during application startup to ensure SIGINT and SIGTERM trigger graceful
    shutdown and that state is flushed on normal interpreter exit.
    """
    global _STATE_PATH, _handlers_installed
    if path:
        _STATE_PATH = path

    with _state_lock:
        if _handlers_installed:
            return
        # Load existing state if present
        try:
            loaded = load_state(_STATE_PATH)
            # merge loaded into in-memory state
            _state.update(loaded)
        except Exception:
            pass

        # Use Python-level signal handlers. These are sufficient for typical TUI processes.
        try:
            signal.signal(signal.SIGINT, _shutdown_handler)
        except Exception:
            pass
        try:
            signal.signal(signal.SIGTERM, _shutdown_handler)
        except Exception:
            pass

        # Ensure state is saved on normal exit as well
        try:
            atexit.register(save_state, _STATE_PATH)
        except Exception:
            pass

        _handlers_installed = True


# Provide a convenience automatic install when imported from a running TUI. This is a
# best-effort operation and won't crash if the environment forbids signal manipulation.
try:
    install()
except Exception:
    # Swallow all errors at import time; callers can call install() explicitly.
    try:
        sys.stderr.write("TUI: shutdown.install() failed at import\n")
    except Exception:
        pass
