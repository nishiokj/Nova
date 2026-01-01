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
    response_id: Optional[str] = None  # For stateful conversation continuation

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

    # @abstractmethod
    # def complete(
    #     self,
    #     messages: List[Message],
    #     tools: Optional[List[ToolDefinition]] = None,
    #     **kwargs
    # ) -> LLMResponse:
    #     """
    #     Synchronous completion.
    #     Returns full response after completion.
    #     """
    #     pass

    @abstractmethod
    def respond(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Synchronous response using Responses API format.

        Args:
            input: User input (string or context array)
            instructions: System instructions (separated from input)
            tools: Tool definitions (internally-tagged format)
            prompt_cache_key: Stable key for prompt caching (enables cache hits)
            prompt_cache_retention: Cache retention policy (e.g., "24h")
            previous_response_id: Continue from a previous response (stateful mode)
            **kwargs: Additional API parameters

        Returns:
            LLMResponse with output

        Stateful Conversations:
            When previous_response_id is provided, OpenAI continues from that
            response's state. You only need to send NEW items in the input array,
            not the full conversation history. This significantly reduces payload
            size and latency.
        """
        pass

    # @abstractmethod
    # def stream(
    #     self,
    #     messages: List[Message],
    #     tools: Optional[List[ToolDefinition]] = None,
    #     **kwargs
    # ) -> Generator[str, None, LLMResponse]:
    #     """
    #     Streaming completion.
    #     Yields content chunks, returns full response at end.
    #     """
    #     pass

    # @abstractmethod
    # async def acomplete(
    #     self,
    #     messages: List[Message],
    #     tools: Optional[List[ToolDefinition]] = None,
    #     **kwargs
    # ) -> LLMResponse:
    #     """Async completion"""
    #     pass

    # @abstractmethod
    # async def astream(
    #     self,
    #     messages: List[Message],
    #     tools: Optional[List[ToolDefinition]] = None,
    #     **kwargs
    # ) -> AsyncGenerator[str, None]:
    #     """Async streaming completion"""
    #     pass

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

    def _supports_prompt_cache_retention(self) -> bool:
        """
        Check if the model supports prompt_cache_retention parameter.
        Some smaller models (e.g., gpt-5-nano) don't support this feature.
        """
        model = (self.config.model or "").lower()
        # gpt-5-nano doesn't support prompt_cache_retention
        if "nano" in model:
            return False
        return True

    def _normalize_responses_input(
        self,
        input: Union[str, List[Dict[str, Any]]]
    ) -> Union[str, List[Dict[str, Any]]]:
        """
        Normalize "input" to the Responses API's message content-block shape when possible.

        - If input is a plain string, keep it as-is.
        - If input is a list of message dicts with string "content", convert to:
            {"role": "...", "content": [{"type": "input_text" | "output_text", "text": "..."}]}
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
                role = item.get("role", "")
                content_type = "output_text" if role == "assistant" else "input_text"
                normalized.append({**item, "content": [{"type": content_type, "text": content}]})
            else:
                role = item.get("role", "")
                content_type = "output_text" if role == "assistant" else "input_text"
                if isinstance(content, list):
                    blocks: List[Dict[str, Any]] = []
                    for block in content:
                        if not isinstance(block, dict):
                            blocks.append(block)
                            continue
                        block_type = block.get("type")
                        if block_type in ("input", "text"):
                            blocks.append({**block, "type": content_type})
                        else:
                            blocks.append(block)
                    normalized.append({**item, "content": blocks})
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
            if item_type in ("output_text", "text"):
                text = item.get("text") if isinstance(item, dict) else getattr(item, "text", None)
                if isinstance(text, str) and text:
                    parts.append(text)
                continue

            if item_type != "message":
                continue

            content = item.get("content") if isinstance(item, dict) else getattr(item, "content", None)
            if not isinstance(content, list):
                continue

            for block in content:
                block_type = block.get("type") if isinstance(block, dict) else getattr(block, "type", None)
                if block_type not in ("output_text", "text"):
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

        model_override = kwargs.get("model")
        params = {
            "model": model_override or self.config.model,
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
            # Convert ToolDefinition objects to dicts if needed
            converted_tools = []
            for t in tools:
                if hasattr(t, 'to_openai_format'):
                    converted_tools.append(t.to_openai_format())
                elif isinstance(t, dict):
                    converted_tools.append(t)
                else:
                    converted_tools.append({
                        "type": "function",
                        "function": {
                            "name": getattr(t, 'name', 'unknown'),
                            "description": getattr(t, 'description', ''),
                            "parameters": getattr(t, 'parameters', {})
                        }
                    })
            params["tools"] = converted_tools
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

    # @llm_resilience
    # def complete(
    #     self,
    #     messages: List[Message],
    #     tools: Optional[List[ToolDefinition]] = None,
    #     **kwargs
    # ) -> LLMResponse:
    #     """Synchronous completion"""
    #     self._log_request(messages)
    #     start_time = time.time()

    #     try:
    #         client = self._get_client()
    #         params = self._prepare_request(messages, tools, **kwargs)

    #         # DIAGNOSTIC: Log exactly what we're sending
    #         tool_names = [t.name for t in tools] if tools else []
    #         self.logger.info(
    #             f"API REQUEST: model={params.get('model')}, tools={tool_names}, "
    #             f"tool_choice={params.get('tool_choice', 'none')}",
    #             component="llm"
    #         )

    #         tracer = get_tracer()
    #         with tracer.span("openai_api_call", model=self.config.model):
    #             response = client.chat.completions.create(**params)

    #         with tracer.span("parse_openai_response"):
    #             result = self._parse_response(response)

    #         tracer.add_metadata("input_tokens", result.usage.get("prompt_tokens", 0) if result.usage else 0)
    #         tracer.add_metadata("output_tokens", result.usage.get("completion_tokens", 0) if result.usage else 0)

    #         # DIAGNOSTIC: Log what we got back
    #         self.logger.info(
    #             f"API RESPONSE: content_len={len(result.content) if result.content else 0}, "
    #             f"tool_calls={len(result.tool_calls)}, finish={result.finish_reason}",
    #             component="llm"
    #         )

    #         duration_ms = (time.time() - start_time) * 1000
    #         self._log_response(result, duration_ms)
    #         return result

    #     except Exception as e:
    #         self.logger.llm_error(self.provider, self.config.model, e)
    #         raise

    @llm_resilience
    def respond(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Synchronous response using OpenAI Responses API.

        Args:
            input: User input (string or context array)
            instructions: System instructions
            tools: Tool definitions (internally-tagged format)
            prompt_cache_key: Stable key for prompt caching (enables cache hits on similar requests)
            prompt_cache_retention: Cache retention policy (e.g., "24h" for extended caching)
            previous_response_id: Continue from a previous response (stateful mode - send only deltas)
            **kwargs: Additional API parameters

        Returns:
            LLMResponse with output

        Prompt Caching:
            When prompt_cache_key is provided, OpenAI will cache the input prefix
            for faster subsequent requests with the same key. This can significantly
            reduce latency and costs for repeated similar requests.

        Stateful Conversations:
            When previous_response_id is provided, continue from that response.
            Only send NEW items in input - OpenAI maintains the conversation state.
            This dramatically reduces payload size and processing time.
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
            text_value = kwargs.get("text")

            # =================================================================
            # PROMPT CACHING OPTIMIZATION: Order matters for cache hits!
            # Stable content (instructions, tools) should come BEFORE dynamic
            # content (input) so the prefix can be cached across requests.
            # Order: model → instructions → tools → config → input
            # =================================================================

            model_override = kwargs.get("model")
            params = {
                "model": model_override or self.config.model,
            }

            # 1. Instructions (system prompt) - STABLE, cacheable prefix
            if instructions:
                params["instructions"] = instructions

            # 2. Tools - STABLE, cacheable prefix
            if tools:
                # Convert ToolDefinition objects to Responses API format
                converted_tools = []
                for t in tools:
                    if hasattr(t, 'to_responses_format'):
                        converted_tools.append(t.to_responses_format())
                    elif isinstance(t, dict):
                        converted_tools.append(t)
                    else:
                        # Fallback: Responses API format (flat, name at top level)
                        converted_tools.append({
                            "type": "function",
                            "name": getattr(t, 'name', 'unknown'),
                            "description": getattr(t, 'description', ''),
                            "parameters": {
                                "type": "object",
                                "properties": getattr(t, 'parameters', {}),
                                "required": getattr(t, 'required', [])
                            }
                        })
                params["tools"] = converted_tools
                # For reasoning models, force "required"
                default_choice = "required" if self._is_reasoning_model() else "auto"
                explicit_choice = kwargs.get("tool_choice")
                params["tool_choice"] = explicit_choice if explicit_choice is not None else default_choice

            # 3. Prompt caching parameters - config for cache behavior
            if prompt_cache_key:
                params["prompt_cache_key"] = prompt_cache_key
            # Only add prompt_cache_retention for models that support it
            if prompt_cache_retention and self._supports_prompt_cache_retention():
                params["prompt_cache_retention"] = prompt_cache_retention

            # 4. Stateful conversation continuation
            if previous_response_id:
                params["previous_response_id"] = previous_response_id

            # 5. Generation config - relatively stable
            if self._supports_sampling_params():
                if temperature_value is not None:
                    params["temperature"] = temperature_value
                top_p_value = kwargs.get("top_p", self.config.top_p)
                if top_p_value is not None:
                    params["top_p"] = top_p_value

            if max_output_tokens_value is not None:
                params["max_output_tokens"] = max_output_tokens_value

            if max_tool_calls_value is not None:
                params["max_tool_calls"] = max_tool_calls_value
            if parallel_tool_calls_value is not None:
                params["parallel_tool_calls"] = parallel_tool_calls_value
            if text_value is not None:
                params["text"] = text_value

            timeout_override = kwargs.get("timeout")
            if timeout_override is not None:
                params["timeout"] = timeout_override

            # 6. Input (conversation) - DYNAMIC, comes LAST for cache efficiency
            params["input"] = self._normalize_responses_input(input)

            # DIAGNOSTIC: Log what we're sending
            # Handle both ToolDefinition objects and dicts
            tool_names = [
                t.name if hasattr(t, 'name') else t.get("name", "unknown")
                for t in tools
            ] if tools else []
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
                raw_response=response,
                response_id=getattr(response, "id", None),  # Capture for stateful continuation
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
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        """
        Streaming response using OpenAI Responses API.

        Args:
            input: User input (string or context array)
            instructions: System instructions
            tools: Tool definitions (internally-tagged format)
            prompt_cache_key: Stable key for prompt caching
            prompt_cache_retention: Cache retention policy (e.g., "24h")
            previous_response_id: Continue from a previous response (stateful mode)
            **kwargs: Additional API parameters

        Yields:
            Text content chunks as they arrive

        Returns:
            LLMResponse with full output after stream completes
        """
        start_time = time.time()

        try:
            client = self._get_client()

            # Prepare request parameters for Responses API (same as respond())
            max_output_tokens_value = kwargs.get("max_output_tokens")
            if max_output_tokens_value is None:
                max_output_tokens_value = kwargs.get("max_tokens", self.config.max_tokens)
            temperature_value = kwargs.get("temperature", self.config.temperature)
            max_tool_calls_value = kwargs.get("max_tool_calls")
            parallel_tool_calls_value = kwargs.get("parallel_tool_calls")
            text_value = kwargs.get("text")

            # =================================================================
            # PROMPT CACHING OPTIMIZATION: Order matters for cache hits!
            # Stable content (instructions, tools) should come BEFORE dynamic
            # content (input) so the prefix can be cached across requests.
            # Order: model → instructions → tools → config → input
            # =================================================================

            model_override = kwargs.get("model")
            params = {
                "model": model_override or self.config.model,
                "stream": True,
            }

            # 1. Instructions (system prompt) - STABLE, cacheable prefix
            if instructions:
                params["instructions"] = instructions

            # 2. Tools - STABLE, cacheable prefix
            if tools:
                # Convert ToolDefinition objects to Responses API format
                converted_tools = []
                for t in tools:
                    if hasattr(t, 'to_responses_format'):
                        converted_tools.append(t.to_responses_format())
                    elif isinstance(t, dict):
                        converted_tools.append(t)
                    else:
                        # Fallback: Responses API format (flat, name at top level)
                        converted_tools.append({
                            "type": "function",
                            "name": getattr(t, 'name', 'unknown'),
                            "description": getattr(t, 'description', ''),
                            "parameters": {
                                "type": "object",
                                "properties": getattr(t, 'parameters', {}),
                                "required": getattr(t, 'required', [])
                            }
                        })
                params["tools"] = converted_tools
                # For reasoning models, force "required"
                default_choice = "required" if self._is_reasoning_model() else "auto"
                explicit_choice = kwargs.get("tool_choice")
                params["tool_choice"] = explicit_choice if explicit_choice is not None else default_choice

            # 3. Prompt caching parameters - config for cache behavior
            if prompt_cache_key:
                params["prompt_cache_key"] = prompt_cache_key
            # Only add prompt_cache_retention for models that support it
            if prompt_cache_retention and self._supports_prompt_cache_retention():
                params["prompt_cache_retention"] = prompt_cache_retention

            # 4. Stateful conversation continuation
            if previous_response_id:
                params["previous_response_id"] = previous_response_id

            # 5. Generation config - relatively stable
            if self._supports_sampling_params():
                if temperature_value is not None:
                    params["temperature"] = temperature_value
                top_p_value = kwargs.get("top_p", self.config.top_p)
                if top_p_value is not None:
                    params["top_p"] = top_p_value

            if max_output_tokens_value is not None:
                params["max_output_tokens"] = max_output_tokens_value

            if max_tool_calls_value is not None:
                params["max_tool_calls"] = max_tool_calls_value
            if parallel_tool_calls_value is not None:
                params["parallel_tool_calls"] = parallel_tool_calls_value
            if text_value is not None:
                params["text"] = text_value

            timeout_override = kwargs.get("timeout")
            if timeout_override is not None:
                params["timeout"] = timeout_override

            # 6. Input (conversation) - DYNAMIC, comes LAST for cache efficiency
            params["input"] = self._normalize_responses_input(input)

            # DIAGNOSTIC: Log what we're sending
            # Handle both ToolDefinition objects and dicts
            tool_names = [
                t.name if hasattr(t, 'name') else t.get("name", "unknown")
                for t in tools
            ] if tools else []
            is_delta = bool(previous_response_id)
            self.logger.info(
                f"RESPONSES API STREAM REQUEST: model={params.get('model')}, tools={tool_names}, "
                f"tool_choice={params.get('tool_choice', 'none')}, delta_mode={is_delta}",
                component="llm"
            )

            full_content = ""
            tool_calls_data: Dict[str, Dict[str, Any]] = {}  # call_id -> {name, arguments}
            usage_data = None
            finish_reason = "stop"
            response_obj = None
            response_id: Optional[str] = None  # Track response ID for stateful continuation
            emitted_text = False

            def _extract_event_text(event: Any) -> str:
                for attr in ("text", "output_text", "delta"):
                    value = getattr(event, attr, None)
                    if isinstance(value, str) and value:
                        return value
                return ""

            def _append_stream_text(text: str) -> Generator[str, None, None]:
                nonlocal full_content, emitted_text
                if not text:
                    return
                if full_content and text.startswith(full_content):
                    if len(text) > len(full_content):
                        extra = text[len(full_content):]
                        full_content = text
                        if extra:
                            emitted_text = True
                            yield extra
                    return
                if len(text) >= len(full_content):
                    full_content = text
                if not emitted_text:
                    emitted_text = True
                    yield text

            # Stream from Responses API
            tracer = get_tracer()
            with tracer.span("openai_responses_api_stream", model=self.config.model):
                stream = client.responses.create(**params)

                for event in stream:
                    event_type = getattr(event, "type", None)

                    # Handle text content deltas
                    if event_type == "response.output_text.delta":
                        delta = getattr(event, "delta", "")
                        if delta:
                            full_content += delta
                            emitted_text = True
                            yield delta
                    elif event_type in ("response.output_text.done", "response.output_text"):
                        text = _extract_event_text(event)
                        if text:
                            yield from _append_stream_text(text)

                    # Handle function call output item added (captures call_id and name)
                    elif event_type == "response.output_item.added":
                        item = getattr(event, "item", None)
                        if item:
                            item_type = getattr(item, "type", None)
                            if item_type == "function_call":
                                call_id = getattr(item, "call_id", None) or getattr(item, "id", "")
                                name = getattr(item, "name", "")
                                if call_id:
                                    tool_calls_data[call_id] = {"name": name, "arguments": ""}

                    # Handle function call arguments delta
                    elif event_type == "response.function_call_arguments.delta":
                        call_id = getattr(event, "call_id", None) or getattr(event, "item_id", "")
                        delta = getattr(event, "delta", "")
                        if call_id and call_id in tool_calls_data:
                            tool_calls_data[call_id]["arguments"] += delta

                    # Handle completion event for usage data
                    elif event_type == "response.completed":
                        response_obj = getattr(event, "response", None)
                        if response_obj:
                            # Capture response ID for stateful continuation
                            response_id = getattr(response_obj, "id", None)
                            usage = getattr(response_obj, "usage", None)
                            if usage:
                                usage_data = {
                                    "prompt_tokens": getattr(usage, "input_tokens", None),
                                    "completion_tokens": getattr(usage, "output_tokens", None),
                                    "total_tokens": getattr(usage, "total_tokens", None)
                                }
                            finish_reason = getattr(response_obj, "status", None) or "stop"
                            parsed_text = self._parse_responses_output_text(response_obj)
                            if parsed_text:
                                yield from _append_stream_text(parsed_text)

            if response_obj and not full_content:
                parsed_text = self._parse_responses_output_text(response_obj)
                if parsed_text:
                    full_content = parsed_text
            if not emitted_text and full_content:
                emitted_text = True
                yield full_content

            # Build final tool calls list
            parsed_tool_calls: List[ToolCall] = []
            seen_call_ids = set()
            for call_id, tc_data in tool_calls_data.items():
                if tc_data["name"]:
                    try:
                        args = json.loads(tc_data["arguments"]) if tc_data["arguments"] else {}
                    except json.JSONDecodeError:
                        args = {}
                    parsed_tool_calls.append(ToolCall(
                        id=call_id,
                        name=tc_data["name"],
                        arguments=args
                    ))
                    seen_call_ids.add(call_id)
            if response_obj:
                for tool_call in self._parse_responses_tool_calls(response_obj):
                    if tool_call.id and tool_call.id in seen_call_ids:
                        continue
                    if tool_call.name:
                        parsed_tool_calls.append(tool_call)

            result = LLMResponse(
                content=full_content,
                role=MessageRole.ASSISTANT,
                tool_calls=parsed_tool_calls,
                finish_reason=finish_reason,
                usage=usage_data,
                model=self.config.model,
                response_id=response_id,  # For stateful continuation
            )

            # DIAGNOSTIC: Log what we got back
            self.logger.info(
                f"RESPONSES API STREAM COMPLETE: output_len={len(full_content)}, "
                f"tool_calls={len(parsed_tool_calls)}, finish={finish_reason}",
                component="llm"
            )

            duration_ms = (time.time() - start_time) * 1000
            self._log_response(result, duration_ms)
            return result

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            raise

    def respond_with_messages(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Respond using pre-formatted message dicts (for Worker compatibility).

        This method bridges the gap between Workers that build message arrays
        and the Responses API which expects input + instructions format.

        Properly handles:
        - System messages → instructions parameter
        - User/assistant messages → input array
        - Tool calls in assistant messages → preserved in input
        - Tool results → function_call_output items

        Args:
            messages: List of message dicts with role/content/tool_calls/tool_call_id
            tools: Tool definitions (internally-tagged format)
            prompt_cache_key: Stable key for prompt caching
            prompt_cache_retention: Cache retention policy
            previous_response_id: Continue from previous response (stateful mode)
            **kwargs: Additional API parameters

        Returns:
            LLMResponse with output and response_id for continuation
        """
        # Extract system message as instructions
        instructions: Optional[str] = None
        input_items: List[Dict[str, Any]] = []

        for msg in messages:
            role = msg.get("role", "")

            if role == "system":
                # System message becomes instructions
                instructions = msg.get("content", "")

            elif role == "assistant":
                # Assistant message - may have tool_calls
                assistant_item: Dict[str, Any] = {
                    "role": "assistant",
                    "content": msg.get("content", "") or "",
                }

                # Preserve tool calls if present
                tool_calls = msg.get("tool_calls")
                if tool_calls:
                    # Convert to Responses API format (function_call items)
                    for tc in tool_calls:
                        tc_type = tc.get("type", "function")
                        if tc_type == "function":
                            func = tc.get("function", {})
                            # Responses API requires arguments as JSON string, not dict
                            raw_args = func.get("arguments", "{}")
                            if isinstance(raw_args, dict):
                                args_str = json.dumps(raw_args)
                            elif isinstance(raw_args, str):
                                args_str = raw_args
                            else:
                                args_str = "{}"
                            input_items.append({
                                "type": "function_call",
                                "call_id": tc.get("id", ""),
                                "name": func.get("name", ""),
                                "arguments": args_str,
                            })

                # Only add assistant content if non-empty
                if assistant_item["content"]:
                    input_items.append(assistant_item)

            elif role == "tool":
                # Tool result → function_call_output
                input_items.append({
                    "type": "function_call_output",
                    "call_id": msg.get("tool_call_id", ""),
                    "output": msg.get("content", ""),
                })

            elif role == "user":
                # User message
                content = msg.get("content", "")
                if isinstance(content, str):
                    input_items.append({
                        "role": "user",
                        "content": content,
                    })
                else:
                    # Content blocks (e.g., multimodal)
                    input_items.append({
                        "role": "user",
                        "content": content,
                    })

        # Call respond() with properly formatted input
        return self.respond(
            input=input_items if input_items else "",
            instructions=instructions,
            tools=tools,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
            previous_response_id=previous_response_id,
            **kwargs
        )


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

            model_override = kwargs.get("model")
            params = {
                "model": model_override or self.config.model,
                "messages": chat_messages,
                "max_output_tokens": kwargs.get("max_tokens", self.config.max_tokens),
                "temperature": kwargs.get("temperature", self.config.temperature),
            }

            if system_param:
                params["system"] = system_param

            if tools:
                # Convert ToolDefinition objects to Anthropic format if needed
                converted_tools = []
                for t in tools:
                    if hasattr(t, 'to_anthropic_format'):
                        converted_tools.append(t.to_anthropic_format())
                    elif isinstance(t, dict):
                        converted_tools.append(t)
                    else:
                        converted_tools.append({
                            "name": getattr(t, 'name', 'unknown'),
                            "description": getattr(t, 'description', ''),
                            "input_schema": getattr(t, 'parameters', {})
                        })
                params["tools"] = converted_tools

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
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        """
        Streaming using Responses API format.
        Anthropic doesn't have Responses API - convert to Messages API format internally.

        Note: prompt_cache_key, prompt_cache_retention, and previous_response_id
        are accepted for interface compatibility but ignored (Anthropic uses
        different caching and doesn't support stateful conversations this way).
        """
        def _extract_text(content: Any) -> str:
            if content is None:
                return ""
            if isinstance(content, str):
                return content
            if isinstance(content, dict):
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
                    block_text = getattr(block, "text", None)
                    if isinstance(block_text, str):
                        parts.append(block_text)
                return "".join(parts)
            return str(content)

        # Convert Responses API format to Messages API format
        messages: List[Message] = []

        if instructions:
            messages.append(Message(MessageRole.SYSTEM, instructions))

        if isinstance(input, str):
            messages.append(Message(MessageRole.USER, input))
        elif isinstance(input, list):
            for item in input:
                if not isinstance(item, dict):
                    continue
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
        tool_defs: Optional[List[ToolDefinition]] = None
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

        # Call internal streaming implementation
        return self._stream_messages(messages, tool_defs, **kwargs)

    def _stream_messages(
        self,
        messages: List[Message],
        tools: Optional[List[ToolDefinition]] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        """Internal streaming implementation using Messages API"""
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
                # Convert ToolDefinition objects to Anthropic format if needed
                converted_tools = []
                for t in tools:
                    if hasattr(t, 'to_anthropic_format'):
                        converted_tools.append(t.to_anthropic_format())
                    elif isinstance(t, dict):
                        converted_tools.append(t)
                    else:
                        converted_tools.append({
                            "name": getattr(t, 'name', 'unknown'),
                            "description": getattr(t, 'description', ''),
                            "input_schema": getattr(t, 'parameters', {})
                        })
                params["tools"] = converted_tools

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
                # Convert ToolDefinition objects to Anthropic format if needed
                converted_tools = []
                for t in tools:
                    if hasattr(t, 'to_anthropic_format'):
                        converted_tools.append(t.to_anthropic_format())
                    elif isinstance(t, dict):
                        converted_tools.append(t)
                    else:
                        converted_tools.append({
                            "name": getattr(t, 'name', 'unknown'),
                            "description": getattr(t, 'description', ''),
                            "input_schema": getattr(t, 'parameters', {})
                        })
                params["tools"] = converted_tools

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
                # Convert ToolDefinition objects to Anthropic format if needed
                converted_tools = []
                for t in tools:
                    if hasattr(t, 'to_anthropic_format'):
                        converted_tools.append(t.to_anthropic_format())
                    elif isinstance(t, dict):
                        converted_tools.append(t)
                    else:
                        converted_tools.append({
                            "name": getattr(t, 'name', 'unknown'),
                            "description": getattr(t, 'description', ''),
                            "input_schema": getattr(t, 'parameters', {})
                        })
                params["tools"] = converted_tools

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
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Anthropic doesn't have Responses API - convert to Messages API format.

        Note: prompt_cache_key, prompt_cache_retention, and previous_response_id
        are accepted for interface compatibility but ignored (Anthropic uses
        different caching and doesn't support stateful conversations this way).
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

    def respond_with_messages(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """
        Respond using pre-formatted message dicts (for Worker compatibility).

        Note: prompt_cache_key, prompt_cache_retention, and previous_response_id
        are accepted for interface compatibility but logged as warnings since
        Anthropic uses different mechanisms for these features.
        """
        if prompt_cache_key or prompt_cache_retention:
            self.logger.warning(
                "Anthropic adapter: prompt_cache_key/retention ignored (use Anthropic-specific caching)",
                component="llm"
            )
        if previous_response_id:
            self.logger.warning(
                "Anthropic adapter: previous_response_id ignored (Anthropic doesn't support stateful mode)",
                component="llm"
            )

        # Extract system message as instructions
        instructions: Optional[str] = None
        input_items: List[Dict[str, Any]] = []

        for msg in messages:
            role = msg.get("role", "")

            if role == "system":
                instructions = msg.get("content", "")

            elif role == "tool":
                # Tool result
                input_items.append({
                    "type": "function_call_output",
                    "call_id": msg.get("tool_call_id", ""),
                    "output": msg.get("content", ""),
                })

            else:
                # User or assistant message
                input_items.append({
                    "role": role,
                    "content": msg.get("content", ""),
                })

        # Delegate to respond() which handles conversion to Messages API
        return self.respond(
            input=input_items if input_items else "",
            instructions=instructions,
            tools=tools,
            **kwargs
        )


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
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        """Streaming via custom endpoint using Responses API format"""
        return self._get_adapter().stream(
            input, instructions, tools,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
            previous_response_id=previous_response_id,
            **kwargs
        )

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
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """Delegate to underlying OpenAI adapter"""
        return self._get_adapter().respond(
            input, instructions, tools,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
            previous_response_id=previous_response_id,
            **kwargs
        )

    def respond_with_messages(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """Delegate to underlying OpenAI adapter"""
        return self._get_adapter().respond_with_messages(
            messages, tools,
            prompt_cache_key=prompt_cache_key,
            prompt_cache_retention=prompt_cache_retention,
            previous_response_id=previous_response_id,
            **kwargs
        )


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


    def stream(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        """Streaming with failover support using Responses API format, passing through cache params"""
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
                stream = adapter.stream(
                    input, instructions, tools,
                    prompt_cache_key=prompt_cache_key,
                    prompt_cache_retention=prompt_cache_retention,
                    previous_response_id=previous_response_id,
                    **kwargs
                )
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


    def respond(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """Respond with failover support, passing through caching and stateful params"""
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
                return adapter.respond(
                    input, instructions, tools,
                    prompt_cache_key=prompt_cache_key,
                    prompt_cache_retention=prompt_cache_retention,
                    previous_response_id=previous_response_id,
                    **kwargs
                )
            except Exception as e:
                last_exc = e
                self.logger.llm_error(provider, model, e)
                continue

        if last_exc:
            raise last_exc
        raise RuntimeError("FailoverLLMAdapter: no adapters available for respond")

    def respond_with_messages(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        prompt_cache_key: Optional[str] = None,
        prompt_cache_retention: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        **kwargs
    ) -> LLMResponse:
        """Respond with messages with failover support, passing through caching and stateful params"""
        last_exc: Optional[Exception] = None

        for idx, adapter in enumerate(self._iter_adapters()):
            provider = adapter.provider
            model = getattr(adapter, "config", self.config).model

            if idx > 0:
                self.logger.warning(
                    f"LLM respond_with_messages failover: primary failed, trying {provider}:{model}",
                    component="llm"
                )

            try:
                return adapter.respond_with_messages(
                    messages, tools,
                    prompt_cache_key=prompt_cache_key,
                    prompt_cache_retention=prompt_cache_retention,
                    previous_response_id=previous_response_id,
                    **kwargs
                )
            except Exception as e:
                last_exc = e
                self.logger.llm_error(provider, model, e)
                continue

        if last_exc:
            raise last_exc
        raise RuntimeError("FailoverLLMAdapter: no adapters available for respond_with_messages")


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
