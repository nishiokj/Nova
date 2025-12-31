"""
Agent execution benchmarks.
"""

import time
from statistics import mean, stdev

import pytest


class TestToolRegistryBenchmarks:
    """Benchmark tool registry operations."""

    @pytest.mark.benchmark
    def test_tool_dispatch_overhead(self, tool_registry):
        """Measure tool registry dispatch overhead."""
        # Register a no-op tool
        def noop_tool(**kwargs):
            return {"result": "ok"}

        tool_registry.register_function(
            name="noop",
            func=noop_tool,
            description="No-op tool for benchmarks",
            parameters={"type": "object", "properties": {}},
        )

        times = []
        for _ in range(100):
            start = time.perf_counter()
            tool_registry.execute("noop", {})
            elapsed = time.perf_counter() - start
            times.append(elapsed * 1000)

        avg_ms = mean(times)

        print(f"\nTool dispatch: {avg_ms:.4f}ms avg")

        # Should be very fast
        assert avg_ms < 10, f"Tool dispatch too slow: {avg_ms}ms"

    @pytest.mark.benchmark
    def test_tool_lookup_performance(self, tool_registry):
        """Measure tool lookup time with many registered tools."""
        # Register many tools
        for i in range(100):

            def tool_func(**kwargs):
                return {"i": i}

            tool_registry.register_function(
                name=f"tool_{i}",
                func=tool_func,
                description=f"Tool {i}",
                parameters={"type": "object", "properties": {}},
            )

        times = []
        for _ in range(100):
            start = time.perf_counter()
            tool_registry.get_tool("tool_50")
            elapsed = time.perf_counter() - start
            times.append(elapsed * 1000)

        avg_ms = mean(times)

        print(f"\nTool lookup (100 tools): {avg_ms:.4f}ms avg")

        # Should be fast even with many tools
        assert avg_ms < 1, f"Tool lookup too slow: {avg_ms}ms"


class TestResilienceBenchmarks:
    """Benchmark resilience operations."""

    @pytest.mark.benchmark
    def test_circuit_breaker_state_check(self):
        """Measure circuit breaker state check performance."""
        from util.resilience import CircuitBreakerState

        state = CircuitBreakerState()

        times = []
        for _ in range(1000):
            start = time.perf_counter()
            state.is_open(time.monotonic())
            elapsed = time.perf_counter() - start
            times.append(elapsed * 1000)

        avg_ms = mean(times)

        print(f"\nCircuit breaker check: {avg_ms:.6f}ms avg")

        # Should be extremely fast
        assert avg_ms < 0.1, f"Circuit breaker check too slow: {avg_ms}ms"

    @pytest.mark.benchmark
    def test_backoff_computation(self):
        """Measure backoff computation performance."""
        from util.resilience import ResilienceConfig, _compute_backoff

        config = ResilienceConfig(
            initial_backoff=1.0, backoff_multiplier=2.0, max_backoff=30.0, jitter=0.1
        )

        times = []
        for _ in range(1000):
            start = time.perf_counter()
            _compute_backoff(config, 5)
            elapsed = time.perf_counter() - start
            times.append(elapsed * 1000)

        avg_ms = mean(times)

        print(f"\nBackoff computation: {avg_ms:.6f}ms avg")

        # Should be very fast
        assert avg_ms < 0.1, f"Backoff computation too slow: {avg_ms}ms"


class TestLoggerBenchmarks:
    """Benchmark logger operations."""

    @pytest.mark.benchmark
    def test_correlation_id_generation(self):
        """Measure correlation ID generation performance."""
        from util.logger import get_correlation_id, clear_correlation_id

        times = []
        for _ in range(1000):
            clear_correlation_id()
            start = time.perf_counter()
            get_correlation_id()
            elapsed = time.perf_counter() - start
            times.append(elapsed * 1000)

        avg_ms = mean(times)

        print(f"\nCorrelation ID generation: {avg_ms:.6f}ms avg")

        # Should be fast
        assert avg_ms < 0.5, f"Correlation ID generation too slow: {avg_ms}ms"

    @pytest.mark.benchmark
    def test_structured_log_formatting(self):
        """Measure structured log entry formatting performance."""
        from util.logger import RequestLog

        times = []
        for i in range(1000):
            start = time.perf_counter()
            entry = RequestLog(
                ts="2024-01-01T00:00:00",
                lvl="INFO",
                svc="test",
                req_id=f"req-{i}",
                span="test",
                evt="benchmark event",
                cid="abc123",
                detail={"key": "value", "count": i},
            )
            entry.to_json()
            elapsed = time.perf_counter() - start
            times.append(elapsed * 1000)

        avg_ms = mean(times)

        print(f"\nLog formatting: {avg_ms:.4f}ms avg")

        # Should be reasonably fast
        assert avg_ms < 1, f"Log formatting too slow: {avg_ms}ms"
