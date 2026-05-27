from __future__ import annotations

import json
import queue
import random
import string
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

from .protocol import (
    BRIDGE_COMMAND_CHANNEL,
    is_bridge_event,
    is_rpc_response,
    rpc_request,
    run_channel,
    session_channel,
)

BridgeEvent = dict[str, Any]
BridgeCommand = dict[str, Any]
EventCallback = Callable[[BridgeEvent, str], None]
ErrorCallback = Callable[[dict[str, Any]], None]


class NovaClientError(RuntimeError):
    pass


class NovaRpcError(NovaClientError):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class _PendingRpc:
    event: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: Optional[BaseException] = None


@dataclass
class _EventWaiter:
    event_type: str
    request_id: Optional[str]
    event: threading.Event = field(default_factory=threading.Event)
    data: Optional[dict[str, Any]] = None


class NovaClient:
    def __init__(
        self,
        host: str,
        port: int,
        *,
        auth_token: Optional[str] = None,
        request_timeout: float = 120.0,
        on_event: Optional[EventCallback] = None,
        on_error: Optional[ErrorCallback] = None,
    ) -> None:
        self.host = host
        self.port = port
        self.auth_token = auth_token.strip() if auth_token else None
        self.request_timeout = request_timeout
        self.on_event = on_event
        self.on_error = on_error

        self._ws: Any = None
        self._reader: Optional[threading.Thread] = None
        self._closed = threading.Event()
        self._lock = threading.RLock()
        self._pending: dict[str, _PendingRpc] = {}
        self._waiters: list[_EventWaiter] = []
        self._active_runs: set[str] = set()
        self._subscriptions: set[str] = set()
        self._events: "queue.Queue[tuple[BridgeEvent, str]]" = queue.Queue()
        self._session_key: Optional[str] = None

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self._closed.is_set()

    @property
    def session_key(self) -> Optional[str]:
        return self._session_key

    def connect(self) -> None:
        if self.connected:
            return

        try:
            from websocket import create_connection
        except ImportError as exc:
            raise NovaClientError(
                "Missing dependency 'websocket-client'. Install with: pip install nova-client"
            ) from exc

        headers = []
        if self.auth_token:
            headers.append(f"Authorization: Bearer {self.auth_token}")

        self._closed.clear()
        self._ws = create_connection(
            f"ws://{self.host}:{self.port}",
            timeout=self.request_timeout,
            header=headers,
        )
        self._reader = threading.Thread(target=self._reader_loop, name="nova-client-reader", daemon=True)
        self._reader.start()

    def close(self) -> None:
        self._closed.set()
        with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
            self._waiters.clear()
            self._active_runs.clear()
            self._subscriptions.clear()
            self._session_key = None

        for item in pending:
            item.error = NovaClientError("Connection closed")
            item.event.set()

        ws = self._ws
        self._ws = None
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass

    def subscribe(self, channel: str) -> None:
        with self._lock:
            if channel in self._subscriptions:
                return
            self._subscriptions.add(channel)
        self._send_bus({"type": "subscribe", "channel": channel})

    def unsubscribe(self, channel: str) -> None:
        with self._lock:
            if channel not in self._subscriptions:
                return
            self._subscriptions.remove(channel)
        self._send_bus({"type": "unsubscribe", "channel": channel})

    def publish(self, channel: str, payload: Any) -> None:
        self._send_bus({"type": "publish", "channel": channel, "payload": payload})

    def send(self, command: BridgeCommand) -> bool:
        if not self.connected:
            self._emit_error({"message": "Not connected to bridge"})
            return False

        command = dict(command)
        data = dict(command.get("data") or {})
        command_type = command.get("type")

        if command_type in {"send_text", "send_media"}:
            request_id = data.get("client_request_id")
            if not isinstance(request_id, str) or not request_id:
                request_id = _generate_request_id()
                data["client_request_id"] = request_id
            self.subscribe_run(request_id)
            command["data"] = data

        if command_type in {"user_prompt_response", "permission_response"}:
            request_id = data.get("request_id")
            if isinstance(request_id, str) and request_id:
                self.subscribe_run(request_id)

        self.publish(BRIDGE_COMMAND_CHANNEL, command)
        return True

    def request(self, method: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        if not self.connected:
            raise NovaClientError("Not connected to bridge")

        request_id = _generate_rpc_id()
        pending = _PendingRpc()
        with self._lock:
            self._pending[request_id] = pending

        try:
            self.publish(BRIDGE_COMMAND_CHANNEL, rpc_request(method, request_id, params))
        except Exception:
            with self._lock:
                self._pending.pop(request_id, None)
            raise

        if not pending.event.wait(self.request_timeout):
            with self._lock:
                self._pending.pop(request_id, None)
            raise NovaClientError(f"RPC timeout for method {method}")

        if pending.error:
            raise pending.error
        return pending.result

    def init_session(
        self,
        *,
        session_key: Optional[str] = None,
        working_dir: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> dict[str, Any]:
        waiter = self._add_waiter("ready", None)
        data: dict[str, Any] = {}
        if session_key:
            data["session_key"] = session_key
        if working_dir:
            data["working_dir"] = working_dir
        try:
            if not self.send({"type": "init", "data": data}):
                raise NovaClientError("Not connected to bridge")
            return self._wait(waiter, timeout)
        except Exception:
            self._remove_waiter(waiter)
            raise

    def send_text(
        self,
        text: str,
        *,
        session_key: Optional[str] = None,
        working_dir: Optional[str] = None,
        tier: Optional[str] = None,
        attachments: Optional[list[dict[str, Any]]] = None,
        request_id: Optional[str] = None,
    ) -> str:
        if session_key:
            self.subscribe_session(session_key)

        resolved_request_id = request_id or _generate_request_id()
        data: dict[str, Any] = {
            "text": text,
            "client_request_id": resolved_request_id,
        }
        if working_dir:
            data["working_dir"] = working_dir
        if tier:
            data["tier"] = tier
        if attachments:
            data["attachments"] = attachments

        if not self.send({"type": "send_text", "data": data}):
            raise NovaClientError("Not connected to bridge")
        return resolved_request_id

    def send_media(
        self,
        attachments: list[dict[str, Any]],
        *,
        text: Optional[str] = None,
        session_key: Optional[str] = None,
        working_dir: Optional[str] = None,
        tier: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> str:
        if session_key:
            self.subscribe_session(session_key)

        resolved_request_id = request_id or _generate_request_id()
        data: dict[str, Any] = {
            "attachments": attachments,
            "client_request_id": resolved_request_id,
        }
        if text:
            data["text"] = text
        if working_dir:
            data["working_dir"] = working_dir
        if tier:
            data["tier"] = tier

        if not self.send({"type": "send_media", "data": data}):
            raise NovaClientError("Not connected to bridge")
        return resolved_request_id

    def run_to_completion(
        self,
        text: str,
        *,
        session_key: Optional[str] = None,
        working_dir: Optional[str] = None,
        tier: Optional[str] = None,
        attachments: Optional[list[dict[str, Any]]] = None,
        request_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> dict[str, Any]:
        resolved_request_id = request_id or _generate_request_id()
        waiter = self._add_waiter("response", resolved_request_id)
        try:
            self.send_text(
                text,
                session_key=session_key,
                working_dir=working_dir,
                tier=tier,
                attachments=attachments,
                request_id=resolved_request_id,
            )
            return self._wait(waiter, timeout)
        except Exception:
            self._remove_waiter(waiter)
            raise

    def respond_to_prompt(self, request_id: str, answer: str) -> None:
        if not self.send({
            "type": "user_prompt_response",
            "data": {"request_id": request_id, "answer": answer},
        }):
            raise NovaClientError("Not connected to bridge")

    def respond_to_permission(
        self,
        request_id: str,
        *,
        decision: str = "allow",
        pattern: Optional[str] = None,
    ) -> None:
        data: dict[str, Any] = {"request_id": request_id, "decision": decision}
        if pattern:
            data["pattern"] = pattern
        if not self.send({"type": "permission_response", "data": data}):
            raise NovaClientError("Not connected to bridge")

    def health(self) -> dict[str, Any]:
        return self.request("service.health", {})

    def readiness(self) -> dict[str, Any]:
        return self.request("service.readiness", {})

    def list_sessions(self, **params: Any) -> dict[str, Any]:
        return self.request("session.list", params)

    def subscribe_session(self, session_key: str) -> None:
        self._session_key = session_key
        self.subscribe(session_channel(session_key))

    def subscribe_run(self, request_id: str) -> None:
        with self._lock:
            self._active_runs.add(request_id)
        self.subscribe(run_channel(request_id))

    def unsubscribe_run(self, request_id: str) -> None:
        with self._lock:
            self._active_runs.discard(request_id)
        self.unsubscribe(run_channel(request_id))

    def next_event(self, timeout: Optional[float] = None) -> tuple[BridgeEvent, str]:
        return self._events.get(timeout=timeout)

    def _send_bus(self, message: Mapping[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            raise NovaClientError("Not connected to bridge")
        ws.send(json.dumps(dict(message), separators=(",", ":")))

    def _reader_loop(self) -> None:
        while not self._closed.is_set():
            try:
                raw = self._ws.recv()
            except Exception as exc:
                if not self._closed.is_set():
                    self._emit_error({"message": "bus_client_error", "detail": str(exc)})
                    self._handle_disconnect(NovaClientError(str(exc)))
                return

            if raw is None:
                self._handle_disconnect(NovaClientError("Connection closed"))
                return
            try:
                message = json.loads(raw)
            except json.JSONDecodeError as exc:
                self._emit_error({"message": "invalid_json", "detail": str(exc)})
                continue

            message_type = message.get("type") if isinstance(message, dict) else None
            if message_type == "event":
                self._handle_bus_event(message.get("payload"), message.get("channel", ""))
            elif message_type == "error":
                self._emit_error({"message": message.get("message"), "detail": message.get("detail")})

    def _handle_bus_event(self, payload: Any, channel: str) -> None:
        if is_rpc_response(payload):
            pending = None
            with self._lock:
                pending = self._pending.pop(payload["id"], None)
            if pending:
                if "error" in payload:
                    error = payload["error"]
                    pending.error = NovaRpcError(int(error["code"]), str(error["message"]))
                else:
                    pending.result = payload.get("result")
                pending.event.set()
            return

        if not is_bridge_event(payload):
            self._emit_error({"message": "Malformed event from bridge"})
            return

        event = payload
        data = event.get("data") or {}
        event_type = event.get("type")

        if event_type == "ready":
            session_key = data.get("session_key")
            if isinstance(session_key, str) and session_key and session_key != self._session_key:
                previous = self._session_key
                if previous:
                    self.unsubscribe(session_channel(previous))
                self._session_key = session_key
                self.subscribe(session_channel(session_key))

        if event_type == "response":
            request_id = data.get("request_id")
            if isinstance(request_id, str) and request_id in self._active_runs:
                self.unsubscribe_run(request_id)

        self._events.put((event, channel))
        self._notify_waiters(event)
        if self.on_event:
            self.on_event(event, channel)

    def _emit_error(self, payload: dict[str, Any]) -> None:
        if self.on_error:
            self.on_error(payload)

    def _add_waiter(self, event_type: str, request_id: Optional[str]) -> _EventWaiter:
        waiter = _EventWaiter(event_type=event_type, request_id=request_id)
        with self._lock:
            self._waiters.append(waiter)
        return waiter

    def _remove_waiter(self, waiter: _EventWaiter) -> None:
        with self._lock:
            if waiter in self._waiters:
                self._waiters.remove(waiter)

    def _wait(self, waiter: _EventWaiter, timeout: Optional[float]) -> dict[str, Any]:
        resolved_timeout = self.request_timeout if timeout is None else timeout
        if not waiter.event.wait(resolved_timeout):
            self._remove_waiter(waiter)
            raise NovaClientError(f"Timed out waiting for {waiter.event_type}")
        return waiter.data or {}

    def _handle_disconnect(self, error: BaseException) -> None:
        with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
            self._waiters.clear()
            self._active_runs.clear()
            self._subscriptions.clear()
            self._session_key = None

        for item in pending:
            item.error = error
            item.event.set()

        self._closed.set()
        self._ws = None

    def _notify_waiters(self, event: BridgeEvent) -> None:
        data = event.get("data") or {}
        matched: list[_EventWaiter] = []

        with self._lock:
            for waiter in self._waiters:
                if event.get("type") != waiter.event_type:
                    continue
                if waiter.request_id is not None and data.get("request_id") != waiter.request_id:
                    continue
                waiter.data = data
                waiter.event.set()
                matched.append(waiter)

            for waiter in matched:
                if waiter in self._waiters:
                    self._waiters.remove(waiter)


def _generate_request_id() -> str:
    return f"req_{int(time.time() * 1000)}_{_random_suffix(6)}"


def _generate_rpc_id() -> str:
    return f"rpc_{int(time.time() * 1000)}_{_random_suffix(7)}"


def _random_suffix(length: int) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(length))
