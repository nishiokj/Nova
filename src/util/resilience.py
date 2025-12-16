"""
Resilience helpers for LLM and tool calls.

Provides a reusable decorator that layers exponential backoff retries
and circuit breaker protections around potentially flaky operations.
"""

from __future__ import annotations

import asyncio
import functools
import random
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Sequence, Tuple, Type

DEFAULT_KEY = "__default__"


def _current_time() -> float:
    """Return monotonic time. Split out for easier testing."""
    return time.monotonic()


def _log(logger: Any, level: str, message: str, component: str):
    """Log helper that tolerates standard or structured loggers."""
    if not logger:
        return
    log_fn = getattr(logger, level, None)
    if not callable(log_fn):
        return
    try:
        log_fn(message, component=component)
    except TypeError:
        log_fn(message)


@dataclass
class ResilienceConfig:
    """Configuration knobs for retry + circuit breaking."""

    max_retries: int = 0
    initial_backoff: float = 0.5
    backoff_multiplier: float = 2.0
    max_backoff: float = 30.0
    jitter: float = 0.1
    failure_threshold: int = 5
    recovery_timeout: float = 30.0
    half_open_successes: int = 1


@dataclass
class CircuitBreakerState:
    """State tracked per target for the circuit breaker."""

    consecutive_failures: int = 0
    opened_until: Optional[float] = None
    half_open: bool = False
    half_open_successes: int = 0
    last_error: Optional[str] = None

    def is_open(self, now: float) -> bool:
        return self.opened_until is not None and self.opened_until > now

    def time_remaining(self, now: float) -> float:
        if not self.opened_until:
            return 0.0
        return max(0.0, self.opened_until - now)

    def enter_half_open(self):
        self.opened_until = None
        self.half_open = True
        self.half_open_successes = 0
        self.consecutive_failures = 0

    def reset(self):
        self.consecutive_failures = 0
        self.opened_until = None
        self.half_open = False
        self.half_open_successes = 0
        self.last_error = None


class CircuitBreakerOpenError(RuntimeError):
    """Raised when a call is attempted while the circuit breaker is open."""

    def __init__(
        self,
        component: str,
        target: str,
        retry_after: Optional[float] = None,
        last_error: Optional[str] = None,
    ):
        message = f"{component} circuit for '{target}' is open"
        if retry_after is not None:
            message += f"; retry after {retry_after:.1f}s"
        if last_error:
            message += f" (last error: {last_error})"
        super().__init__(message)
        self.component = component
        self.target = target
        self.retry_after = retry_after
        self.last_error = last_error


def _get_state(storage: Dict[str, CircuitBreakerState], key: str) -> CircuitBreakerState:
    state = storage.get(key)
    if state is None:
        state = CircuitBreakerState()
        storage[key] = state
    return state


def _compute_backoff(config: ResilienceConfig, attempt: int) -> float:
    if config.initial_backoff <= 0:
        return 0.0
    delay = config.initial_backoff * (config.backoff_multiplier ** (attempt - 1))
    if config.max_backoff > 0:
        delay = min(delay, config.max_backoff)
    if config.jitter and delay > 0:
        delay += random.uniform(0, config.jitter * delay)
    return delay


def resilient_call(
    *,
    state_attr: str,
    config_getter: Callable[[Any], ResilienceConfig],
    key_getter: Optional[Callable[..., str]] = None,
    component: str = "resilience",
    logger_getter: Optional[Callable[[Any], Any]] = None,
    retry_exceptions: Sequence[Type[BaseException]] = (Exception,),
    result_validator: Optional[Callable[[Any], bool]] = None,
):
    """Decorator that adds retry with backoff plus circuit breaker logic."""

    retry_exceptions = tuple(retry_exceptions)

    def decorator(func):
        is_coroutine = asyncio.iscoroutinefunction(func)

        if is_coroutine:

            @functools.wraps(func)
            async def async_wrapper(self, *args, **kwargs):
                return await _execute_async(
                    func,
                    self,
                    args,
                    kwargs,
                    config_getter,
                    state_attr,
                    key_getter,
                    component,
                    logger_getter,
                    retry_exceptions,
                    result_validator,
                )

            return async_wrapper

        @functools.wraps(func)
        def sync_wrapper(self, *args, **kwargs):
            return _execute_sync(
                func,
                self,
                args,
                kwargs,
                config_getter,
                state_attr,
                key_getter,
                component,
                logger_getter,
                retry_exceptions,
                result_validator,
            )

        return sync_wrapper

    return decorator


def _prepare_context(
    instance,
    args,
    kwargs,
    config_getter,
    state_attr,
    key_getter,
    logger_getter,
) -> Tuple[ResilienceConfig, Any, CircuitBreakerState, str]:
    config = config_getter(instance)
    logger = logger_getter(instance) if logger_getter else getattr(instance, "logger", None)
    storage: Dict[str, CircuitBreakerState] = getattr(instance, state_attr, None)
    if storage is None:
        storage = {}
        setattr(instance, state_attr, storage)

    key = key_getter(instance, *args, **kwargs) if key_getter else DEFAULT_KEY
    if key is None:
        key = DEFAULT_KEY
    key = str(key)
    state = _get_state(storage, key)
    return config, logger, state, key


def _ensure_circuit_available(
    state: CircuitBreakerState,
    config: ResilienceConfig,
    component: str,
    key: str,
    logger: Any,
):
    now = _current_time()
    if state.is_open(now):
        retry_after = state.time_remaining(now)
        _log(logger, "warning", f"{component} circuit for {key} is OPEN; rejecting call", component)
        raise CircuitBreakerOpenError(component, key, retry_after, state.last_error)

    if state.opened_until is not None and not state.is_open(now):
        state.enter_half_open()
        _log(logger, "info", f"{component} circuit for {key} entering HALF-OPEN", component)


def _record_failure(state, config, component, key, logger):
    now = _current_time()
    if state.half_open:
        state.half_open = False
        state.half_open_successes = 0

    state.consecutive_failures += 1
    _log(logger, "warning", f"{component} failure recorded for {key} (count={state.consecutive_failures})", component)

    if state.consecutive_failures >= config.failure_threshold:
        state.opened_until = now + max(0.0, config.recovery_timeout)
        state.consecutive_failures = 0
        _log(
            logger,
            "error",
            f"{component} circuit for {key} OPEN for {config.recovery_timeout:.1f}s",
            component,
        )


def _record_success(state, config, component, key, logger):
    if state.half_open:
        state.half_open_successes += 1
        if state.half_open_successes >= max(1, config.half_open_successes):
            state.reset()
            _log(logger, "info", f"{component} circuit for {key} CLOSED", component)
        else:
            state.last_error = None
        return

    state.reset()


def _should_retry(attempt: int, attempts: int) -> bool:
    return attempt < attempts


def _handle_result(
    result,
    result_validator: Optional[Callable[[Any], bool]],
    state: CircuitBreakerState,
) -> bool:
    if result_validator is None:
        return True
    try:
        return result_validator(result)
    except Exception as validator_exc:  # pragma: no cover - defensive
        state.last_error = str(validator_exc)
        return False


def _execute_sync(
    func,
    instance,
    args,
    kwargs,
    config_getter,
    state_attr,
    key_getter,
    component,
    logger_getter,
    retry_exceptions,
    result_validator,
):
    config, logger, state, key = _prepare_context(
        instance, args, kwargs, config_getter, state_attr, key_getter, logger_getter
    )
    _ensure_circuit_available(state, config, component, key, logger)

    attempts = max(1, int(config.max_retries) + 1)
    attempt = 0

    while attempt < attempts:
        attempt += 1
        try:
            result = func(instance, *args, **kwargs)
        except retry_exceptions as exc:  # type: ignore[arg-type]
            state.last_error = str(exc)
            if not _should_retry(attempt, attempts):
                _record_failure(state, config, component, key, logger)
                raise

            delay = _compute_backoff(config, attempt)
            if delay > 0:
                _log(
                    logger,
                    "warning",
                    f"{component} call for {key} failed (attempt {attempt}/{attempts}); retrying in {delay:.2f}s",
                    component,
                )
                time.sleep(delay)
            continue
        except Exception as exc:  # pragma: no cover - default path
            state.last_error = str(exc)
            _record_failure(state, config, component, key, logger)
            raise

        success = _handle_result(result, result_validator, state)
        if success:
            _record_success(state, config, component, key, logger)
            return result

        state.last_error = getattr(result, "error", None) or "Result indicated failure"
        if not _should_retry(attempt, attempts) or config.initial_backoff <= 0:
            _record_failure(state, config, component, key, logger)
            return result

        delay = _compute_backoff(config, attempt)
        if delay > 0:
            _log(
                logger,
                "warning",
                f"{component} result for {key} failed validation; retrying in {delay:.2f}s",
                component,
            )
            time.sleep(delay)

    return None


async def _execute_async(
    func,
    instance,
    args,
    kwargs,
    config_getter,
    state_attr,
    key_getter,
    component,
    logger_getter,
    retry_exceptions,
    result_validator,
):
    config, logger, state, key = _prepare_context(
        instance, args, kwargs, config_getter, state_attr, key_getter, logger_getter
    )
    _ensure_circuit_available(state, config, component, key, logger)

    attempts = max(1, int(config.max_retries) + 1)
    attempt = 0

    while attempt < attempts:
        attempt += 1
        try:
            result = await func(instance, *args, **kwargs)
        except retry_exceptions as exc:  # type: ignore[arg-type]
            state.last_error = str(exc)
            if not _should_retry(attempt, attempts):
                _record_failure(state, config, component, key, logger)
                raise

            delay = _compute_backoff(config, attempt)
            if delay > 0:
                _log(
                    logger,
                    "warning",
                    f"{component} call for {key} failed (attempt {attempt}/{attempts}); retrying in {delay:.2f}s",
                    component,
                )
                await asyncio.sleep(delay)
            continue
        except Exception as exc:  # pragma: no cover - default path
            state.last_error = str(exc)
            _record_failure(state, config, component, key, logger)
            raise

        success = _handle_result(result, result_validator, state)
        if success:
            _record_success(state, config, component, key, logger)
            return result

        state.last_error = getattr(result, "error", None) or "Result indicated failure"
        if not _should_retry(attempt, attempts) or config.initial_backoff <= 0:
            _record_failure(state, config, component, key, logger)
            return result

        delay = _compute_backoff(config, attempt)
        if delay > 0:
            _log(
                logger,
                "warning",
                f"{component} result for {key} failed validation; retrying in {delay:.2f}s",
                component,
            )
            await asyncio.sleep(delay)

    return None
