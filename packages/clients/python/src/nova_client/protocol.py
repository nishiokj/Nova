from __future__ import annotations

from typing import Any, Mapping, MutableMapping, Set

NOVA_PROTOCOL_VERSION = "0.1"
BRIDGE_COMMAND_CHANNEL = "bridge_command"

BRIDGE_COMMAND_TYPES: Set[str] = {
    "init",
    "send_text",
    "send_media",
    "user_prompt_response",
    "permission_response",
}

BRIDGE_EVENT_TYPES: Set[str] = {
    "ready",
    "status",
    "progress",
    "stream",
    "response",
    "transcription",
    "user_prompt",
    "error",
    "provider_key_required",
    "model_changed",
    "permission_request",
    "llm_call",
}


def bridge_command_types() -> Set[str]:
    return set(BRIDGE_COMMAND_TYPES)


def bridge_event_types() -> Set[str]:
    return set(BRIDGE_EVENT_TYPES)


def run_channel(request_id: str) -> str:
    return f"run:{request_id}"


def session_channel(session_key: str) -> str:
    return f"session:{session_key}"


def is_record(value: Any) -> bool:
    return isinstance(value, MutableMapping)


def is_protocol_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_bridge_command(value: Any) -> bool:
    if not is_record(value):
        return False
    message_type = value.get("type")
    data = value.get("data")
    return (
        isinstance(message_type, str)
        and message_type in BRIDGE_COMMAND_TYPES
        and (data is None or is_record(data))
    )


def is_bridge_event(value: Any) -> bool:
    if not is_record(value):
        return False
    message_type = value.get("type")
    data = value.get("data")
    return (
        isinstance(message_type, str)
        and message_type in BRIDGE_EVENT_TYPES
        and (data is None or is_record(data))
    )


def is_bus_client_message(value: Any) -> bool:
    if not is_record(value):
        return False
    message_type = value.get("type")
    if message_type in {"subscribe", "unsubscribe"}:
        return isinstance(value.get("channel"), str)
    if message_type == "publish":
        return isinstance(value.get("channel"), str) and "payload" in value
    return False


def is_bus_server_message(value: Any) -> bool:
    if not is_record(value):
        return False
    message_type = value.get("type")
    if message_type == "event":
        return isinstance(value.get("channel"), str) and "payload" in value
    if message_type == "error":
        return isinstance(value.get("message"), str)
    return False


def is_rpc_request(value: Any) -> bool:
    return (
        is_record(value)
        and value.get("rpc") == 1
        and isinstance(value.get("id"), str)
        and len(value["id"]) > 0
        and isinstance(value.get("method"), str)
        and len(value["method"]) > 0
    )


def is_rpc_response(value: Any) -> bool:
    if not (
        is_record(value)
        and value.get("rpc") == 1
        and isinstance(value.get("id"), str)
        and len(value["id"]) > 0
    ):
        return False

    has_result = "result" in value
    has_error = "error" in value
    if has_result == has_error:
        return False

    if not has_error:
        return True

    error = value.get("error")
    return (
        is_record(error)
        and is_protocol_number(error.get("code"))
        and isinstance(error.get("message"), str)
    )


def rpc_request(method: str, request_id: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
    return {
        "rpc": 1,
        "id": request_id,
        "method": method,
        "params": dict(params or {}),
    }
