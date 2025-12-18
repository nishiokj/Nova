"""Language-specific symbol and dependency extraction."""

from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from typing import List, Optional, Set, Tuple

from .types import ExportDef, ModuleEdge, SymbolDef
from .utils import make_symbol_id, normalize_path, sha1_text


class LanguagePlugin(ABC):
    name: str = "unknown"
    extensions: Set[str] = set()

    @abstractmethod
    def extract_symbols(self, path: str, content: str) -> List[SymbolDef]:
        raise NotImplementedError

    @abstractmethod
    def extract_module_edges(self, path: str, content: str, repo_root: str) -> List[ModuleEdge]:
        raise NotImplementedError

    def extract_exports(self, path: str, content: str) -> List[ExportDef]:
        return []


def _indent_level(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _find_block_end(lines: List[str], start_index: int) -> int:
    start_line = lines[start_index]
    base_indent = _indent_level(start_line)
    end_index = len(lines) - 1
    for i in range(start_index + 1, len(lines)):
        stripped = lines[i].strip()
        if not stripped or stripped.startswith("#"):
            continue
        if _indent_level(lines[i]) <= base_indent:
            end_index = i - 1
            break
    return end_index + 1


class PythonPlugin(LanguagePlugin):
    name = "python"
    extensions = {".py"}

    _def_re = re.compile(r"^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)")
    _class_re = re.compile(r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?:")
    _type_alias_re = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*TypeAlias\s*=")
    _type_alias_re2 = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*TypeAlias\b")
    _config_re = re.compile(r"^\s*([A-Z_][A-Z0-9_]*)\s*=")
    _logger_re = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*logging\.getLogger\(([^)]*)\)")

    _import_re = re.compile(r"^\s*import\s+(.+)")
    _from_re = re.compile(r"^\s*from\s+([.\w]+)\s+import\s+")
    _all_re = re.compile(r"^\s*__all__\s*=\s*\[(.*)\]\s*$")

    def extract_symbols(self, path: str, content: str) -> List[SymbolDef]:
        symbols: List[SymbolDef] = []
        lines = content.splitlines()
        for idx, line in enumerate(lines, start=1):
            match = self._def_re.match(line)
            if match:
                name = match.group(1)
                sig = f"def {name}({match.group(2).strip()})"
                end_line = _find_block_end(lines, idx - 1)
                symbols.append(self._make_symbol(path, "function", name, sig, idx, end_line))
                continue

            match = self._class_re.match(line)
            if match:
                name = match.group(1)
                sig = f"class {name}{match.group(2) or ''}"
                end_line = _find_block_end(lines, idx - 1)
                symbols.append(self._make_symbol(path, "class", name, sig, idx, end_line))
                continue

            match = self._type_alias_re.match(line) or self._type_alias_re2.match(line)
            if match:
                name = match.group(1)
                sig = f"type {name}"
                symbols.append(self._make_symbol(path, "type", name, sig, idx, idx))
                continue

            match = self._logger_re.match(line)
            if match:
                name = match.group(1)
                sig = f"logger {name} = getLogger({match.group(2).strip()})"
                symbols.append(self._make_symbol(path, "logger", name, sig, idx, idx))
                continue

            match = self._config_re.match(line)
            if match:
                name = match.group(1)
                sig = f"config {name}"
                symbols.append(self._make_symbol(path, "config", name, sig, idx, idx))

        return symbols

    def extract_module_edges(self, path: str, content: str, repo_root: str) -> List[ModuleEdge]:
        edges: List[ModuleEdge] = []
        lines = content.splitlines()
        for line in lines:
            match = self._import_re.match(line)
            if match:
                modules = [m.strip() for m in match.group(1).split(",")]
                for mod in modules:
                    mod = mod.split(" as ")[0].strip()
                    resolved = self._resolve_module(mod, path, repo_root)
                    if resolved:
                        edges.append(ModuleEdge(src_path=path, dst_path=resolved))
                continue

            match = self._from_re.match(line)
            if match:
                mod = match.group(1).strip()
                resolved = self._resolve_module(mod, path, repo_root)
                if resolved:
                    edges.append(ModuleEdge(src_path=path, dst_path=resolved))

        return edges

    def extract_exports(self, path: str, content: str) -> List[ExportDef]:
        exports: List[ExportDef] = []
        lines = content.splitlines()
        for line in lines:
            match = self._all_re.match(line)
            if not match:
                continue
            raw = match.group(1)
            names = []
            for token in raw.split(","):
                token = token.strip().strip("'\"")
                if token:
                    names.append(token)
            for name in names:
                exports.append(ExportDef(path=path, symbol_id=None, kind=name))
        return exports

    def _resolve_module(self, module: str, path: str, repo_root: str) -> Optional[str]:
        if not module:
            return None
        base_dir = os.path.dirname(path)
        if module.startswith("."):
            dots = len(module) - len(module.lstrip("."))
            rel_module = module[dots:]
            base_parts = base_dir.split("/")
            if dots > 1:
                base_parts = base_parts[: max(0, len(base_parts) - (dots - 1))]
            if rel_module:
                rel_path = "/".join(base_parts + rel_module.split("."))
            else:
                rel_path = "/".join(base_parts)
        else:
            rel_path = "/".join(module.split("."))

        candidate = normalize_path(os.path.join(repo_root, rel_path + ".py"), repo_root)
        init_candidate = normalize_path(os.path.join(repo_root, rel_path, "__init__.py"), repo_root)
        if os.path.exists(os.path.join(repo_root, candidate)):
            return candidate
        if os.path.exists(os.path.join(repo_root, init_candidate)):
            return init_candidate
        return None

    @staticmethod
    def _make_symbol(path: str, kind: str, name: str, sig: str, start: int, end: int) -> SymbolDef:
        symbol_id = make_symbol_id(path, kind, name, start, end)
        return SymbolDef(
            id=symbol_id,
            path=path,
            kind=kind,
            name=name,
            qualname=name,
            sig=sig,
            span_start=start,
            span_end=end,
            hash=sha1_text(sig)[:12],
        )


class JSTypescriptPlugin(LanguagePlugin):
    name = "javascript"
    extensions = {".js", ".jsx", ".ts", ".tsx"}

    _func_re = re.compile(r"^\s*(export\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)")
    _const_func_re = re.compile(r"^\s*(export\s+)?(const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(async\s*)?\(")
    _class_re = re.compile(r"^\s*(export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)")
    _type_re = re.compile(r"^\s*(export\s+)?(type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)\b")
    _config_re = re.compile(r"^\s*(export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=")
    _logger_re = re.compile(r"^\s*(export\s+)?(const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(createLogger|pino|winston\.createLogger)\b")

    _import_re = re.compile(r"^\s*import\s+.*?\s+from\s+['\"](.+?)['\"]")
    _import_side_re = re.compile(r"^\s*import\s+['\"](.+?)['\"]")
    _require_re = re.compile(r"require\(['\"](.+?)['\"]\)")
    _export_named_re = re.compile(r"^\s*export\s+\{([^}]+)\}")

    def extract_symbols(self, path: str, content: str) -> List[SymbolDef]:
        symbols: List[SymbolDef] = []
        lines = content.splitlines()
        for idx, line in enumerate(lines, start=1):
            match = self._func_re.match(line)
            if match:
                name = match.group(2)
                sig = f"function {name}({match.group(3).strip()})"
                symbols.append(self._make_symbol(path, "function", name, sig, idx))
                continue

            match = self._const_func_re.match(line)
            if match:
                name = match.group(3)
                sig = f"{match.group(2)} {name} = ("
                symbols.append(self._make_symbol(path, "function", name, sig, idx))
                continue

            match = self._class_re.match(line)
            if match:
                name = match.group(2)
                sig = f"class {name}"
                symbols.append(self._make_symbol(path, "class", name, sig, idx))
                continue

            match = self._type_re.match(line)
            if match:
                name = match.group(3)
                sig = f"{match.group(2)} {name}"
                symbols.append(self._make_symbol(path, "type", name, sig, idx))
                continue

            match = self._logger_re.match(line)
            if match:
                name = match.group(3)
                sig = f"logger {name} = {match.group(4)}"
                symbols.append(self._make_symbol(path, "logger", name, sig, idx))
                continue

            match = self._config_re.match(line)
            if match:
                name = match.group(2)
                sig = f"config {name}"
                symbols.append(self._make_symbol(path, "config", name, sig, idx))

        return symbols

    def extract_module_edges(self, path: str, content: str, repo_root: str) -> List[ModuleEdge]:
        edges: List[ModuleEdge] = []
        lines = content.splitlines()
        for line in lines:
            for pattern in (self._import_re, self._import_side_re):
                match = pattern.match(line)
                if match:
                    target = match.group(1)
                    resolved = self._resolve_module(target, path, repo_root)
                    if resolved:
                        edges.append(ModuleEdge(src_path=path, dst_path=resolved))
                    break
            for match in self._require_re.finditer(line):
                target = match.group(1)
                resolved = self._resolve_module(target, path, repo_root)
                if resolved:
                    edges.append(ModuleEdge(src_path=path, dst_path=resolved))
        return edges

    def extract_exports(self, path: str, content: str) -> List[ExportDef]:
        exports: List[ExportDef] = []
        lines = content.splitlines()
        for line in lines:
            match = self._export_named_re.match(line)
            if match:
                names = [name.strip() for name in match.group(1).split(",") if name.strip()]
                for name in names:
                    exports.append(ExportDef(path=path, symbol_id=None, kind=name))
        return exports

    def _resolve_module(self, module: str, path: str, repo_root: str) -> Optional[str]:
        if not module:
            return None
        if module.startswith("."):
            base_dir = os.path.dirname(path)
            candidate = os.path.normpath(os.path.join(base_dir, module))
        else:
            return None

        candidates = self._expand_js_candidates(candidate)
        for cand in candidates:
            rel = normalize_path(os.path.join(repo_root, cand), repo_root)
            if os.path.exists(os.path.join(repo_root, rel)):
                return rel
        return None

    @staticmethod
    def _expand_js_candidates(base: str) -> List[str]:
        _, ext = os.path.splitext(base)
        if ext:
            return [base]
        return [
            base + ".ts",
            base + ".tsx",
            base + ".js",
            base + ".jsx",
            base + ".json",
            os.path.join(base, "index.ts"),
            os.path.join(base, "index.tsx"),
            os.path.join(base, "index.js"),
            os.path.join(base, "index.jsx"),
        ]

    @staticmethod
    def _make_symbol(path: str, kind: str, name: str, sig: str, line: int) -> SymbolDef:
        symbol_id = make_symbol_id(path, kind, name, line, line)
        return SymbolDef(
            id=symbol_id,
            path=path,
            kind=kind,
            name=name,
            qualname=name,
            sig=sig,
            span_start=line,
            span_end=line,
            hash=sha1_text(sig)[:12],
        )


def default_plugins() -> Tuple[LanguagePlugin, ...]:
    return (PythonPlugin(), JSTypescriptPlugin())
