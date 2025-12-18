"""
Structured logging for the agentic harness.
REDESIGNED: Separation of concerns with clean, readable JSON logs.

Log files:
- requests.jsonl: End-to-end request tracking (INFO) - clean lifecycle stages
- health.jsonl: System health metrics (DEBUG) - heartbeat, VAD, internal diagnostics
- prompts.jsonl: Full prompts stored with prompt_id references
"""

import os
import json
import logging
import threading
import hashlib
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


class RequestStage(Enum):
    """Main stages in request lifecycle - keep logs focused on these"""
    REQUEST_RECEIVED = "request_received"
    INPUT_PARSED = "input_parsed"
    PLAN_CREATED = "plan_created"        # Execution plan created
    REQUEST_SENT = "request_sent"        # To LLM
    RESPONSE_RECEIVED = "response_received"  # From LLM
    TOOL_CALL_START = "tool_call_start"
    TOOL_CALL_END = "tool_call_end"
    REFLECTION = "reflection"            # Post-execution evaluation
    RESPONSE_SENT = "response_sent"


@dataclass
class RequestLog:
    """
    Compact log entry for request tracking.
    Field names shortened for readability.
    """
    ts: str               # timestamp
    lvl: str              # level
    svc: str              # service/component
    req_id: str           # request_id
    span: str             # stage/span name
    evt: str              # event description
    detail: Optional[Dict[str, Any]] = None  # event-specific details

    def to_dict(self) -> Dict[str, Any]:
        result = {
            "ts": self.ts,
            "lvl": self.lvl,
            "svc": self.svc,
            "req_id": self.req_id,
            "span": self.span,
            "evt": self.evt
        }
        if self.detail:
            result["detail"] = self.detail
        return result

    def to_json(self, pretty: bool = True) -> str:
        if pretty:
            return json.dumps(self.to_dict(), indent=2)
        return json.dumps(self.to_dict())


@dataclass
class HealthLog:
    """Log entry for system health/debug metrics"""
    ts: str
    lvl: str
    svc: str
    evt: str
    data: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        result = {
            "ts": self.ts,
            "lvl": self.lvl,
            "svc": self.svc,
            "evt": self.evt
        }
        if self.data:
            result["data"] = self.data
        return result

    def to_json(self) -> str:
        return json.dumps(self.to_dict())


class StructuredLogger:
    """
    REDESIGNED structured logger with separation of concerns.

    - requests.jsonl: Clean request lifecycle (INFO) - readable JSON
    - health.jsonl: System diagnostics (DEBUG) - heartbeat, VAD, etc.
    - prompts.jsonl: Full prompts stored by prompt_id

    log_dir defaults to "logs" if not provided.
    """

    def __init__(
        self,
        log_dir: Optional[str] = None,
        name: str = "harness",
        log_level: str = "INFO",
        log_to_file: bool = True,
        log_to_console: bool = True,
        structured_format: bool = True,
        max_log_size: int = 10 * 1024 * 1024,
        backup_count: int = 5
    ):
        if not log_dir:
            log_dir = "logs"  # Default to logs directory for backward compatibility
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
        self._prompt_counter = 0

        # Request timing
        self._request_start_times: Dict[str, float] = {}

        self._setup_logging()

    def _setup_logging(self):
        """Set up separate log files for different concerns"""
        self.log_dir.mkdir(parents=True, exist_ok=True)

        from logging.handlers import RotatingFileHandler

        # Console logger - clean, minimal
        self.console_logger = logging.getLogger(f"{self.name}_console")
        self.console_logger.setLevel(self.log_level)
        self.console_logger.handlers = []
        self.console_logger.propagate = False

        if self.log_to_console:
            console_handler = logging.StreamHandler()
            console_handler.setLevel(self.log_level)
            console_handler.setFormatter(logging.Formatter(
                '%(asctime)s [%(levelname)s] %(message)s',
                datefmt='%H:%M:%S'
            ))
            self.console_logger.addHandler(console_handler)

        if self.log_to_file:
            # REQUEST LOGS - clean lifecycle tracking (INFO)
            self.request_logger = logging.getLogger(f"{self.name}_requests")
            self.request_logger.setLevel(logging.INFO)
            self.request_logger.handlers = []
            self.request_logger.propagate = False

            request_handler = RotatingFileHandler(
                self.log_dir / "requests.jsonl",
                maxBytes=self.max_log_size,
                backupCount=self.backup_count
            )
            request_handler.setFormatter(logging.Formatter('%(message)s'))
            self.request_logger.addHandler(request_handler)

            # HEALTH LOGS - system diagnostics (DEBUG)
            self.health_logger = logging.getLogger(f"{self.name}_health")
            self.health_logger.setLevel(logging.DEBUG)
            self.health_logger.handlers = []
            self.health_logger.propagate = False

            health_handler = RotatingFileHandler(
                self.log_dir / "health.jsonl",
                maxBytes=self.max_log_size,
                backupCount=self.backup_count
            )
            health_handler.setFormatter(logging.Formatter('%(message)s'))
            self.health_logger.addHandler(health_handler)

            # PROMPT LOGS - full prompts stored by ID
            self.prompt_logger = logging.getLogger(f"{self.name}_prompts")
            self.prompt_logger.setLevel(logging.DEBUG)
            self.prompt_logger.handlers = []
            self.prompt_logger.propagate = False

            prompt_handler = RotatingFileHandler(
                self.log_dir / "prompts.jsonl",
                maxBytes=self.max_log_size * 2,  # Prompts can be large
                backupCount=self.backup_count
            )
            prompt_handler.setFormatter(logging.Formatter('%(message)s'))
            self.prompt_logger.addHandler(prompt_handler)

    def _ts(self) -> str:
        """Short timestamp"""
        return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    def new_request(self) -> str:
        """Start a new request, return request_id"""
        import time
        with self._lock:
            self._request_counter += 1
            self._current_request_id = f"{self._session_id}-{self._request_counter:04d}"
            self._request_start_times[self._current_request_id] = time.time()
            return self._current_request_id

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def request_id(self) -> Optional[str]:
        return self._current_request_id

    def _get_elapsed_ms(self, req_id: str = None) -> Optional[float]:
        """Get elapsed time for a request"""
        import time
        rid = req_id or self._current_request_id
        if rid and rid in self._request_start_times:
            return (time.time() - self._request_start_times[rid]) * 1000
        return None

    def _store_prompt(self, prompt: str) -> str:
        """Store a prompt and return its prompt_id"""
        with self._lock:
            self._prompt_counter += 1
            prompt_id = f"p-{self._session_id}-{self._prompt_counter:04d}"

        prompt_entry = {
            "prompt_id": prompt_id,
            "ts": self._ts(),
            "req_id": self._current_request_id,
            "prompt": prompt
        }

        if self.log_to_file and hasattr(self, 'prompt_logger'):
            self.prompt_logger.info(json.dumps(prompt_entry))

        return prompt_id

    def _log_request(
        self,
        span: str,
        evt: str,
        svc: str = "harness",
        detail: Optional[Dict[str, Any]] = None,
        console_msg: Optional[str] = None
    ):
        """Log a request lifecycle event (INFO level) - readable JSON"""
        entry = RequestLog(
            ts=self._ts(),
            lvl="INFO",
            svc=svc,
            req_id=self._current_request_id or "no-req",
            span=span,
            evt=evt,
            detail=detail
        )

        if self.log_to_file and hasattr(self, 'request_logger'):
            self.request_logger.info(entry.to_json(pretty=True))

        if console_msg:
            self.console_logger.info(console_msg)

    def _log_health(
        self,
        evt: str,
        svc: str = "system",
        data: Optional[Dict[str, Any]] = None,
        console_msg: Optional[str] = None
    ):
        """Log a health/debug event - goes to health.jsonl only"""
        entry = HealthLog(
            ts=self._ts(),
            lvl="DEBUG",
            svc=svc,
            evt=evt,
            data=data
        )

        if self.log_to_file and hasattr(self, 'health_logger'):
            self.health_logger.debug(entry.to_json())

        # Health logs rarely go to console
        if console_msg:
            self.console_logger.debug(console_msg)

    # ========== REQUEST LIFECYCLE STAGES (INFO -> requests.jsonl) ==========

    def request_received(self, text: str, metadata: Optional[Dict] = None):
        """Stage 1: Request received from user"""
        self._log_request(
            span=RequestStage.REQUEST_RECEIVED.value,
            evt=text[:100] + ("..." if len(text) > 100 else ""),
            svc="input",
            detail={"len": len(text), **(metadata or {})},
            console_msg=f"🎤 REQUEST: {text[:80]}"
        )

    def input_parsed(self, tier: str, confidence: float = 1.0):
        """Stage 2: Input parsed and routed"""
        self._log_request(
            span=RequestStage.INPUT_PARSED.value,
            evt=f"routed to {tier}",
            svc="router",
            detail={"tier": tier, "conf": round(confidence, 2)},
            console_msg=f"📍 ROUTE: {tier} (conf={confidence:.2f})"
        )

    def request_sent(self, model: str, prompt: str):
        """Stage 3: Request sent to LLM"""
        prompt_id = self._store_prompt(prompt)
        self._log_request(
            span=RequestStage.REQUEST_SENT.value,
            evt=f"sent to {model}",
            svc="llm",
            detail={"model": model, "prompt_id": prompt_id},
            console_msg=f"🤖 LLM REQUEST: {model}"
        )
        return prompt_id

    def response_received(
        self,
        model: str,
        tokens: Optional[Dict] = None,
        has_tool_calls: bool = False,
        duration_ms: float = 0
    ):
        """Stage 4: Response received from LLM"""
        detail = {"model": model, "ms": round(duration_ms)}
        if tokens:
            detail["tokens"] = tokens
        if has_tool_calls:
            detail["has_tools"] = True

        self._log_request(
            span=RequestStage.RESPONSE_RECEIVED.value,
            evt=f"received from {model}",
            svc="llm",
            detail=detail,
            console_msg=f"🤖 LLM RESPONSE ({duration_ms:.0f}ms)"
        )

    def plan_created(self, plan_summary: str, tools: Optional[List[str]] = None):
        """Stage 5: Agent created execution plan"""
        self._log_request(
            span=RequestStage.PLAN_CREATED.value,
            evt=plan_summary[:100],
            svc="agent",
            detail={"tools": tools} if tools else None,
            console_msg=f"🧠 PLAN: {plan_summary[:60]}"
        )

    def tool_call_start(self, tools: List[Dict[str, Any]]):
        """Stage 6: Tool execution starting"""
        tool_names = [t.get("name", "unknown") for t in tools]
        self._log_request(
            span=RequestStage.TOOL_CALL_START.value,
            evt=f"calling {len(tools)} tool(s)",
            svc="tools",
            detail={"tools": tool_names},
            console_msg=f"🔧 TOOLS: {', '.join(tool_names)}"
        )

    def tool_call_end(
        self,
        tool_name: str,
        success: bool,
        duration_ms: float,
        result_preview: Optional[str] = None
    ):
        """Stage 7: Tool execution completed"""
        status = "success" if success else "failed"
        detail = {
            "tool": tool_name,
            "status": status,
            "ms": round(duration_ms)
        }
        if result_preview:
            detail["result"] = result_preview[:100]

        icon = "✅" if success else "❌"
        self._log_request(
            span=RequestStage.TOOL_CALL_END.value,
            evt=f"{tool_name} {status}",
            svc="tools",
            detail=detail,
            console_msg=f"{icon} TOOL {tool_name} ({duration_ms:.0f}ms)"
        )

    def reflection(
        self,
        goal_achieved: bool,
        confidence: float,
        gaps: Optional[List[str]] = None
    ):
        """Stage 8: Post-execution reflection"""
        status = "achieved" if goal_achieved else "not_achieved"
        detail = {
            "goal_achieved": goal_achieved,
            "conf": round(confidence, 2)
        }
        if gaps:
            detail["gaps"] = gaps[:3]  # Limit to 3 gaps

        icon = "✅" if goal_achieved else "⚠️"
        self._log_request(
            span=RequestStage.REFLECTION.value,
            evt=f"goal {status}",
            svc="reflect",
            detail=detail,
            console_msg=f"{icon} REFLECT: goal {status} (conf={confidence:.2f})"
        )

    def response_sent(self, response_preview: str, metadata: Optional[Dict] = None):
        """Stage 8: Final response sent to user"""
        elapsed_ms = self._get_elapsed_ms()
        detail = {"len": len(response_preview)}
        if elapsed_ms:
            detail["e2e_ms"] = round(elapsed_ms)
        if metadata:
            detail.update(metadata)

        self._log_request(
            span=RequestStage.RESPONSE_SENT.value,
            evt=response_preview[:80] + ("..." if len(response_preview) > 80 else ""),
            svc="output",
            detail=detail,
            console_msg=f"💬 RESPONSE ({elapsed_ms:.0f}ms): {response_preview[:60]}"
        )

        # Clean up timing
        if self._current_request_id in self._request_start_times:
            del self._request_start_times[self._current_request_id]

    # ========== HEALTH/DEBUG EVENTS (DEBUG -> health.jsonl) ==========

    def heartbeat(self, component: str, data: Optional[Dict] = None):
        """System heartbeat - DEBUG"""
        self._log_health(
            evt="heartbeat",
            svc=component,
            data=data
        )

    def vad_event(self, event_type: str, data: Optional[Dict] = None):
        """Voice activity detection event - DEBUG"""
        self._log_health(
            evt=f"vad_{event_type}",
            svc="vad",
            data=data
        )

    def tts_event(self, event_type: str, data: Optional[Dict] = None):
        """TTS system event - DEBUG"""
        self._log_health(
            evt=f"tts_{event_type}",
            svc="tts",
            data=data
        )

    def system_init(self, component: str, status: str, data: Optional[Dict] = None):
        """System initialization - DEBUG"""
        self._log_health(
            evt=f"init_{status}",
            svc=component,
            data=data
        )

    # ========== ERRORS & WARNINGS (go to both files) ==========

    def error(
        self,
        message: str,
        error: Optional[Exception] = None,
        component: Optional[str] = None
    ):
        """Log error - goes to both request and health logs"""
        detail = {}
        if error:
            detail["error"] = str(error)
            detail["type"] = type(error).__name__

        # Log to request file if in request context
        if self._current_request_id:
            entry = RequestLog(
                ts=self._ts(),
                lvl="ERROR",
                svc=component or "system",
                req_id=self._current_request_id,
                span="error",
                evt=message[:100],
                detail=detail if detail else None
            )
            if self.log_to_file and hasattr(self, 'request_logger'):
                self.request_logger.error(entry.to_json(pretty=True))

        # Always log to health file
        self._log_health(
            evt=message[:200],
            svc=component or "system",
            data={"error": str(error)} if error else None
        )

        self.console_logger.error(f"❌ ERROR [{component or 'system'}]: {message}")

    def warning(
        self,
        message: str,
        component: Optional[str] = None,
        data: Optional[Dict] = None
    ):
        """Log warning"""
        if self._current_request_id:
            entry = RequestLog(
                ts=self._ts(),
                lvl="WARN",
                svc=component or "system",
                req_id=self._current_request_id,
                span="warning",
                evt=message[:100],
                detail=data
            )
            if self.log_to_file and hasattr(self, 'request_logger'):
                self.request_logger.warning(entry.to_json(pretty=True))

        self.console_logger.warning(f"⚠️ WARNING [{component or 'system'}]: {message}")

    # ========== LEGACY COMPATIBILITY METHODS ==========
    # These map old method names to new ones for gradual migration

    def speech_received(self, text: str, metadata: Optional[Dict] = None):
        """Legacy: maps to request_received"""
        self.request_received(text, metadata)

    def router_classification(self, input_text: str, tier: str, confidence: float = 1.0):
        """Legacy: maps to input_parsed"""
        self.input_parsed(tier, confidence)

    def tool_call(self, tool_name: str, params: Dict[str, Any]):
        """Legacy: maps to tool_call_start"""
        self.tool_call_start([{"name": tool_name, "params": params}])

    def tool_result(self, tool_name: str, result: Any, duration_ms: float):
        """Legacy: maps to tool_call_end"""
        result_str = str(result)[:100] if result else None
        self.tool_call_end(tool_name, True, duration_ms, result_str)

    def tool_error(self, tool_name: str, error: Exception, duration_ms: float = 0):
        """Legacy: maps to tool_call_end with failure"""
        self.tool_call_end(tool_name, False, duration_ms, str(error)[:100])

    def response_generated(self, response: str, metadata: Optional[Dict] = None):
        """Legacy: maps to response_sent"""
        self.response_sent(response, metadata)

    def llm_request(self, provider: str, model: str, prompt_preview: str):
        """Legacy: maps to request_sent"""
        self.request_sent(model, prompt_preview)

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
        """Legacy: maps to response_received"""
        self.response_received(model, tokens, bool(tool_calls), duration_ms)

    def llm_error(self, provider: str, model: str, error: Exception):
        """Legacy: maps to error"""
        self.error(f"LLM error from {model}: {error}", error, "llm")

    def service_rep_acknowledgment(self, user_input: str, acknowledgment: str):
        """Legacy: now goes to health log as it's internal"""
        self._log_health(
            evt=f"ack: {acknowledgment}",
            svc="service_rep",
            data={"input": user_input[:50]}
        )

    def tts_output(self, text: str):
        """Legacy: maps to tts_event"""
        self.tts_event("speak", {"text": text[:50]})

    def agent_thinking(self, thought: str, component: str = "agent"):
        """Legacy: goes to health log"""
        self._log_health(evt=f"thinking: {thought[:100]}", svc=component)

    def agent_decision(self, decision: str, tools: Optional[List[str]] = None):
        """Legacy: maps to plan_created"""
        self.plan_created(decision, tools)

    def file_operation(
        self,
        operation: str,
        path: Optional[str],
        status: str,
        detail: Optional[str] = None,
        component: str = "tools"
    ):
        """Legacy: now goes to health log"""
        self._log_health(
            evt=f"file_{operation}_{status}",
            svc=component,
            data={"path": path, "detail": detail} if path else None
        )

    def config_change(self, path: str, old_value: Any, new_value: Any):
        """Legacy: goes to health log"""
        self._log_health(
            evt=f"config_changed: {path}",
            svc="config",
            data={"old": str(old_value)[:50], "new": str(new_value)[:50]}
        )

    def info(self, message: str, component: Optional[str] = None, data: Optional[Dict] = None):
        """Generic info - goes to health log unless in request context"""
        self._log_health(evt=message[:200], svc=component or "system", data=data)

    def debug(self, message: str, component: Optional[str] = None, data: Optional[Dict] = None):
        """Generic debug - goes to health log"""
        self._log_health(evt=message[:200], svc=component or "system", data=data)

