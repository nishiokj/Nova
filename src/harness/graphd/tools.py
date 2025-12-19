"""Graphd tool wrappers for agent integration.

These tools expose graphd's graph queries as callable tools that the agent
can use during planning and execution.
"""

from typing import Any, Dict, List, Optional

from .client import GraphdClient
from .types import ImpactItem


class GraphdTools:
    """Tool wrappers for graphd functionality."""

    def __init__(self, host: str = "127.0.0.1", port: int = 9444, timeout_s: int = 2):
        self.client = GraphdClient(host=host, port=port, timeout_s=timeout_s)

    def graphd_symbol_lookup(self, path: str, line: int) -> Dict[str, Any]:
        """
        Look up symbol at file:line using graphd.

        Args:
            path: File path (relative to repo root)
            line: Line number

        Returns:
            Dict with symbol info or error

        Example:
            result = graphd_symbol_lookup("src/harness/agent/planner.py", 63)
            # Returns: {"symbol": {"id": "...", "name": "create_plan", ...}, "path": "..."}
        """
        try:
            return self.client.symbol(path, line)
        except Exception as e:
            return {"error": str(e)}

    def graphd_impact_analysis(
        self,
        path: str,
        change_type: str = "unknown",
        budget: int = 20
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        Analyze impact of changes to a file using graphd.

        Args:
            path: File path that changed
            change_type: Type of change (sig_change, rename, move, unknown)
            budget: Max number of impact items to return

        Returns:
            Dict with "items" list containing impacted files

        Example:
            result = graphd_impact_analysis("src/harness/agent/planner.py", "sig_change")
            # Returns: {"items": [{"kind": "callers", "target": "...", ...}, ...]}
        """
        try:
            return self.client.impact({
                "entity": {"type": "file", "path": path},
                "change_type": change_type,
                "budget": budget
            })
        except Exception as e:
            return {"error": str(e), "items": []}

    def graphd_search_symbol(
        self,
        pattern: str,
        path: Optional[str] = None,
        max_results: int = 20
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        Search for symbol references using graphd's ripgrep backend.

        Args:
            pattern: Search pattern (regex)
            path: Optional path to restrict search
            max_results: Max number of results

        Returns:
            Dict with "items" list of search results

        Example:
            result = graphd_search_symbol("create_plan", "src/harness/agent")
            # Returns: {"items": [{"path": "...", "line": 1046, ...}, ...]}
        """
        try:
            payload = {
                "pattern": pattern,
                "max_results": max_results
            }
            if path:
                payload["path"] = path
            return self.client.search(payload)
        except Exception as e:
            return {"error": str(e), "items": []}

    def graphd_find_callers(
        self,
        symbol_path: str,
        symbol_line: int,
        budget: int = 10
    ) -> Dict[str, List[str]]:
        """
        Find who calls a specific symbol (uses Tier B cache).

        This uses the derived edge cache and will trigger ripgrep search if cache miss.

        Args:
            symbol_path: File containing the symbol
            symbol_line: Line number of symbol definition
            budget: Max number of callers to return

        Returns:
            Dict with "callers" list of file paths

        Example:
            result = graphd_find_callers("src/harness/agent/planner.py", 63)
            # Returns: {"callers": ["src/harness/agent/agent.py", ...]}
        """
        try:
            # First lookup the symbol
            symbol_resp = self.client.symbol(symbol_path, symbol_line)
            symbol = symbol_resp.get("symbol")
            if not symbol:
                return {"error": "Symbol not found", "callers": []}

            # Get impact analysis (triggers cache lookup/build)
            impact_resp = self.client.impact({
                "entity": {
                    "type": "symbol",
                    "symbol_id": symbol["id"],
                    "path": symbol_path,
                    "line": symbol_line
                },
                "change_type": "sig_change",
                "budget": budget
            })

            # Extract caller paths
            items = impact_resp.get("items", [])
            callers = [
                item["target"] for item in items
                if item.get("kind") == "callers"
            ]

            return {"callers": callers[:budget]}

        except Exception as e:
            return {"error": str(e), "callers": []}

    def graphd_get_imports(self, path: str) -> Dict[str, List[Dict[str, Any]]]:
        """
        Get modules imported by a file (Tier A - fast, exact).

        Args:
            path: File path

        Returns:
            Dict with "imports" list

        Example:
            result = graphd_get_imports("src/harness/agent/agent.py")
            # Returns: {"imports": [{"dst_path": "src/harness/agent/planner.py", ...}, ...]}
        """
        try:
            # Use context endpoint to get module edges
            # First need symbol - use line 1 as placeholder
            symbol_resp = self.client.symbol(path, 1)
            symbol = symbol_resp.get("symbol")
            if not symbol:
                return {"error": "File not indexed", "imports": []}

            context_resp = self.client.context(symbol["id"], depth=1)
            imports = context_resp.get("module_edges", {}).get("imports", [])

            return {"imports": imports}

        except Exception as e:
            return {"error": str(e), "imports": []}

    def graphd_health_check(self) -> Dict[str, Any]:
        """
        Check if graphd is healthy and responsive.

        Returns:
            Health status dict

        Example:
            result = graphd_health_check()
            # Returns: {"status": "ok", "version": "v1-2024", ...}
        """
        try:
            return self.client.health()
        except Exception as e:
            return {"status": "error", "error": str(e)}
