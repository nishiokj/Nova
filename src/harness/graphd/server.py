"""HTTP server for graphd."""

from __future__ import annotations

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

from .utils import safe_int


class ReuseAddrHTTPServer(ThreadingHTTPServer):
    """HTTP server with SO_REUSEADDR to allow quick restarts."""

    allow_reuse_address = True
    daemon_threads = True  # Don't wait for request handler threads on shutdown

    def server_bind(self):
        """Override to set SO_REUSEADDR and SO_REUSEPORT if available."""
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # SO_REUSEPORT allows multiple processes to bind to same port (macOS/Linux)
        if hasattr(socket, 'SO_REUSEPORT'):
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except OSError:
                pass  # Not supported on all systems
        super().server_bind()


class GraphdHTTPServer:
    def __init__(self, host: str, port: int, handler_factory):
        self.host = host
        self.port = port
        self._server: Optional[ReuseAddrHTTPServer] = None
        self._handler_factory = handler_factory
        self._shutdown_event = threading.Event()

    def start(self) -> None:
        """Start the HTTP server with graceful shutdown support."""
        self._server = ReuseAddrHTTPServer((self.host, self.port), self._handler_factory)
        # Use poll_interval to check shutdown flag periodically
        self._server.serve_forever(poll_interval=0.5)

    def stop(self) -> None:
        """Stop the server gracefully with timeout."""
        self._shutdown_event.set()
        if self._server:
            # shutdown() signals serve_forever() to stop
            self._server.shutdown()
            self._server.server_close()
            self._server = None


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
