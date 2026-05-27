import json
import threading
import time
import unittest
from typing import Any

from nova_client import BRIDGE_COMMAND_CHANNEL, NovaClient
from nova_client.client import _PendingRpc


class FakeWebSocket:
    def __init__(self, *, fail_send: bool = False) -> None:
        self.sent: list[dict[str, Any]] = []
        self.closed = False
        self.fail_send = fail_send
        self._condition = threading.Condition()

    def send(self, payload: str) -> None:
        if self.fail_send:
            raise OSError("send failed")
        with self._condition:
            self.sent.append(json.loads(payload))
            self._condition.notify_all()

    def close(self) -> None:
        self.closed = True

    def wait_for(self, predicate: Any, timeout: float = 1.0) -> dict[str, Any]:
        deadline = time.time() + timeout
        with self._condition:
            while time.time() < deadline:
                for item in self.sent:
                    if predicate(item):
                        return item
                self._condition.wait(0.01)
        raise AssertionError("timed out waiting for sent websocket message")


class FailingRecvWebSocket(FakeWebSocket):
    def recv(self) -> str:
        raise OSError("connection lost")


class NovaClientTest(unittest.TestCase):
    def test_rpc_request_correlates_response(self) -> None:
        ws = FakeWebSocket()
        client = NovaClient("127.0.0.1", 9555, request_timeout=1)
        client._ws = ws

        result: list[dict[str, Any]] = []
        thread = threading.Thread(
            target=lambda: result.append(client.request("service.health", {})),
            daemon=True,
        )
        thread.start()

        sent = ws.wait_for(
            lambda item: item["type"] == "publish"
            and item["channel"] == BRIDGE_COMMAND_CHANNEL
            and item["payload"]["method"] == "service.health"
        )
        client._handle_bus_event(
            {
                "rpc": 1,
                "id": sent["payload"]["id"],
                "result": {"success": True, "status": "ok"},
            },
            "direct",
        )

        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, [{"success": True, "status": "ok"}])

    def test_run_to_completion_subscribes_and_returns_response(self) -> None:
        ws = FakeWebSocket()
        client = NovaClient("127.0.0.1", 9555, request_timeout=1)
        client._ws = ws

        result: list[dict[str, Any]] = []
        thread = threading.Thread(
            target=lambda: result.append(client.run_to_completion("hello", request_id="req_test")),
            daemon=True,
        )
        thread.start()

        ws.wait_for(lambda item: item == {"type": "subscribe", "channel": "run:req_test"})
        sent = ws.wait_for(
            lambda item: item["type"] == "publish"
            and item["payload"]["type"] == "send_text"
            and item["payload"]["data"]["client_request_id"] == "req_test"
        )
        self.assertEqual(sent["payload"]["data"]["text"], "hello")

        client._handle_bus_event(
            {
                "type": "response",
                "data": {
                    "request_id": "req_test",
                    "success": True,
                    "content": "done",
                },
            },
            "run:req_test",
        )

        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, [{"request_id": "req_test", "success": True, "content": "done"}])
        self.assertIn({"type": "unsubscribe", "channel": "run:req_test"}, ws.sent)

    def test_rpc_publish_failure_removes_pending_request(self) -> None:
        client = NovaClient("127.0.0.1", 9555, request_timeout=1)
        client._ws = FakeWebSocket(fail_send=True)

        with self.assertRaises(OSError):
            client.request("service.health", {})

        self.assertEqual(client._pending, {})

    def test_init_session_send_failure_removes_waiter(self) -> None:
        client = NovaClient("127.0.0.1", 9555, request_timeout=1)
        client._ws = FakeWebSocket(fail_send=True)

        with self.assertRaises(OSError):
            client.init_session()

        self.assertEqual(client._waiters, [])

    def test_run_to_completion_send_failure_removes_waiter(self) -> None:
        client = NovaClient("127.0.0.1", 9555, request_timeout=1)
        client._ws = FakeWebSocket(fail_send=True)

        with self.assertRaises(OSError):
            client.run_to_completion("hello", request_id="req_test")

        self.assertEqual(client._waiters, [])

    def test_reader_error_marks_client_disconnected_and_rejects_pending_rpc(self) -> None:
        errors: list[dict[str, Any]] = []
        client = NovaClient("127.0.0.1", 9555, request_timeout=1, on_error=errors.append)
        client._ws = FailingRecvWebSocket()
        pending = client._pending["rpc_test"] = _PendingRpc()

        client._reader_loop()

        self.assertFalse(client.connected)
        self.assertEqual(client._pending, {})
        self.assertTrue(pending.event.is_set())
        self.assertIsNotNone(pending.error)
        self.assertEqual(errors[0]["message"], "bus_client_error")


if __name__ == "__main__":
    unittest.main()
