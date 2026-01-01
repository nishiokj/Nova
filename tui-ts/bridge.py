#!/usr/bin/env python3
"""JSONL bridge for the Ink TUI.

Owns EventBus + ProcessManager, proxies events over JSONL stdin/stdout.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import sys
import threading
import time
from multiprocessing import Queue as MPQueue
from typing import Any, Dict, Optional

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(PROJECT_ROOT, "src")

# Add PROJECT_ROOT so we can import 'tui' as a package
# Add SRC_DIR so we can import src modules directly
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

from app_config import load_app_config, AppConfig
from communication import EventBus, Mailbox
from communication.events import (
    AgentProgressEvent,
    AgentResponseCompleteEvent,
    EventType,
    StreamingChunkEvent,
    TranscriptionCompleteEvent,
)
from communication.process_manager import ProcessManager
from harness.graphd import generate_session_key
from tui.logging_config import configure_tui_logging
from tui.voice_service import VoiceService
from util.config import ServiceRepConfig, load_or_create_config
from util.logger import StructuredLogger
from skills.store import SkillStore, StoreError as SkillStoreError
from hooks.store import HookStore, StoreError as HookStoreError
from workers.console_tts_worker import ConsoleTTSWorker
from workers.service_rep_worker import ServiceRepWorker


class JSONLBridge:
    """Bridge between the Ink UI and the backend EventBus."""

    def __init__(self) -> None:
        self._initialized = False
        self._shutdown = False
        self._session_key: Optional[str] = None
        self._request_counter = 0
        self._log_transcripts = True

        self._state = "idle"
        self._state_message = "Ready"

        self._out_queue: queue.Queue[Dict[str, Any]] = queue.Queue()
        self._writer_thread = threading.Thread(
            target=self._writer_loop,
            daemon=True,
            name="BridgeWriter",
        )
        self._writer_thread.start()

        self.logger = logging.getLogger("tui.bridge")
        self.event_bus: Optional[EventBus] = None
        self.process_manager: Optional[ProcessManager] = None
        self.response_mailbox: Optional[Mailbox] = None
        self.streaming_mailbox: Optional[Mailbox] = None
        self.progress_mailbox: Optional[Mailbox] = None
        self.voice_mailbox: Optional[Mailbox] = None
        self.voice_service: Optional[VoiceService] = None
        self.event_thread: Optional[threading.Thread] = None
        self.config: Optional[AppConfig] = None
        self.log_dir: Optional[str] = None
        self.harness_config = None
        self.skill_store: Optional[SkillStore] = None
        self.hook_store: Optional[HookStore] = None
        self.hook_manager = None
        self.tool_registry = None
        self.skill_runner = None

    def run(self) -> None:
        try:
            for line in sys.stdin:
                if self._shutdown:
                    break
                self._handle_line(line)
        except KeyboardInterrupt:
            pass
        finally:
            self.shutdown()

    def _handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            self._send_error("Invalid JSON", detail=str(exc))
            return

        cmd_type = payload.get("type")
        data = payload.get("data") or {}
        if not isinstance(data, dict):
            data = {}
        if not cmd_type:
            self._send_error("Command missing type")
            return

        if cmd_type != "init" and not self._initialized:
            self._send_error("Bridge not initialized", detail="Send init first")
            return

        # Skills and hooks are read-only in TUI. Create/update/delete via agent file_write.
        handler = {
            "init": self._handle_init,
            "send_text": self._handle_send_text,
            "user_prompt_response": self._handle_user_prompt_response,
            "voice_start": self._handle_voice_start,
            "voice_stop": self._handle_voice_stop,
            "get_config": self._handle_get_config,
            "get_models": self._handle_get_models,
            "get_status": self._handle_get_status,
            "skills_list": self._handle_skills_list,
            "hooks_list": self._handle_hooks_list,
            "shutdown": self._handle_shutdown,
        }.get(cmd_type)

        if not handler:
            self._send_error("Unknown command", detail=str(cmd_type))
            return

        handler(data)

    def _handle_init(self, data: Dict[str, Any]) -> None:
        if self._initialized:
            self._send_ready()
            return

        try:
            config_path = data.get("config_path")
            log_dir = data.get("log_dir")
            enable_voice = bool(data.get("enable_voice", True))
            self._log_transcripts = bool(data.get("log_transcripts", True))

            if not log_dir:
                log_dir = os.path.join(PROJECT_ROOT, "tui", "logs")
            self.log_dir = log_dir

            configure_tui_logging(
                log_dir=log_dir,
                level=logging.INFO,
                enable_console=False,
                enable_file=True,
            )

            os.environ["LOG_TO_CONSOLE"] = "false"
            os.environ["LOG_LEVEL"] = "WARNING"

            self.config = load_app_config(config_path) if config_path else load_app_config()
            self._session_key = generate_session_key("tui")

            self._setup_event_bus()
            self._start_workers()

            if enable_voice:
                self._setup_voice()

            self._setup_skills_hooks()

            self._initialized = True
            self._set_state("idle", "Ready")
            self._send_ready()
        except Exception as exc:
            self._send_error("Init failed", detail=str(exc), fatal=True)
            self.shutdown()

    def _setup_event_bus(self) -> None:
        self.event_bus = EventBus()

        self.response_mailbox = Mailbox("bridge_responses", MPQueue())
        self.response_mailbox.subscribe_to(self.event_bus, EventType.AGENT_RESPONSE_COMPLETE)

        self.streaming_mailbox = Mailbox("bridge_streaming", MPQueue())
        self.streaming_mailbox.subscribe_to(self.event_bus, EventType.STREAMING_CHUNK)

        self.progress_mailbox = Mailbox("bridge_progress", MPQueue())
        self.progress_mailbox.subscribe_to(self.event_bus, EventType.AGENT_PROGRESS)

        self.event_thread = threading.Thread(
            target=self._event_loop,
            daemon=True,
            name="BridgeEventLoop",
        )
        self.event_thread.start()

    def _start_workers(self) -> None:
        if not self.config:
            raise RuntimeError("Config not loaded")

        import multiprocessing as mp

        if mp.get_start_method(allow_none=True) != "spawn":
            mp.set_start_method("spawn", force=True)

        os.environ.setdefault("TUI_REDIRECT_WORKER_STDOUT", "1")

        self.process_manager = ProcessManager(
            event_bus=self.event_bus,
            check_interval=self.config.runtime.health_check_interval_s,
        )

        self.process_manager.register_worker(
            worker_id="tts",
            worker_class=ConsoleTTSWorker,
            subscribe_to=[EventType.TTS_REQUESTED],
            worker_kwargs={},
        )

        service_rep_config = ServiceRepConfig(enabled=True, llm_config=None)
        self.process_manager.register_worker(
            worker_id="service_rep",
            worker_class=ServiceRepWorker,
            subscribe_to=[EventType.TRANSCRIPTION_COMPLETE],
            worker_kwargs={
                "event_bus": self.event_bus,
                "service_rep_config": service_rep_config,
                "harness_config_path": self.config.harness.config_path,
                "log_dir": self.log_dir,
            },
        )

        self.process_manager.start()
        time.sleep(0.5)

    def _setup_voice(self) -> None:
        if not self.event_bus:
            return

        self.voice_mailbox = Mailbox("bridge_transcription", MPQueue())
        self.voice_service = VoiceService(
            event_bus=self.event_bus,
            transcription_mailbox=self.voice_mailbox,
        )

        def on_voice_error(message: str) -> None:
            self._send_error(message)

        self.voice_service.on_error = on_voice_error
        started = self.voice_service.start()
        if not started:
            self.voice_service = None
            self.voice_mailbox = None

    def _setup_skills_hooks(self) -> None:
        if not self.config:
            return
        try:
            self.harness_config = load_or_create_config(self.config.harness.config_path)
            structured_logger = StructuredLogger(
                log_dir=self.log_dir or "logs",
                log_to_file=False,
                log_to_console=False,
                log_level="INFO",
            )
            self.skill_store = SkillStore(self.harness_config.skills.skills_dir, logger=structured_logger)
            self.hook_store = HookStore(self.harness_config.hooks.hooks_dir, logger=structured_logger)
            self.hook_manager = None
            self.tool_registry = None
            self.skill_runner = None
        except Exception as exc:
            self.logger.warning(f"Skill/hook setup failed: {exc}")

    def _handle_send_text(self, data: Dict[str, Any]) -> None:
        if not self.event_bus:
            self._send_error("Event bus not ready")
            return

        text = data.get("text")
        if not isinstance(text, str) or not text.strip():
            return

        request_id = data.get("client_request_id")
        if not request_id:
            self._request_counter += 1
            request_id = f"ink_{self._request_counter}_{int(time.time() * 1000) % 100000}"

        self._set_state("sending", "Sending...")

        if self._log_transcripts:
            self.logger.info("send_text", extra={"request_id": request_id})

        event = TranscriptionCompleteEvent(
            request_id=request_id,
            text=text,
            confidence=None,
            duration_ms=0.0,
            session_key=self._session_key,
        )
        self.event_bus.publish(event)

    def _handle_user_prompt_response(self, data: Dict[str, Any]) -> None:
        """Handle user's response to an ask_user prompt."""
        answer = data.get("answer")
        if not isinstance(answer, str):
            self._send_error("Answer required for user_prompt_response")
            return

        request_id = data.get("request_id", f"prompt_response_{int(time.time() * 1000)}")

        self._set_state("processing", "Processing response...")

        # The answer will be forwarded to the service_rep_worker
        # which will call harness.resume_with_answer()
        # For now, we send it as a special transcription event
        event = TranscriptionCompleteEvent(
            request_id=request_id,
            text=f"[USER_PROMPT_RESPONSE] {answer}",
            confidence=None,
            duration_ms=0.0,
            session_key=self._session_key,
            metadata={"is_prompt_response": True, "answer": answer},
        )
        self.event_bus.publish(event)

    def _handle_voice_start(self, data: Dict[str, Any]) -> None:
        if not self.voice_service or not self.voice_service.is_active:
            self._send_error("Voice not available")
            return

        if self.voice_service.is_recording:
            return

        self.voice_service.begin_recording()
        self._set_state("recording", "Recording...")

    def _handle_voice_stop(self, data: Dict[str, Any]) -> None:
        if not self.voice_service or not self.voice_service.is_active:
            return

        self.voice_service.end_recording()
        self._set_state("transcribing", "Transcribing...")

    def _handle_get_config(self, data: Dict[str, Any]) -> None:
        if not self.config:
            return
        text = format_config_summary(self.config, self.log_dir)
        self._send_response(kind="config", content=text)

    def _handle_get_models(self, data: Dict[str, Any]) -> None:
        text = format_models_summary()
        self._send_response(kind="models", content=text)

    def _handle_get_status(self, data: Dict[str, Any]) -> None:
        text, meta = format_status_summary(self)
        self._send_response(kind="status", content=text, metadata=meta)

    def _handle_skills_list(self, data: Dict[str, Any]) -> None:
        """List skills (read-only). To create/edit, use the agent with file_write."""
        if not self.skill_store:
            self._send_error("Skills not initialized")
            return
        result = self.skill_store.list()
        items = [skill.model_dump() for skill in result.items]
        content = format_skill_list(items, result.errors)
        payload = {"action": "list", "items": items, "errors": result.errors}
        self._send_response(kind="skills", content=content, payload=payload)

    def _handle_hooks_list(self, data: Dict[str, Any]) -> None:
        """List hooks (read-only). To create/edit, use the agent with file_write."""
        if not self.hook_store:
            self._send_error("Hooks not initialized")
            return
        result = self.hook_store.list()
        items = [hook.model_dump() for hook in result.items]
        content = format_hook_list(items, result.errors)
        payload = {"action": "list", "items": items, "errors": result.errors}
        self._send_response(kind="hooks", content=content, payload=payload)

    def _handle_shutdown(self, data: Dict[str, Any]) -> None:
        self.shutdown()
        raise SystemExit(0)

    def _send_ready(self) -> None:
        capabilities = {
            "voice_available": bool(self.voice_service and self.voice_service.is_active),
            "streaming_supported": True,
        }
        config_summary = format_config_summary(self.config, self.log_dir) if self.config else ""
        self._send_event(
            "ready",
            {
                "session_key": self._session_key,
                "log_dir": self.log_dir,
                "capabilities": capabilities,
                "config_summary": config_summary,
            },
        )

    def _send_response(
        self,
        kind: str,
        content: str,
        payload: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        meta = {"kind": kind}
        if payload is not None:
            meta["payload"] = payload
        if metadata:
            meta.update(metadata)
        self._send_event(
            "response",
            {
                "request_id": f"{kind}_{int(time.time() * 1000)}",
                "success": True,
                "content": content,
                "metadata": meta,
            },
        )

    def _event_loop(self) -> None:
        while not self._shutdown:
            try:
                if self.response_mailbox:
                    event = self.response_mailbox.receive(timeout=0.01)
                    if isinstance(event, AgentResponseCompleteEvent):
                        self._handle_agent_response(event)

                if self.streaming_mailbox:
                    event = self.streaming_mailbox.receive(timeout=0.01)
                    if isinstance(event, StreamingChunkEvent):
                        self._handle_stream_chunk(event)

                if self.progress_mailbox:
                    event = self.progress_mailbox.receive(timeout=0.01)
                    if isinstance(event, AgentProgressEvent):
                        self._handle_progress(event)

                if self.voice_mailbox:
                    event = self.voice_mailbox.receive(timeout=0.01)
                    if isinstance(event, TranscriptionCompleteEvent):
                        self._handle_transcription(event)
            except Exception as exc:
                self.logger.error(f"Bridge event loop error: {exc}")
                time.sleep(0.05)

    def _handle_progress(self, event: AgentProgressEvent) -> None:
        self._send_event(
            "progress",
            {
                "request_id": event.request_id,
                "message": event.message,
                "tool_name": event.tool_name,
                "step_number": event.step_number,
            },
        )

    def _handle_stream_chunk(self, event: StreamingChunkEvent) -> None:
        if event.is_final:
            self._set_state("idle", "Ready")
        else:
            self._set_state("streaming", "Receiving response...")

        self._send_event(
            "stream",
            {
                "request_id": event.request_id,
                "chunk": event.chunk,
                "chunk_index": event.chunk_index,
                "is_final": event.is_final,
            },
        )

    def _handle_agent_response(self, event: AgentResponseCompleteEvent) -> None:
        safe_metadata = ensure_jsonable(event.metadata)

        # Check if this is a paused response awaiting user input
        is_paused = safe_metadata.get("paused", False)
        user_prompt = safe_metadata.get("user_prompt")

        if is_paused and user_prompt:
            self._set_state("awaiting_input", "Waiting for your response...")
            self._send_event(
                "user_prompt",
                {
                    "request_id": event.request_id,
                    "question": user_prompt.get("question", ""),
                    "options": user_prompt.get("options", []),
                    "context": user_prompt.get("context", ""),
                },
            )
        else:
            self._set_state("idle", "Ready")

        self._send_event(
            "response",
            {
                "request_id": event.request_id,
                "success": event.success,
                "content": event.content,
                "spoken_response": event.spoken_response,
                "tools_used": event.tools_used,
                "duration_ms": event.duration_ms,
                "error": event.error,
                "metadata": safe_metadata,
                "paused": is_paused,
                "user_prompt": user_prompt,
            },
        )

    def _handle_transcription(self, event: TranscriptionCompleteEvent) -> None:
        if not event.request_id or not event.request_id.startswith("ptt_"):
            return

        self._set_state("idle", "Ready")
        self._send_event(
            "transcription",
            {
                "text": event.text,
                "request_id": event.request_id,
                "duration_ms": event.duration_ms,
            },
        )

    def _set_state(self, state: str, message: str) -> None:
        if state == self._state and message == self._state_message:
            return
        self._state = state
        self._state_message = message
        self._send_event("status", {"state": state, "message": message})

    def _send_error(self, message: str, detail: Optional[str] = None, fatal: bool = False) -> None:
        self._send_event(
            "error",
            {
                "message": message,
                "detail": detail,
                "fatal": fatal,
            },
        )

    def _send_event(self, event_type: str, data: Dict[str, Any]) -> None:
        self._out_queue.put({"type": event_type, "data": data})

    def _writer_loop(self) -> None:
        while not self._shutdown:
            try:
                item = self._out_queue.get(timeout=0.1)
            except queue.Empty:
                continue

            try:
                payload = json.dumps(item, ensure_ascii=True)
                sys.stdout.write(payload + "\n")
                sys.stdout.flush()
            except Exception:
                # Never allow logging to stdout here.
                pass

    def shutdown(self) -> None:
        if self._shutdown:
            return

        self._shutdown = True

        try:
            if self.voice_service:
                self.voice_service.stop()
        except Exception:
            pass

        try:
            if self.process_manager:
                self.process_manager.stop()
        except Exception:
            pass

        try:
            if self.event_bus:
                self.event_bus.shutdown()
        except Exception:
            pass

        try:
            if self._writer_thread.is_alive():
                self._writer_thread.join(timeout=1.0)
        except Exception:
            pass


def format_skill_list(items: list[dict[str, Any]], errors: list[dict[str, Any]]) -> str:
    if not items:
        lines = ["No skills found."]
    else:
        lines = ["Skills:"]
        for skill in items:
            enabled = "enabled" if skill.get("enabled", False) else "disabled"
            name = skill.get("name", "")
            lines.append(f"- {skill.get('id')} [{enabled}] {name}")
    if errors:
        lines.append("")
        lines.append("Errors:")
        for err in errors:
            lines.append(f"- {err.get('path')}: {err.get('message')}")
    return "\n".join(lines)


def format_hook_list(items: list[dict[str, Any]], errors: list[dict[str, Any]]) -> str:
    if not items:
        lines = ["No hooks found."]
    else:
        lines = ["Hooks:"]
        for hook in items:
            enabled = "enabled" if hook.get("enabled", False) else "disabled"
            name = hook.get("name", "")
            lines.append(f"- {hook.get('id')} [{enabled}] {name}")
    if errors:
        lines.append("")
        lines.append("Errors:")
        for err in errors:
            lines.append(f"- {err.get('path')}: {err.get('message')}")
    return "\n".join(lines)


def format_config_summary(config: AppConfig, log_dir: Optional[str]) -> str:
    lines = [
        "Configuration",
        "",
        f"Runtime Mode: {config.runtime.mode.value}",
        f"Log Level: {config.logging.level}",
        f"Log Directory: {log_dir or config.logging.log_dir}",
        "",
        f"STT Engine: {config.stt.engine}",
        f"STT Model: {config.stt.model_size}",
        f"STT Device: {config.stt.device}",
        "",
        f"TTS Engine: {config.tts.engine}",
        f"TTS Voice: {config.tts.voice or 'default'}",
        f"TTS Rate: {config.tts.rate}",
        "",
        f"Harness Config: {config.harness.config_path}",
    ]
    return "\n".join(lines)


def format_models_summary() -> str:
    has_openai = bool(os.getenv("OPENAI_API_KEY"))
    has_anthropic = bool(os.getenv("ANTHROPIC_API_KEY"))
    has_google = bool(os.getenv("GOOGLE_API_KEY"))

    def status(ok: bool) -> str:
        return "Configured" if ok else "Not configured"

    lines = [
        "LLM Models & API Keys",
        "",
        f"OpenAI: {status(has_openai)}",
        f"Anthropic: {status(has_anthropic)}",
        f"Google: {status(has_google)}",
    ]
    return "\n".join(lines)


def format_status_summary(bridge: JSONLBridge) -> tuple[str, Dict[str, Any]]:
    workers = {
        "service_rep": "not_started",
        "tts": "not_started",
    }
    if bridge.process_manager:
        workers["service_rep"] = bridge.process_manager.get_worker_status("service_rep")
        workers["tts"] = bridge.process_manager.get_worker_status("tts")

    lines = [
        "Runtime Status",
        "",
        f"State: {bridge._state}",
        f"Message: {bridge._state_message}",
        f"Session Key: {bridge._session_key or '-'}",
        f"Event Bus: {'Connected' if bridge.event_bus else 'Not connected'}",
        f"Workers: service_rep={workers['service_rep']}, tts={workers['tts']}",
    ]

    meta = {
        "state": bridge._state,
        "message": bridge._state_message,
        "session_key": bridge._session_key,
        "workers": workers,
    }

    return "\n".join(lines), meta


def ensure_jsonable(payload: Any) -> Any:
    try:
        json.dumps(payload)
        return payload
    except TypeError:
        return json.loads(json.dumps(payload, default=str))


def main() -> int:
    bridge = JSONLBridge()
    bridge.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
