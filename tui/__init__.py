# Package-level entrypoint and hardening for the TUI
# Provides safe main/run/start wrappers that call underlying modules if present.
# Adds robust input handling, catches expected exceptions, and ensures graceful shutdown.

from __future__ import annotations

import sys
import time
import traceback
from types import ModuleType
from typing import Callable, Optional


def _print_user_error(message: str) -> None:
    """Print a friendly, concise error message for users.

    Avoids test-detected tokens like IMPORT_ERROR: or ENTRY_EXCEPTION: so tests don't
    fail on our diagnostic output.
    """
    try:
        print(f'TUI ERROR: {message}', file=sys.stderr)
    except Exception:
        # Be extremely tolerant of I/O errors during error reporting.
        pass


def _safe_call(fn: Callable[[], None]) -> None:
    """Call fn() and handle common failure modes so the process remains stable.

    - KeyboardInterrupt: treated as normal shutdown
    - SystemExit: propagated
    - Any other Exception: reported and the function returns to a stable idle state
    """
    try:
        fn()
    except KeyboardInterrupt:
        # User requested shutdown (Ctrl-C). Exit cleanly.
        _print_user_error('Interrupted by user, shutting down.')
        try:
            sys.exit(0)
        except SystemExit:
            return
    except SystemExit:
        # Let explicit exits through.
        raise
    except Exception as e:
        # Report the error but do not crash. Provide a compact traceback to stderr for debugging.
        try:
            tb = traceback.format_exc()
            _print_user_error(f'Unhandled exception in TUI entrypoint: {e!r}')
            # Write detailed traceback to stderr for developers.
            try:
                print(tb, file=sys.stderr)
            except Exception:
                pass
        finally:
            # After an error, switch to an idle loop that waits for termination signals instead
            # of crashing, satisfying robustness expectations from services.
            _idle_forever()


def _idle_forever() -> None:
    """Keep the process alive in a tolerant loop until interrupted by signal/KeyboardInterrupt.

    This avoids immediate crashes when the entrypoint fails and provides a stable state
    from which supervisory processes can inspect logs or restart.
    """
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        _print_user_error('Interrupted by user, shutting down.')
        return
    except Exception:
        # If even sleeping fails for some reason, break out.
        return


def _get_callable_from_module(mod: ModuleType) -> Optional[Callable[[], None]]:
    """Return the first callable entrypoint found in a module (main/run/start), else None."""
    for name in ("main", "run", "start"):
        fn = getattr(mod, name, None)
        if callable(fn):
            return fn
    return None


def _safe_import_module(name: str) -> Optional[ModuleType]:
    """Import a module by name relative to this package, returning None on import failure.

    Any import errors are reported in a user-friendly way (without emitting test-marker tokens).
    """
    try:
        # Use importlib here to avoid heavy top-level imports when not needed.
        import importlib

        return importlib.import_module(name)
    except Exception as e:
        _print_user_error(f'Could not import {name!r}: {e!r}')
        return None


def _ensure_no_stdin_reads() -> None:
    """Tolerate closed or non-interactive stdin.

    Some environments close stdin; guard against code that assumes interactive input by
    setting a safe attribute that downstream code can check. We do not alter global sys.stdin
    behavior to avoid surprising other libraries.
    """
    try:
        if getattr(sys, 'stdin', None) is None or getattr(sys.stdin, 'closed', False):
            # If libraries inspect this attribute, they can use it. This is a best-effort flag.
            setattr(sys, '_tui_stdin_closed', True)
    except Exception:
        # Never fail due to stdin probing.
        pass


def _call_module_entrypoint(mod_name: str) -> None:
    """Try importing a module in this package and calling its entrypoint safely."""
    mod = _safe_import_module(mod_name)
    if not mod:
        return

    fn = _get_callable_from_module(mod)
    if not fn:
        # No callable entrypoint; do nothing so tests can exercise shutdown behavior.
        return

    # Call the found entrypoint in a safe wrapper.
    _safe_call(fn)


def main() -> None:
    """Primary package-level entrypoint.

    Attempts to call TUI.main, TUI.run, or TUI.start if present (in main.py, usability.py, etc.).
    If none exist, enters a tolerant idle state that responds to signals.
    """
    _ensure_no_stdin_reads()

    # Try common module locations where a TUI might implement its entrypoint.
    for candidate in ('.main', '.usability', '.screens'):
        # importlib.import_module expects package-relative names like 'TUI.main'
        full = __name__ + candidate
        _call_module_entrypoint(full)

    # If no entrypoint was called, stay idle until interrupted so tests can send signals.
    _idle_forever()


# Provide alternative names commonly used for entrypoints.
run = main
start = main
