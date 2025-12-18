"""Graphd HTTP client."""

from __future__ import annotations

import json
import urllib.request
from urllib.parse import quote
from typing import Any, Dict, Optional


class GraphdClient:
    def __init__(self, host: str, port: int, timeout_s: int = 2, enabled: bool = True):
        self.host = host
        self.port = port
        self.timeout_s = timeout_s
        self.enabled = enabled

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def health(self) -> Dict[str, Any]:
        return self._get("/health")

    def symbol(self, path: str, line: int) -> Dict[str, Any]:
        return self._get(f"/symbol?path={quote(path)}&line={line}")

    def context(self, symbol_id: str, depth: int = 1) -> Dict[str, Any]:
        return self._get(f"/context?symbol_id={quote(symbol_id)}&depth={depth}")

    def impact(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("/impact", payload)

    def search(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("/search", payload)

    def control(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("/control", payload)

    def export(self, table: str, fmt: str = "jsonl") -> Dict[str, Any]:
        return self._get(f"/export?table={quote(table)}&format={quote(fmt)}")

    def record_artifact(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("/artifact", payload)

    def _get(self, path: str) -> Dict[str, Any]:
        if not self.enabled:
            return {"error": "graphd_disabled"}
        try:
            req = urllib.request.Request(self.base_url + path, method="GET")
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                data = resp.read().decode("utf-8")
                return json.loads(data) if data else {}
        except Exception as exc:
            return {"error": str(exc)}

    def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.enabled:
            return {"error": "graphd_disabled"}
        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(self.base_url + path, data=data, method="POST")
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                response = resp.read().decode("utf-8")
                return json.loads(response) if response else {}
        except Exception as exc:
            return {"error": str(exc)}
