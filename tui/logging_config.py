"""
TUI Logging Configuration

IMPORTANT: This module does NOT auto-configure logging on import.
The application must explicitly call configure_tui_logging() with a log_dir.

Each application should have its own logs folder co-located with the app:
    tui/logs/           # TUI application logs
    evals/logs/         # Evals application logs
    src/app/logs/       # Voice app logs (if applicable)

Log folder structure:
    {app}/logs/
    ├── tui.log          # Main application log (INFO+)
    ├── requests.jsonl   # Request lifecycle (via StructuredLogger)
    ├── health.jsonl     # System health (via StructuredLogger)
    ├── errors/
    │   └── errors.log   # Full stack traces with timestamps (ERROR+)
    └── llm_requests.log # LLM context logging (via AgentLogger)
"""
from __future__ import annotations

import datetime
import json
import logging
import logging.handlers
import os
import sys
import traceback
from pathlib import Path
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
        for attr in ("user_action", "step", "task_id", "log_file", "component"):
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


class _ErrorFormatter(logging.Formatter):
    """Detailed error formatter with full stack traces, timestamps, and context.

    Designed for the errors/ subdirectory - human-readable format for debugging.
    """

    def format(self, record: logging.LogRecord) -> str:
        lines = [
            "=" * 80,
            f"TIMESTAMP: {datetime.datetime.utcfromtimestamp(record.created).isoformat()}Z",
            f"LEVEL: {record.levelname}",
            f"LOGGER: {record.name}",
            f"FILE: {record.pathname}:{record.lineno}",
            f"FUNCTION: {record.funcName}",
            "",
            "MESSAGE:",
            record.getMessage(),
        ]

        # Add any extra context
        extra_attrs = ["user_action", "step", "task_id", "component", "request_id"]
        extras = []
        for attr in extra_attrs:
            if hasattr(record, attr):
                extras.append(f"  {attr}: {getattr(record, attr)}")
        if extras:
            lines.append("")
            lines.append("CONTEXT:")
            lines.extend(extras)

        # Add full stack trace if present
        if record.exc_info:
            lines.append("")
            lines.append("STACK TRACE:")
            lines.append(self.formatException(record.exc_info))

        lines.append("=" * 80)
        lines.append("")

        return "\n".join(lines)


# Track if logging has been configured (to prevent double-configuration)
_logging_configured = False
_configured_log_dir: Optional[str] = None


def configure_tui_logging(
    log_dir: str,
    level: int = logging.INFO,
    enable_console: bool = False,
    enable_file: bool = True
) -> str:
    """
    Configure TUI logging with a specific log directory.

    IMPORTANT: This function MUST be called explicitly by the application.
    Logging is NOT auto-configured on import.

    Args:
        log_dir: Directory where logs will be written. REQUIRED.
                 Creates the directory if it doesn't exist.
        level: Logging level (default: INFO)
        enable_console: Whether to log to console (default: False for TUI)
        enable_file: Whether to log to files (default: True)

    Returns:
        The log_dir path (for confirmation)

    Creates:
        {log_dir}/tui.log - Main application log
        {log_dir}/errors/errors.log - Full error traces
    """
    global _logging_configured, _configured_log_dir

    if not log_dir:
        raise ValueError("log_dir is required - TUI logging does not use default paths")

    log_path = Path(log_dir)
    log_path.mkdir(parents=True, exist_ok=True)

    # Create errors subdirectory
    errors_path = log_path / "errors"
    errors_path.mkdir(exist_ok=True)

    root = logging.getLogger()

    # Clear existing handlers if reconfiguring
    if _logging_configured:
        for handler in list(root.handlers):
            if getattr(handler, "_tui_configured", False):
                root.removeHandler(handler)
                handler.close()

    root.setLevel(level)

    # Console handler (optional, usually disabled for TUI to keep screen clean)
    if enable_console:
        sh = logging.StreamHandler(sys.stderr)
        sh.setLevel(level)
        sh.setFormatter(_JSONFormatter())
        sh._tui_configured = True
        root.addHandler(sh)

    if enable_file:
        # Main log file (INFO+)
        main_log = log_path / "tui.log"
        fh = logging.handlers.RotatingFileHandler(
            main_log,
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8"
        )
        fh.setLevel(level)
        fh.setFormatter(_JSONFormatter())
        fh._tui_configured = True
        root.addHandler(fh)

        # Error log file (ERROR+ with full traces)
        error_log = errors_path / "errors.log"
        eh = logging.handlers.RotatingFileHandler(
            error_log,
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8"
        )
        eh.setLevel(logging.ERROR)
        eh.setFormatter(_ErrorFormatter())
        eh._tui_configured = True
        root.addHandler(eh)

    _logging_configured = True
    _configured_log_dir = str(log_path)

    # Log startup (goes to tui.log, not console)
    root.info(
        "TUI logging configured",
        extra={"user_action": "startup", "log_file": str(main_log), "component": "tui"}
    )

    return str(log_path)


def get_tui_log_dir() -> Optional[str]:
    """Get the configured log directory, or None if not configured."""
    return _configured_log_dir


def is_logging_configured() -> bool:
    """Check if TUI logging has been configured."""
    return _logging_configured


def get_logger(name: Optional[str] = None) -> logging.Logger:
    """
    Get a logger for TUI components.

    Args:
        name: Logger name (default: "tui")

    Returns:
        Logger instance

    Note: If logging is not configured, this returns a logger that
          will do nothing until configure_tui_logging() is called.
    """
    if name:
        return logging.getLogger(name)
    return logging.getLogger("tui")


# =============================================================================
# IMPORTANT: No auto-configuration on import!
# The application MUST call configure_tui_logging() explicitly.
# =============================================================================
