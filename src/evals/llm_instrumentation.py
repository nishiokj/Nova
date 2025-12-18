"""
LLM Call Instrumentation for Evaluation.

This module provides a wrapper for LLM clients that captures the actual prompts,
tool schemas, and responses sent to/from the LLM API. This fixes the "synthetic
prompts" issue where the agent_adapter was fabricating messages instead of
capturing the real LLM interactions.

Usage:
    # Wrap the LLM client before passing to agent
    from evals.llm_instrumentation import InstrumentedLLMClient, LLMCallCapture

    capture = LLMCallCapture()
    instrumented_client = InstrumentedLLMClient(real_client, capture)

    # Use instrumented client with agent
    agent = TieredAgent(..., llm_client=instrumented_client)

    # After execution, get captured calls
    for call in capture.get_calls():
        print(f"Phase: {call['phase']}")
        print(f"Messages: {call['messages']}")
        print(f"Tools: {call['tools']}")
        print(f"Response: {call['response']}")
"""

import time
from typing import Dict, Any, List, Optional, Callable, Generator, Union
from dataclasses import dataclass, field
from datetime import datetime
import threading

from util.llm_adapter import LLMAdapter, LLMResponse, MessageRole, ToolCall


@dataclass
class CapturedLLMCall:
    """A single captured LLM API call."""
    # Request info
    messages: List[Dict[str, Any]]
    tools: List[Dict[str, Any]]
    model: str
    temperature: float
    max_tokens: int

    # Response info
    response_content: str
    response_tool_calls: List[Dict[str, Any]]
    stop_reason: str

    # Metadata
    phase: str  # 'planning', 'execution', 'reflection', or custom
    started_at: str
    completed_at: str
    latency_ms: float

    # Token counts (from API response if available)
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0

    # Raw request/response for debugging
    raw_request: Optional[Dict[str, Any]] = None
    raw_response: Optional[Dict[str, Any]] = None


class LLMCallCapture:
    """
    Thread-safe collector for captured LLM calls.

    One instance should be used per evaluation turn to collect all LLM
    interactions for that turn.
    """

    def __init__(self):
        self._calls: List[CapturedLLMCall] = []
        self._lock = threading.Lock()
        self._current_phase: str = "unknown"

    def set_phase(self, phase: str):
        """Set the current execution phase for tagging calls."""
        with self._lock:
            self._current_phase = phase

    def add_call(self, call: CapturedLLMCall):
        """Add a captured call."""
        with self._lock:
            if call.phase == "unknown":
                call.phase = self._current_phase
            self._calls.append(call)

    def get_calls(self, phase: Optional[str] = None) -> List[CapturedLLMCall]:
        """Get captured calls, optionally filtered by phase."""
        with self._lock:
            if phase:
                return [c for c in self._calls if c.phase == phase]
            return list(self._calls)

    def get_calls_as_dicts(self, phase: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get captured calls as dictionaries for serialization."""
        calls = self.get_calls(phase)
        return [
            {
                'messages': c.messages,
                'tools': c.tools,
                'model': c.model,
                'temperature': c.temperature,
                'max_tokens': c.max_tokens,
                'response_content': c.response_content,
                'response_tool_calls': c.response_tool_calls,
                'stop_reason': c.stop_reason,
                'phase': c.phase,
                'started_at': c.started_at,
                'completed_at': c.completed_at,
                'latency_ms': c.latency_ms,
                'input_tokens': c.input_tokens,
                'output_tokens': c.output_tokens,
                'cache_read_tokens': c.cache_read_tokens,
                'cache_creation_tokens': c.cache_creation_tokens
            }
            for c in calls
        ]

    def clear(self):
        """Clear all captured calls (for new turn)."""
        with self._lock:
            self._calls = []
            self._current_phase = "unknown"

    def get_total_tokens(self) -> Dict[str, int]:
        """Get total token counts across all calls."""
        with self._lock:
            return {
                'input_tokens': sum(c.input_tokens for c in self._calls),
                'output_tokens': sum(c.output_tokens for c in self._calls),
                'cache_read_tokens': sum(c.cache_read_tokens for c in self._calls),
                'cache_creation_tokens': sum(c.cache_creation_tokens for c in self._calls),
                'total_tokens': sum(c.input_tokens + c.output_tokens for c in self._calls)
            }

    def get_total_latency_ms(self) -> float:
        """Get total latency across all calls."""
        with self._lock:
            return sum(c.latency_ms for c in self._calls)


class InstrumentedLLMClient:
    """
    Wrapper around an LLM client that captures all API calls.

    This wraps the Anthropic client (or any client with a similar interface)
    and intercepts calls to capture the actual prompts and responses.

    Usage:
        real_client = anthropic.Anthropic()
        capture = LLMCallCapture()
        instrumented = InstrumentedLLMClient(real_client, capture)

        # Use instrumented client - calls are captured automatically
        response = instrumented.messages.create(
            model="claude-sonnet-4-5",
            messages=[...],
            tools=[...]
        )

        # Get captured calls
        calls = capture.get_calls()
    """

    def __init__(
        self,
        real_client: Any,
        capture: LLMCallCapture,
        capture_raw: bool = False  # Whether to capture raw request/response
    ):
        self._real_client = real_client
        self._capture = capture
        self._capture_raw = capture_raw

        # Wrap the messages attribute
        self.messages = InstrumentedMessages(
            real_client.messages if hasattr(real_client, 'messages') else real_client,
            capture,
            capture_raw
        )

    def __getattr__(self, name: str):
        """Forward other attributes to the real client."""
        return getattr(self._real_client, name)


class InstrumentedMessages:
    """Wrapper for the messages API that captures calls."""

    def __init__(
        self,
        real_messages: Any,
        capture: LLMCallCapture,
        capture_raw: bool = False
    ):
        self._real_messages = real_messages
        self._capture = capture
        self._capture_raw = capture_raw

    def create(self, **kwargs) -> Any:
        """Intercept message creation and capture the call."""
        started_at = datetime.utcnow().isoformat()
        start_time = time.time()

        # Extract request info
        messages = kwargs.get('messages', [])
        tools = kwargs.get('tools', [])
        model = kwargs.get('model', 'unknown')
        temperature = kwargs.get('temperature', 0.0)
        max_tokens = kwargs.get('max_tokens', 4096)

        try:
            # Make the actual call
            response = self._real_messages.create(**kwargs)

            completed_at = datetime.utcnow().isoformat()
            latency_ms = (time.time() - start_time) * 1000

            # Extract response info
            response_content = self._extract_content(response)
            response_tool_calls = self._extract_tool_calls(response)
            stop_reason = getattr(response, 'stop_reason', 'unknown')

            # Extract token counts from usage
            usage = getattr(response, 'usage', None)
            input_tokens = getattr(usage, 'input_tokens', 0) if usage else 0
            output_tokens = getattr(usage, 'output_tokens', 0) if usage else 0
            cache_read = getattr(usage, 'cache_read_input_tokens', 0) if usage else 0
            cache_creation = getattr(usage, 'cache_creation_input_tokens', 0) if usage else 0

            # Build captured call
            captured = CapturedLLMCall(
                messages=self._serialize_messages(messages),
                tools=self._serialize_tools(tools),
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                response_content=response_content,
                response_tool_calls=response_tool_calls,
                stop_reason=stop_reason,
                phase="unknown",  # Will be set by capture
                started_at=started_at,
                completed_at=completed_at,
                latency_ms=latency_ms,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_read_tokens=cache_read,
                cache_creation_tokens=cache_creation,
                raw_request=kwargs if self._capture_raw else None,
                raw_response=self._serialize_response(response) if self._capture_raw else None
            )

            self._capture.add_call(captured)

            return response

        except Exception as e:
            # Still capture failed calls
            completed_at = datetime.utcnow().isoformat()
            latency_ms = (time.time() - start_time) * 1000

            captured = CapturedLLMCall(
                messages=self._serialize_messages(messages),
                tools=self._serialize_tools(tools),
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                response_content=f"ERROR: {str(e)}",
                response_tool_calls=[],
                stop_reason="error",
                phase="unknown",
                started_at=started_at,
                completed_at=completed_at,
                latency_ms=latency_ms,
                raw_request=kwargs if self._capture_raw else None
            )

            self._capture.add_call(captured)
            raise

    def _serialize_messages(self, messages: List) -> List[Dict[str, Any]]:
        """Serialize messages to dicts."""
        serialized = []
        for msg in messages:
            if isinstance(msg, dict):
                serialized.append(msg)
            else:
                # Handle message objects
                serialized.append({
                    'role': getattr(msg, 'role', 'unknown'),
                    'content': self._serialize_content(getattr(msg, 'content', ''))
                })
        return serialized

    def _serialize_content(self, content: Any) -> Any:
        """Serialize message content."""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            # Multi-part content
            return [self._serialize_content_block(b) for b in content]
        return str(content)

    def _serialize_content_block(self, block: Any) -> Dict[str, Any]:
        """Serialize a content block."""
        if isinstance(block, dict):
            return block
        # Handle content block objects
        block_type = getattr(block, 'type', 'text')
        if block_type == 'text':
            return {'type': 'text', 'text': getattr(block, 'text', '')}
        elif block_type == 'image':
            return {'type': 'image', 'source': getattr(block, 'source', {})}
        elif block_type == 'tool_use':
            return {
                'type': 'tool_use',
                'id': getattr(block, 'id', ''),
                'name': getattr(block, 'name', ''),
                'input': getattr(block, 'input', {})
            }
        elif block_type == 'tool_result':
            return {
                'type': 'tool_result',
                'tool_use_id': getattr(block, 'tool_use_id', ''),
                'content': getattr(block, 'content', '')
            }
        return {'type': block_type, 'data': str(block)}

    def _serialize_tools(self, tools: List) -> List[Dict[str, Any]]:
        """Serialize tools to dicts."""
        serialized = []
        for tool in tools:
            if isinstance(tool, dict):
                serialized.append(tool)
            else:
                serialized.append({
                    'name': getattr(tool, 'name', 'unknown'),
                    'description': getattr(tool, 'description', ''),
                    'input_schema': getattr(tool, 'input_schema', {})
                })
        return serialized

    def _extract_content(self, response: Any) -> str:
        """Extract text content from response."""
        content = getattr(response, 'content', [])
        if isinstance(content, str):
            return content

        # Multi-part content - extract text
        text_parts = []
        for block in content:
            if hasattr(block, 'type') and block.type == 'text':
                text_parts.append(getattr(block, 'text', ''))
            elif isinstance(block, dict) and block.get('type') == 'text':
                text_parts.append(block.get('text', ''))

        return '\n'.join(text_parts)

    def _extract_tool_calls(self, response: Any) -> List[Dict[str, Any]]:
        """Extract tool calls from response."""
        content = getattr(response, 'content', [])
        if isinstance(content, str):
            return []

        tool_calls = []
        for block in content:
            block_type = getattr(block, 'type', None) if hasattr(block, 'type') else block.get('type')
            if block_type == 'tool_use':
                tool_calls.append({
                    'id': getattr(block, 'id', '') if hasattr(block, 'id') else block.get('id', ''),
                    'name': getattr(block, 'name', '') if hasattr(block, 'name') else block.get('name', ''),
                    'input': getattr(block, 'input', {}) if hasattr(block, 'input') else block.get('input', {})
                })

        return tool_calls

    def _serialize_response(self, response: Any) -> Dict[str, Any]:
        """Serialize response for raw capture."""
        try:
            if hasattr(response, 'model_dump'):
                return response.model_dump()
            elif hasattr(response, '__dict__'):
                return dict(response.__dict__)
            return {'raw': str(response)}
        except Exception:
            return {'raw': str(response)}

    def __getattr__(self, name: str):
        """Forward other attributes to real messages."""
        return getattr(self._real_messages, name)


def _serialize_tools(tools: Optional[List[Any]]) -> List[Dict[str, Any]]:
    """Serialize tool definitions to dicts."""
    if not tools:
        return []
    serialized = []
    for tool in tools:
        if isinstance(tool, dict):
            serialized.append(tool)
        else:
            serialized.append({
                "name": getattr(tool, "name", "unknown"),
                "description": getattr(tool, "description", ""),
                "input_schema": getattr(tool, "input_schema", {})
            })
    return serialized


def _extract_text_from_content(content: Any) -> str:
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


def _serialize_responses_messages(
    input: Union[str, List[Dict[str, Any]]],
    instructions: Optional[str] = None
) -> List[Dict[str, Any]]:
    messages: List[Dict[str, Any]] = []
    if instructions:
        messages.append({"role": "system", "content": instructions})
    if isinstance(input, str):
        messages.append({"role": "user", "content": input})
    elif isinstance(input, list):
        for item in input:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            if not role:
                item_type = item.get("type")
                if item_type in ("function_call_output", "tool_output"):
                    messages.append({
                        "role": "tool",
                        "content": _extract_text_from_content(item.get("output", ""))
                    })
                continue
            content = _extract_text_from_content(item.get("content", ""))
            messages.append({"role": role, "content": content})
    return messages


def _serialize_tool_calls(tool_calls: List[ToolCall]) -> List[Dict[str, Any]]:
    return [
        {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
        for tc in tool_calls or []
    ]


class InstrumentedLLMAdapter:
    """
    Wrapper for LLMAdapter that captures Responses API prompts/responses.
    """

    def __init__(
        self,
        adapter: LLMAdapter,
        capture: LLMCallCapture,
        capture_raw: bool = False
    ):
        self._adapter = adapter
        self._capture = capture
        self._capture_raw = capture_raw
        self.config = adapter.config
        self.logger = getattr(adapter, "logger", None)

    @property
    def provider(self) -> str:
        return getattr(self._adapter, "provider", "unknown")

    def respond(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        **kwargs
    ) -> LLMResponse:
        started_at = datetime.utcnow().isoformat()
        start_time = time.time()
        adapter_config = getattr(self._adapter, "config", None)
        model = adapter_config.model if adapter_config else "unknown"
        temperature = kwargs.get("temperature", getattr(adapter_config, "temperature", 0.0) if adapter_config else 0.0)
        max_tokens = kwargs.get("max_output_tokens", kwargs.get("max_tokens", getattr(adapter_config, "max_tokens", 4096) if adapter_config else 4096))
        messages = _serialize_responses_messages(input, instructions)
        tool_defs = _serialize_tools(tools)

        try:
            response = self._adapter.respond(input=input, instructions=instructions, tools=tools, **kwargs)
            latency_ms = (time.time() - start_time) * 1000
            usage = response.usage or {}
            input_tokens = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
            output_tokens = usage.get("completion_tokens") or usage.get("output_tokens") or 0
            captured = CapturedLLMCall(
                messages=messages,
                tools=tool_defs,
                model=response.model or model,
                temperature=temperature or 0.0,
                max_tokens=max_tokens,
                response_content=response.content or "",
                response_tool_calls=_serialize_tool_calls(response.tool_calls),
                stop_reason=response.finish_reason or "stop",
                phase="unknown",
                started_at=started_at,
                completed_at=datetime.utcnow().isoformat(),
                latency_ms=latency_ms,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                raw_request={"input": input, "instructions": instructions, "tools": tools, "kwargs": kwargs} if self._capture_raw else None,
                raw_response=response.raw_response if self._capture_raw else None
            )
            self._capture.add_call(captured)
            return response
        except Exception as e:
            latency_ms = (time.time() - start_time) * 1000
            captured = CapturedLLMCall(
                messages=messages,
                tools=tool_defs,
                model=model,
                temperature=temperature or 0.0,
                max_tokens=max_tokens,
                response_content=f"ERROR: {str(e)}",
                response_tool_calls=[],
                stop_reason="error",
                phase="unknown",
                started_at=started_at,
                completed_at=datetime.utcnow().isoformat(),
                latency_ms=latency_ms,
                raw_request={"input": input, "instructions": instructions, "tools": tools, "kwargs": kwargs} if self._capture_raw else None
            )
            self._capture.add_call(captured)
            raise

    def stream(
        self,
        input: Union[str, List[Dict[str, Any]]],
        instructions: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        **kwargs
    ) -> Generator[str, None, LLMResponse]:
        started_at = datetime.utcnow().isoformat()
        start_time = time.time()
        adapter_config = getattr(self._adapter, "config", None)
        model = adapter_config.model if adapter_config else "unknown"
        temperature = kwargs.get("temperature", getattr(adapter_config, "temperature", 0.0) if adapter_config else 0.0)
        max_tokens = kwargs.get("max_output_tokens", kwargs.get("max_tokens", getattr(adapter_config, "max_tokens", 4096) if adapter_config else 4096))
        messages = _serialize_responses_messages(input, instructions)
        tool_defs = _serialize_tools(tools)

        full_content = ""
        response: Optional[LLMResponse] = None

        try:
            stream_gen = self._adapter.stream(input=input, instructions=instructions, tools=tools, **kwargs)
            while True:
                try:
                    chunk = next(stream_gen)
                except StopIteration as stop:
                    response = stop.value if hasattr(stop, "value") else None
                    break
                full_content += chunk
                yield chunk

            if response is None:
                response = LLMResponse(content=full_content, role=MessageRole.ASSISTANT)
            response_text = response.content or full_content
            usage = response.usage or {}
            input_tokens = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
            output_tokens = usage.get("completion_tokens") or usage.get("output_tokens") or 0
            latency_ms = (time.time() - start_time) * 1000
            captured = CapturedLLMCall(
                messages=messages,
                tools=tool_defs,
                model=response.model or model,
                temperature=temperature or 0.0,
                max_tokens=max_tokens,
                response_content=response_text,
                response_tool_calls=_serialize_tool_calls(response.tool_calls),
                stop_reason=response.finish_reason or "stop",
                phase="unknown",
                started_at=started_at,
                completed_at=datetime.utcnow().isoformat(),
                latency_ms=latency_ms,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                raw_request={"input": input, "instructions": instructions, "tools": tools, "kwargs": kwargs} if self._capture_raw else None,
                raw_response=response.raw_response if self._capture_raw else None
            )
            self._capture.add_call(captured)
            return response
        except Exception as e:
            latency_ms = (time.time() - start_time) * 1000
            captured = CapturedLLMCall(
                messages=messages,
                tools=tool_defs,
                model=model,
                temperature=temperature or 0.0,
                max_tokens=max_tokens,
                response_content=f"ERROR: {str(e)}",
                response_tool_calls=[],
                stop_reason="error",
                phase="unknown",
                started_at=started_at,
                completed_at=datetime.utcnow().isoformat(),
                latency_ms=latency_ms,
                raw_request={"input": input, "instructions": instructions, "tools": tools, "kwargs": kwargs} if self._capture_raw else None
            )
            self._capture.add_call(captured)
            raise

    def __getattr__(self, name: str):
        return getattr(self._adapter, name)

def create_instrumented_agent(
    agent_class: type,
    capture: LLMCallCapture,
    **agent_kwargs
) -> Any:
    """
    Helper to create an agent with instrumented LLM client.

    This patches the agent's LLM client after creation.

    Args:
        agent_class: The agent class to instantiate
        capture: LLMCallCapture instance for collecting calls
        **agent_kwargs: Arguments to pass to agent constructor

    Returns:
        Agent instance with instrumented LLM client
    """
    agent = agent_class(**agent_kwargs)

    # Find and wrap the LLM client
    # Common attribute names for LLM clients
    client_attrs = ['_llm_client', 'llm_client', '_client', 'client', '_anthropic', 'anthropic']

    for attr in client_attrs:
        if hasattr(agent, attr):
            real_client = getattr(agent, attr)
            if real_client is not None:
                instrumented = InstrumentedLLMClient(real_client, capture)
                setattr(agent, attr, instrumented)
                break

    return agent
