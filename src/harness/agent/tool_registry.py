"""
Tool Registry - Registry of pure function tools for the agent.
Provides safe, well-typed inputs/outputs.
"""

import os
import sys
import json
import time
import subprocess
import tempfile
import threading
import re
import shutil
import asyncio
import base64
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Callable, Union, Tuple, Set
from enum import Enum
import traceback
import signal
import io
from datetime import datetime
from pathlib import Path
from contextlib import redirect_stdout, redirect_stderr, contextmanager, nullcontext
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeoutError

from util.config import ToolConfig, NanoBananaConfig, LLMConfig
from util.logger import StructuredLogger
from util.llm_adapter import ToolDefinition, create_adapter
from util.resilience import ResilienceConfig, resilient_call
from hooks.manager import HookManager
from hooks.models import InvocationContext, ToolPolicy


# ========== FILESYSTEM SEARCH EXCLUSIONS ==========
# Directories and patterns to always exclude from filesystem searches
DEFAULT_EXCLUDE_DIRS: Set[str] = {
    "__pycache__",
    ".venv",
    "venv",
    "site-packages",
    "dist",
    "build",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    "node_modules",
    ".tox",
    ".eggs",
    "*.egg-info",
    ".cache",
    ".ruff_cache",
    "htmlcov",
    "coverage",
}

# File extensions to exclude from search results
DEFAULT_EXCLUDE_EXTENSIONS: Set[str] = {
    ".pyc",
    ".pyo",
    ".so",
    ".o",
    ".a",
    ".dylib",
    ".dll",
    ".exe",
    ".class",
}


# ========== NANO BANANA (GEMINI IMAGE GENERATION) ==========

@dataclass
class ImageGenerationResult:
    """Result of an image generation request"""
    success: bool
    image_bytes: Optional[bytes] = None
    file_path: Optional[str] = None
    error: Optional[str] = None
    thought_text: Optional[str] = None  # For multi-turn reasoning
    duration_ms: float = 0
    metadata: Dict[str, Any] = field(default_factory=dict)


class GeminiImageClient:
    """Async client for Gemini image generation (Nano Banana)"""

    def __init__(
        self,
        api_key: str,
        api_base: str = "https://generativelanguage.googleapis.com/v1beta",
        model: str = "gemini-3-pro-image-preview",
        timeout: int = 60,
        max_retries: int = 3,
        logger: Optional[StructuredLogger] = None
    ):
        self.api_key = api_key
        self.api_base = api_base
        self.model = model
        self.timeout = timeout
        self.max_retries = max_retries
        self.logger = logger or StructuredLogger()
        self._session = None

    async def _ensure_session(self):
        """Lazy session initialization"""
        try:
            import aiohttp
            if self._session is None or self._session.closed:
                self._session = aiohttp.ClientSession(
                    timeout=aiohttp.ClientTimeout(total=self.timeout)
                )
        except ImportError:
            raise ImportError("aiohttp is required for async image generation. Install with: pip install aiohttp")

    async def generate_image(
        self,
        prompt: str,
        output_path: Optional[str] = None,
        callback: Optional[Callable[[ImageGenerationResult], Any]] = None
    ) -> ImageGenerationResult:
        """
        Generate an image from a prompt.

        Args:
            prompt: The image generation prompt
            output_path: Where to save the image (optional)
            callback: Optional callback for result notification

        Returns:
            ImageGenerationResult with success status and file path
        """
        import aiohttp
        start_time = time.time()
        await self._ensure_session()

        url = f"{self.api_base}/models/{self.model}:generateContent"
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.api_key
        }
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseModalities": ["image", "text"]
            }
        }

        last_error = None
        for attempt in range(self.max_retries):
            try:
                async with self._session.post(url, json=payload, headers=headers) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        last_error = f"API error {resp.status}: {error_text}"
                        self.logger.warning(
                            f"Gemini image API error (attempt {attempt + 1}): {last_error}",
                            component="nano_banana"
                        )
                        continue

                    data = await resp.json()
                    return await self._process_response(
                        data, output_path, callback, start_time
                    )

            except asyncio.TimeoutError:
                last_error = f"Request timed out after {self.timeout}s"
            except aiohttp.ClientError as e:
                last_error = f"Network error: {str(e)}"
            except Exception as e:
                last_error = f"Unexpected error: {str(e)}"

            # Exponential backoff
            if attempt < self.max_retries - 1:
                await asyncio.sleep(2 ** attempt)

        result = ImageGenerationResult(
            success=False,
            error=last_error,
            duration_ms=(time.time() - start_time) * 1000
        )
        if callback:
            callback(result)
        return result

    async def _process_response(
        self,
        data: Dict[str, Any],
        output_path: Optional[str],
        callback: Optional[Callable],
        start_time: float
    ) -> ImageGenerationResult:
        """Process API response and extract image"""
        try:
            candidates = data.get("candidates", [])
            if not candidates:
                return ImageGenerationResult(
                    success=False,
                    error="No candidates in response",
                    duration_ms=(time.time() - start_time) * 1000
                )

            content = candidates[0].get("content", {})
            parts = content.get("parts", [])

            image_bytes = None
            thought_text = None

            for part in parts:
                if "text" in part:
                    thought_text = part["text"]
                elif "inlineData" in part:
                    b64_data = part["inlineData"].get("data")
                    if b64_data:
                        image_bytes = base64.b64decode(b64_data)

            if not image_bytes:
                return ImageGenerationResult(
                    success=False,
                    error="No image data in response",
                    thought_text=thought_text,
                    duration_ms=(time.time() - start_time) * 1000
                )

            # Save to file if path provided
            file_path = None
            if output_path:
                file_path = await self._save_image(image_bytes, output_path)

            result = ImageGenerationResult(
                success=True,
                image_bytes=image_bytes,
                file_path=file_path,
                thought_text=thought_text,
                duration_ms=(time.time() - start_time) * 1000,
                metadata={"model": self.model, "size_bytes": len(image_bytes)}
            )

            if callback:
                callback(result)

            return result

        except Exception as e:
            return ImageGenerationResult(
                success=False,
                error=f"Response processing error: {str(e)}",
                duration_ms=(time.time() - start_time) * 1000
            )

    async def _save_image(self, image_bytes: bytes, output_path: str) -> str:
        """Save image bytes to file (async file I/O)"""
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        # Use asyncio for non-blocking write
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, path.write_bytes, image_bytes)

        self.logger.file_operation("image_save", str(path.absolute()), status="success")
        return str(path.absolute())

    async def close(self):
        """Close the session"""
        if self._session and not self._session.closed:
            await self._session.close()


# Prompt engineering system prompt for helper agent
NANO_BANANA_HELPER_SYSTEM = """You are an expert image prompt engineer for AI image generation.

Your task is to transform user requests into optimal prompts for Gemini's image generation model.

CRITICAL RULES:
1. PRESERVE the user's core intent - don't add unwanted elements
2. ADD technical details that improve image quality (lighting, composition, style)
3. EXTRACT any mentioned file path or location for saving the image
4. If no path mentioned, return "DEFAULT" for output_path
5. Keep prompts concise but descriptive (50-150 words ideal)

For path extraction:
- Look for patterns like "save to", "at", "in folder", "to file", etc.
- Common patterns: ~/Desktop/image.png, ./output/pic.jpg, /tmp/test.png
- File extensions: .png, .jpg, .jpeg, .webp

Respond in this exact JSON format:
{
    "enhanced_prompt": "The improved image generation prompt",
    "output_path": "extracted/path.png or DEFAULT",
    "original_intent": "Brief description of what user wants",
    "style_hints": "photorealistic|illustration|cartoon|abstract|etc or null",
    "confidence": 0.0 to 1.0
}"""


@dataclass
class PromptEngineeringResult:
    """Result of prompt engineering"""
    enhanced_prompt: str
    output_path: str
    original_intent: str
    style_hints: Optional[str] = None
    confidence: float = 1.0


class NanoBananaHelperAgent:
    """Helper agent for prompt engineering and path extraction"""

    def __init__(
        self,
        config: Optional[NanoBananaConfig] = None,
        logger: Optional[StructuredLogger] = None
    ):
        self.config = config or NanoBananaConfig()
        self.logger = logger or StructuredLogger()
        self._llm = None

    def _get_llm(self):
        """Lazy LLM initialization"""
        if self._llm is None:
            llm_config = LLMConfig(
                provider=self.config.helper_llm_provider,
                model=self.config.helper_llm_model,
                max_tokens=self.config.helper_max_tokens,
                temperature=0.3  # Lower for more consistent outputs
            )
            self._llm = create_adapter(llm_config, self.logger)
        return self._llm

    def process_request(self, user_request: str) -> PromptEngineeringResult:
        """
        Process user request through helper LLM.

        Args:
            user_request: Raw user request like "make me a cat picture"

        Returns:
            PromptEngineeringResult with enhanced prompt and output path
        """
        try:
            llm = self._get_llm()

            response = llm.respond(
                input=f"User request: {user_request}",
                instructions=NANO_BANANA_HELPER_SYSTEM
            )

            return self._parse_response(response.content or "", user_request)

        except Exception as e:
            self.logger.warning(
                f"Helper agent failed, using fallback: {e}",
                component="nano_banana.helper"
            )
            # Fallback: use original request and default path
            return PromptEngineeringResult(
                enhanced_prompt=self._basic_enhance(user_request),
                output_path=self._generate_default_path(),
                original_intent=user_request,
                confidence=0.5
            )

    def _parse_response(
        self,
        content: str,
        original_request: str
    ) -> PromptEngineeringResult:
        """Parse LLM response into structured result"""
        try:
            # Handle potential markdown code blocks
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]

            data = json.loads(content.strip())

            output_path = data.get("output_path", "DEFAULT")
            if output_path == "DEFAULT" or not output_path:
                output_path = self._generate_default_path()
            else:
                output_path = self._resolve_path(output_path)

            return PromptEngineeringResult(
                enhanced_prompt=data.get("enhanced_prompt", original_request),
                output_path=output_path,
                original_intent=data.get("original_intent", "Generate image"),
                style_hints=data.get("style_hints"),
                confidence=data.get("confidence", 0.8)
            )

        except (json.JSONDecodeError, KeyError, IndexError):
            # Fallback: use original request and default path
            return PromptEngineeringResult(
                enhanced_prompt=self._basic_enhance(original_request),
                output_path=self._generate_default_path(),
                original_intent=original_request,
                confidence=0.5
            )

    def _basic_enhance(self, prompt: str) -> str:
        """Basic prompt enhancement without LLM"""
        quality_terms = ["high quality", "detailed", "professional", "4k"]
        has_quality = any(term in prompt.lower() for term in quality_terms)

        if not has_quality:
            return f"{prompt}, high quality, detailed"
        return prompt

    def _generate_default_path(self) -> str:
        """Generate default output path with timestamp"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = self.config.default_filename_pattern.format(timestamp=timestamp)
        return os.path.join(self.config.default_output_dir, filename)

    def _resolve_path(self, path: str) -> str:
        """Resolve and validate output path"""
        # Expand ~ and environment variables
        path = os.path.expanduser(path)
        path = os.path.expandvars(path)

        # Make absolute if relative
        if not os.path.isabs(path):
            path = os.path.join(self.config.default_output_dir, path)

        # Ensure image extension
        if not path.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
            path = f"{path}.png"

        return os.path.abspath(path)


# Default callback for image generation - returns file path
def default_image_callback(result: ImageGenerationResult) -> str:
    """Default callback - returns file path string"""
    if result.success and result.file_path:
        return result.file_path
    elif result.success:
        return "Image generated successfully (not saved to disk)"
    else:
        return f"Image generation failed: {result.error}"


class ToolStatus(Enum):
    """Tool execution status"""
    SUCCESS = "success"
    ERROR = "error"
    TIMEOUT = "timeout"
    PERMISSION_DENIED = "permission_denied"
    AWAITING_USER = "awaiting_user"  # Tool needs user input to proceed


@dataclass
class CachedToolResult:
    """Cached result of a tool execution"""
    result: 'ToolResult'
    timestamp: float
    hit_count: int = 0


@dataclass
class ToolResult:
    """Result of a tool execution"""
    status: ToolStatus
    output: Any
    error: Optional[str] = None
    duration_ms: float = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status.value,
            "output": self.output,
            "error": self.error,
            "duration_ms": self.duration_ms,
            "metadata": self.metadata
        }

    @property
    def is_success(self) -> bool:
        return self.status == ToolStatus.SUCCESS

    @property
    def is_awaiting_user(self) -> bool:
        return self.status == ToolStatus.AWAITING_USER

    def __str__(self) -> str:
        if self.is_success:
            return str(self.output)
        return f"Error: {self.error}"


@dataclass
class ToolExecutionContext:
    env_overrides: Dict[str, str] = field(default_factory=dict)
    workdir_override: Optional[str] = None
    tool_policy: Optional[ToolPolicy] = None


@dataclass
class Tool:
    """A tool that can be executed by the agent"""
    name: str
    description: str
    parameters: Dict[str, Any]  # JSON Schema for parameters
    required_params: List[str] = field(default_factory=list)
    executor: Optional[Callable[..., ToolResult]] = None
    enabled: bool = True
    timeout: int = 30
    # Execution metadata
    read_only: bool = False              # True when tool performs no writes
    parallelizable: bool = False         # True when safe to run concurrently
    cost_hint: str = "standard"          # "low" | "standard" | "high"

    def to_definition(self) -> ToolDefinition:
        """Convert to ToolDefinition for LLM"""
        return ToolDefinition(
            name=self.name,
            description=self.description,
            parameters=self.parameters,
            required=self.required_params
        )

    def execute(self, **kwargs) -> ToolResult:
        """Execute the tool"""
        if not self.enabled:
            return ToolResult(
                status=ToolStatus.PERMISSION_DENIED,
                output=None,
                error=f"Tool '{self.name}' is disabled"
            )

        if self.executor is None:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"No executor defined for tool '{self.name}'"
            )

        start_time = time.time()
        try:
            result = self.executor(**kwargs)
            result.duration_ms = (time.time() - start_time) * 1000
            return result
        except Exception as e:
            tb = traceback.format_exc()
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
                metadata={"traceback": tb}
            )


class ToolRegistry:
    """
    Registry for tools available to the agent.
    Manages tool registration, execution, and lifecycle.
    """

    def __init__(
        self,
        config: Optional[ToolConfig] = None,
        default_working_dir: Optional[str] = None,
        logger: Optional[StructuredLogger] = None,
        nano_banana_config: Optional[NanoBananaConfig] = None,
        graphd_client: Optional[Any] = None,
        graphd_tools_enabled: bool = False,
        hook_manager: Optional[HookManager] = None
    ):
        self.config = config or ToolConfig()
        self.logger = logger or StructuredLogger()
        self._tools: Dict[str, Tool] = {}
        self._lock = threading.Lock()
        self._default_working_dir = os.path.abspath(default_working_dir) if default_working_dir else os.getcwd()
        self._thread_local = threading.local()
        self._tool_circuit_state: Dict[str, Any] = {}
        # Nano Banana (Gemini Image Generation) config
        self._nano_banana_config = nano_banana_config or NanoBananaConfig()
        self._graphd_client = graphd_client
        self._graphd_tools_enabled = graphd_tools_enabled
        self._hook_manager = hook_manager

        # ========== TOOL RESULT CACHING ==========
        # Cache for read-only, deterministic tool results
        self._result_cache: Dict[str, CachedToolResult] = {}
        self._cache_lock = threading.Lock()
        self._cache_ttl: float = 60.0  # seconds - results expire after this
        self._cache_max_size: int = 100  # max cached entries
        # Only cache read-only tools with deterministic outputs
        self._cacheable_tools: set = {
            "Read",   # File contents (invalidate on write)
            "Glob",   # File pattern matches
            "Grep",   # Content search results
        }
        # Track file writes to invalidate relevant caches
        self._cache_invalidation_paths: Dict[str, float] = {}

        # Log config for debugging tool availability issues
        self.logger.info(
            f"ToolRegistry initialized with enabled_tools: {self.config.enabled_tools}",
            component="tools"
        )

        # Register built-in tools
        self._register_builtin_tools()

        # Log summary of registered tools
        enabled_tools = [t.name for t in self._tools.values() if t.enabled]
        disabled_tools = [t.name for t in self._tools.values() if not t.enabled]
        self.logger.info(
            f"Tool registration complete: {len(enabled_tools)} enabled, {len(disabled_tools)} disabled",
            component="tools"
        )
        if disabled_tools:
            self.logger.debug(
                f"Disabled tools: {disabled_tools}",
                component="tools"
            )

    def _get_current_working_dir(self) -> str:
        """Return the active working directory for this thread/tool call"""
        return getattr(self._thread_local, "workdir", self._default_working_dir)

    def set_default_working_dir(self, workdir: Optional[str]):
        """Override the default working directory used when no context is set"""
        if workdir:
            self._default_working_dir = os.path.abspath(workdir)

    @contextmanager
    def with_working_dir(self, workdir: Optional[str]):
        """Context manager that temporarily uses a specific working directory"""
        previous = getattr(self._thread_local, "workdir", None)
        changed = bool(workdir)
        if changed:
            self._thread_local.workdir = os.path.abspath(workdir)
        try:
            yield
        finally:
            if changed:
                if previous is None:
                    self._thread_local.__dict__.pop("workdir", None)
                else:
                    self._thread_local.workdir = previous

    @contextmanager
    def with_execution_context(self, context: Optional[ToolExecutionContext]):
        previous = getattr(self._thread_local, "exec_context", None)
        if context is not None:
            self._thread_local.exec_context = context
        try:
            yield
        finally:
            if previous is None:
                self._thread_local.__dict__.pop("exec_context", None)
            else:
                self._thread_local.exec_context = previous

    @contextmanager
    def with_invocation_context(self, context: Optional[InvocationContext]):
        previous = getattr(self._thread_local, "invocation_context", None)
        if context is not None:
            self._thread_local.invocation_context = context
        try:
            yield
        finally:
            if previous is None:
                self._thread_local.__dict__.pop("invocation_context", None)
            else:
                self._thread_local.invocation_context = previous

    @contextmanager
    def with_allowed_tools(self, allowed_tools: List[str]):
        """Context manager that temporarily restricts which tools can be executed.

        Args:
            allowed_tools: List of allowed tool names. Use ["*"] for all tools.
        """
        if not allowed_tools or "*" in allowed_tools:
            # No restriction
            yield
            return

        previous = getattr(self._thread_local, "allowed_tools", None)
        self._thread_local.allowed_tools = set(allowed_tools)
        try:
            yield
        finally:
            if previous is None:
                self._thread_local.__dict__.pop("allowed_tools", None)
            else:
                self._thread_local.allowed_tools = previous

    def _is_tool_allowed(self, tool_name: str) -> bool:
        """Check if a tool is allowed in the current context."""
        allowed = getattr(self._thread_local, "allowed_tools", None)
        if allowed is None:
            return True  # No restriction
        return tool_name in allowed

    def set_hook_manager(self, hook_manager: Optional[HookManager]) -> None:
        self._hook_manager = hook_manager

    @contextmanager
    def _with_env_overrides(self, overrides: Dict[str, str]):
        if not overrides:
            yield
            return
        original: Dict[str, Optional[str]] = {}
        for key, value in overrides.items():
            original[key] = os.environ.get(key)
            os.environ[key] = value
        try:
            yield
        finally:
            for key, value in original.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def _resolve_path(self, path: str, cwd: Optional[str] = None) -> str:
        """Resolve a user-provided path against the active working directory."""
        path = os.path.expanduser(path)
        if os.path.isabs(path):
            return os.path.abspath(path)
        base = os.path.abspath(cwd) if cwd else self._get_current_working_dir()
        return os.path.abspath(os.path.join(base, path))

    def _summarize_kwargs(self, kwargs: Dict[str, Any], max_length: int = 200) -> Dict[str, str]:
        """Compact kwargs for logging to avoid giant blobs or sensitive data."""
        summary: Dict[str, str] = {}
        for key, value in kwargs.items():
            try:
                text = str(value)
            except Exception:
                text = "<unserializable>"
            summary[key] = text if len(text) <= max_length else text[:max_length] + "..."
        return summary

    def _truncate_text(self, text: Optional[str], max_length: int = 4000) -> Optional[str]:
        if not text:
            return None
        return text if len(text) <= max_length else text[:max_length] + "..."

    def _filter_tool_kwargs(self, tool: Tool, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        """Drop unexpected kwargs before invoking a tool executor."""
        if not kwargs or not tool.executor:
            return kwargs
        try:
            import inspect
            sig = inspect.signature(tool.executor)
            if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
                return kwargs
            allowed = set(sig.parameters.keys())
            filtered = {k: v for k, v in kwargs.items() if k in allowed}
            dropped = [k for k in kwargs.keys() if k not in allowed]
            if dropped:
                self.logger.debug(
                    f"Dropped unexpected args for tool '{tool.name}': {dropped}",
                    component="tools"
                )
            return filtered
        except Exception:
            return kwargs

    def register(self, tool: Tool):
        """Register a tool"""
        with self._lock:
            # Explicitly set enabled based on config
            # Note: we explicitly set True/False rather than relying on defaults
            # to avoid subtle bugs where tool.enabled might be set incorrectly
            if tool.name in self.config.enabled_tools:
                tool.enabled = True
            elif self._graphd_tools_enabled and tool.name.startswith("graphd_"):
                tool.enabled = True
            else:
                tool.enabled = False

            self._tools[tool.name] = tool
            self.logger.debug(
                f"Registered tool: {tool.name} (enabled={tool.enabled}, in_config={tool.name in self.config.enabled_tools})",
                component="tools"
            )

    def unregister(self, name: str) -> bool:
        """Unregister a tool"""
        with self._lock:
            if name in self._tools:
                del self._tools[name]
                return True
            return False

    def get(self, name: str) -> Optional[Tool]:
        """Get a tool by name"""
        return self._tools.get(name)

    def list_tools(self, enabled_only: bool = True) -> List[Tool]:
        """List all registered tools"""
        with self._lock:
            tools = list(self._tools.values())
            if enabled_only:
                tools = [t for t in tools if t.enabled]
            return tools

    def is_parallel_safe(self, name: str) -> bool:
        """Return True if tool is enabled, read-only, and marked parallelizable"""
        tool = self.get(name)
        return bool(tool and tool.enabled and tool.read_only and tool.parallelizable)

    def get_definitions(self, enabled_only: bool = True) -> List[ToolDefinition]:
        """Get tool definitions for LLM"""
        return [
            t.to_definition()
            for t in self.list_tools(enabled_only)
            if not t.name.startswith("graphd_")
        ]

    # ========== CACHE HELPER METHODS ==========

    def _generate_cache_key(self, tool_name: str, kwargs: Dict[str, Any]) -> str:
        """Generate a deterministic cache key for a tool call."""
        # Sort kwargs for consistent ordering
        sorted_items = sorted(kwargs.items(), key=lambda x: x[0])
        # Create hashable representation
        key_parts = [tool_name]
        for k, v in sorted_items:
            key_parts.append(f"{k}={v}")
        return "|".join(key_parts)

    def _parse_cache_key(self, key: str) -> Tuple[str, Dict[str, str]]:
        """Parse a cache key back into tool name and parameters."""
        parts = key.split("|") if key else []
        tool = parts[0] if parts else ""
        params: Dict[str, str] = {}
        for part in parts[1:]:
            if "=" in part:
                param, value = part.split("=", 1)
                params[param] = value
        return tool, params

    def _get_cached_result(self, cache_key: str) -> Optional[ToolResult]:
        """
        Get cached result if valid (not expired).
        Returns None if cache miss or expired.
        """
        with self._cache_lock:
            cached = self._result_cache.get(cache_key)
            if cached is None:
                return None

            # Check TTL
            age = time.time() - cached.timestamp
            if age > self._cache_ttl:
                # Expired - remove from cache
                del self._result_cache[cache_key]
                return None

            # Cache hit - increment counter
            cached.hit_count += 1
            return cached.result

    def _store_cached_result(self, cache_key: str, result: ToolResult):
        """Store result in cache, evicting oldest if at capacity."""
        with self._cache_lock:
            # Evict oldest entries if at capacity
            if len(self._result_cache) >= self._cache_max_size:
                # Find oldest entry
                oldest_key = min(
                    self._result_cache.keys(),
                    key=lambda k: self._result_cache[k].timestamp
                )
                del self._result_cache[oldest_key]

            self._result_cache[cache_key] = CachedToolResult(
                result=result,
                timestamp=time.time(),
                hit_count=0
            )

    def _invalidate_cache_for_path(self, path: str, cwd: Optional[str] = None):
        """Invalidate cache entries that might be affected by a file write."""
        resolved = self._resolve_path(path, cwd=cwd) if path else ""
        with self._cache_lock:
            keys_to_remove = []
            for key in self._result_cache:
                tool_name, params = self._parse_cache_key(key)
                if tool_name == "Read":
                    cached_path = params.get("path")
                    cached_cwd = params.get("cwd")
                    if cached_path:
                        cached_resolved = self._resolve_path(cached_path, cwd=cached_cwd)
                        if cached_resolved == resolved:
                            keys_to_remove.append(key)
                elif tool_name in ("Glob", "Grep"):
                    keys_to_remove.append(key)

            for key in keys_to_remove:
                del self._result_cache[key]

            if keys_to_remove:
                self.logger.debug(
                    f"Invalidated {len(keys_to_remove)} cache entries for path: {path}",
                    component="tools.cache"
                )

    def clear_cache(self):
        """Clear all cached tool results."""
        with self._cache_lock:
            count = len(self._result_cache)
            self._result_cache.clear()
            self.logger.debug(f"Cleared {count} cached tool results", component="tools.cache")

    def get_cache_stats(self) -> Dict[str, Any]:
        """Get cache statistics for monitoring."""
        with self._cache_lock:
            total_hits = sum(c.hit_count for c in self._result_cache.values())
            return {
                "size": len(self._result_cache),
                "max_size": self._cache_max_size,
                "ttl_seconds": self._cache_ttl,
                "total_hits": total_hits,
                "cacheable_tools": list(self._cacheable_tools)
            }

    def _tool_resilience_config(self) -> ResilienceConfig:
        """Resilience settings for tool calls."""
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

    @resilient_call(
        state_attr="_tool_circuit_state",
        config_getter=lambda self: self._tool_resilience_config(),
        key_getter=lambda self, name, *_, **__: name,
        component="tools",
        logger_getter=lambda self: self.logger,
        result_validator=lambda result: getattr(result, "is_success", True),
    )
    def execute(self, name: str, timeout_override: Optional[float] = None, **kwargs) -> ToolResult:
        """
        Execute a tool by name with optional caching.

        Args:
            name: Tool name to execute
            timeout_override: Optional timeout override in seconds (used by microloop)
            **kwargs: Tool-specific arguments

        Returns:
            ToolResult with status, output, and error info
        """
        tool = self.get(name)
        if not tool:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Tool '{name}' not found"
            )

        # Apply timeout override if provided (microloop uses this)
        if timeout_override is not None and "timeout" not in kwargs:
            # Only inject timeout when the executor actually accepts it
            try:
                import inspect
                sig = inspect.signature(tool.executor)
                if "timeout" in sig.parameters or any(
                    p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
                ):
                    kwargs["timeout"] = int(timeout_override)
            except Exception:
                # Best effort – if we cannot inspect, don't inject
                pass

        invocation_context = getattr(self._thread_local, "invocation_context", None)
        exec_context = getattr(self._thread_local, "exec_context", None) or ToolExecutionContext()

        if invocation_context:
            invocation_context.tool_name = name
            invocation_context.tool_args = dict(kwargs)

            if self._hook_manager:
                hook_result = self._hook_manager.run("tool.before", invocation_context)
                if hook_result.blocked:
                    return ToolResult(
                        status=ToolStatus.PERMISSION_DENIED,
                        output=None,
                        error=hook_result.message or "Tool blocked by hook"
                    )

            if invocation_context.tool_args is not None:
                kwargs = invocation_context.tool_args
            exec_context.env_overrides = invocation_context.env_overrides
            exec_context.workdir_override = invocation_context.workdir_override
            exec_context.tool_policy = invocation_context.tool_policy

        # Check skill-based allowed tools restriction
        if not self._is_tool_allowed(name):
            return ToolResult(
                status=ToolStatus.PERMISSION_DENIED,
                output=None,
                error=f"Tool '{name}' not allowed by active skill"
            )

        if exec_context.tool_policy and not exec_context.tool_policy.is_allowed(name):
            return ToolResult(
                status=ToolStatus.PERMISSION_DENIED,
                output=None,
                error=f"Tool '{name}' blocked by invocation policy"
            )

        # Remove any unexpected args before caching/execution.
        kwargs = self._filter_tool_kwargs(tool, kwargs)

        # ========== CACHE CHECK (read-only tools only) ==========
        is_cacheable = name in self._cacheable_tools and tool.read_only
        if exec_context.env_overrides or exec_context.workdir_override:
            is_cacheable = False
        cache_key = None

        if is_cacheable:
            cache_key = self._generate_cache_key(name, kwargs)
            cached_result = self._get_cached_result(cache_key)
            if cached_result is not None:
                cached_result.metadata["cache_hit"] = True
                self.logger.debug(
                    f"Cache hit for {name}",
                    component="tools.cache",
                    data={"cache_key": cache_key[:50]}
                )
                return cached_result

        # ========== EXECUTE TOOL ==========
        env_overrides = exec_context.env_overrides
        if name == "Bash" and env_overrides and "env" not in kwargs:
            env = os.environ.copy()
            env.update(env_overrides)
            kwargs["env"] = env
        if name == "Bash" and exec_context.workdir_override and "cwd" not in kwargs:
            kwargs["cwd"] = exec_context.workdir_override

        workdir_ctx = self.with_working_dir(exec_context.workdir_override) if exec_context.workdir_override else nullcontext()
        with workdir_ctx:
            with self._with_env_overrides(env_overrides):
                result = tool.execute(**kwargs)

        if invocation_context and self._hook_manager:
            invocation_context.tool_result = result
            hook_result = self._hook_manager.run("tool.after", invocation_context)
            if hook_result.blocked:
                return ToolResult(
                    status=ToolStatus.PERMISSION_DENIED,
                    output=None,
                    error=hook_result.message or "Tool blocked by hook"
                )
            if invocation_context.tool_result is not None:
                result = invocation_context.tool_result

        # Log detailed failure context for transparency
        if not result.is_success:
            trace = None
            if isinstance(result.metadata, dict):
                trace = result.metadata.get("traceback")
            self.logger.error(
                f"Tool '{name}' execution failed",
                component="tools",
                data={
                    "tool": name,
                    "status": result.status.value if hasattr(result, "status") else "unknown",
                    "error": result.error,
                    "duration_ms": result.duration_ms,
                    "args": self._summarize_kwargs(kwargs),
                    "traceback": self._truncate_text(trace),
                }
            )

        # ========== CACHE STORAGE (successful read-only results) ==========
        if is_cacheable and cache_key and result.is_success:
            self._store_cached_result(cache_key, result)
            result.metadata["cached"] = True

        # ========== CACHE INVALIDATION (write operations) ==========
        if result.is_success:
            if name in ("Write", "Edit"):
                path = kwargs.get("path", "")
                cwd = kwargs.get("cwd")
                if path:
                    self._invalidate_cache_for_path(path, cwd=cwd)
            elif name in ("Bash", "python_execute"):
                # These can modify files in unknown ways - clear filesystem caches
                # Only clear if the command likely modified files
                command = kwargs.get("command", "") or kwargs.get("code", "")
                write_indicators = [
                    ">", ">>",  # redirects
                    "touch ", "mkdir ", "rm ", "mv ", "cp ",  # file ops
                    "echo ", "printf ",  # with redirects
                    "open(", "write(", "save(",  # python file ops
                ]
                if any(ind in command for ind in write_indicators):
                    self._invalidate_filesystem_caches()

        return result

    def _invalidate_filesystem_caches(self):
        """Clear all filesystem-related caches (Read, Glob, Grep)."""
        with self._cache_lock:
            keys_to_remove = [
                key for key in self._result_cache
                if any(tool in key for tool in ("Read", "Glob", "Grep"))
            ]
            for key in keys_to_remove:
                del self._result_cache[key]
            if keys_to_remove:
                self.logger.debug(
                    f"Invalidated {len(keys_to_remove)} filesystem cache entries",
                    component="tools.cache"
                )

    def enable(self, name: str) -> bool:
        """Enable a tool"""
        tool = self.get(name)
        if tool:
            tool.enabled = True
            return True
        return False

    def disable(self, name: str) -> bool:
        """Disable a tool"""
        tool = self.get(name)
        if tool:
            tool.enabled = False
            return True
        return False

    def _register_builtin_tools(self):
        """Register built-in tools"""

        # # Web Fetch Tool
        # self.register(Tool(
        #     name="web_fetch",
        #     description="Fetch and extract content from a URL. Returns the main text content of the page.",
        #     parameters={
        #         "url": {
        #             "type": "string",
        #             "description": "The URL to fetch"
        #         },
        #         "extract_type": {
        #             "type": "string",
        #             "enum": ["text", "html", "markdown"],
        #             "description": "Type of content to extract",
        #             "default": "text"
        #         }
        #     },
        #     required_params=["url"],
        #     executor=self._web_fetch,
        #     timeout=60
        # ))

        # Core tool set (cwd is required for filesystem operations)
        self.register(Tool(
            name="Read",
            description="Read any file in the working directory.",
            parameters={
                "cwd": {
                    "type": "string",
                    "description": "Working directory to resolve relative paths against"
                },
                "path": {
                    "type": "string",
                    "description": "Path to the file to read (relative to cwd or absolute)"
                },
                "encoding": {
                    "type": "string",
                    "description": "File encoding (default: utf-8)",
                    "default": "utf-8"
                },
                "max_bytes": {
                    "type": "integer",
                    "description": "Maximum bytes to read (default: 100000)",
                    "default": 100000
                }
            },
            required_params=["cwd", "path"],
            executor=self._file_read,
            timeout=10,
            read_only=True,
            parallelizable=True,
            cost_hint="low"
        ))

        self.register(Tool(
            name="Write",
            description="Create new files in the working directory.",
            parameters={
                "cwd": {
                    "type": "string",
                    "description": "Working directory to resolve relative paths against"
                },
                "path": {
                    "type": "string",
                    "description": "Path to the new file (relative to cwd or absolute)"
                },
                "content": {
                    "type": "string",
                    "description": "Full file content to write"
                }
            },
            required_params=["cwd", "path", "content"],
            executor=self._file_create,
            timeout=10
        ))

        self.register(Tool(
            name="Edit",
            description="Make precise edits to existing files.",
            parameters={
                "cwd": {
                    "type": "string",
                    "description": "Working directory to resolve relative paths against"
                },
                "path": {
                    "type": "string",
                    "description": "Path to the file to edit (relative to cwd or absolute)"
                },
                "old_string": {
                    "type": "string",
                    "description": "Exact string to find"
                },
                "new_string": {
                    "type": "string",
                    "description": "Replacement string"
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "Replace all occurrences (default: false, requires unique match)",
                    "default": False
                }
            },
            required_params=["cwd", "path", "old_string", "new_string"],
            executor=self._file_edit,
            timeout=10
        ))

        self.register(Tool(
            name="Bash",
            description="Run terminal commands, scripts, or git operations.",
            parameters={
                "cwd": {
                    "type": "string",
                    "description": "Working directory for command execution"
                },
                "command": {
                    "type": "string",
                    "description": "The command to execute"
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds (default: 30)",
                    "default": 30
                }
            },
            required_params=["cwd", "command"],
            executor=self._bash_execute,
            timeout=self.config.bash_timeout
        ))

        self.register(Tool(
            name="Glob",
            description="Find files by glob pattern (e.g., **/*.ts, src/**/*.py).",
            parameters={
                "cwd": {
                    "type": "string",
                    "description": "Working directory to resolve patterns against"
                },
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern to match"
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of matches to return (default: 200)",
                    "default": 200
                },
                "include_hidden": {
                    "type": "boolean",
                    "description": "Include hidden files and directories (default: false)",
                    "default": False
                }
            },
            required_params=["cwd", "pattern"],
            executor=self._glob_search,
            timeout=15,
            read_only=True,
            parallelizable=True,
            cost_hint="low"
        ))

        self.register(Tool(
            name="Grep",
            description="Search file contents with a regex pattern.",
            parameters={
                "cwd": {
                    "type": "string",
                    "description": "Working directory to search within"
                },
                "pattern": {
                    "type": "string",
                    "description": "Regex pattern to search for"
                },
                "path": {
                    "type": "string",
                    "description": "Optional subpath to scope the search (default: '.')",
                    "default": "."
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of matches to return (default: 20)",
                    "default": 20
                },
                "case_sensitive": {
                    "type": "boolean",
                    "description": "Whether the search should respect case",
                    "default": False
                }
            },
            required_params=["cwd", "pattern"],
            executor=self._grep_search,
            timeout=20,
            read_only=True,
            parallelizable=True,
            cost_hint="low"
        ))

        # Python Execute Tool
        self.register(Tool(
            name="python_execute",
            description="Execute Python code and return the output. Use for calculations, data processing, or complex logic.",
            parameters={
                "code": {
                    "type": "string",
                    "description": "The Python code to execute"
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds (default: 60)",
                    "default": 60
                }
            },
            required_params=["code"],
            executor=self._python_execute,
            timeout=self.config.python_timeout
        ))

        # Ask User Tool - for interactive workflows
        self.register(Tool(
            name="ask_user",
            description=(
                "Ask the user a question and pause execution until they respond. "
                "Use this for interactive workflows where you need user input, preferences, or decisions. "
                "Provide clear options when possible to make it easy for the user to respond."
            ),
            parameters={
                "question": {
                    "type": "string",
                    "description": "The question to ask the user"
                },
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional list of choices to present to the user",
                    "default": []
                },
                "context": {
                    "type": "string",
                    "description": "Additional context or explanation to help the user answer",
                    "default": ""
                }
            },
            required_params=["question"],
            executor=self._ask_user,
            timeout=5  # Tool itself returns quickly; the pause happens at orchestration level
        ))

        # Image Generation Tool (Gemini)
        self.register(Tool(
            name="generate_image",
            description=(
                "Generate an image from a text description. When you call this, lightly embellish the prompt with 1-2"
                " concrete visual details (lighting, composition, style cues) and pass the enhanced text directly."
                " Accepts natural language descriptions and optional output_path; otherwise uses a default save path."
                " Returns the file path of the saved image."
            ),
            parameters={
                "prompt": {
                    "type": "string",
                    "description": "Image description to send to the generator. Add 1-2 crisp details yourself before calling."
                },
                "style": {
                    "type": "string",
                    "description": "Optional style guidance such as 'photorealistic', 'watercolor', or 'pixel art'",
                    "default": None
                },
                "width": {
                    "type": "integer",
                    "description": "Preferred image width in pixels (best-effort hint)",
                    "default": None
                },
                "height": {
                    "type": "integer",
                    "description": "Preferred image height in pixels (best-effort hint)",
                    "default": None
                },
                "output_path": {
                    "type": "string",
                    "description": "Optional explicit output path. If not provided, extracted from prompt or uses default.",
                    "default": None
                },
                "skip_prompt_engineering": {
                    "type": "boolean",
                    "description": "Legacy flag; prompt is now passed through directly. Leave as true.",
                    "default": True
                }
            },
            required_params=["prompt"],
            executor=self._generate_image,
            timeout=70,  # Extra buffer for API call
            read_only=False,  # Creates files
            parallelizable=True,  # Can run concurrent image generations
            cost_hint="high"  # API calls are expensive
        ))

        # Graphd tools (optional)
        if self._graphd_client and self._graphd_tools_enabled:
            self.register(Tool(
                name="graphd_health",
                description="Check graphd health and stats.",
                parameters={},
                required_params=[],
                executor=self._graphd_health,
                timeout=5,
                read_only=True,
                parallelizable=True,
                cost_hint="low"
            ))
            self.register(Tool(
                name="graphd_symbol",
                description="Resolve nearest symbol definition for a file and line.",
                parameters={
                    "path": {"type": "string", "description": "File path relative to repo root"},
                    "line": {"type": "integer", "description": "1-based line number"},
                },
                required_params=["path", "line"],
                executor=self._graphd_symbol,
                timeout=5,
                read_only=True,
                parallelizable=True,
                cost_hint="low"
            ))
            self.register(Tool(
                name="graphd_context",
                description="Fetch graphd context for a symbol id.",
                parameters={
                    "symbol_id": {"type": "string", "description": "Graphd symbol id"},
                    "depth": {"type": "integer", "description": "Neighbor depth", "default": 1},
                },
                required_params=["symbol_id"],
                executor=self._graphd_context,
                timeout=5,
                read_only=True,
                parallelizable=True,
                cost_hint="low"
            ))
            self.register(Tool(
                name="graphd_impact",
                description="Get ranked impact candidates for a change.",
                parameters={
                    "entity_type": {"type": "string", "description": "file | symbol"},
                    "path": {"type": "string", "description": "File path (for file or symbol lookup)"},
                    "symbol_id": {"type": "string", "description": "Symbol id (optional)"},
                    "line": {"type": "integer", "description": "Line for symbol lookup (optional)"},
                    "change_type": {"type": "string", "description": "sig_change | rename | move | config_contract_change | logging_contract_change | unknown"},
                    "diff_summary": {"type": "string", "description": "Optional diff summary"},
                    "budget": {"type": "integer", "description": "Max candidates", "default": 20},
                },
                required_params=["entity_type", "change_type"],
                executor=self._graphd_impact,
                timeout=10,
                read_only=True,
                parallelizable=True,
                cost_hint="low"
            ))
            self.register(Tool(
                name="graphd_search",
                description="Search the repo via graphd controlled search.",
                parameters={
                    "pattern": {"type": "string", "description": "Regex pattern to search"},
                    "path": {"type": "string", "description": "Optional relative path scope"},
                    "max_results": {"type": "integer", "description": "Max results", "default": 50},
                },
                required_params=["pattern"],
                executor=self._graphd_search,
                timeout=10,
                read_only=True,
                parallelizable=True,
                cost_hint="low"
            ))
            self.register(Tool(
                name="graphd_export",
                description="Export graphd table as JSONL payload.",
                parameters={
                    "table": {"type": "string", "description": "files | symbols | module_edges | exports | run_artifacts"},
                    "format": {"type": "string", "description": "jsonl", "default": "jsonl"},
                },
                required_params=["table"],
                executor=self._graphd_export,
                timeout=10,
                read_only=True,
                parallelizable=True,
                cost_hint="low"
            ))

    # Tool Executors

    def _web_fetch(self, url: str, extract_type: str = "text") -> ToolResult:
        """Fetch and extract content from URL"""
        try:
            import requests
            from urllib.parse import urlparse

            # Validate URL
            parsed = urlparse(url)
            if not parsed.scheme or not parsed.netloc:
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error="Invalid URL format"
                )

            headers = {
                "User-Agent": "Mozilla/5.0 (compatible; AgentHarness/1.0)"
            }

            response = requests.get(url, headers=headers, timeout=30)
            response.raise_for_status()

            if extract_type == "html":
                content = response.text
            elif extract_type == "markdown":
                try:
                    from bs4 import BeautifulSoup
                    import html2text
                    soup = BeautifulSoup(response.text, "html.parser")
                    # Remove scripts and styles
                    for tag in soup(["script", "style", "nav", "footer"]):
                        tag.decompose()
                    h = html2text.HTML2Text()
                    h.ignore_links = False
                    content = h.handle(str(soup))
                except ImportError:
                    content = response.text
            else:  # text
                try:
                    from bs4 import BeautifulSoup
                    soup = BeautifulSoup(response.text, "html.parser")
                    # Remove scripts and styles
                    for tag in soup(["script", "style", "nav", "footer"]):
                        tag.decompose()
                    content = soup.get_text(separator="\n", strip=True)
                except ImportError:
                    # Fallback to raw text
                    content = response.text

            # Truncate if too long
            if len(content) > self.config.max_output_length:
                content = content[:self.config.max_output_length] + "\n...[truncated]"

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=content,
                metadata={"url": url, "content_type": extract_type, "length": len(content)}
            )

        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Fetch failed: {str(e)}"
            )

    def _bash_execute(
        self,
        command: str,
        timeout: int = 30,
        cwd: Optional[str] = None,
        working_dir: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> ToolResult:
        """Execute bash command"""
        # Security check - block dangerous commands
        dangerous_patterns = [
            "rm -rf /", "rm -rf /*", "> /dev/sda",
            "mkfs", ":(){:|:&};:", "dd if=/dev/",
            "chmod -R 777 /", "chown -R"
        ]

        for pattern in dangerous_patterns:
            if pattern in command:
                return ToolResult(
                    status=ToolStatus.PERMISSION_DENIED,
                    output=None,
                    error=f"Command blocked for safety: contains '{pattern}'"
                )

        try:
            # Use timeout from config if not specified
            timeout = min(timeout, self.config.bash_timeout)

            # Resolve working directory against calling context
            base_dir = cwd or working_dir
            if base_dir:
                resolved_cwd = self._resolve_path(base_dir)
            else:
                resolved_cwd = self._get_current_working_dir()

            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=resolved_cwd,
                env=env or os.environ.copy(),
            )

            output = result.stdout
            if result.stderr:
                output += f"\n[stderr]: {result.stderr}"

            # Truncate if too long
            if len(output) > self.config.max_output_length:
                output = output[:self.config.max_output_length] + "\n...[truncated]"

            if result.returncode != 0:
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=output,
                    error=f"Command exited with code {result.returncode}",
                    metadata={"return_code": result.returncode}
                )

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=output,
                metadata={"return_code": result.returncode}
            )

        except subprocess.TimeoutExpired:
            return ToolResult(
                status=ToolStatus.TIMEOUT,
                output=None,
                error=f"Command timed out after {timeout} seconds"
            )
        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Execution failed: {str(e)}"
            )

    def _python_execute(self, code: str, timeout: int = 60) -> ToolResult:
        """Execute Python code in a sandboxed environment"""
        try:
            timeout = min(timeout, self.config.python_timeout)

            # Create isolated namespace
            namespace = {
                "__builtins__": __builtins__,
                "print": print,
            }

            original_open = open

            def logging_open(file, mode='r', *args, **kwargs):
                abs_path = os.path.abspath(file)
                write_mode = any(ch in mode for ch in ("w", "a", "x", "+"))
                if write_mode:
                    self.logger.file_operation("python_open", abs_path, status="starting", detail=f"mode={mode}")
                try:
                    result = original_open(file, mode, *args, **kwargs)
                except Exception as e:
                    if write_mode:
                        self.logger.file_operation("python_open", abs_path, status="failed", detail=str(e))
                    raise
                else:
                    if write_mode:
                        self.logger.file_operation("python_open", abs_path, status="success", detail=f"mode={mode}")
                    return result

            namespace["open"] = logging_open

            # Capture stdout/stderr
            stdout_capture = io.StringIO()
            stderr_capture = io.StringIO()

            # Execute with timeout
            result_container = {"result": None, "error": None}

            def execute():
                try:
                    with redirect_stdout(stdout_capture), redirect_stderr(stderr_capture):
                        exec(code, namespace)
                        # Get the result if any
                        if "_result" in namespace:
                            result_container["result"] = namespace["_result"]
                except Exception as e:
                    result_container["error"] = traceback.format_exc()

            thread = threading.Thread(target=execute)
            thread.start()
            thread.join(timeout=timeout)

            if thread.is_alive():
                return ToolResult(
                    status=ToolStatus.TIMEOUT,
                    output=None,
                    error=f"Execution timed out after {timeout} seconds"
                )

            stdout_output = stdout_capture.getvalue()
            stderr_output = stderr_capture.getvalue()

            if result_container["error"]:
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=stdout_output,
                    error=result_container["error"]
                )

            output = stdout_output
            if result_container["result"] is not None:
                output += f"\nResult: {result_container['result']}"

            # Truncate if too long
            if len(output) > self.config.max_output_length:
                output = output[:self.config.max_output_length] + "\n...[truncated]"

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=output,
                metadata={"has_result": result_container["result"] is not None}
            )

        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Python execution failed: {str(e)}"
            )

    def _file_read(
        self,
        path: str,
        cwd: Optional[str] = None,
        encoding: str = "utf-8",
        max_bytes: int = 100000
    ) -> ToolResult:
        """Read file contents"""
        resolved_path = self._resolve_path(path, cwd=cwd)
        try:
            self.logger.file_operation("file_read", resolved_path, status="starting")

            if not os.path.exists(resolved_path):
                error_msg = f"File not found: {resolved_path}"
                self.logger.file_operation("file_read", resolved_path, status="failed", detail=error_msg)
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error=error_msg
                )

            if not os.path.isfile(resolved_path):
                error_msg = f"Path is not a file: {resolved_path}"
                self.logger.file_operation("file_read", resolved_path, status="failed", detail=error_msg)
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error=error_msg
                )

            file_size = os.path.getsize(resolved_path)
            if file_size > max_bytes:
                with open(resolved_path, "r", encoding=encoding) as f:
                    content = f.read(max_bytes)
                content += f"\n...[truncated, file size: {file_size} bytes]"
            else:
                with open(resolved_path, "r", encoding=encoding) as f:
                    content = f.read()

            self.logger.file_operation(
                "file_read",
                resolved_path,
                status="success",
                detail=f"bytes={len(content)} size={file_size}"
            )

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=content,
                metadata={"path": resolved_path, "size": file_size, "action": "read"}
            )

        except UnicodeDecodeError as e:
            detail = f"Failed to decode with encoding '{encoding}': {str(e)}"
            self.logger.file_operation("file_read", resolved_path, status="failed", detail=detail)
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=detail
            )
        except Exception as e:
            detail = f"File read failed: {str(e)}"
            self.logger.file_operation("file_read", resolved_path, status="failed", detail=detail)
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=detail
            )

    def _file_write(
        self,
        path: str,
        cwd: Optional[str] = None,
        content: Optional[str] = None,
        append: bool = False,
        old_string: Optional[str] = None,
        new_string: Optional[str] = None,
        replace_all: bool = False
    ) -> ToolResult:
        """
        Write or edit a file with atomic writes.

        Modes:
        1. FULL WRITE: content provided, old_string not provided
        2. APPEND: content provided, append=True
        3. TARGETED EDIT: old_string + new_string provided (content ignored)
        """
        resolved_path = self._resolve_path(path, cwd=cwd)

        # Determine mode
        is_edit_mode = old_string is not None and new_string is not None

        # Validate parameters
        if is_edit_mode:
            if not os.path.exists(resolved_path):
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error=f"File not found for edit: {resolved_path}. Use Write to create new files."
                )
        else:
            if content is None:
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error="Must provide 'content' for write/append, or 'old_string'+'new_string' for edit"
                )

        try:
            action = "edit" if is_edit_mode else ("append" if append else "write")
            self.logger.file_operation(
                "file_write",
                resolved_path,
                status="starting",
                detail=f"action={action}"
            )

            # Create directory if needed (for write/append mode only)
            dir_path = os.path.dirname(resolved_path)
            if dir_path and not os.path.exists(dir_path):
                self.logger.file_operation("mkdir", dir_path, status="starting")
                os.makedirs(dir_path, exist_ok=True)
                self.logger.file_operation("mkdir", dir_path, status="success")

            # ========== TARGETED EDIT MODE ==========
            if is_edit_mode:
                with open(resolved_path, "r", encoding="utf-8") as f:
                    original_content = f.read()

                # Uniqueness check
                occurrence_count = original_content.count(old_string)
                if occurrence_count == 0:
                    return ToolResult(
                        status=ToolStatus.ERROR,
                        output=None,
                        error=f"old_string not found in {resolved_path}. Verify the exact text including whitespace.",
                        metadata={"path": resolved_path, "action": "edit"}
                    )
                if occurrence_count > 1 and not replace_all:
                    # Provide context to help user disambiguate
                    first_idx = original_content.find(old_string)
                    snippet_start = max(0, first_idx - 30)
                    snippet_end = min(len(original_content), first_idx + len(old_string) + 30)
                    context_snippet = original_content[snippet_start:snippet_end]
                    return ToolResult(
                        status=ToolStatus.ERROR,
                        output=None,
                        error=f"old_string found {occurrence_count} times - not unique. "
                              f"Add surrounding context to make unique, or use replace_all=true. "
                              f"First occurrence near: ...{context_snippet}...",
                        metadata={"path": resolved_path, "action": "edit", "occurrences": occurrence_count}
                    )

                # Apply replacement
                if replace_all:
                    new_content = original_content.replace(old_string, new_string)
                    replacements_made = occurrence_count
                else:
                    new_content = original_content.replace(old_string, new_string, 1)
                    replacements_made = 1

                bytes_written = len(new_content)
                output_msg = f"Replaced {replacements_made} occurrence(s) in {resolved_path}"

            # ========== APPEND MODE ==========
            elif append:
                # Append is safe without atomic write (just adding to end)
                with open(resolved_path, "a", encoding="utf-8") as f:
                    f.write(content)

                self.logger.file_operation(
                    "file_write",
                    resolved_path,
                    status="success",
                    detail=f"bytes={len(content)} action=append"
                )
                return ToolResult(
                    status=ToolStatus.SUCCESS,
                    output=f"Successfully appended to {resolved_path}",
                    metadata={
                        "path": resolved_path,
                        "bytes_written": len(content),
                        "action": "append"
                    }
                )

            # ========== FULL WRITE MODE ==========
            else:
                new_content = content
                bytes_written = len(content)
                output_msg = f"Successfully wrote {resolved_path}"

            # ========== ATOMIC WRITE (for edit and full write) ==========
            # Write to temp file, then atomic rename
            tmp_fd, tmp_path = tempfile.mkstemp(
                dir=dir_path or ".",
                prefix=".tmp_write_",
                suffix=".tmp"
            )
            try:
                with os.fdopen(tmp_fd, "w", encoding="utf-8") as tmp_f:
                    tmp_f.write(new_content)
                # Atomic rename (POSIX guarantees atomicity)
                os.replace(tmp_path, resolved_path)
            except Exception:
                # Clean up temp file on failure
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
                raise

            self.logger.file_operation(
                "file_write",
                resolved_path,
                status="success",
                detail=f"bytes={bytes_written} action={action}"
            )

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=output_msg,
                metadata={
                    "path": resolved_path,
                    "bytes_written": bytes_written,
                    "action": action,
                    "replacements": replacements_made if is_edit_mode else None,
                    "atomic": True
                }
            )

        except Exception as e:
            detail = f"File {action} failed: {str(e)}"
            self.logger.file_operation("file_write", resolved_path, status="failed", detail=detail)
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=detail
            )

    def _file_create(self, cwd: str, path: str, content: str) -> ToolResult:
        """Create a new file; fails if the file already exists."""
        if content is None:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error="Must provide 'content' to create a new file"
            )

        resolved_path = self._resolve_path(path, cwd=cwd)
        if os.path.exists(resolved_path):
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"File already exists: {resolved_path}. Use Edit to modify existing files."
            )

        return self._file_write(
            path=path,
            cwd=cwd,
            content=content,
            append=False
        )

    def _file_edit(
        self,
        cwd: str,
        path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False
    ) -> ToolResult:
        """Apply a precise string replacement to an existing file."""
        return self._file_write(
            path=path,
            cwd=cwd,
            old_string=old_string,
            new_string=new_string,
            replace_all=replace_all
        )

    def _get_current_time(self, format: str = "human", timezone: str = "local") -> ToolResult:
        """Get current time"""
        try:
            from datetime import datetime

            if timezone == "local":
                now = datetime.now()
            else:
                try:
                    import pytz
                    tz = pytz.timezone(timezone)
                    now = datetime.now(tz)
                except ImportError:
                    now = datetime.utcnow()
                    timezone = "UTC"

            if format == "iso":
                result = now.isoformat()
            elif format == "unix":
                result = int(now.timestamp())
            elif format == "human":
                result = now.strftime("%A, %B %d, %Y at %I:%M %p")
            else:
                # Custom strftime format
                result = now.strftime(format)

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=result,
                metadata={"timezone": timezone, "format": format}
            )

        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Failed to get time: {str(e)}"
            )

    def _ask_user(
        self,
        question: str,
        options: Optional[List[str]] = None,
        context: Optional[str] = None,
    ) -> ToolResult:
        """
        Ask the user a question and signal that execution should pause.

        Returns a special AWAITING_USER status that the orchestration layer
        (Worker/Wizard) will intercept to pause and request user input.
        """
        prompt_data = {
            "question": question,
            "options": options or [],
            "context": context or "",
        }

        return ToolResult(
            status=ToolStatus.AWAITING_USER,
            output=json.dumps(prompt_data),
            metadata={"prompt_type": "ask_user"}
        )

    # ========== FILESYSTEM SEARCH HELPERS ==========

    def _get_repo_root(self, start_path: Optional[str] = None) -> str:
        """
        Determine the repository root directory.

        Tries git first, then falls back to the working directory.
        This ensures searches are always anchored to a sensible root.
        """
        start = start_path or self._get_current_working_dir()

        # Try git root first
        try:
            result = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=start,
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                git_root = result.stdout.strip()
                if git_root and os.path.isdir(git_root):
                    return git_root
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass

        # Fallback to working directory
        return start

    def _should_skip_dir(self, dirname: str) -> bool:
        """
        Check if a directory should be skipped during filesystem search.

        Args:
            dirname: Directory name (not full path)

        Returns:
            True if directory should be skipped
        """
        # Check exact matches
        if dirname in DEFAULT_EXCLUDE_DIRS:
            return True

        # Check glob patterns (e.g., *.egg-info)
        for pattern in DEFAULT_EXCLUDE_DIRS:
            if "*" in pattern:
                # Simple glob matching
                if pattern.startswith("*") and dirname.endswith(pattern[1:]):
                    return True
                elif pattern.endswith("*") and dirname.startswith(pattern[:-1]):
                    return True

        return False

    def _should_skip_file(self, filename: str) -> bool:
        """
        Check if a file should be skipped during filesystem search.

        Args:
            filename: File name (not full path)

        Returns:
            True if file should be skipped
        """
        # Check extension
        _, ext = os.path.splitext(filename)
        if ext.lower() in DEFAULT_EXCLUDE_EXTENSIONS:
            return True

        return False

    def _is_safe_path(self, path: str, root: str) -> bool:
        """
        Check if a path is safe (within repo root, not a symlink escape).

        Args:
            path: Path to check
            root: Repository root to stay within

        Returns:
            True if path is safe to include
        """
        try:
            # Resolve the real path (follows symlinks)
            real_path = os.path.realpath(path)
            real_root = os.path.realpath(root)

            # Check if resolved path is within root
            return real_path.startswith(real_root + os.sep) or real_path == real_root
        except (OSError, ValueError):
            return False

    def _sanitize_search_pattern(self, pattern: str) -> str:
        """Clean user-provided pattern so it can safely be used for filesystem searches."""
        if not pattern:
            return ""
        cleaned = pattern.strip()
        cleaned = re.sub(r"[\r\n\t]+", " ", cleaned)
        cleaned = re.sub(r"[\"'`]+", "", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned)
        return cleaned

    def _relax_grep_pattern(self, pattern: str) -> Optional[str]:
        """Derive a broader literal token from a regex pattern for fallback matching."""
        if not pattern or re.fullmatch(r"[A-Za-z0-9_]+", pattern):
            return None
        stripped = re.sub(r"\\.", " ", pattern)
        tokens = re.findall(r"[A-Za-z0-9_]+", stripped)
        if not tokens:
            return None
        candidate = max(tokens, key=len)
        if len(candidate) < 3:
            return None
        return candidate

    def _match_filenames(self, root: str, pattern: str, limit: int) -> List[str]:
        """
        Find files whose names contain the pattern.

        Excludes:
        - Directories in DEFAULT_EXCLUDE_DIRS
        - Files with extensions in DEFAULT_EXCLUDE_EXTENSIONS
        - Symlinks that point outside the repo root
        """
        matches = []
        needle = pattern.lower()

        # Don't follow symlinks to prevent escaping the repo
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            # Filter out excluded directories IN-PLACE (modifying dirnames affects os.walk)
            dirnames[:] = [
                d for d in dirnames
                if not self._should_skip_dir(d)
                and self._is_safe_path(os.path.join(dirpath, d), root)
            ]

            for fname in filenames:
                # Skip excluded file types
                if self._should_skip_file(fname):
                    continue

                # Check if pattern matches
                if needle not in fname.lower():
                    continue

                full_path = os.path.join(dirpath, fname)

                # Skip symlinks pointing outside repo
                if os.path.islink(full_path) and not self._is_safe_path(full_path, root):
                    continue

                rel_path = os.path.relpath(full_path, root)
                matches.append(rel_path)

                if len(matches) >= limit:
                    return matches

        return matches

    def _run_fast_search(self, root: str, pattern: str, max_results: int, case_sensitive: bool) -> Tuple[str, str]:
        """
        Attempt to run a fast grep-style search using rg/grep.
        Returns (output, strategy) for the first method that succeeds.

        Automatically excludes:
        - Directories in DEFAULT_EXCLUDE_DIRS
        - Files with extensions in DEFAULT_EXCLUDE_EXTENSIONS
        - Does not follow symlinks
        """
        strategies = []

        # Build ripgrep command with exclusions
        if shutil.which("rg"):
            cmd = [
                "rg",
                "--line-number",
                "--no-heading",
                "--color", "never",
                "--max-count", str(max_results),
                "--no-follow",  # Don't follow symlinks
            ]
            # Add directory exclusions
            for exclude_dir in DEFAULT_EXCLUDE_DIRS:
                cmd.extend(["--glob", f"!**/{exclude_dir}/**"])
            # Add file extension exclusions
            for ext in DEFAULT_EXCLUDE_EXTENSIONS:
                cmd.extend(["--glob", f"!*{ext}"])

            if not case_sensitive:
                cmd.append("-i")
            cmd.append(pattern)
            strategies.append(("rg", cmd))

        # Build grep command with exclusions
        if shutil.which("grep"):
            cmd = [
                "grep", "-R", "-n",
                "--binary-files=without-match",
                "-m", str(max_results),
            ]
            # Add directory exclusions
            for exclude_dir in DEFAULT_EXCLUDE_DIRS:
                # grep uses --exclude-dir without glob wildcards
                clean_dir = exclude_dir.replace("*", "")
                if clean_dir:
                    cmd.append(f"--exclude-dir={clean_dir}")
            # Add file pattern exclusions
            for ext in DEFAULT_EXCLUDE_EXTENSIONS:
                cmd.append(f"--exclude=*{ext}")

            if not case_sensitive:
                cmd.append("-i")
            cmd.append(pattern)
            strategies.append(("grep", cmd))

        for name, cmd in strategies:
            try:
                result = subprocess.run(
                    cmd,
                    cwd=root,
                    capture_output=True,
                    text=True,
                    timeout=10
                )
            except subprocess.TimeoutExpired:
                continue
            except FileNotFoundError:
                continue

            if result.returncode in (0, 1):
                output = result.stdout.strip()
                return output, name
        return "", ""

    def _manual_content_search(self, root: str, pattern: str, max_results: int, case_sensitive: bool) -> str:
        """
        Fallback content search that scans files line-by-line.

        Excludes:
        - Directories in DEFAULT_EXCLUDE_DIRS
        - Files with extensions in DEFAULT_EXCLUDE_EXTENSIONS
        - Symlinks that point outside the repo root
        """
        matches = []
        needle = pattern if case_sensitive else pattern.lower()

        # Don't follow symlinks to prevent escaping the repo
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            # Filter out excluded directories IN-PLACE
            dirnames[:] = [
                d for d in dirnames
                if not self._should_skip_dir(d)
                and self._is_safe_path(os.path.join(dirpath, d), root)
            ]

            for fname in filenames:
                # Skip excluded file types
                if self._should_skip_file(fname):
                    continue

                full_path = os.path.join(dirpath, fname)

                # Skip symlinks pointing outside repo
                if os.path.islink(full_path) and not self._is_safe_path(full_path, root):
                    continue

                try:
                    with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
                        for lineno, line in enumerate(f, start=1):
                            haystack = line if case_sensitive else line.lower()
                            if needle in haystack:
                                rel_path = os.path.relpath(full_path, root)
                                matches.append(f"{rel_path}:{lineno}:{line.strip()}")
                                if len(matches) >= max_results:
                                    return "\n".join(matches)
                except (UnicodeDecodeError, OSError):
                    continue

        return "\n".join(matches)

    def _glob_search(
        self,
        cwd: str,
        pattern: str,
        max_results: int = 200,
        include_hidden: bool = False
    ) -> ToolResult:
        """Find files by glob pattern rooted at cwd."""
        if not pattern:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error="Empty glob pattern"
            )

        max_results = max(1, min(max_results, 1000))
        resolved_cwd = self._resolve_path(cwd)

        if not os.path.isdir(resolved_cwd):
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Working directory does not exist or is not a directory: {resolved_cwd}"
            )

        search_pattern = pattern if os.path.isabs(pattern) else os.path.join(resolved_cwd, pattern)

        try:
            import glob

            def _filter_glob_matches(matches: List[str]) -> List[str]:
                filtered: List[str] = []
                seen = set()
                for match in sorted(matches):
                    if not self._is_safe_path(match, resolved_cwd):
                        continue

                    rel_path = os.path.relpath(match, resolved_cwd)
                    parts = rel_path.split(os.sep)

                    if not include_hidden and any(part.startswith(".") for part in parts):
                        continue

                    if any(self._should_skip_dir(part) for part in parts[:-1]):
                        continue

                    basename = os.path.basename(match)
                    if os.path.isfile(match) and self._should_skip_file(basename):
                        continue

                    if rel_path in seen:
                        continue

                    seen.add(rel_path)
                    if os.path.isdir(match):
                        rel_path = f"{rel_path}/"
                    filtered.append(rel_path)

                    if len(filtered) >= max_results:
                        break
                return filtered

            raw_matches = glob.glob(search_pattern, recursive=True)
            filtered = _filter_glob_matches(raw_matches)
            used_pattern = pattern

            if not filtered and not os.path.isabs(pattern) and not glob.has_magic(pattern):
                if not pattern.startswith("..") and not pattern.startswith("~"):
                    fallback_seed = pattern
                    if fallback_seed.startswith("./"):
                        fallback_seed = fallback_seed[2:]
                    fallback_seed = fallback_seed.lstrip(os.sep)
                    if fallback_seed:
                        fallback_pattern = f"**/*{fallback_seed}*"
                        fallback_search = os.path.join(resolved_cwd, fallback_pattern)
                        raw_matches = glob.glob(fallback_search, recursive=True)
                        filtered = _filter_glob_matches(raw_matches)
                        if filtered:
                            used_pattern = fallback_pattern

            if filtered:
                output = "\n".join(filtered)
            else:
                output = f"No matches for '{pattern}' in {resolved_cwd}"

            if len(output) > self.config.max_output_length:
                output = output[:self.config.max_output_length] + "\n...[truncated]"

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=output,
                metadata={
                    "cwd": resolved_cwd,
                    "pattern": pattern,
                    "count": len(filtered),
                    **({"pattern_used": used_pattern} if used_pattern != pattern else {})
                }
            )

        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Glob search failed: {str(e)}"
            )

    def _grep_search(
        self,
        cwd: str,
        pattern: str,
        path: str = ".",
        max_results: int = 20,
        case_sensitive: bool = False
    ) -> ToolResult:
        """Search file contents with a regex pattern rooted at cwd."""
        sanitized = self._sanitize_search_pattern(pattern)
        if not sanitized:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error="Empty or invalid search pattern"
            )

        max_results = max(1, min(max_results, 200))
        resolved_root = self._resolve_path(path, cwd=cwd)

        if not os.path.isdir(resolved_root):
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Search path does not exist or is not a directory: {resolved_root}"
            )

        content_output, strategy = self._run_fast_search(
            resolved_root, sanitized, max_results, case_sensitive
        )
        if not content_output:
            content_output = self._manual_content_search(
                resolved_root, sanitized, max_results, case_sensitive
            )
            if not strategy:
                strategy = "manual"

        used_relaxed = False
        relaxed_pattern = None
        if not content_output:
            relaxed_pattern = self._relax_grep_pattern(sanitized)
            if relaxed_pattern:
                relaxed_output, relaxed_strategy = self._run_fast_search(
                    resolved_root, relaxed_pattern, max_results, case_sensitive
                )
                if not relaxed_output:
                    relaxed_output = self._manual_content_search(
                        resolved_root, relaxed_pattern, max_results, case_sensitive
                    )
                    if not relaxed_strategy:
                        relaxed_strategy = "manual"
                if relaxed_output:
                    content_output = relaxed_output
                    strategy = f"{relaxed_strategy or 'manual'}-relaxed"
                    used_relaxed = True

        if content_output:
            output = content_output
        else:
            output = f"No matches for '{sanitized}' in {resolved_root}"

        if len(output) > self.config.max_output_length:
            output = output[:self.config.max_output_length] + "\n...[truncated]"

        return ToolResult(
            status=ToolStatus.SUCCESS,
            output=output,
            metadata={
                "path": resolved_root,
                "pattern": sanitized,
                "strategy": strategy or "manual",
                "matches": bool(content_output),
                **(
                    {"pattern_used": relaxed_pattern, "pattern_relaxed_from": sanitized}
                    if used_relaxed and relaxed_pattern
                    else {}
                )
            }
        )

    def _search_filesystem(
        self,
        pattern: str,
        path: Optional[str] = None,
        max_results: int = 20,
        case_sensitive: bool = False
    ) -> ToolResult:
        """
        Search the workspace for file names or contents matching the given pattern.

        Search is anchored to the repository root (git root if available, else cwd).
        Automatically excludes:
        - Directories: __pycache__, .venv, venv, site-packages, dist, build, .git,
                       .mypy_cache, .pytest_cache, node_modules, etc.
        - File types: .pyc, .pyo, .so, .o, .dll, .exe, .class, etc.
        - Symlinks pointing outside the repository root
        """
        sanitized = self._sanitize_search_pattern(pattern)
        if not sanitized:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error="Empty or invalid search pattern"
            )

        max_results = max(1, min(max_results, 200))

        # Anchor search to repo root for safety
        if path:
            search_root = self._resolve_path(path)
        else:
            # Use git repo root if available, else working directory
            search_root = self._get_repo_root()

        if not os.path.isdir(search_root):
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Search path does not exist or is not a directory: {search_root}"
            )

        filename_matches = self._match_filenames(search_root, sanitized, max_results)
        content_output, strategy = self._run_fast_search(search_root, sanitized, max_results, case_sensitive)
        if not content_output:
            content_output = self._manual_content_search(search_root, sanitized, max_results, case_sensitive)
            if not strategy:
                strategy = "manual"

        sections = []
        if filename_matches:
            sections.append("Matching filenames:\n" + "\n".join(filename_matches))
        if content_output:
            sections.append("Content matches:\n" + content_output)
        else:
            sections.append(f"No content matches for '{sanitized}' in {search_root}")

        output = "\n\n".join(sections)
        if len(output) > self.config.max_output_length:
            output = output[:self.config.max_output_length] + "\n...[truncated]"

        metadata = {
            "path": search_root,
            "pattern": sanitized,
            "strategy": strategy or "manual",
            "content_matches": bool(content_output)
        }
        if filename_matches:
            metadata["filename_matches"] = len(filename_matches)

        return ToolResult(
            status=ToolStatus.SUCCESS,
            output=output,
            metadata=metadata
        )

    def _get_working_directory(self) -> ToolResult:
        """Get the current working directory"""
        try:
            cwd = self._get_current_working_dir()
            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=cwd,
                metadata={"path": cwd}
            )
        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Failed to get working directory: {str(e)}"
            )

    def _list_files(
        self,
        path: str = ".",
        include_hidden: bool = False,
        recursive: bool = False,
        max_depth: int = 3
    ) -> ToolResult:
        """List files and directories"""
        try:
            resolved_path = self._resolve_path(path)

            if not os.path.exists(resolved_path):
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error=f"Path does not exist: {resolved_path}"
                )

            if not os.path.isdir(resolved_path):
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error=f"Path is not a directory: {resolved_path}"
                )

            entries = []

            if recursive:
                for root, dirs, files in os.walk(resolved_path):
                    # Calculate current depth
                    depth = root[len(resolved_path):].count(os.sep)
                    if depth >= max_depth:
                        dirs[:] = []  # Don't recurse deeper
                        continue

                    # Filter hidden files/dirs if needed
                    if not include_hidden:
                        dirs[:] = [d for d in dirs if not d.startswith('.')]
                        files = [f for f in files if not f.startswith('.')]

                    for d in dirs:
                        dir_path = os.path.join(root, d)
                        rel_path = os.path.relpath(dir_path, resolved_path)
                        entries.append(f"{rel_path}/ [DIR]")

                    for f in files:
                        file_path = os.path.join(root, f)
                        rel_path = os.path.relpath(file_path, resolved_path)
                        try:
                            size = os.path.getsize(file_path)
                            entries.append(f"{rel_path} ({self._format_size(size)})")
                        except OSError:
                            entries.append(f"{rel_path} [ERROR]")
            else:
                # Non-recursive listing
                items = os.listdir(resolved_path)

                if not include_hidden:
                    items = [item for item in items if not item.startswith('.')]

                # Sort: directories first, then files
                dirs = []
                files = []

                for item in sorted(items):
                    item_path = os.path.join(resolved_path, item)
                    if os.path.isdir(item_path):
                        dirs.append(f"{item}/ [DIR]")
                    else:
                        try:
                            size = os.path.getsize(item_path)
                            files.append(f"{item} ({self._format_size(size)})")
                        except OSError:
                            files.append(f"{item} [ERROR]")

                entries = dirs + files

            if not entries:
                output = f"Directory is empty: {resolved_path}"
            else:
                output = f"Contents of {resolved_path}:\n" + "\n".join(entries)

            # Truncate if too long
            if len(output) > self.config.max_output_length:
                output = output[:self.config.max_output_length] + "\n...[truncated]"

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=output,
                metadata={
                    "path": resolved_path,
                    "count": len(entries),
                    "recursive": recursive
                }
            )

        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Failed to list files: {str(e)}"
            )

    def _format_size(self, bytes: int) -> str:
        """Format file size in human-readable format"""
        for unit in ['B', 'KB', 'MB', 'GB']:
            if bytes < 1024.0:
                return f"{bytes:.1f}{unit}"
            bytes /= 1024.0
        return f"{bytes:.1f}TB"

    # ========== NANO BANANA IMAGE GENERATION ==========

    def _generate_image(
        self,
        prompt: str,
        output_path: Optional[str] = None,
        _skip_prompt_engineering: bool = False,
        style: Optional[str] = None,
        width: Optional[Union[int, str]] = None,
        height: Optional[Union[int, str]] = None,
        callback: Optional[Callable[[ImageGenerationResult], Any]] = None,
        **extra_kwargs
    ) -> ToolResult:
        """
        Generate an image using Gemini's Nano Banana API.

        Args:
            prompt: User's image request (can be natural language)
            output_path: Optional explicit output path (overrides extraction)
            skip_prompt_engineering: If True, use prompt as-is
            callback: Optional custom callback (default returns file path)

        Returns:
            ToolResult with status and file path output
        """
        start_time = time.time()
        original_prompt = prompt

        def _coerce_int(value: Optional[Union[int, str]]) -> Optional[int]:
            if value is None:
                return None
            try:
                return int(value)
            except (TypeError, ValueError):
                return None

        width_hint = _coerce_int(width)
        height_hint = _coerce_int(height)

        # Blend style/size hints into the prompt so the backend can consider them even if not first-class params
        prompt_suffix_parts = []
        if style:
            prompt_suffix_parts.append(f"Style: {style}")
        if width_hint and height_hint:
            prompt_suffix_parts.append(f"Preferred size: {width_hint}x{height_hint}")
        elif width_hint or height_hint:
            size_hint = width_hint or height_hint
            prompt_suffix_parts.append(f"Preferred size: {size_hint}px")
        if prompt_suffix_parts:
            prompt = f"{prompt.rstrip()}\n" + "\n".join(prompt_suffix_parts)

        # Get Nano Banana config
        nano_config = getattr(self, '_nano_banana_config', None) or NanoBananaConfig()

        # Check if API key is available
        if not nano_config.api_key:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error="No Gemini API key configured. Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable."
            )

        try:
            # Step 1: Direct prompt pass-through (embellish in the calling LLM, not here)
            enhanced_prompt = prompt
            # Generate default path if not provided
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = nano_config.default_filename_pattern.format(timestamp=timestamp)
            resolved_path = output_path or os.path.join(
                nano_config.default_output_dir, filename
            )

            # Step 2: Resolve path against working directory
            if resolved_path and not os.path.isabs(resolved_path):
                resolved_path = self._resolve_path(resolved_path)

            # Step 3: Call Gemini async API
            client = GeminiImageClient(
                api_key=nano_config.api_key,
                api_base=nano_config.api_base,
                model=nano_config.model,
                timeout=nano_config.timeout,
                max_retries=nano_config.max_retries,
                logger=self.logger
            )

            # Run async in sync context
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                image_result = loop.run_until_complete(
                    client.generate_image(
                        prompt=enhanced_prompt,
                        output_path=resolved_path,
                        callback=callback
                    )
                )
            finally:
                loop.run_until_complete(client.close())
                loop.close()

            # Step 4: Process result through default callback
            duration_ms = (time.time() - start_time) * 1000

            if image_result.success:
                output_message = default_image_callback(image_result)

                self.logger.info(
                    f"Image generated successfully: {image_result.file_path}",
                    component="nano_banana"
                )

                return ToolResult(
                    status=ToolStatus.SUCCESS,
                    output=output_message,
                    duration_ms=duration_ms,
                    metadata={
                        "file_path": image_result.file_path,
                        "original_prompt": original_prompt,
                        "applied_prompt": prompt,
                        "enhanced_prompt": enhanced_prompt,
                        "model": nano_config.model,
                        "size_bytes": image_result.metadata.get("size_bytes") if image_result.metadata else None,
                        "thought_text": image_result.thought_text,
                        "style": style,
                        "width": width_hint,
                        "height": height_hint,
                        "extra_kwargs": extra_kwargs or None
                    }
                )
            else:
                self.logger.warning(
                    f"Image generation failed: {image_result.error}",
                    component="nano_banana"
                )
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error=image_result.error,
                    duration_ms=duration_ms,
                    metadata={
                        "original_prompt": original_prompt,
                        "applied_prompt": prompt,
                        "enhanced_prompt": enhanced_prompt,
                        "style": style,
                        "width": width_hint,
                        "height": height_hint,
                        "extra_kwargs": extra_kwargs or None
                    }
                )

        except ImportError as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Missing dependency: {str(e)}. Install with: pip install aiohttp",
                duration_ms=(time.time() - start_time) * 1000
            )
        except Exception as e:
            tb = traceback.format_exc()
            self.logger.error(
                "Image generation error",
                error=e,
                component="nano_banana",
                data={
                    "prompt": prompt[:120],
                    "output_path": locals().get("resolved_path") or output_path,
                    "traceback": tb[:4000] if tb else None
                }
            )
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
                metadata={
                    "original_prompt": original_prompt,
                    "applied_prompt": prompt,
                    "enhanced_prompt": locals().get("enhanced_prompt"),
                    "style": style,
                    "width": width_hint,
                    "height": height_hint,
                    "extra_kwargs": extra_kwargs or None,
                    "traceback": tb
                }
            )

    # ========== GRAPHD TOOL EXECUTORS ==========

    def _graphd_health(self) -> ToolResult:
        if not self._graphd_client:
            return ToolResult(status=ToolStatus.ERROR, output=None, error="Graphd client not configured")
        return ToolResult(status=ToolStatus.SUCCESS, output=self._graphd_client.health())

    def _graphd_symbol(self, path: str, line: int) -> ToolResult:
        if not self._graphd_client:
            return ToolResult(status=ToolStatus.ERROR, output=None, error="Graphd client not configured")
        return ToolResult(status=ToolStatus.SUCCESS, output=self._graphd_client.symbol(path, line))

    def _graphd_context(self, symbol_id: str, depth: int = 1) -> ToolResult:
        if not self._graphd_client:
            return ToolResult(status=ToolStatus.ERROR, output=None, error="Graphd client not configured")
        return ToolResult(status=ToolStatus.SUCCESS, output=self._graphd_client.context(symbol_id, depth))

    def _graphd_impact(
        self,
        entity_type: str,
        change_type: str,
        path: Optional[str] = None,
        symbol_id: Optional[str] = None,
        line: Optional[int] = None,
        diff_summary: Optional[str] = None,
        budget: int = 20
    ) -> ToolResult:
        if not self._graphd_client:
            return ToolResult(status=ToolStatus.ERROR, output=None, error="Graphd client not configured")
        payload = {
            "entity": {
                "type": entity_type,
                "path": path,
                "symbol_id": symbol_id,
                "line": line,
            },
            "change_type": change_type,
            "diff_summary": diff_summary,
            "budget": budget,
        }
        return ToolResult(status=ToolStatus.SUCCESS, output=self._graphd_client.impact(payload))

    def _graphd_search(self, pattern: str, path: Optional[str] = None, max_results: int = 50) -> ToolResult:
        if not self._graphd_client:
            return ToolResult(status=ToolStatus.ERROR, output=None, error="Graphd client not configured")
        payload = {"pattern": pattern, "path": path, "max_results": max_results}
        return ToolResult(status=ToolStatus.SUCCESS, output=self._graphd_client.search(payload))

    def _graphd_export(self, table: str, format: str = "jsonl") -> ToolResult:
        if not self._graphd_client:
            return ToolResult(status=ToolStatus.ERROR, output=None, error="Graphd client not configured")
        return ToolResult(status=ToolStatus.SUCCESS, output=self._graphd_client.export(table, format))


# Decorator for easy tool registration
def tool(
    name: str,
    description: str,
    parameters: Dict[str, Any],
    required: List[str] = None,
    timeout: int = 30
):
    """Decorator to register a function as a tool"""
    def decorator(func: Callable) -> Tool:
        def executor(**kwargs) -> ToolResult:
            try:
                result = func(**kwargs)
                if isinstance(result, ToolResult):
                    return result
                return ToolResult(
                    status=ToolStatus.SUCCESS,
                    output=result
                )
            except Exception as e:
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error=str(e)
                )

        return Tool(
            name=name,
            description=description,
            parameters=parameters,
            required_params=required or [],
            executor=executor,
            timeout=timeout
        )
    return decorator
