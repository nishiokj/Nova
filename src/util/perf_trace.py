"""
Performance tracing for hot path analysis.

Lightweight span-based tracing to identify performance bottlenecks.
Spans are hierarchical and track wall-clock time with clear labels.

Usage:
    from util.perf_trace import PerfTracer, span

    tracer = PerfTracer("agent")

    with tracer.span("run_request"):
        with tracer.span("context_build"):
            # ... context building code
        with tracer.span("planning"):
            # ... planning code

    tracer.print_summary()  # Prints span tree with timings
"""

import time
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any
from contextlib import contextmanager
import json


@dataclass
class Span:
    """A single timing span"""
    name: str
    start_time: float
    end_time: Optional[float] = None
    parent: Optional[str] = None
    children: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def duration_ms(self) -> float:
        if self.end_time is None:
            return (time.time() - self.start_time) * 1000
        return (self.end_time - self.start_time) * 1000

    @property
    def is_complete(self) -> bool:
        return self.end_time is not None


class PerfTracer:
    """
    Lightweight performance tracer for hot path analysis.

    Thread-safe span tracking with hierarchical timing.
    """

    def __init__(self, name: str = "default", enabled: bool = True):
        self.name = name
        self.enabled = enabled
        self._spans: Dict[str, Span] = {}
        self._span_stack: List[str] = []
        self._lock = threading.Lock()
        self._trace_start = time.time()
        self._span_counter = 0

    def _generate_span_id(self, name: str) -> str:
        """Generate unique span ID"""
        self._span_counter += 1
        return f"{name}_{self._span_counter}"

    @contextmanager
    def span(self, name: str, **metadata):
        """
        Context manager for timing a span.

        Usage:
            with tracer.span("my_operation", detail="extra info"):
                # ... code to time
        """
        if not self.enabled:
            yield
            return

        span_id = self._generate_span_id(name)

        with self._lock:
            parent_id = self._span_stack[-1] if self._span_stack else None

            span = Span(
                name=name,
                start_time=time.time(),
                parent=parent_id,
                metadata=metadata
            )
            self._spans[span_id] = span

            if parent_id:
                self._spans[parent_id].children.append(span_id)

            self._span_stack.append(span_id)

        try:
            yield span
        finally:
            with self._lock:
                span.end_time = time.time()
                self._span_stack.pop()

    def add_metadata(self, key: str, value: Any):
        """Add metadata to the current span"""
        if not self.enabled:
            return
        with self._lock:
            if self._span_stack:
                current_span_id = self._span_stack[-1]
                self._spans[current_span_id].metadata[key] = value

    def get_summary(self) -> Dict[str, Any]:
        """Get timing summary as a dictionary"""
        with self._lock:
            root_spans = [
                span_id for span_id, span in self._spans.items()
                if span.parent is None
            ]

            def build_tree(span_id: str) -> Dict[str, Any]:
                span = self._spans[span_id]
                result = {
                    "name": span.name,
                    "duration_ms": round(span.duration_ms, 2),
                    "complete": span.is_complete
                }
                if span.metadata:
                    result["metadata"] = span.metadata
                if span.children:
                    result["children"] = [build_tree(c) for c in span.children]
                return result

            return {
                "tracer": self.name,
                "total_ms": round((time.time() - self._trace_start) * 1000, 2),
                "spans": [build_tree(s) for s in root_spans]
            }

    def get_flat_timings(self) -> List[Dict[str, Any]]:
        """Get flat list of all spans with timings, sorted by duration"""
        with self._lock:
            timings = []
            for span_id, span in self._spans.items():
                if span.is_complete:
                    timings.append({
                        "name": span.name,
                        "duration_ms": round(span.duration_ms, 2),
                        "parent": self._spans[span.parent].name if span.parent else None,
                        **span.metadata
                    })
            return sorted(timings, key=lambda x: x["duration_ms"], reverse=True)

    def print_summary(self, threshold_ms: float = 10.0):
        """Print span tree with timings (only spans above threshold)"""
        summary = self.get_summary()

        print(f"\n{'='*60}")
        print(f"PERF TRACE: {self.name} (total: {summary['total_ms']:.1f}ms)")
        print('='*60)

        def print_span(span: Dict, indent: int = 0):
            duration = span["duration_ms"]
            if duration < threshold_ms and not span.get("children"):
                return

            prefix = "  " * indent
            status = "✓" if span.get("complete", True) else "⏳"

            # Color code by duration
            if duration > 1000:
                marker = "🔴"  # > 1s = red
            elif duration > 500:
                marker = "🟠"  # > 500ms = orange
            elif duration > 100:
                marker = "🟡"  # > 100ms = yellow
            else:
                marker = "🟢"  # < 100ms = green

            meta_str = ""
            if span.get("metadata"):
                meta_str = f" {span['metadata']}"

            print(f"{prefix}{marker} {span['name']}: {duration:.1f}ms {status}{meta_str}")

            for child in span.get("children", []):
                print_span(child, indent + 1)

        for span in summary.get("spans", []):
            print_span(span)

        print('='*60)

        # Print top 5 slowest spans
        flat = self.get_flat_timings()
        if flat:
            print("\nTOP 5 SLOWEST SPANS:")
            for i, span in enumerate(flat[:5], 1):
                print(f"  {i}. {span['name']}: {span['duration_ms']:.1f}ms")
        print()

    def to_json(self) -> str:
        """Export trace as JSON"""
        return json.dumps(self.get_summary(), indent=2)

    def reset(self):
        """Reset all spans for a new trace"""
        with self._lock:
            self._spans.clear()
            self._span_stack.clear()
            self._trace_start = time.time()
            self._span_counter = 0


# Global tracer instance for convenience
_global_tracer: Optional[PerfTracer] = None


def get_tracer(name: str = "default") -> PerfTracer:
    """Get or create a global tracer"""
    global _global_tracer
    if _global_tracer is None or _global_tracer.name != name:
        _global_tracer = PerfTracer(name)
    return _global_tracer


def reset_tracer():
    """Reset the global tracer"""
    global _global_tracer
    if _global_tracer:
        _global_tracer.reset()


# Convenience decorator for timing functions
def trace(name: Optional[str] = None, tracer: Optional[PerfTracer] = None):
    """
    Decorator to trace function execution time.

    Usage:
        @trace("my_function")
        def my_function():
            pass
    """
    def decorator(func):
        span_name = name or func.__name__

        def wrapper(*args, **kwargs):
            t = tracer or get_tracer()
            with t.span(span_name):
                return func(*args, **kwargs)

        return wrapper
    return decorator
