"""
Structured logging for the agentic harness.
Provides clean, traceable logs for debugging and monitoring.
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
    # Input/Output
    SPEECH_RECEIVED = "speech_received"
    RESPONSE_GENERATED = "response_generated"
    TTS_OUTPUT = "tts_output"

    # Routing
    ROUTER_CLASSIFICATION = "router_classification"
    TIER_SELECTED = "tier_selected"

    # Agent
    AGENT_THINKING = "agent_thinking"
    AGENT_DECISION = "agent_decision"
    AGENT_RESPONSE = "agent_response"

    # Tool execution
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    TOOL_ERROR = "tool_error"

    # LLM
    LLM_REQUEST = "llm_request"
    LLM_RESPONSE = "llm_response"
    LLM_STREAM_CHUNK = "llm_stream_chunk"
    LLM_ERROR = "llm_error"

    # Service Rep
    SERVICE_REP_ACK = "service_rep_acknowledgment"

    # System
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
        """Convert to dictionary, excluding None values"""
        result = {}
        for key, value in asdict(self).items():
            if value is not None:
                result[key] = value
        return result

    def to_json(self) -> str:
        """Convert to JSON string"""
        return json.dumps(self.to_dict())

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LogEntry":
        """Create from dictionary"""
        return cls(**data)


class StructuredLogger:
    """
    Thread-safe structured logger for the harness.
    Produces clean, parseable logs for debugging and monitoring.
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

        # In-memory log buffer for recent entries
        self._log_buffer: List[LogEntry] = []
        self._max_buffer_size = 1000

        # Set up logging
        self._setup_logging()

    def _setup_logging(self):
        """Set up Python logging handlers"""
        self.log_dir.mkdir(parents=True, exist_ok=True)

        self.logger = logging.getLogger(self.name)
        self.logger.setLevel(self.log_level)
        self.logger.handlers = []  # Clear existing handlers

        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )

        if self.log_to_console:
            console_handler = logging.StreamHandler()
            console_handler.setLevel(self.log_level)
            console_handler.setFormatter(formatter)
            self.logger.addHandler(console_handler)

        if self.log_to_file:
            from logging.handlers import RotatingFileHandler
            file_handler = RotatingFileHandler(
                self.log_dir / "harness.log",
                maxBytes=self.max_log_size,
                backupCount=self.backup_count
            )
            file_handler.setLevel(self.log_level)
            file_handler.setFormatter(formatter)
            self.logger.addHandler(file_handler)

            # Structured JSON log file
            json_handler = RotatingFileHandler(
                self.log_dir / "harness_structured.jsonl",
                maxBytes=self.max_log_size,
                backupCount=self.backup_count
            )
            json_handler.setLevel(self.log_level)
            json_handler.setFormatter(logging.Formatter('%(message)s'))
            self.json_logger = logging.getLogger(f"{self.name}_json")
            self.json_logger.setLevel(self.log_level)
            self.json_logger.handlers = [json_handler]

    def new_request(self) -> str:
        """Start a new request and return request ID"""
        with self._lock:
            self._request_counter += 1
            self._current_request_id = f"{self._session_id}-{self._request_counter:04d}"
            return self._current_request_id

    @property
    def session_id(self) -> str:
        """Get current session ID"""
        return self._session_id

    @property
    def request_id(self) -> Optional[str]:
        """Get current request ID"""
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
        """Create a log entry"""
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

    def _log_entry(self, entry: LogEntry):
        """Log an entry to all configured outputs"""
        with self._lock:
            # Add to buffer
            self._log_buffer.append(entry)
            if len(self._log_buffer) > self._max_buffer_size:
                self._log_buffer = self._log_buffer[-self._max_buffer_size:]

            # Log to standard logger
            level_map = {
                "debug": logging.DEBUG,
                "info": logging.INFO,
                "warning": logging.WARNING,
                "error": logging.ERROR,
                "critical": logging.CRITICAL
            }
            log_level = level_map.get(entry.level, logging.INFO)

            if self.structured_format:
                log_msg = f"[{entry.event_type}] {entry.message}"
                if entry.component:
                    log_msg = f"[{entry.component}] {log_msg}"
                if entry.data:
                    log_msg += f" | {json.dumps(entry.data)}"
            else:
                log_msg = entry.message

            self.logger.log(log_level, log_msg)

            # Log to JSON file
            if self.log_to_file and hasattr(self, 'json_logger'):
                self.json_logger.info(entry.to_json())

    # Convenience methods for different event types

    def speech_received(self, text: str, metadata: Optional[Dict] = None):
        """Log speech input received"""
        entry = self._create_entry(
            EventType.SPEECH_RECEIVED,
            LogLevel.INFO,
            f"Speech received: {text[:100]}{'...' if len(text) > 100 else ''}",
            component="input",
            data={"text": text, "length": len(text), **(metadata or {})}
        )
        self._log_entry(entry)

    def router_classification(self, input_text: str, tier: str, confidence: float = 1.0):
        """Log router classification result"""
        entry = self._create_entry(
            EventType.ROUTER_CLASSIFICATION,
            LogLevel.INFO,
            f"Classified as '{tier}' (confidence: {confidence:.2f})",
            component="router",
            data={"input_preview": input_text[:50], "tier": tier, "confidence": confidence}
        )
        self._log_entry(entry)

    def agent_thinking(self, thought: str, component: str = "agent"):
        """Log agent thinking/reasoning"""
        entry = self._create_entry(
            EventType.AGENT_THINKING,
            LogLevel.DEBUG,
            f"Thinking: {thought[:200]}{'...' if len(thought) > 200 else ''}",
            component=component,
            data={"thought": thought}
        )
        self._log_entry(entry)

    def agent_decision(self, decision: str, tools: Optional[List[str]] = None):
        """Log agent decision"""
        entry = self._create_entry(
            EventType.AGENT_DECISION,
            LogLevel.INFO,
            f"Decision: {decision}",
            component="agent",
            data={"decision": decision, "tools_to_use": tools or []}
        )
        self._log_entry(entry)

    def tool_call(self, tool_name: str, params: Dict[str, Any]):
        """Log tool invocation"""
        # Sanitize params to avoid logging sensitive data
        safe_params = self._sanitize_params(params)
        entry = self._create_entry(
            EventType.TOOL_CALL,
            LogLevel.INFO,
            f"Calling tool: {tool_name}",
            component="tools",
            data={"tool": tool_name, "params": safe_params}
        )
        self._log_entry(entry)

    def tool_result(self, tool_name: str, result: Any, duration_ms: float):
        """Log tool result"""
        result_preview = str(result)[:500] if result else "None"
        entry = self._create_entry(
            EventType.TOOL_RESULT,
            LogLevel.INFO,
            f"Tool {tool_name} completed",
            component="tools",
            data={"tool": tool_name, "result_preview": result_preview},
            duration_ms=duration_ms
        )
        self._log_entry(entry)

    def tool_error(self, tool_name: str, error: Exception, duration_ms: Optional[float] = None):
        """Log tool error"""
        entry = self._create_entry(
            EventType.TOOL_ERROR,
            LogLevel.ERROR,
            f"Tool {tool_name} failed: {error}",
            component="tools",
            data={"tool": tool_name},
            duration_ms=duration_ms,
            error=error
        )
        self._log_entry(entry)

    def llm_request(self, provider: str, model: str, prompt_preview: str):
        """Log LLM request"""
        entry = self._create_entry(
            EventType.LLM_REQUEST,
            LogLevel.DEBUG,
            f"LLM request to {provider}/{model}",
            component="llm",
            data={
                "provider": provider,
                "model": model,
                "prompt_preview": prompt_preview[:200]
            }
        )
        self._log_entry(entry)

    def llm_response(self, provider: str, model: str, response_preview: str, tokens: Optional[Dict] = None, duration_ms: float = 0):
        """Log LLM response"""
        entry = self._create_entry(
            EventType.LLM_RESPONSE,
            LogLevel.DEBUG,
            f"LLM response from {provider}/{model}",
            component="llm",
            data={
                "provider": provider,
                "model": model,
                "response_preview": response_preview[:200],
                "tokens": tokens or {}
            },
            duration_ms=duration_ms
        )
        self._log_entry(entry)

    def llm_error(self, provider: str, model: str, error: Exception):
        """Log LLM error"""
        entry = self._create_entry(
            EventType.LLM_ERROR,
            LogLevel.ERROR,
            f"LLM error from {provider}/{model}: {error}",
            component="llm",
            data={"provider": provider, "model": model},
            error=error
        )
        self._log_entry(entry)

    def service_rep_acknowledgment(self, user_input: str, acknowledgment: str):
        """Log service rep acknowledgment"""
        entry = self._create_entry(
            EventType.SERVICE_REP_ACK,
            LogLevel.INFO,
            f"ServiceRep: {acknowledgment}",
            component="service_rep",
            data={"user_input_preview": user_input[:50], "acknowledgment": acknowledgment}
        )
        self._log_entry(entry)

    def tts_output(self, text: str):
        """Log TTS output"""
        entry = self._create_entry(
            EventType.TTS_OUTPUT,
            LogLevel.INFO,
            f"TTS output: {text[:100]}{'...' if len(text) > 100 else ''}",
            component="tts",
            data={"text": text, "length": len(text)}
        )
        self._log_entry(entry)

    def response_generated(self, response: str, metadata: Optional[Dict] = None):
        """Log final response"""
        entry = self._create_entry(
            EventType.RESPONSE_GENERATED,
            LogLevel.INFO,
            f"Response: {response[:100]}{'...' if len(response) > 100 else ''}",
            component="output",
            data={"response": response, "length": len(response), **(metadata or {})}
        )
        self._log_entry(entry)

    def error(self, message: str, error: Optional[Exception] = None, component: Optional[str] = None):
        """Log an error"""
        entry = self._create_entry(
            EventType.ERROR,
            LogLevel.ERROR,
            message,
            component=component,
            error=error
        )
        self._log_entry(entry)

    def warning(self, message: str, component: Optional[str] = None, data: Optional[Dict] = None):
        """Log a warning"""
        entry = self._create_entry(
            EventType.WARNING,
            LogLevel.WARNING,
            message,
            component=component,
            data=data
        )
        self._log_entry(entry)

    def info(self, message: str, component: Optional[str] = None, data: Optional[Dict] = None):
        """Log info message"""
        entry = self._create_entry(
            EventType.SYSTEM,
            LogLevel.INFO,
            message,
            component=component,
            data=data
        )
        self._log_entry(entry)

    def debug(self, message: str, component: Optional[str] = None, data: Optional[Dict] = None):
        """Log debug message"""
        entry = self._create_entry(
            EventType.SYSTEM,
            LogLevel.DEBUG,
            message,
            component=component,
            data=data
        )
        self._log_entry(entry)

    def config_change(self, path: str, old_value: Any, new_value: Any):
        """Log configuration change"""
        entry = self._create_entry(
            EventType.CONFIG_CHANGE,
            LogLevel.INFO,
            f"Config changed: {path}",
            component="config",
            data={
                "path": path,
                "old_value": str(old_value)[:100],
                "new_value": str(new_value)[:100]
            }
        )
        self._log_entry(entry)

    def _sanitize_params(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Sanitize parameters to avoid logging sensitive data"""
        sensitive_keys = {'password', 'api_key', 'secret', 'token', 'auth', 'key', 'credential'}
        safe_params = {}
        for key, value in params.items():
            if any(s in key.lower() for s in sensitive_keys):
                safe_params[key] = "***REDACTED***"
            elif isinstance(value, str) and len(value) > 1000:
                safe_params[key] = value[:1000] + "...[truncated]"
            else:
                safe_params[key] = value
        return safe_params

    def get_recent_logs(self, count: int = 100, event_type: Optional[str] = None) -> List[LogEntry]:
        """Get recent log entries from buffer"""
        with self._lock:
            logs = self._log_buffer[-count:]
            if event_type:
                logs = [l for l in logs if l.event_type == event_type]
            return logs

    def get_request_logs(self, request_id: str) -> List[LogEntry]:
        """Get all logs for a specific request"""
        with self._lock:
            return [l for l in self._log_buffer if l.request_id == request_id]

    def clear_buffer(self):
        """Clear the log buffer"""
        with self._lock:
            self._log_buffer = []


# Global logger instance
_global_logger: Optional[StructuredLogger] = None


def get_logger() -> StructuredLogger:
    """Get or create global logger instance"""
    global _global_logger
    if _global_logger is None:
        _global_logger = StructuredLogger()
    return _global_logger


def set_logger(logger: StructuredLogger):
    """Set global logger instance"""
    global _global_logger
    _global_logger = logger
