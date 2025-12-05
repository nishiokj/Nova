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
from .logger import get_logger


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


class LLMAdapter(ABC):
    """
    Abstract base class for LLM adapters.
    Provides uniform interface for different LLM backends.
    """

    def __init__(self, config: LLMConfig):
        self.config = config
        self.logger = get_logger()
        self._retry_count = 0
        self._prewarmed = False

    @property
    @abstractmethod
    def provider(self) -> str:
        """Get provider name"""
        pass

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

    def _handle_retry(self, error: Exception) -> bool:
        """Handle retry logic. Returns True if should retry."""
        self._retry_count += 1
        if self._retry_count <= self.config.max_retries:
            time.sleep(self.config.retry_delay * self._retry_count)
            return True
        self._retry_count = 0
        return False

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

    def __init__(self, config: LLMConfig):
        super().__init__(config)
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

            response = client.chat.completions.create(**params)
            result = self._parse_response(response)

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
            if self._handle_retry(e):
                return self.complete(messages, tools, **kwargs)
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
            if self._handle_retry(e):
                return self.stream(messages, tools, **kwargs)
            raise

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
            if self._handle_retry(e):
                return await self.acomplete(messages, tools, **kwargs)
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

    def __init__(self, config: LLMConfig):
        super().__init__(config)
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
            system_message, chat_messages = self._prepare_messages(messages)

            params = {
                "model": self.config.model,
                "messages": chat_messages,
                "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
                "temperature": kwargs.get("temperature", self.config.temperature),
            }

            if system_message:
                params["system"] = system_message

            if tools:
                params["tools"] = [t.to_anthropic_format() for t in tools]

            response = client.messages.create(**params)
            result = self._parse_response(response)

            duration_ms = (time.time() - start_time) * 1000
            self._log_response(result, duration_ms)
            return result

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            if self._handle_retry(e):
                return self.complete(messages, tools, **kwargs)
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
            system_message, chat_messages = self._prepare_messages(messages)

            params = {
                "model": self.config.model,
                "messages": chat_messages,
                "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
                "temperature": kwargs.get("temperature", self.config.temperature),
            }

            if system_message:
                params["system"] = system_message

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
            if self._handle_retry(e):
                return self.stream(messages, tools, **kwargs)
            raise

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
            system_message, chat_messages = self._prepare_messages(messages)

            params = {
                "model": self.config.model,
                "messages": chat_messages,
                "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
                "temperature": kwargs.get("temperature", self.config.temperature),
            }

            if system_message:
                params["system"] = system_message

            if tools:
                params["tools"] = [t.to_anthropic_format() for t in tools]

            response = await client.messages.create(**params)
            result = self._parse_response(response)

            duration_ms = (time.time() - start_time) * 1000
            self._log_response(result, duration_ms)
            return result

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            if self._handle_retry(e):
                return await self.acomplete(messages, tools, **kwargs)
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
            system_message, chat_messages = self._prepare_messages(messages)

            params = {
                "model": self.config.model,
                "messages": chat_messages,
                "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
                "temperature": kwargs.get("temperature", self.config.temperature),
            }

            if system_message:
                params["system"] = system_message

            if tools:
                params["tools"] = [t.to_anthropic_format() for t in tools]

            async with client.messages.stream(**params) as stream:
                async for text in stream.text_stream:
                    yield text

        except Exception as e:
            self.logger.llm_error(self.provider, self.config.model, e)
            raise


class CustomAdapter(LLMAdapter):
    """
    Custom API adapter for OpenAI-compatible endpoints.
    Works with vLLM, Ollama, text-generation-webui, etc.
    """

    def __init__(self, config: LLMConfig):
        super().__init__(config)
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


def create_adapter(config: LLMConfig) -> LLMAdapter:
    """Factory function to create appropriate adapter based on config"""
    adapters = {
        "openai": OpenAIAdapter,
        "anthropic": AnthropicAdapter,
        "custom": CustomAdapter,
    }

    provider = config.provider.lower()
    if provider not in adapters:
        # Fallback to custom adapter for unknown providers
        return CustomAdapter(config)

    return adapters[provider](config)


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
