"""Unit tests for the resilience decorator."""

import logging
import pytest

from harness.resilience import (
    CircuitBreakerOpenError,
    ResilienceConfig,
    resilient_call,
)


class _RetryTester:
    """Helper class exposing methods wrapped with the decorator."""

    def __init__(self):
        self.logger = logging.getLogger("retry-tester")
        self._states = {}
        self.failures_before_success = 2
        self.invocations = 0
        self.resilience = ResilienceConfig(
            max_retries=2,
            initial_backoff=0.0,
            backoff_multiplier=1.0,
            max_backoff=0.0,
            jitter=0.0,
            failure_threshold=5,
            recovery_timeout=60.0,
        )

    def _config(self) -> ResilienceConfig:
        return self.resilience

    @resilient_call(
        state_attr="_states",
        config_getter=lambda self: self._config(),
        key_getter=lambda self, *_, **__: "retry",
        component="test",
        logger_getter=lambda self: self.logger,
    )
    def flaky(self):
        self.invocations += 1
        if self.invocations <= self.failures_before_success:
            raise RuntimeError("not yet")
        return "ok"


def test_resilient_call_retries_until_success():
    tester = _RetryTester()
    tester.failures_before_success = 2
    assert tester.flaky() == "ok"
    assert tester.invocations == 3  # 2 failures + 1 success


class _CircuitTester:
    def __init__(self, resilience_config: ResilienceConfig):
        self.logger = logging.getLogger("circuit-tester")
        self._states = {}
        self.resilience = resilience_config

    @resilient_call(
        state_attr="_states",
        config_getter=lambda self: self.resilience,
        key_getter=lambda self, *_, **__: "circuit",
        component="test",
        logger_getter=lambda self: self.logger,
    )
    def always_fail(self):
        raise ValueError("boom")


def test_circuit_breaker_opens_after_threshold(monkeypatch):
    fake_time = {"value": 0.0}

    def fake_now():
        return fake_time["value"]

    monkeypatch.setattr("harness.resilience._current_time", fake_now)

    config = ResilienceConfig(
        max_retries=0,
        initial_backoff=0.0,
        backoff_multiplier=1.0,
        max_backoff=0.0,
        jitter=0.0,
        failure_threshold=2,
        recovery_timeout=10.0,
    )
    tester = _CircuitTester(config)

    with pytest.raises(ValueError):
        tester.always_fail()

    fake_time["value"] += 1.0
    with pytest.raises(ValueError):
        tester.always_fail()

    with pytest.raises(CircuitBreakerOpenError):
        tester.always_fail()

    # Advance time past cooldown and ensure the breaker half-opens again
    fake_time["value"] += 20.0
    with pytest.raises(ValueError):
        tester.always_fail()

    with pytest.raises(CircuitBreakerOpenError):
        tester.always_fail()
