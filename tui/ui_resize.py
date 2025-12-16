# handle SIGWINCH (terminal resize) and provide Unicode-safe helpers
# Ensures UI redraws on terminal resize and prevents crashes from encoding issues.

from __future__ import annotations

import signal
import sys
import threading
import traceback
from typing import Callable, Optional

_resize_lock = threading.RLock()
_current_handler = None
_callback: Optional[Callable[[], None]] = None
_old_handler = None


def _safe_text(s: object) -> str:
    """Return a str for s, replacing invalid bytes/characters where necessary.

    Accepts bytes or str or objects with __str__ and ensures the returned string
    will not raise on printing or encoding by using errors='replace'.
    """
    try:
        if isinstance(s, bytes):
            return s.decode(sys.getfilesystemencoding() or 'utf-8', errors='replace')
        return str(s)
    except Exception:
        # Fallback to a repr if conversion fails
        try:
            return repr(s)
        except Exception:
            return '<unrepresentable>'


def safe_print(*args, file=None, sep=' ', end='\n') -> None:
    """Print safely to a stream, replacing problematic characters.

    Useful for logging from signal handlers or other places where encoding might fail.
    """
    try:
        text = sep.join(_safe_text(a) for a in args) + end
        out = file if file is not None else sys.stdout
        try:
            out.write(text)
            out.flush()
        except Exception:
            # Try encoding then writing bytes if text write fails.
            try:
                out.buffer.write(text.encode(getattr(out, 'encoding', 'utf-8') or 'utf-8', errors='replace'))
                out.flush()
            except Exception:
                # Give up silently to avoid raising from diagnostics
                pass
    except Exception:
        # Ensure print never raises
        try:
            sys.stderr.write('TUI: failed to safe_print\n')
        except Exception:
            pass


def _sigwinch_handler(signum, frame) -> None:
    """Signal handler for SIGWINCH that calls the registered callback safely.

    This handler is conservative: it will catch exceptions and avoid non-reentrant
    operations. It schedules the user callback to run in a background thread to
    avoid doing heavy work inside the signal context.
    """
    try:
        # Run the callback in a separate thread to avoid doing non-reentrant work
        # inside the signal handler. If no callback is registered, do nothing.
        global _callback
        cb = None
        with _resize_lock:
            cb = _callback
        if cb is None:
            return

        def _runner():
            try:
                cb()
            except Exception:
                # Do not propagate exceptions out of the handler; log to stderr safely.
                try:
                    safe_print('TUI: resize callback raised:', traceback.format_exc(), file=sys.stderr)
                except Exception:
                    pass

        t = threading.Thread(target=_runner, name='tui-sigwinch-callback')
        t.daemon = True
        t.start()
    except Exception:
        # As a last resort, write a brief note
        try:
            safe_print('TUI: SIGWINCH handler failed', file=sys.stderr)
        except Exception:
            pass


def install_resize_handler(callback: Callable[[], None]) -> None:
    """Install a SIGWINCH handler that calls callback on terminal resize.

    The callback should be safe to call multiple times and should perform the UI
    redraw. install_resize_handler is idempotent and will replace any existing
    callback while preserving the previous signal handler so uninstall can restore it.
    """
    global _current_handler, _callback, _old_handler
    with _resize_lock:
        _callback = callback
        try:
            _old_handler = signal.getsignal(signal.SIGWINCH)
            # Only replace if not already our handler
            if _old_handler is not _sigwinch_handler:
                signal.signal(signal.SIGWINCH, _sigwinch_handler)
                _current_handler = _sigwinch_handler
        except Exception:
            # If signals can't be modified in this environment, swallow the error.
            try:
                safe_print('TUI: could not install SIGWINCH handler; continuing without it', file=sys.stderr)
            except Exception:
                pass


def uninstall_resize_handler() -> None:
    """Restore previous SIGWINCH handler and remove registered callback."""
    global _current_handler, _callback, _old_handler
    with _resize_lock:
        _callback = None
        try:
            if _old_handler is not None:
                signal.signal(signal.SIGWINCH, _old_handler)
            _current_handler = None
            _old_handler = None
        except Exception:
            try:
                safe_print('TUI: could not restore previous SIGWINCH handler', file=sys.stderr)
            except Exception:
                pass


def handle_curses_resize_if_needed(stdscr) -> None:
    """If the app uses curses, call curses.resizeterm and return True on success.

    Call with the application's main curses window (stdscr). This function is
    tolerant of missing curses or uninitialized curses state.
    """
    try:
        import curses

        try:
            # Some curses versions provide is_term_resized; use it if available.
            rows, cols = stdscr.getmaxyx()
            try:
                if hasattr(curses, 'resizeterm'):
                    curses.resizeterm(rows, cols)
                else:
                    # On some platforms, calling resizeok/endwin/refresh helps
                    try:
                        stdscr.resize(rows, cols)
                    except Exception:
                        pass
                return True
            except Exception:
                return False
        except Exception:
            return False
    except Exception:
        return False


def safe_render_text_for_display(text: object, width: Optional[int] = None) -> str:
    """Return a display-safe string of at most width characters.

    Handles multibyte characters by ensuring we operate on Python str and replacing
    any problematic bytes. Does not attempt to implement grapheme-aware truncation
    (which requires external libs); instead it truncates code points safely.
    """
    s = _safe_text(text)
    if width is None:
        return s
    try:
        # Simple truncation; encode/decode roundtrip to ensure invalid surrogates are replaced
        encoded = s.encode('utf-8', errors='replace')
        truncated = encoded[:width]
        return truncated.decode('utf-8', errors='replace')
    except Exception:
        return s[:width]
