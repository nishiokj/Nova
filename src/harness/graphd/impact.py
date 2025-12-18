"""Impact inference for graphd."""

from __future__ import annotations

import re
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .derived import DerivedEdgeCache, RipgrepSearch
from .store import GraphStore
from .types import DerivedEdge, ImpactItem
from .utils import is_test_path


class ImpactEngine:
    def __init__(
        self,
        store: GraphStore,
        cache: DerivedEdgeCache,
        search: RipgrepSearch,
        root: str,
        ttl_s: int,
    ):
        self.store = store
        self.cache = cache
        self.search = search
        self.root = root
        self.ttl_s = ttl_s

    def compute(self, request: Dict[str, Any]) -> List[ImpactItem]:
        entity = request.get("entity", {})
        change_type = request.get("change_type", "unknown")
        budget = int(request.get("budget", 20))

        items: List[ImpactItem] = []
        if entity.get("type") == "file":
            path = entity.get("path")
            if path:
                items.extend(self._impact_for_file(path))
        elif entity.get("type") == "symbol":
            items.extend(self._impact_for_symbol(entity, change_type))

        items = self._dedupe(items)
        items.sort(key=lambda x: x.confidence, reverse=True)
        return items[:budget]

    def build_callers_cache(self, symbol_id: str, name: str, path: str) -> None:
        _ = self._callers_for_symbol(symbol_id, name, path)

    def _impact_for_file(self, path: str) -> List[ImpactItem]:
        items: List[ImpactItem] = []
        importers = self.store.get_importers_for_file(path)
        for edge in importers:
            target = edge.get("src_path")
            conf = float(edge.get("confidence", 0.9))
            items.append(
                ImpactItem(
                    kind="imports",
                    target=target,
                    confidence=conf,
                    rationale=f"imports {path}",
                    suggested_verification=f"open {target}",
                    provenance="module_edge",
                )
            )
        for item in list(items):
            if is_test_path(item.target):
                items.append(
                    ImpactItem(
                        kind="tests",
                        target=item.target,
                        confidence=max(item.confidence - 0.1, 0.4),
                        rationale=f"test file imports {path}",
                        suggested_verification=f"run relevant tests in {item.target}",
                        provenance=item.provenance,
                    )
                )
        return items

    def _impact_for_symbol(self, entity: Dict[str, Any], change_type: str) -> List[ImpactItem]:
        symbol = None
        symbol_id = entity.get("symbol_id")
        if symbol_id:
            symbol = self.store.get_symbol(symbol_id)
        if not symbol:
            path = entity.get("path")
            line = entity.get("line")
            if path and line:
                symbol = self.store.find_symbol_by_position(path, int(line))
        if not symbol:
            return []

        name = symbol.get("name")
        path = symbol.get("path")
        symbol_id = symbol.get("id") or symbol_id
        if not name or not path:
            return []

        items: List[ImpactItem] = []
        if change_type in {"sig_change", "rename", "move", "unknown"}:
            items.extend(self._callers_for_symbol(symbol_id or name, name, path))

        if change_type in {"config_contract_change"}:
            items.extend(self._config_readers(name))

        if change_type in {"logging_contract_change"}:
            items.extend(self._logger_references(name))

        return items

    def _callers_for_symbol(self, symbol_id: str, name: str, path: str) -> List[ImpactItem]:
        cached = self.cache.get(symbol_id, "callers")
        if cached:
            return [
                ImpactItem(
                    kind="callers",
                    target=edge.dst,
                    confidence=edge.confidence,
                    rationale=f"cached callers for {name}",
                    suggested_verification=f"rg -n \"{name}\\s*\\(\" {edge.dst}",
                    provenance=edge.provenance,
                )
                for edge in cached
            ]

        importers = self.store.get_importers_for_file(path)
        candidate_paths = [edge.get("src_path") for edge in importers if edge.get("src_path")]
        if path and path not in candidate_paths:
            candidate_paths.append(path)
        search_results = self._search_symbol_calls(name, candidate_paths or None)
        edges = []
        for result in search_results:
            edges.append(
                DerivedEdge(
                    src=symbol_id,
                    dst=result.path,
                    kind="callers",
                    confidence=0.6,
                    provenance="rg",
                    expires_at=time.time() + self.ttl_s,
                )
            )
        if edges:
            self.cache.set(symbol_id, "callers", edges)
        return [
            ImpactItem(
                kind="callers",
                target=edge.dst,
                confidence=edge.confidence,
                rationale=f"references {name}()",
                suggested_verification=f"rg -n \"{name}\\s*\\(\" {edge.dst}",
                provenance=edge.provenance,
            )
            for edge in edges
        ]

    def _config_readers(self, name: str) -> List[ImpactItem]:
        results = self._search_identifier(name)
        return [
            ImpactItem(
                kind="configs",
                target=res.path,
                confidence=0.55,
                rationale=f"references config {name}",
                suggested_verification=f"rg -n \"{name}\" {res.path}",
                provenance="rg",
            )
            for res in results
        ]

    def _logger_references(self, name: str) -> List[ImpactItem]:
        results = self._search_identifier(name)
        return [
            ImpactItem(
                kind="loggers",
                target=res.path,
                confidence=0.55,
                rationale=f"references logger {name}",
                suggested_verification=f"rg -n \"{name}\" {res.path}",
                provenance="rg",
            )
            for res in results
        ]

    def _search_symbol_calls(self, name: str, paths: Optional[Sequence[str]]) -> List[Any]:
        pattern = rf"\\b{re.escape(name)}\\s*\\("
        return self.search.search(pattern, self.root, paths)

    def _search_identifier(self, name: str) -> List[Any]:
        pattern = rf"\\b{re.escape(name)}\\b"
        return self.search.search(pattern, self.root, None)

    @staticmethod
    def _dedupe(items: Iterable[ImpactItem]) -> List[ImpactItem]:
        seen: set[Tuple[str, str]] = set()
        deduped: List[ImpactItem] = []
        for item in items:
            key = (item.kind, item.target)
            if key in seen:
                continue
            seen.add(key)
            deduped.append(item)
        return deduped
