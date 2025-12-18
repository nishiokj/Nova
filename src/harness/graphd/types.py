"""Shared graphd data structures."""

from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass
class SymbolDef:
    id: str
    path: str
    kind: str
    name: str
    qualname: str
    sig: str
    span_start: int
    span_end: int
    hash: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "path": self.path,
            "kind": self.kind,
            "name": self.name,
            "qualname": self.qualname,
            "sig": self.sig,
            "span_start": self.span_start,
            "span_end": self.span_end,
            "hash": self.hash,
        }


@dataclass
class ModuleEdge:
    src_path: str
    dst_path: str
    kind: str = "imports"
    confidence: float = 0.95

    def to_dict(self) -> Dict[str, Any]:
        return {
            "src_path": self.src_path,
            "dst_path": self.dst_path,
            "kind": self.kind,
            "confidence": self.confidence,
        }


@dataclass
class ExportDef:
    path: str
    symbol_id: Optional[str]
    kind: str
    confidence: float = 0.8

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "symbol_id": self.symbol_id,
            "kind": self.kind,
            "confidence": self.confidence,
        }


@dataclass
class DerivedEdge:
    src: str
    dst: str
    kind: str
    confidence: float
    provenance: str
    expires_at: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "src": self.src,
            "dst": self.dst,
            "kind": self.kind,
            "confidence": self.confidence,
            "provenance": self.provenance,
            "expires_at": self.expires_at,
        }


@dataclass
class ImpactItem:
    kind: str
    target: str
    confidence: float
    rationale: str
    suggested_verification: str
    provenance: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "target": self.target,
            "confidence": self.confidence,
            "rationale": self.rationale,
            "suggested_verification": self.suggested_verification,
            "provenance": self.provenance,
        }
