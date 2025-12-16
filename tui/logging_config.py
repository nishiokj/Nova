# configure structured logging and file handler
from __future__ import annotations

import datetime
import json
import logging
import logging.handlers
import os
import sys
from typing import Optional


class _JSONFormatter(logging.Formatter):
    """Simple JSON formatter for structured logs.

    Produces a compact JSON object with timestamp, level, logger, message, and optional
    exception text and extra fields. Designed to be safe and dependency-free.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.datetime.utcfromtimestamp(record.created).isoformat() + "Z",
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Include exception text if present
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)

        # Include a few commonly-set extras if present
        for attr in ("user_action", "step", "task_id", "log_file"):
            if hasattr(record, attr):
                payload[attr] = getattr(record, attr)

        # Avoid failure if non-serializable extras are attached; fall back to string repr
        try:
            return json.dumps(payload, ensure_ascii=False)
        except Exception:
            for k, v in list(payload.items()):
                try:
                    json.dumps(v)
                except Exception:
                    payload[k] = repr(v)
            return json.dumps(payload, ensure_ascii=False)


def _detect_non_interactive() -> bool:
    """Return True when the process is likely running non-interactively (e.g. service)."""
    try:
        # If stdin/stdout aren't ttys or are closed, consider non-interactive.
        if not hasattr(sys, "stdin") or not hasattr(sys, "stdout"):
            return True
        if getattr(sys.stdin, "closed", False) or getattr(sys.stdout, "closed", False):
            return True
        return not (sys.stdin.isatty() and sys.stdout.isatty())
    except Exception:
        # If any probing fails, assume non-interactive to be conservative.
        return True


def _default_log_dir() -> str:
    """Choose a sane default directory for persistent logs, honoring XDG if available."""
    try:
        state = os.environ.get("XDG_STATE_HOME") or os.environ.get("XDG_DATA_HOME")
        if state:
            base = state
        else:
            base = os.path.join(os.path.expanduser("~"), ".local", "share")
        path = os.path.join(base, "tui")
        os.makedirs(path, exist_ok=True)
        return path
    except Exception:
        # Fall back to current directory if creation fails
        return os.getcwd()


def configure_logging(level: int = logging.INFO, *, enable_file: Optional[bool] = None) -> None:
    """Configure root logger with JSON console formatter and optional rotating file handler.

    - By default, a file handler is added when the environment looks non-interactive.
    - Safe to call multiple times (will not duplicate handlers aggressively).
    """
    root = logging.getLogger()

    # Avoid reconfiguring if we've already attached our sentinel handler
    if any(getattr(h, "_tui_configured", False) for h in root.handlers):
        return

    root.setLevel(level)

    # Console handler (stderr) with structured formatter
    sh = logging.StreamHandler(sys.stderr)
    sh.setLevel(level)
    sh.setFormatter(_JSONFormatter())
    sh._tui_configured = True
    root.addHandler(sh)

    non_interactive = _detect_non_interactive()
    if enable_file is None:
        enable_file = non_interactive

    if enable_file:
        try:
            log_dir = _default_log_dir()
            log_path = os.path.join(log_dir, "tui.log")

            fh = logging.handlers.RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
            fh.setLevel(level)
            fh.setFormatter(_JSONFormatter())
            fh._tui_configured = True
            root.addHandler(fh)

            # Emit a startup message that includes the log file location for operators.
            root.info("tui.startup", extra={"user_action": "startup", "log_file": log_path})
        except Exception as e:
            # If file logging fails, emit a warning to stderr but continue.
            try:
                root.warning("tui.startup.file_failed", extra={"user_action": "startup", "error": repr(e)})
            except Exception:
                pass
    else:
        root.info("tui.startup", extra={"user_action": "startup", "interactive": True})


def get_logger(name: Optional[str] = None) -> logging.Logger:
    """Convenience wrapper to retrieve a logger configured by this module."""
    if name:
        return logging.getLogger(name)
    return logging.getLogger("tui")


# Configure automatically on import to ensure logs are available as early as possible.
try:
    configure_logging()
except Exception:
    # Best-effort: never let logging configuration break the application.
    try:
        logging.getLogger("tui").exception("tui.startup.configure_failed")
    except Exception:
        pass
