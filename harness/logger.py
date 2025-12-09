"""
Structured logging for the agentic harness.
SIMPLIFIED: Clean console output, detailed JSON file for debugging.
"""

import os
import json
import logging
import threading
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Dict, Any, Optional, List, Union
from enum import Enum
from pathlib import Path
import traceback
import uuid


class LogLevel(Enum):
    """Log levels for structured logging"""
    DEBUG = "debug"
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class EventType(Enum):
    """Types of events in the harness"""
    SPEECH_RECEIVED = "speech_received"
    RESPONSE_GENERATED = "response_generated"
    TTS_OUTPUT = "tts_output"
    ROUTER_CLASSIFICATION = "router_classification"
    AGENT_THINKING = "agent_thinking"
    AGENT_DECISION = "agent_decision"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    TOOL_ERROR = "tool_error"
    FILE_OPERATION = "file_operation"
    LLM_REQUEST = "llm_request"
    LLM_RESPONSE = "llm_response"
    LLM_ERROR = "llm_error"
    SERVICE_REP_ACK = "service_rep_acknowledgment"
    CONFIG_CHANGE = "config_change"
    ERROR = "error"
    WARNING = "warning"
    SYSTEM = "system"


@dataclass
class LogEntry:
    """Structured log entry"""
    timestamp: str
    event_type: str
    level: str
    message: str
    session_id: str
    request_id: Optional[str] = None
    component: Optional[str] = None
    data: Dict[str, Any] = field(default_factory=dict)
    duration_ms: Optional[float] = None
    error: Optional[str] = None
    stack_trace: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result = {}
        for key, value in asdict(self).items():
            if value is not None:
                result[key] = value
        return result

    def to_json(self) -> str:
        return json.dumps(self.to_dict())


class StructuredLogger:
    """
    SIMPLIFIED structured logger.
    - Console: Clean, readable, ONE line per important event
    - File: Full JSON for debugging
    """

    def __init__(
        self,
        name: str = "harness",
        log_dir: str = "logs",
        log_level: str = "INFO",
        log_to_file: bool = True,
        log_to_console: bool = True,
        structured_format: bool = True,
        max_log_size: int = 10 * 1024 * 1024,
        backup_count: int = 5
    ):
        self.name = name
        self.log_dir = Path(log_dir)
        self.log_level = getattr(logging, log_level.upper(), logging.INFO)
        self.log_to_file = log_to_file
        self.log_to_console = log_to_console
        self.structured_format = structured_format
        self.max_log_size = max_log_size
        self.backup_count = backup_count

        self._lock = threading.Lock()
        self._session_id = str(uuid.uuid4())[:8]
        self._request_counter = 0
        self._current_request_id: Optional[str] = None
        self._log_buffer: List[LogEntry] = []
        self._max_buffer_size = 1000

        self._setup_logging()

    def _setup_logging(self):
        """Set up logging - CLEAN console, DETAILED file"""
        self.log_dir.mkdir(parents=True, exist_ok=True)

        # Main logger - console only, clean format
        self.logger = logging.getLogger(self.name)
        self.logger.setLevel(self.log_level)
        self.logger.handlers = []
        self.logger.propagate = False  # CRITICAL: prevent duplicate logs

        if self.log_to_console:
            console_handler = logging.StreamHandler()
            console_handler.setLevel(self.log_level)
            # Clean format: just component and message
            console_handler.setFormatter(logging.Formatter(
                '%(asctime)s [%(levelname)s] %(message)s',
                datefmt='%H:%M:%S'
            ))
            self.logger.addHandler(console_handler)

        # JSON file logger - separate, detailed
        if self.log_to_file:
            from logging.handlers import RotatingFileHandler

            # JSON file for detailed debugging
            self.json_logger = logging.getLogger(f"{self.name}_json")
            self.json_logger.setLevel(logging.DEBUG)
            self.json_logger.handlers = []
            self.json_logger.propagate = False  # CRITICAL: no console output

            json_handler = RotatingFileHandler(
                self.log_dir / "harness_debug.jsonl",
                maxBytes=self.max_log_size,
                backupCount=self.backup_count
            )
            json_handler.setFormatter(logging.Formatter('%(message)s'))
            self.json_logger.addHandler(json_handler)

    def new_request(self) -> str:
        with self._lock:
            self._request_counter += 1
            self._current_request_id = f"{self._session_id}-{self._request_counter:04d}"
            return self._current_request_id

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def request_id(self) -> Optional[str]:
        return self._current_request_id

    def _create_entry(
        self,
        event_type: Union[EventType, str],
        level: Union[LogLevel, str],
        message: str,
        component: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
        duration_ms: Optional[float] = None,
        error: Optional[Exception] = None
    ) -> LogEntry:
        event_str = event_type.value if isinstance(event_type, EventType) else event_type
        level_str = level.value if isinstance(level, LogLevel) else level

        entry = LogEntry(
            timestamp=datetime.utcnow().isoformat() + "Z",
            event_type=event_str,
            level=level_str,
            message=message,
            session_id=self._session_id,
            request_id=self._current_request_id,
            component=component,
            data=data or {},
            duration_ms=duration_ms
        )

        if error:
            entry.error = str(error)
            entry.stack_trace = traceback.format_exc()

        return entry

    def _log_entry(self, entry: LogEntry, console_msg: Optional[str] = None):
        """Log entry - clean console, detailed JSON file"""
        with self._lock:
            self._log_buffer.append(entry)
            if len(self._log_buffer) > self._max_buffer_size:
                self._log_buffer = self._log_buffer[-self._max_buffer_size:]

            level_map = {
                "debug": logging.DEBUG,
                "info": logging.INFO,
                "warning": logging.WARNING,
                "error": logging.ERROR,
                "critical": logging.CRITICAL
            }
            log_level = level_map.get(entry.level, logging.INFO)

            # Console: clean, readable
            if console_msg:
                self.logger.log(log_level, console_msg)

            # JSON file: everything for debugging
            if self.log_to_file and hasattr(self, 'json_logger'):
                self.json_logger.debug(entry.to_json())

    # ========== GOLDEN PATH EVENTS (always show on console) ==========

    def speech_received(self, text: str, metadata: Optional[Dict] = None):
        """Log speech input - GOLDEN PATH"""
        entry = self._create_entry(
            EventType.SPEECH_RECEIVED, LogLevel.INFO,
            f"Speech: {text}", component="input",
            data={"text": text, "length": len(text), **(metadata or {})}
        )
        self._log_entry(entry, f"🎤 INPUT: {text}")

    def router_classification(self, input_text: str, tier: str, confidence: float = 1.0):
        """Log routing - GOLDEN PATH"""
        entry = self._create_entry(
            EventType.ROUTER_CLASSIFICATION, LogLevel.INFO,
            f"Routed to {tier}", component="router",
            data={"tier": tier, "confidence": confidence}
        )
        self._log_entry(entry, f"📍 ROUTE: {tier} (conf={confidence:.2f})")

    def tool_call(self, tool_name: str, params: Dict[str, Any]):
        """Log tool call - GOLDEN PATH"""
        safe_params = self._sanitize_params(params)
        entry = self._create_entry(
            EventType.TOOL_CALL, LogLevel.INFO,
            f"Tool: {tool_name}", component="tools",
            data={"tool": tool_name, "params": safe_params}
        )
        self._log_entry(entry, f"🔧 TOOL: {tool_name}({self._format_params(safe_params)})")

    def tool_result(self, tool_name: str, result: Any, duration_ms: float):
        """Log tool result - GOLDEN PATH"""
        result_str = str(result)[:200] if result else "None"
        entry = self._create_entry(
            EventType.TOOL_RESULT, LogLevel.INFO,
            f"Tool {tool_name} done", component="tools",
            data={"tool": tool_name, "result": str(result)[:1000]},
            duration_ms=duration_ms
        )
        self._log_entry(entry, f"✅ TOOL RESULT ({duration_ms:.0f}ms): {result_str}")

    def tool_error(self, tool_name: str, error: Exception, duration_ms: float = 0):
        """Log tool error - GOLDEN PATH"""
        entry = self._create_entry(
            EventType.TOOL_ERROR, LogLevel.ERROR,
            f"Tool {tool_name} failed: {error}", component="tools",
            data={"tool": tool_name}, error=error,
            duration_ms=duration_ms
        )
        self._log_entry(entry, f"❌ TOOL ERROR ({duration_ms:.0f}ms): {tool_name} - {error}")

    def file_operation(
        self,
        operation: str,
        path: Optional[str],
        status: str,
        detail: Optional[str] = None,
        component: str = "tools"
    ):
        """Log file operations with clear path information"""
        safe_path = path or "(unknown)"
        message = f"{operation} {status}: {safe_path}"
        level = LogLevel.INFO
        if status.lower() in {"failed", "error", "denied"}:
            level = LogLevel.ERROR
        entry = self._create_entry(
            EventType.FILE_OPERATION,
            level,
            message,
            component=component,
            data={
                "operation": operation,
                "path": safe_path,
                "status": status,
                **({"detail": detail} if detail else {})
            }
        )
        log_msg = f"🗂️ FILE {operation} {status}: {safe_path}"
        if detail:
            log_msg += f" | {detail}"
        self._log_entry(entry, log_msg)

    def response_generated(self, response: str, metadata: Optional[Dict] = None):
        """Log final response - GOLDEN PATH"""
        entry = self._create_entry(
            EventType.RESPONSE_GENERATED, LogLevel.INFO,
            f"Response: {response}", component="output",
            data={"response": response, **(metadata or {})}
        )
        duration = metadata.get("duration_ms", 0) if metadata else 0
        self._log_entry(entry, f"💬 RESPONSE ({duration:.0f}ms): {response[:150]}")

    # ========== LLM EVENTS (detailed for debugging) ==========

    def llm_request(self, provider: str, model: str, prompt_preview: str):
        """Log LLM request"""
        entry = self._create_entry(
            EventType.LLM_REQUEST, LogLevel.DEBUG,
            f"LLM request to {model}", component="llm",
            data={"provider": provider, "model": model, "prompt": prompt_preview[:500]}
        )
        self._log_entry(entry, f"🤖 LLM REQUEST: {model}")

    def llm_response(
        self,
        provider: str,
        model: str,
        response_content: str,
        tokens: Optional[Dict] = None,
        duration_ms: float = 0,
        tool_calls: Optional[List[Dict]] = None,
        finish_reason: Optional[str] = None,
        raw_response: Optional[str] = None
    ):
        """Log LLM response - DETAILED for debugging"""
        data = {
            "provider": provider,
            "model": model,
            "content": response_content,
            "content_length": len(response_content) if response_content else 0,
            "tokens": tokens or {},
            "finish_reason": finish_reason,
            "has_tool_calls": bool(tool_calls),
            "tool_calls": tool_calls or [],
        }
        if raw_response:
            data["raw_response"] = raw_response[:2000]

        entry = self._create_entry(
            EventType.LLM_RESPONSE, LogLevel.DEBUG,
            f"LLM response from {model}", component="llm",
            data=data, duration_ms=duration_ms
        )

        # Console: show what matters
        content_preview = response_content[:100] if response_content else "(empty)"
        tool_info = f", tools={len(tool_calls)}" if tool_calls else ""
        token_info = f", tokens={tokens.get('completion_tokens', '?')}" if tokens else ""
        self._log_entry(entry, f"🤖 LLM RESPONSE ({duration_ms:.0f}ms{token_info}{tool_info}): {content_preview}")

    def llm_error(self, provider: str, model: str, error: Exception):
        entry = self._create_entry(
            EventType.LLM_ERROR, LogLevel.ERROR,
            f"LLM error: {error}", component="llm",
            data={"provider": provider, "model": model}, error=error
        )
        self._log_entry(entry, f"❌ LLM ERROR: {error}")

    # ========== SERVICE REP / TTS ==========

    def service_rep_acknowledgment(self, user_input: str, acknowledgment: str):
        entry = self._create_entry(
            EventType.SERVICE_REP_ACK, LogLevel.INFO,
            f"Ack: {acknowledgment}", component="service_rep",
            data={"user_input": user_input[:50], "acknowledgment": acknowledgment}
        )
        self._log_entry(entry, f"🗣️ ACK: {acknowledgment}")

    def tts_output(self, text: str):
        entry = self._create_entry(
            EventType.TTS_OUTPUT, LogLevel.DEBUG,
            f"TTS: {text}", component="tts",
            data={"text": text}
        )
        # Don't spam console with TTS
        self._log_entry(entry, None)

    # ========== AGENT EVENTS ==========

    def agent_thinking(self, thought: str, component: str = "agent"):
        entry = self._create_entry(
            EventType.AGENT_THINKING, LogLevel.DEBUG,
            f"Thinking: {thought}", component=component,
            data={"thought": thought}
        )
        # Debug only - don't spam console
        self._log_entry(entry, None)

    def agent_decision(self, decision: str, tools: Optional[List[str]] = None):
        entry = self._create_entry(
            EventType.AGENT_DECISION, LogLevel.INFO,
            f"Decision: {decision}", component="agent",
            data={"decision": decision, "tools": tools or []}
        )
        self._log_entry(entry, f"🧠 DECISION: {decision}")

    # ========== ERRORS & WARNINGS ==========

    def error(self, message: str, error: Optional[Exception] = None, component: Optional[str] = None):
        entry = self._create_entry(
            EventType.ERROR, LogLevel.ERROR,
            message, component=component, error=error
        )
        # ALWAYS show errors on console with component - never silent!
        self._log_entry(entry, f"❌ ERROR [{component or 'system'}]: {message}")

    def warning(self, message: str, component: Optional[str] = None, data: Optional[Dict] = None):
        entry = self._create_entry(
            EventType.WARNING, LogLevel.WARNING,
            message, component=component, data=data
        )
        # ALWAYS show warnings on console - never silent!
        self._log_entry(entry, f"⚠️ WARNING [{component or 'system'}]: {message}")

    def info(self, message: str, component: Optional[str] = None, data: Optional[Dict] = None):
        entry = self._create_entry(
            EventType.SYSTEM, LogLevel.INFO,
            message, component=component, data=data
        )
        # Only important system messages to console
        self._log_entry(entry, None)

    def debug(self, message: str, component: Optional[str] = None, data: Optional[Dict] = None):
        entry = self._create_entry(
            EventType.SYSTEM, LogLevel.DEBUG,
            message, component=component, data=data
        )
        self._log_entry(entry, None)

    def config_change(self, path: str, old_value: Any, new_value: Any):
        entry = self._create_entry(
            EventType.CONFIG_CHANGE, LogLevel.INFO,
            f"Config: {path}", component="config",
            data={"path": path, "old": str(old_value)[:100], "new": str(new_value)[:100]}
        )
        self._log_entry(entry, f"⚙️ CONFIG: {path} changed")

    # ========== HELPERS ==========

    def _sanitize_params(self, params: Dict[str, Any]) -> Dict[str, Any]:
        sensitive_keys = {'password', 'api_key', 'secret', 'token', 'auth', 'key', 'credential'}
        safe_params = {}
        for key, value in params.items():
            if any(s in key.lower() for s in sensitive_keys):
                safe_params[key] = "***"
            elif isinstance(value, str) and len(value) > 500:
                safe_params[key] = value[:500] + "..."
            else:
                safe_params[key] = value
        return safe_params

    def _format_params(self, params: Dict[str, Any]) -> str:
        """Format params for clean console display"""
        parts = []
        for k, v in list(params.items())[:3]:
            if isinstance(v, str) and len(v) > 30:
                v = v[:30] + "..."
            parts.append(f"{k}={v}")
        return ", ".join(parts)

    def get_recent_logs(self, count: int = 100, event_type: Optional[str] = None) -> List[LogEntry]:
        with self._lock:
            logs = self._log_buffer[-count:]
            if event_type:
                logs = [l for l in logs if l.event_type == event_type]
            return logs

    def get_request_logs(self, request_id: str) -> List[LogEntry]:
        with self._lock:
            return [l for l in self._log_buffer if l.request_id == request_id]

    def clear_buffer(self):
        with self._lock:
            self._log_buffer = []


# Global logger instance
_global_logger: Optional[StructuredLogger] = None


def get_logger() -> StructuredLogger:
    global _global_logger
    if _global_logger is None:
        _global_logger = StructuredLogger()
    return _global_logger


def set_logger(logger: StructuredLogger):
    global _global_logger
    _global_logger = logger
