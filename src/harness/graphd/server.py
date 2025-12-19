"""HTTP server for graphd."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

from .utils import safe_int


class GraphdHTTPServer:
    def __init__(self, host: str, port: int, handler_factory):
        self.host = host
        self.port = port
        self._server: Optional[ThreadingHTTPServer] = None
        self._handler_factory = handler_factory

    def start(self) -> None:
        self._server = ThreadingHTTPServer((self.host, self.port), self._handler_factory)
        self._server.serve_forever()

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()


class GraphdRequestHandler(BaseHTTPRequestHandler):
    manager = None

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json(self.manager.handle_health())
            return
        if parsed.path == "/symbol":
            params = parse_qs(parsed.query)
            path = params.get("path", [""])[0]
            line = safe_int(params.get("line", [None])[0], 0)
            self._send_json(self.manager.handle_symbol(path, line))
            return
        if parsed.path == "/context":
            params = parse_qs(parsed.query)
            symbol_id = params.get("symbol_id", [""])[0]
            depth = safe_int(params.get("depth", [None])[0], 1)
            self._send_json(self.manager.handle_context(symbol_id, depth))
            return
        if parsed.path == "/export":
            params = parse_qs(parsed.query)
            table = params.get("table", ["files"])[0]
            fmt = params.get("format", ["jsonl"])[0]
            self._send_json(self.manager.handle_export(table, fmt))
            return
        self._send_json({"error": "not_found"}, status=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        payload = self._read_json()
        if parsed.path == "/impact":
            self._send_json(self.manager.handle_impact(payload))
            return
        if parsed.path == "/search":
            self._send_json(self.manager.handle_search(payload))
            return
        if parsed.path == "/control":
            self._send_json(self.manager.handle_control(payload))
            return
        if parsed.path == "/artifact":
            self._send_json(self.manager.handle_artifact(payload))
            return
        self._send_json({"error": "not_found"}, status=404)

    def log_message(self, format, *args):
        return

    def _read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = self.rfile.read(length).decode("utf-8")
            return json.loads(data) if data else {}
        except Exception:
            return {}

    def _send_json(self, payload: Dict[str, Any], status: int = 200) -> None:
        response = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)
