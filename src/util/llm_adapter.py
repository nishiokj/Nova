"""
LLM Adapter Interface and Implementations.
Provides uniform interface for multiple LLM backends.
"""

import os
import json
import time
import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Generator, AsyncGenerator, Callable, Union
from enum import Enum
import threading

from .config import LLMConfig
from .logger import StructuredLogger
from .resilience import ResilienceConfig, resilient_call
from .perf_trace import get_tracer


class MessageRole(Enum):
    """Message roles for chat-based LLMs"""
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


@dataclass
class Message:
    """A message in a conversation"""
    role: MessageRole
    content: str
    name: Optional[str] = None  # For tool messages
    tool_call_id: Optional[str] = None
    tool_calls: Optional[List[Dict]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for API calls"""
        result = {
            "role": self.role.value,
            "content": self.content
        }
        if self.name:
            result["name"] = self.name
        if self.tool_call_id:
            result["tool_call_id"] = self.tool_call_id
        if self.tool_calls:
            result["tool_calls"] = self.tool_calls
        return result


@dataclass
class ToolDefinition:
    """Definition of a tool for LLM function calling"""
    name: str
    description: str
    parameters: Dict[str, Any]  # JSON Schema
    required: List[str] = field(default_factory=list)

    def to_openai_format(self) -> Dict[str, Any]:
        """Convert to OpenAI function format"""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": self.parameters,
                    "required": self.required
                }
            }
        }

    def to_anthropic_format(self) -> Dict[str, Any]:
        """Convert to Anthropic tool format"""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": {
                "type": "object",
                "properties": self.parameters,
                "required": self.required
            }
        }

    def to_responses_format(self) -> Dict[str, Any]:
        """Convert to OpenAI Responses API format (internally-tagged)"""
        return {
            "type": "function",
            "name": self.name,
            "description": self.description,
            "parameters": {
                "type": "object",
                "properties": self.parameters,
                "required": self.required
            }
        }


@dataclass
class ToolCall:
    """A tool call requested by the LLM"""
    id: str
    name: str
    arguments: Dict[str, Any]


@dataclass
class LLMResponse:
    """Response from an LLM"""
    content: str
    role: MessageRole = MessageRole.ASSISTANT
    tool_calls: List[ToolCall] = field(default_factory=list)
    finish_reason: Optional[str] = None
    usage: Optional[Dict[str, int]] = None
    model: Optional[str] = None
    raw_response: Optional[Any] = None

    @property
    def has_tool_calls(self) -> bool:
        """Check if response contains tool calls"""
        return len(self.tool_calls) > 0


def llm_resilience(func):
    """Decorator for LLM calls that need retries + circuit breaking."""
    return resilient_call(
        state_attr="_llm_circuit_state",
        config_getter=lambda self: self._llm_resilience_config(),
        key_getter=lambda self, *_, **__: self._llm_resilience_key(),
        component="llm",
        logger_getter=lambda self: self.logger,
    )(func)


class LLMAdapter(ABC):
    """
    Abstract base class for LLM adapters.
    Provides uniform interface for different LLM backends.
    """

    def __init__(self, config: LLMConfig, logger: Optional[StructuredLogger] = None):
        self.config = config
        self.logger = logger or StructuredLogger()
        self._prewarmed = False
        self._llm_circuit_state: Dict[str, Any] = {}

    @property
    @abstractmethod
    def provider(self) -> str:
        """Get provider name"""
        pass

    def _llm_resilience_config(self) -> ResilienceConfig:
        """Build resilience config for this adapter."""
        return ResilienceConfig(
            max_retries=self.config.max_retries,
            initial_backoff=self.config.retry_delay,
            backoff_multiplier=self.config.retry_backoff_multiplier,
            max_backoff=self.config.retry_backoff_max,
            jitter=self.config.retry_jitter,
            failure_threshold=self.config.circuit_breaker_threshold,
            recovery_timeout=self.config.circuit_breaker_cooldown,
            half_open_successes=self.config.circuit_breaker_half_open_successes,
        )

    def _llm_resilience_key(self) -> str:
        """Unique key for the circuit breaker."""
        return f"{self.provider}:{self.config.model}"

    def prewarm(self) -> bool:
        """
        Pre-warm the client to avoid cold start latency on first request.
        OPTIMIZATION: Called at startup to initialize client and connection pool.
        Returns True if successful.
        """
        # Default implementation does nothing, override in subclasses
        self._prewarmed = True
        return True

    @abstractmethod
    def complete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Synchronous completion.
        Returns full response after completion.
        """
        pass

    @abstractmethod
    def respond(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Synchronous response using Responses API format.

        Args:
            input: User input (string or context array)
            instructions: System instructions (separated from input)
            tools: Tool definitions (internally-tagged format)
            **kwargs: Additional API parameters

        Returns:
            LLMResponse with output
        """
        pass

    @abstractmethod
    def stream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        """
        Streaming completion.
        Yields content chunks, returns full response at end.
        """
        pass

    @abstractmethod
    async def acomplete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        """Async completion"""
        pass

    @abstractmethod
    async def astream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        """Async streaming completion"""
        pass

    def _log_request(self, messages: List[Message]):
        """Log LLM request"""
        prompt_preview = messages[-1].content if messages else ""
        self.logger.llm_request(self.provider, self.config.model, prompt_preview)

    def _log_response(self, response: LLMResponse, duration_ms: float):
        """Log LLM response with full details for debugging"""
        # Format tool calls for logging
        tool_calls_data = None
        if response.tool_calls:
            tool_calls_data = [
                {"id": tc.id, "name": tc.name, "args": tc.arguments}
                for tc in response.tool_calls
            ]

        self.logger.llm_response(
            provider=self.provider,
            model=self.config.model,
            response_content=response.content or "",
            tokens=response.usage,
            duration_ms=duration_ms,
            tool_calls=tool_calls_data,
            finish_reason=response.finish_reason,
            raw_response=str(response.raw_response)[:500] if response.raw_response else None
        )


class OpenAIAdapter(LLMAdapter):
    """OpenAI API adapter"""

    def __init__(self, config: LLMConfig, logger: Optional[StructuredLogger] = None):
        super().__init__(config, logger=logger)
        self._client = None

    @property
    def provider(self) -> str:
        return "openai"

    def prewarm(self) -> bool:
        """
        Pre-warm the OpenAI client to avoid cold start latency.
        Initializes the client and HTTP connection pool.
        """
        try:
            self._get_client()
            self._prewarmed = True
            self.logger.info(f"OpenAI client pre-warmed for model {self.config.model}", component="llm")
            return True
        except Exception as e:
            self.logger.error(f"Failed to pre-warm OpenAI client: {e}", component="llm")
            return False

    def _get_client(self):
        """Lazy initialize OpenAI client"""
        if self._client is None:
            try:
                from openai import OpenAI
                self._client = OpenAI(
                    api_key=self.config.api_key,
                    base_url=self.config.api_base,
                    timeout=self.config.timeout
                )
            except ImportError:
                raise ImportError("openai package not installed. Run: pip install openai")
        return self._client

    def _get_async_client(self):
        """Get async OpenAI client"""
        try:
            from openai import AsyncOpenAI
            return AsyncOpenAI(
                api_key=self.config.api_key,
                base_url=self.config.api_base,
                timeout=self.config.timeout
            )
        except ImportError:
            raise ImportError("openai package not installed. Run: pip install openai")

    def _use_max_completion_tokens(self) -> bool:
        """
        Some newer OpenAI models (e.g., gpt-5-*) reject max_tokens in favor of max_completion_tokens.
        """
        model = (self.config.model or "").lower()
        return model.startswith(("gpt-5", "o1", "o3"))

    def _requires_default_temperature(self) -> bool:
        """
        Some models only support the default temperature (1.0) and will reject overrides.
        """
        model = (self.config.model or "").lower()
        return model.startswith(("gpt-5", "o1", "o3"))

    def _supports_sampling_params(self) -> bool:
        """
        Some newer models reject sampling controls like top_p/temperature overrides.
        """
        model = (self.config.model or "").lower()
        return not model.startswith(("gpt-5", "o1", "o3"))

    def _is_reasoning_model(self) -> bool:
        """
        Check if this is a reasoning model (o1, o3, gpt-5-*).
        These models tend to ignore tool calls unless forced.
        """
        model = (self.config.model or "").lower()
        return model.startswith(("gpt-5", "o1", "o3"))

    def _normalize_responses_input(
        self,
        input: Union[str, List[Dict[str, Any]]]
    ) -> Union[str, List[Dict[str, Any]]]:
        """
        Normalize "input" to the Responses API's message content-block shape when possible.

        - If input is a plain string, keep it as-is.
        - If input is a list of message dicts with string "content", convert to:
            {"role": "...", "content": [{"type": "input_text", "text": "..."}]}
        - Leave non-message items (e.g. function_call_output) untouched.
        """
        if not isinstance(input, list):
            return input

        normalized: List[Dict[str, Any]] = []
        for item in input:
            if not isinstance(item, dict):
                # Unknown structure; don't risk mutating it.
                return input

            if "role" not in item:
                normalized.append(item)
                continue

            content = item.get("content", "")
            if isinstance(content, str):
                normalized.append({**item, "content": [{"type": "input_text", "text": content}]})
            else:
                # Already content blocks (or something else) - pass through.
                normalized.append(item)

        return normalized

    def _parse_responses_output_text(self, response: Any) -> str:
        """Best-effort extraction of assistant-visible text from a Responses API response."""
        output_text = getattr(response, "output_text", None)
        if isinstance(output_text, str) and output_text:
            return output_text

        output = getattr(response, "output", None)
        if not isinstance(output, list):
            return output_text or ""

        parts: List[str] = []
        for item in output:
            item_type = item.get("type") if isinstance(item, dict) else getattr(item, "type", None)
            if item_type != "message":
                continue

            content = item.get("content") if isinstance(item, dict) else getattr(item, "content", None)
            if not isinstance(content, list):
                continue

            for block in content:
                block_type = block.get("type") if isinstance(block, dict) else getattr(block, "type", None)
                if block_type != "output_text":
                    continue
                text = block.get("text") if isinstance(block, dict) else getattr(block, "text", None)
                if isinstance(text, str) and text:
                    parts.append(text)

        return "".join(parts) if parts else (output_text or "")

    def _parse_responses_tool_calls(self, response: Any) -> List[ToolCall]:
        """Extract function tool calls from a Responses API response."""
        output = getattr(response, "output", None)
        if not isinstance(output, list):
            return []

        tool_calls: List[ToolCall] = []
        for item in output:
            item_type = item.get("type") if isinstance(item, dict) else getattr(item, "type", None)
            if item_type != "function_call":
                continue

            call_id = (
                (item.get("call_id") if isinstance(item, dict) else getattr(item, "call_id", None))
                or (item.get("id") if isinstance(item, dict) else getattr(item, "id", None))
                or ""
            )
            name = (
                (item.get("name") if isinstance(item, dict) else getattr(item, "name", None))
                or ""
            )
            raw_args = (
                (item.get("arguments") if isinstance(item, dict) else getattr(item, "arguments", None))
                or {}
            )

            arguments: Dict[str, Any]
            if isinstance(raw_args, str):
                try:
                    arguments = json.loads(raw_args) if raw_args else {}
                except json.JSONDecodeError:
                    arguments = {}
            elif isinstance(raw_args, dict):
                arguments = raw_args
            else:
                arguments = {}

            tool_calls.append(ToolCall(
                id=str(call_id),
                name=str(name),
                arguments=arguments
            ))

        return tool_calls

    def _prepare_request(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """Prepare request parameters"""
        max_tokens_value = kwargs.get("max_tokens", self.config.max_tokens)
        max_completion_tokens_value = kwargs.get(
            "max_completion_tokens",
            getattr(self.config, "max_completion_tokens", None)
        )
        temperature_value = kwargs.get("temperature", self.config.temperature)

        params = {
            "model": self.config.model,
            "messages": [m.to_dict() for m in messages],
        }

        # Temperature handling: drop overrides for models that require the default
        if self._supports_sampling_params():
            if temperature_value is not None:
                params["temperature"] = temperature_value
            top_p_value = kwargs.get("top_p", self.config.top_p)
            if top_p_value is not None:
                params["top_p"] = top_p_value
        else:
            # Log and drop unsupported sampling params
            if temperature_value not in (None, 1):
                try:
                    self.logger.logger.info(
                        "Model %s requires default temperature; dropping override %s",
                        self.config.model,
                        temperature_value
                    )
                except Exception:
                    pass
            top_p_value = kwargs.get("top_p", self.config.top_p)
            if top_p_value is not None:
                try:
                    self.logger.logger.info(
                        "Model %s does not support top_p; dropping override %s",
                        self.config.model,
                        top_p_value
                    )
                except Exception:
                    pass

        # Choose the correct token limit parameter for the target model
        if max_completion_tokens_value is not None:
            params["max_completion_tokens"] = max_completion_tokens_value
        elif self._use_max_completion_tokens():
            if max_tokens_value is not None:
                params["max_completion_tokens"] = max_tokens_value
        else:
            if max_tokens_value is not None:
                params["max_tokens"] = max_tokens_value

        if tools:
            params["tools"] = [t.to_openai_format() for t in tools]
            # For reasoning models that tend to ignore tools, force "required"
            default_choice = "required" if self._is_reasoning_model() else "auto"
            # Use explicitly passed tool_choice, or fall back to default
            explicit_choice = kwargs.get("tool_choice")
            params["tool_choice"] = explicit_choice if explicit_choice is not None else default_choice

        return params

    def _parse_response(self, response) -> LLMResponse:
        """Parse OpenAI response with detailed debugging"""
        choice = response.choices[0]
        message = choice.message

        # Debug: Log raw message details
        raw_content = message.content
        raw_tool_calls = message.tool_calls
        finish = choice.finish_reason

        tool_calls = []
        if raw_tool_calls:
            for tc in raw_tool_calls:
                try:
                    tool_calls.append(ToolCall(
                        id=tc.id,
                        name=tc.function.name,
                        arguments=json.loads(tc.function.arguments)
                    ))
                except json.JSONDecodeError as e:
                    self.logger.warning(
                        f"Failed to parse tool call args: {tc.function.arguments[:100]}",
                        component="llm"
                    )

        # Warn if we got no content and no tools (usually means token limit hit too early)
        if not raw_content and not tool_calls and finish != "stop":
            self.logger.warning(
                f"Empty response: finish_reason={finish}, tokens used but no content produced. "
                f"Model may need higher max_tokens for reasoning.",
                component="llm"
            )

        return LLMResponse(
            content=raw_content or "",
            role=MessageRole.ASSISTANT,
            tool_calls=tool_calls,
            finish_reason=finish,
            usage={
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens
            } if response.usage else None,
            model=response.model,
            raw_response=response
        )

    @llm_resilience
    def complete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        """Synchronous completion"""
        self._log_request(messages)
        start_time = time.time()

        try:
            client = self._get_client()
            params = self._prepare_request(messages, tools, **kwargs)

            # DIAGNOSTIC: Log exactly what we're sending
            tool_names = [t.name for t in tools] if tools else []
            self.logger.info(
                f"API REQUEST: model={params.get('model')}, tools={tool_names}, "
                f"tool_choice={params.get('tool_choice', 'none')}",
                component="llm"
            )

            tracer = get_tracer()
            with tracer.span("openai_api_call", model=self.config.model):
                response = client.chat.completions.create(**params)

            with tracer.span("parse_openai_response"):
                result = self._parse_response(response)

            tracer.add_metadata("input_tokens", result.usage.get("prompt_tokens", 0) if result.usage else 0)
            tracer.add_metadata("output_tokens", result.usage.get("completion_tokens", 0) if result.usage else 0)

            # DIAGNOSTIC: Log what we got back
            self.logger.info(
                f"API RESPONSE: content_len={len(result.content) if result.content else 0}, "
                f"tool_calls={len(result.tool_calls)}, finish={result.finish_reason}",
                component="llm"
            )

            duration_ms = (time.time() - start_time) * 1000
            self._log_response(result, duration_ms)
            return result

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            raise

    @llm_resilience
    def respond(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Synchronous response using OpenAI Responses API.

        Args:
            input: User input (string or context array)
            instructions: System instructions
            tools: Tool definitions (internally-tagged format)
            **kwargs: Additional API parameters

        Returns:
            LLMResponse with output
        """
        start_time = time.time()

        try:
            client = self._get_client()

            # Prepare request parameters for Responses API
            max_output_tokens_value = kwargs.get("max_output_tokens")
            if max_output_tokens_value is None:
                max_output_tokens_value = kwargs.get("max_tokens", self.config.max_tokens)
            temperature_value = kwargs.get("temperature", self.config.temperature)
            max_tool_calls_value = kwargs.get("max_tool_calls")
            parallel_tool_calls_value = kwargs.get("parallel_tool_calls")

            params = {
                "model": self.config.model,
                "input": self._normalize_responses_input(input),
            }

            if instructions:
                params["instructions"] = instructions

            # Temperature handling
            if self._supports_sampling_params():
                if temperature_value is not None:
                    params["temperature"] = temperature_value
                top_p_value = kwargs.get("top_p", self.config.top_p)
                if top_p_value is not None:
                    params["top_p"] = top_p_value

            # Token limit parameter (Responses API)
            if max_output_tokens_value is not None:
                params["max_output_tokens"] = max_output_tokens_value

            # Tool call limiting (Responses API)
            if max_tool_calls_value is not None:
                params["max_tool_calls"] = max_tool_calls_value
            if parallel_tool_calls_value is not None:
                params["parallel_tool_calls"] = parallel_tool_calls_value

            if tools:
                params["tools"] = tools  # Already internally-tagged format
                # For reasoning models, force "required"
                default_choice = "required" if self._is_reasoning_model() else "auto"
                explicit_choice = kwargs.get("tool_choice")
                params["tool_choice"] = explicit_choice if explicit_choice is not None else default_choice

            # DIAGNOSTIC: Log what we're sending
            tool_names = [t.get("name") for t in tools] if tools else []
            self.logger.info(
                f"RESPONSES API REQUEST: model={params.get('model')}, tools={tool_names}, "
                f"tool_choice={params.get('tool_choice', 'none')}",
                component="llm"
            )

            # Call Responses API endpoint
            tracer = get_tracer()
            with tracer.span("openai_responses_api_call", model=self.config.model):
                response = client.responses.create(**params)

            with tracer.span("parse_responses_output"):
                output_text = self._parse_responses_output_text(response)
                tool_calls = self._parse_responses_tool_calls(response)

            result = LLMResponse(
                content=output_text,
                role=MessageRole.ASSISTANT,
                tool_calls=tool_calls,
                finish_reason=getattr(response, "status", None) or getattr(response, "finish_reason", "stop"),
                usage={
                    "prompt_tokens": getattr(response.usage, "input_tokens", None),
                    "completion_tokens": getattr(response.usage, "output_tokens", None),
                    "total_tokens": getattr(response.usage, "total_tokens", None)
                } if hasattr(response, "usage") and response.usage else None,
                model=getattr(response, "model", self.config.model),
                raw_response=response
            )

            # DIAGNOSTIC: Log what we got back
            self.logger.info(
                f"RESPONSES API RESPONSE: output_len={len(output_text)}, "
                f"tool_calls={len(tool_calls)}, finish={result.finish_reason}",
                component="llm"
            )

            duration_ms = (time.time() - start_time) * 1000
            self._log_response(result, duration_ms)
            return result

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            raise

    def stream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        """Streaming completion"""
        self._log_request(messages)
        start_time = time.time()

        try:
            client = self._get_client()
            params = self._prepare_request(messages, tools, **kwargs)
            params["stream"] = True

            full_content = ""
            tool_calls = []
            current_tool_call = None

            stream = client.chat.completions.create(**params)

            for chunk in stream:
                if chunk.choices:
                    delta = chunk.choices[0].delta

                    # Handle content
                    if delta.content:
                        full_content += delta.content
                        yield delta.content

                    # Handle tool calls
                    if delta.tool_calls:
                        for tc in delta.tool_calls:
                            if tc.index is not None:
                                while len(tool_calls) <= tc.index:
                                    tool_calls.append({"id": "", "name": "", "arguments": ""})
                                if tc.id:
                                    tool_calls[tc.index]["id"] = tc.id
                                if tc.function:
                                    if tc.function.name:
                                        tool_calls[tc.index]["name"] = tc.function.name
                                    if tc.function.arguments:
                                        tool_calls[tc.index]["arguments"] += tc.function.arguments

            # Build final response
            parsed_tool_calls = []
            for tc in tool_calls:
                if tc["name"]:
                    try:
                        args = json.loads(tc["arguments"]) if tc["arguments"] else {}
                    except json.JSONDecodeError:
                        args = {}
                    parsed_tool_calls.append(ToolCall(
                        id=tc["id"],
                        name=tc["name"],
                        arguments=args
                    ))

            result = LLMResponse(
                content=full_content,
                role=MessageRole.ASSISTANT,
                tool_calls=parsed_tool_calls,
                finish_reason="stop",
                model=self.config.model
            )

            duration_ms = (time.time() - start_time) * 1000
            self._log_response(result, duration_ms)
            return result

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            raise

    @llm_resilience
    async def acomplete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        """Async completion"""
        self._log_request(messages)
        start_time = time.time()

        try:
            client = self._get_async_client()
            params = self._prepare_request(messages, tools, **kwargs)
            response = await client.chat.completions.create(**params)
            result = self._parse_response(response)

            duration_ms = (time.time() - start_time) * 1000
            self._log_response(result, duration_ms)
            return result

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            raise

    async def astream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        """Async streaming completion"""
        self._log_request(messages)

        try:
            client = self._get_async_client()
            params = self._prepare_request(messages, tools, **kwargs)
            params["stream"] = True

            stream = await client.chat.completions.create(**params)

            async for chunk in stream:
                if chunk.choices:
                    delta = chunk.choices[0].delta
                    if delta.content:
                        yield delta.content

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            raise


class AnthropicAdapter(LLMAdapter):
    """Anthropic API adapter"""

    def __init__(self, config: LLMConfig, logger: Optional[StructuredLogger] = None):
        super().__init__(config, logger=logger)
        self._client = None

    @property
    def provider(self) -> str:
        return "anthropic"

    def prewarm(self) -> bool:
        """
        Pre-warm the Anthropic client to avoid cold start latency.
        """
        try:
            self._get_client()
            self._prewarmed = True
            self.logger.info(f"Anthropic client pre-warmed for model {self.config.model}", component="llm")
            return True
        except Exception as e:
            self.logger.error(f"Failed to pre-warm Anthropic client: {e}", component="llm")
            return False

    def _get_client(self):
        """Lazy initialize Anthropic client"""
        if self._client is None:
            try:
                from anthropic import Anthropic
                self._client = Anthropic(
                    api_key=self.config.api_key,
                    timeout=self.config.timeout
                )
            except ImportError:
                raise ImportError("anthropic package not installed. Run: pip install anthropic")
        return self._client

    def _get_async_client(self):
        """Get async Anthropic client"""
        try:
            from anthropic import AsyncAnthropic
            return AsyncAnthropic(
                api_key=self.config.api_key,
                timeout=self.config.timeout
            )
        except ImportError:
            raise ImportError("anthropic package not installed. Run: pip install anthropic")

    def _prepare_messages(self, messages: List[Message]) -> tuple:
        """Prepare messages for Anthropic API, extracting system message"""
        system_message = ""
        chat_messages = []

        for msg in messages:
            if msg.role == MessageRole.SYSTEM:
                system_message = msg.content
            elif msg.role == MessageRole.TOOL:
                # Convert tool response to Anthropic format
                chat_messages.append({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": msg.tool_call_id,
                        "content": msg.content
                    }]
                })
            else:
                chat_messages.append({
                    "role": msg.role.value,
                    "content": msg.content
                })

        return system_message, chat_messages

    def _parse_response(self, response) -> LLMResponse:
        """Parse Anthropic response"""
        content = ""
        tool_calls = []

        for block in response.content:
            if block.type == "text":
                content = block.text
            elif block.type == "tool_use":
                tool_calls.append(ToolCall(
                    id=block.id,
                    name=block.name,
                    arguments=block.input
                ))

        return LLMResponse(
            content=content,
            role=MessageRole.ASSISTANT,
            tool_calls=tool_calls,
            finish_reason=response.stop_reason,
            usage={
                "prompt_tokens": response.usage.input_tokens,
                "completion_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.input_tokens + response.usage.output_tokens
            },
            model=response.model,
            raw_response=response
        )

    @llm_resilience
    def complete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        """Synchronous completion"""
        self._log_request(messages)
        start_time = time.time()

        try:
            client = self._get_client()

            # Check if we have system_blocks in kwargs (from ContextManager)
            system_blocks = kwargs.pop("system_blocks", None)

            if system_blocks is not None:
                # Use system blocks directly (from ContextManager serializer)
                chat_messages = [m.to_dict() for m in messages if m.role != MessageRole.SYSTEM]
                system_param = system_blocks  # Array of content blocks
            else:
                # Legacy path: extract system message from messages
                system_message, chat_messages = self._prepare_messages(messages)
                system_param = system_message if system_message else None

            params = {
                "model": self.config.model,
                "messages": chat_messages,
                "max_output_tokens": kwargs.get("max_tokens", self.config.max_tokens),
                "temperature": kwargs.get("temperature", self.config.temperature),
            }

            if system_param:
                params["system"] = system_param

            if tools:
                params["tools"] = [t.to_anthropic_format() for t in tools]

            tracer = get_tracer()
            with tracer.span("anthropic_api_call", model=self.config.model):
                response = client.messages.create(**params)

            with tracer.span("parse_anthropic_response"):
                result = self._parse_response(response)

            tracer.add_metadata("input_tokens", result.usage.get("prompt_tokens", 0) if result.usage else 0)
            tracer.add_metadata("output_tokens", result.usage.get("completion_tokens", 0) if result.usage else 0)

            duration_ms = (time.time() - start_time) * 1000
            self._log_response(result, duration_ms)
            return result

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            raise

    def stream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        """Streaming completion"""
        self._log_request(messages)
        start_time = time.time()

        try:
            client = self._get_client()

            # Check if we have system_blocks in kwargs (from ContextManager)
            system_blocks = kwargs.pop("system_blocks", None)

            if system_blocks is not None:
                # Use system blocks directly (from ContextManager serializer)
                chat_messages = [m.to_dict() for m in messages if m.role != MessageRole.SYSTEM]
                system_param = system_blocks  # Array of content blocks
            else:
                # Legacy path: extract system message from messages
                system_message, chat_messages = self._prepare_messages(messages)
                system_param = system_message if system_message else None

            params = {
                "model": self.config.model,
                "messages": chat_messages,
                "max_output_tokens": kwargs.get("max_tokens", self.config.max_tokens),
                "temperature": kwargs.get("temperature", self.config.temperature),
            }

            if system_param:
                params["system"] = system_param

            if tools:
                params["tools"] = [t.to_anthropic_format() for t in tools]

            full_content = ""
            tool_calls = []
            current_tool = None

            with client.messages.stream(**params) as stream:
                for event in stream:
                    if hasattr(event, 'type'):
                        if event.type == 'content_block_start':
                            if hasattr(event, 'content_block'):
                                if event.content_block.type == 'tool_use':
                                    current_tool = {
                                        "id": event.content_block.id,
                                        "name": event.content_block.name,
                                        "arguments": ""
                                    }
                        elif event.type == 'content_block_delta':
                            if hasattr(event, 'delta'):
                                if hasattr(event.delta, 'text'):
                                    full_content += event.delta.text
                                    yield event.delta.text
                                elif hasattr(event.delta, 'partial_json'):
                                    if current_tool:
                                        current_tool["arguments"] += event.delta.partial_json
                        elif event.type == 'content_block_stop':
                            if current_tool:
                                try:
                                    args = json.loads(current_tool["arguments"])
                                except json.JSONDecodeError:
                                    args = {}
                                tool_calls.append(ToolCall(
                                    id=current_tool["id"],
                                    name=current_tool["name"],
                                    arguments=args
                                ))
                                current_tool = None

            result = LLMResponse(
                content=full_content,
                role=MessageRole.ASSISTANT,
                tool_calls=tool_calls,
                finish_reason="stop",
                model=self.config.model
            )

            duration_ms = (time.time() - start_time) * 1000
            self._log_response(result, duration_ms)
            return result

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            raise

    @llm_resilience
    async def acomplete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        """Async completion"""
        self._log_request(messages)
        start_time = time.time()

        try:
            client = self._get_async_client()

            # Check if we have system_blocks in kwargs (from ContextManager)
            system_blocks = kwargs.pop("system_blocks", None)

            if system_blocks is not None:
                # Use system blocks directly (from ContextManager serializer)
                chat_messages = [m.to_dict() for m in messages if m.role != MessageRole.SYSTEM]
                system_param = system_blocks  # Array of content blocks
            else:
                # Legacy path: extract system message from messages
                system_message, chat_messages = self._prepare_messages(messages)
                system_param = system_message if system_message else None

            params = {
                "model": self.config.model,
                "messages": chat_messages,
                "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
                "temperature": kwargs.get("temperature", self.config.temperature),
            }

            if system_param:
                params["system"] = system_param

            if tools:
                params["tools"] = [t.to_anthropic_format() for t in tools]

            response = await client.messages.create(**params)
            result = self._parse_response(response)

            duration_ms = (time.time() - start_time) * 1000
            self._log_response(result, duration_ms)
            return result

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            raise

    async def astream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        """Async streaming completion"""
        self._log_request(messages)

        try:
            client = self._get_async_client()

            # Check if we have system_blocks in kwargs (from ContextManager)
            system_blocks = kwargs.pop("system_blocks", None)

            if system_blocks is not None:
                # Use system blocks directly (from ContextManager serializer)
                chat_messages = [m.to_dict() for m in messages if m.role != MessageRole.SYSTEM]
                system_param = system_blocks  # Array of content blocks
            else:
                # Legacy path: extract system message from messages
                system_message, chat_messages = self._prepare_messages(messages)
                system_param = system_message if system_message else None

            params = {
                "model": self.config.model,
                "messages": chat_messages,
                "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
                "temperature": kwargs.get("temperature", self.config.temperature),
            }

            if system_param:
                params["system"] = system_param

            if tools:
                params["tools"] = [t.to_anthropic_format() for t in tools]

            async with client.messages.stream(**params) as stream:
                async for text in stream.text_stream:
                    yield text

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            raise

    def respond(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Anthropic doesn't have Responses API - convert to Messages API format.
        """
        def _extract_text(content: Any) -> str:
            if content is None:
                return ""
            if isinstance(content, str):
                return content
            if isinstance(content, dict):
                # e.g. {"type": "input_text", "text": "..."} or similar
                text = content.get("text")
                return text if isinstance(text, str) else ""
            if isinstance(content, list):
                parts: List[str] = []
                for block in content:
                    if isinstance(block, str):
                        parts.append(block)
                        continue
                    if isinstance(block, dict):
                        text = block.get("text")
                        if isinstance(text, str):
                            parts.append(text)
                        continue
                    # Unknown block type (pydantic objects, etc.)
                    block_text = getattr(block, "text", None)
                    if isinstance(block_text, str):
                        parts.append(block_text)
                return "".join(parts)
            return str(content)

        # Convert Responses API format to Messages API format
        messages = []

        if instructions:
            messages.append(Message(MessageRole.SYSTEM, instructions))

        if isinstance(input, str):
            messages.append(Message(MessageRole.USER, input))
        elif isinstance(input, list):
            # Convert input array to messages
            for item in input:
                if not isinstance(item, dict):
                    continue

                # Responses input can include non-message items (e.g. function_call_output)
                if "role" not in item:
                    item_type = item.get("type")
                    if item_type in ("function_call_output", "tool_output"):
                        messages.append(Message(
                            role=MessageRole.TOOL,
                            content=_extract_text(item.get("output", "")),
                            name=item.get("name"),
                            tool_call_id=item.get("call_id") or item.get("id")
                        ))
                    continue

                role_value = item.get("role", "user")
                try:
                    role = MessageRole(role_value)
                except Exception:
                    role = MessageRole.USER
                messages.append(Message(role, _extract_text(item.get("content", ""))))

        # Convert internally-tagged tools to ToolDefinition format
        tool_defs = None
        if tools:
            tool_defs = []
            for tool in tools:
                if tool.get("type") == "function":
                    tool_defs.append(ToolDefinition(
                        name=tool.get("name", ""),
                        description=tool.get("description", ""),
                        parameters=tool.get("parameters", {}).get("properties", {}),
                        required=tool.get("parameters", {}).get("required", [])
                    ))

        # Use existing complete() method
        return self.complete(messages, tool_defs, **kwargs)


class CustomAdapter(LLMAdapter):
    """
    Custom API adapter for OpenAI-compatible endpoints.
    Works with vLLM, Ollama, text-generation-webui, etc.
    """

    def __init__(self, config: LLMConfig, logger: Optional[StructuredLogger] = None):
        super().__init__(config, logger=logger)
        # Use OpenAI client with custom base URL
        self._openai_adapter = None

    @property
    def provider(self) -> str:
        return "custom"

    def _get_adapter(self) -> OpenAIAdapter:
        """Get underlying OpenAI adapter with custom base URL"""
        if self._openai_adapter is None:
            # Ensure base URL is set
            if not self.config.api_base:
                raise ValueError("api_base must be set for custom adapter")
            self._openai_adapter = OpenAIAdapter(self.config)
        return self._openai_adapter

    def complete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        """Synchronous completion via custom endpoint"""
        return self._get_adapter().complete(messages, tools, **kwargs)

    def stream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        """Streaming completion via custom endpoint"""
        return self._get_adapter().stream(messages, tools, **kwargs)

    async def acomplete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        """Async completion via custom endpoint"""
        return await self._get_adapter().acomplete(messages, tools, **kwargs)

    async def astream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        """Async streaming via custom endpoint"""
        async for chunk in self._get_adapter().astream(messages, tools, **kwargs):
            yield chunk

    def respond(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        **kwargs
    ) -> LLMResponse:
        """Delegate to underlying OpenAI adapter"""
        return self._get_adapter().respond(input, instructions, tools, **kwargs)


class FailoverLLMAdapter(LLMAdapter):
    """
    Adapter that adds model-level failover on top of a primary adapter.

    Behavior:
    - Uses the primary adapter first (with its own retry + circuit breaker).
    - If it raises an exception, iterates through configured failover models.
    - If no failover models are configured, behaves like the primary adapter.

    NOTE: Failover is only triggered on exceptions. If all adapters fail,
    the last exception is propagated to the caller.
    """

    def __init__(
        self,
        primary: LLMAdapter,
        failover_models: List[LLMConfig],
        logger: Optional[StructuredLogger] = None
    ):
        super().__init__(primary.config, logger=logger or getattr(primary, "logger", None))
        self._primary = primary
        self._adapters: List[LLMAdapter] = [primary]

        # Initialize adapters for each failover model (if any)
        for cfg in failover_models or []:
            try:
                # Create a base adapter for the failover config using the same factory
                adapter = create_adapter(cfg, logger=self.logger) if not isinstance(primary, FailoverLLMAdapter) else None
                if adapter is not None:
                    self._adapters.append(adapter)
            except Exception as e:
                # Log but continue so a bad failover config doesn't break startup
                self.logger.error(f"Failed to initialize failover adapter for {cfg.provider}:{cfg.model} - {e}",
                                  component="llm")

    @property
    def provider(self) -> str:
        # Report the primary provider for logging/metrics
        return self._primary.provider

    def _iter_adapters(self) -> List[LLMAdapter]:
        """Return the list of adapters to try, primary first."""
        return self._adapters or [self._primary]

    def complete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        last_exc: Optional[Exception] = None

        for idx, adapter in enumerate(self._iter_adapters()):
            provider = adapter.provider
            model = getattr(adapter, "config", self.config).model

            if idx > 0:
                # Log failover attempt
                self.logger.warning(
                    f"LLM failover: primary failed, trying {provider}:{model}",
                    component="llm"
                )

            try:
                return adapter.complete(messages, tools, **kwargs)
            except Exception as e:
                last_exc = e
                # Underlying adapters should also log errors; this is a summary
                self.logger.llm_error(provider, model, e)
                continue

        # All adapters failed; propagate the last exception
        if last_exc:
            raise last_exc
        # Should not reach here, but guard just in case
        raise RuntimeError("FailoverLLMAdapter: no adapters available for completion")

    def stream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        last_exc: Optional[Exception] = None

        for idx, adapter in enumerate(self._iter_adapters()):
            provider = adapter.provider
            model = getattr(adapter, "config", self.config).model

            had_output = False

            if idx > 0:
                self.logger.warning(
                    f"LLM streaming failover: primary failed, trying {provider}:{model}",
                    component="llm"
                )

            try:
                stream = adapter.stream(messages, tools, **kwargs)
                while True:
                    try:
                        chunk = next(stream)
                    except StopIteration as stop:
                        # Normal completion, propagate generator return value if present
                        return stop.value if hasattr(stop, "value") else None  # type: ignore[return-value]
                    had_output = True
                    yield chunk
            except Exception as e:
                last_exc = e
                self.logger.llm_error(provider, model, e)
                # If we've already yielded output from this adapter, do not switch mid-stream
                if had_output:
                    raise
                # Otherwise, try the next adapter
                continue

        if last_exc:
            raise last_exc
        raise RuntimeError("FailoverLLMAdapter: no adapters available for streaming")

    async def acomplete(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> LLMResponse:
        last_exc: Optional[Exception] = None

        for idx, adapter in enumerate(self._iter_adapters()):
            provider = adapter.provider
            model = getattr(adapter, "config", self.config).model

            if idx > 0:
                self.logger.warning(
                    f"LLM async failover: primary failed, trying {provider}:{model}",
                    component="llm"
                )

            try:
                return await adapter.acomplete(messages, tools, **kwargs)
            except Exception as e:
                last_exc = e
                self.logger.llm_error(provider, model, e)
                continue

        if last_exc:
            raise last_exc
        raise RuntimeError("FailoverLLMAdapter: no adapters available for async completion")

    async def astream(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        last_exc: Optional[Exception] = None

        for idx, adapter in enumerate(self._iter_adapters()):
            provider = adapter.provider
            model = getattr(adapter, "config", self.config).model

            had_output = False

            if idx > 0:
                self.logger.warning(
                    f"LLM async streaming failover: primary failed, trying {provider}:{model}",
                    component="llm"
                )

            try:
                async for chunk in adapter.astream(messages, tools, **kwargs):
                    had_output = True
                    yield chunk
                return
            except Exception as e:
                last_exc = e
                self.logger.llm_error(provider, model, e)
                if had_output:
                    raise
                continue

        if last_exc:
            raise last_exc
        raise RuntimeError("FailoverLLMAdapter: no adapters available for async streaming")

    def respond(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        **kwargs
    ) -> LLMResponse:
        """Respond with failover support"""
        last_exc: Optional[Exception] = None

        for idx, adapter in enumerate(self._iter_adapters()):
            provider = adapter.provider
            model = getattr(adapter, "config", self.config).model

            if idx > 0:
                self.logger.warning(
                    f"LLM respond failover: primary failed, trying {provider}:{model}",
                    component="llm"
                )

            try:
                return adapter.respond(input, instructions, tools, **kwargs)
            except Exception as e:
                last_exc = e
                self.logger.llm_error(provider, model, e)
                continue

        if last_exc:
            raise last_exc
        raise RuntimeError("FailoverLLMAdapter: no adapters available for respond")


def create_adapter(config: LLMConfig, logger: Optional[StructuredLogger] = None) -> LLMAdapter:
    """Factory function to create appropriate adapter based on config.

    If failover models are configured on the LLMConfig, this returns a
    FailoverLLMAdapter that will try the primary model first and then
    sequentially fall back to the configured backups on failure.
    """
    adapters = {
        "openai": OpenAIAdapter,
        "anthropic": AnthropicAdapter,
        "custom": CustomAdapter,
        # Gemini support: use OpenAI-compatible adapter (requires api_base to point
        # at a Gemini/OpenAI-compatible endpoint and GEMINI_API_KEY to be set)
        "gemini": OpenAIAdapter,
    }

    provider = config.provider.lower()
    if provider not in adapters:
        base_adapter: LLMAdapter = CustomAdapter(config, logger=logger)
    else:
        base_adapter = adapters[provider](config, logger=logger)

    # If no failover models are configured, return the base adapter directly
    failover_models = getattr(config, "failover_models", None) or []
    if not failover_models:
        return base_adapter

    # Wrap with failover adapter; if any failover config is itself configured
    # with failover_models, those will be respected by the nested adapter.
    return FailoverLLMAdapter(base_adapter, failover_models, logger=logger)


# Convenience functions for simple usage

def quick_complete(
    prompt: str,
    provider: str = "openai",
    model: str = "gpt-4o-mini",
    system_prompt: Optional[str] = None,
    **kwargs
) -> str:
    """Quick one-off completion"""
    config = LLMConfig(provider=provider, model=model, **kwargs)
    adapter = create_adapter(config)

    messages = []
    if system_prompt:
        messages.append(Message(MessageRole.SYSTEM, system_prompt))
    messages.append(Message(MessageRole.USER, prompt))

    response = adapter.complete(messages)
    return response.content


async def aquick_complete(
    prompt: str,
    provider: str = "openai",
    model: str = "gpt-4o-mini",
    system_prompt: Optional[str] = None,
    **kwargs
) -> str:
    """Async quick one-off completion"""
    config = LLMConfig(provider=provider, model=model, **kwargs)
    adapter = create_adapter(config)

    messages = []
    if system_prompt:
        messages.append(Message(MessageRole.SYSTEM, system_prompt))
    messages.append(Message(MessageRole.USER, prompt))

    response = await adapter.acomplete(messages)
    return response.content
