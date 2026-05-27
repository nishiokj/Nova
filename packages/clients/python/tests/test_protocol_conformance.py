import json
import pathlib
import unittest

from nova_client import (
    BRIDGE_COMMAND_CHANNEL,
    NOVA_PROTOCOL_VERSION,
    is_bridge_command,
    is_bridge_event,
    is_bus_client_message,
    is_bus_server_message,
    is_rpc_request,
    is_rpc_response,
    run_channel,
    session_channel,
)


class ProtocolConformanceTest(unittest.TestCase):
    def test_shared_fixture_matches_python_validators(self) -> None:
        repo_root = pathlib.Path(__file__).resolve().parents[4]
        fixture_path = repo_root / "packages/core/protocol/fixtures/conformance.json"
        fixture = json.loads(fixture_path.read_text())

        self.assertEqual(fixture["version"], NOVA_PROTOCOL_VERSION)
        self.assertEqual(fixture["channels"]["bridgeCommand"], BRIDGE_COMMAND_CHANNEL)
        self.assertEqual(fixture["channels"]["run"], run_channel("req_abc123"))
        self.assertEqual(fixture["channels"]["session"], session_channel("sess_abc123"))

        for message in fixture["busClientMessages"]:
            self.assertTrue(is_bus_client_message(message))
        for message in fixture["busServerMessages"]:
            self.assertTrue(is_bus_server_message(message))
        for command in fixture["bridgeCommands"]:
            self.assertTrue(is_bridge_command(command))
        for event in fixture["bridgeEvents"]:
            self.assertTrue(is_bridge_event(event))
        for request in fixture["rpcRequests"]:
            self.assertTrue(is_rpc_request(request))
        for response in fixture["rpcResponses"]:
            self.assertTrue(is_rpc_response(response))

    def test_rpc_error_code_rejects_bool(self) -> None:
        self.assertFalse(is_rpc_response({
            "rpc": 1,
            "id": "rpc_bool_error",
            "error": {
                "code": True,
                "message": "boolean is not a protocol number",
            },
        }))


if __name__ == "__main__":
    unittest.main()
