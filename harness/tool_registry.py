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
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Callable, Union, Tuple
from enum import Enum
import traceback
import signal
import io
from contextlib import redirect_stdout, redirect_stderr, contextmanager
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeoutError

from .config import ToolConfig
from .logger import get_logger
from .llm_adapter import ToolDefinition


class ToolStatus(Enum):
    """Tool execution status"""
    SUCCESS = "success"
    ERROR = "error"
    TIMEOUT = "timeout"
    PERMISSION_DENIED = "permission_denied"


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

    def __str__(self) -> str:
        if self.is_success:
            return str(self.output)
        return f"Error: {self.error}"


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
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000
            )


class ToolRegistry:
    """
    Registry for tools available to the agent.
    Manages tool registration, execution, and lifecycle.
    """

    def __init__(self, config: Optional[ToolConfig] = None, default_working_dir: Optional[str] = None):
        self.config = config or ToolConfig()
        self.logger = get_logger()
        self._tools: Dict[str, Tool] = {}
        self._lock = threading.Lock()
        self._default_working_dir = os.path.abspath(default_working_dir) if default_working_dir else os.getcwd()
        self._thread_local = threading.local()

        # Register built-in tools
        self._register_builtin_tools()

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

    def _resolve_path(self, path: str) -> str:
        """Resolve a user-provided path against the active working directory"""
        path = os.path.expanduser(path)
        if os.path.isabs(path):
            return os.path.abspath(path)
        base = self._get_current_working_dir()
        return os.path.abspath(os.path.join(base, path))

    def register(self, tool: Tool):
        """Register a tool"""
        with self._lock:
            # Check if tool is in enabled list
            if tool.name not in self.config.enabled_tools:
                tool.enabled = False
            self._tools[tool.name] = tool
            self.logger.debug(f"Registered tool: {tool.name}", component="tools")

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

    def get_definitions(self, enabled_only: bool = True) -> List[ToolDefinition]:
        """Get tool definitions for LLM"""
        return [t.to_definition() for t in self.list_tools(enabled_only)]

    def execute(self, name: str, **kwargs) -> ToolResult:
        """Execute a tool by name"""
        tool = self.get(name)
        if not tool:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Tool '{name}' not found"
            )

        # Note: Logging is handled by agent.py to avoid duplicates
        result = tool.execute(**kwargs)
        return result

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

        # Web Search Tool
        self.register(Tool(
            name="web_search",
            description="Search the web for information. Returns relevant search results with titles, URLs, and snippets.",
            parameters={
                "query": {
                    "type": "string",
                    "description": "The search query"
                },
                "num_results": {
                    "type": "integer",
                    "description": "Number of results to return (default: 5)",
                    "default": 5
                }
            },
            required_params=["query"],
            executor=self._web_search,
            timeout=30
        ))

        # Web Fetch Tool
        self.register(Tool(
            name="web_fetch",
            description="Fetch and extract content from a URL. Returns the main text content of the page.",
            parameters={
                "url": {
                    "type": "string",
                    "description": "The URL to fetch"
                },
                "extract_type": {
                    "type": "string",
                    "enum": ["text", "html", "markdown"],
                    "description": "Type of content to extract",
                    "default": "text"
                }
            },
            required_params=["url"],
            executor=self._web_fetch,
            timeout=60
        ))

        # Bash Execute Tool
        self.register(Tool(
            name="bash_execute",
            description="Execute a bash command and return the output. Use for system operations, file management, or running scripts.",
            parameters={
                "command": {
                    "type": "string",
                    "description": "The bash command to execute"
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds (default: 30)",
                    "default": 30
                },
                "working_dir": {
                    "type": "string",
                    "description": "Working directory for command execution"
                }
            },
            required_params=["command"],
            executor=self._bash_execute,
            timeout=self.config.bash_timeout
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

        # File Read Tool
        self.register(Tool(
            name="file_read",
            description="Read the contents of a file. Returns the file content as text.",
            parameters={
                "path": {
                    "type": "string",
                    "description": "Path to the file to read"
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
            required_params=["path"],
            executor=self._file_read,
            timeout=10
        ))

        # File Write Tool
        self.register(Tool(
            name="file_write",
            description="Write content to a file. Creates the file if it doesn't exist.",
            parameters={
                "path": {
                    "type": "string",
                    "description": "Path to the file to write"
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file"
                },
                "append": {
                    "type": "boolean",
                    "description": "Whether to append to existing content (default: false)",
                    "default": False
                }
            },
            required_params=["path", "content"],
            executor=self._file_write,
            timeout=10
        ))

        # Filesystem Search Tool
        self.register(Tool(
            name="search_filesystem",
            description="Fast filesystem search that looks for file names or contents. Use it to gather context on files in the current workspace.",
            parameters={
                "pattern": {
                    "type": "string",
                    "description": "Pattern to search for within file names or file contents"
                },
                "path": {
                    "type": "string",
                    "description": "Optional relative path to scope the search"
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of matches to return",
                    "default": 20
                },
                "case_sensitive": {
                    "type": "boolean",
                    "description": "Whether the search should respect case",
                    "default": False
                }
            },
            required_params=["pattern"],
            executor=self._search_filesystem,
            timeout=20
        ))

        # Calculator Tool
        self.register(Tool(
            name="calculator",
            description="Perform mathematical calculations. Supports basic arithmetic, functions (sin, cos, sqrt, etc.), and variables.",
            parameters={
                "expression": {
                    "type": "string",
                    "description": "Mathematical expression to evaluate (e.g., '2 + 2', 'sqrt(16)', '3.14 * 2^2')"
                }
            },
            required_params=["expression"],
            executor=self._calculator,
            timeout=5
        ))

        # Get Current Time Tool
        self.register(Tool(
            name="get_current_time",
            description="Get the current date and time in various formats.",
            parameters={
                "format": {
                    "type": "string",
                    "description": "Time format (iso, unix, human, custom strftime format)",
                    "default": "human"
                },
                "timezone": {
                    "type": "string",
                    "description": "Timezone (e.g., 'UTC', 'America/New_York')",
                    "default": "local"
                }
            },
            required_params=[],
            executor=self._get_current_time,
            timeout=5
        ))

        # FAST ANSWER TOOL - Single-hop search with parallel fetch
        # This is THE tool to use for simple questions - returns actual content, not just URLs
        self.register(Tool(
            name="fast_answer",
            description="PREFERRED for simple questions. Searches the web AND fetches content from top results IN PARALLEL. Returns actual answer content, not just URLs. Use this for weather, stock prices, facts, current events.",
            parameters={
                "query": {
                    "type": "string",
                    "description": "The search query (be specific for best results)"
                },
                "num_sources": {
                    "type": "integer",
                    "description": "Number of sources to fetch in parallel (default: 3)",
                    "default": 3
                }
            },
            required_params=["query"],
            executor=self._fast_answer,
            timeout=15  # Fast timeout - we fetch in parallel
        ))

        # Get Working Directory Tool
        self.register(Tool(
            name="get_working_directory",
            description="Get the current working directory path. Use this to understand where you are in the filesystem before performing file operations.",
            parameters={},
            required_params=[],
            executor=self._get_working_directory,
            timeout=5
        ))

        # List Files Tool
        self.register(Tool(
            name="list_files",
            description="List files and directories in a given path. Returns file names, sizes, and types.",
            parameters={
                "path": {
                    "type": "string",
                    "description": "Path to list (defaults to current working directory)",
                    "default": "."
                },
                "include_hidden": {
                    "type": "boolean",
                    "description": "Include hidden files (default: false)",
                    "default": False
                },
                "recursive": {
                    "type": "boolean",
                    "description": "List recursively (default: false)",
                    "default": False
                },
                "max_depth": {
                    "type": "integer",
                    "description": "Maximum depth for recursive listing (default: 3)",
                    "default": 3
                }
            },
            required_params=[],
            executor=self._list_files,
            timeout=10
        ))

    # Tool Executors

    def _web_search(self, query: str, num_results: int = 5) -> ToolResult:
        """Execute web search"""
        try:
            # Try duckduckgo_search first
            try:
                from ddgs import DDGS
                with DDGS() as ddgs:
                    results = list(ddgs.text(query, max_results=num_results))
                    formatted = []
                    for r in results:
                        formatted.append({
                            "title": r.get("title", ""),
                            "url": r.get("href", r.get("link", "")),
                            "snippet": r.get("body", r.get("snippet", ""))
                        })
                    return ToolResult(
                        status=ToolStatus.SUCCESS,
                        output=formatted,
                        metadata={"source": "duckduckgo", "query": query}
                    )
            except ImportError:
                pass

            # Fallback: return error with suggestion
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error="Web search requires 'duckduckgo-search' package. Install with: pip install duckduckgo-search"
            )

        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Search failed: {str(e)}"
            )

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

    def _bash_execute(self, command: str, timeout: int = 30, working_dir: Optional[str] = None) -> ToolResult:
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
            if working_dir:
                resolved_cwd = self._resolve_path(working_dir)
            else:
                resolved_cwd = self._get_current_working_dir()

            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=resolved_cwd
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

    def _file_read(self, path: str, encoding: str = "utf-8", max_bytes: int = 100000) -> ToolResult:
        """Read file contents"""
        resolved_path = self._resolve_path(path)
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

    def _file_write(self, path: str, content: str, append: bool = False) -> ToolResult:
        """Write content to file"""
        resolved_path = self._resolve_path(path)
        try:
            self.logger.file_operation(
                "file_write",
                resolved_path,
                status="starting",
                detail=f"append={append}"
            )

            # Create directory if needed
            dir_path = os.path.dirname(resolved_path)
            if dir_path and not os.path.exists(dir_path):
                self.logger.file_operation("mkdir", dir_path, status="starting")
                os.makedirs(dir_path, exist_ok=True)
                self.logger.file_operation("mkdir", dir_path, status="success")

            mode = "a" if append else "w"
            with open(resolved_path, mode, encoding="utf-8") as f:
                f.write(content)

            self.logger.file_operation(
                "file_write",
                resolved_path,
                status="success",
                detail=f"bytes={len(content)} append={append}"
            )

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=f"Successfully {'appended to' if append else 'wrote'} {resolved_path}",
                metadata={
                    "path": resolved_path,
                    "bytes_written": len(content),
                    "append": append,
                    "action": "append" if append else "write"
                }
            )

        except Exception as e:
            detail = f"File write failed: {str(e)}"
            self.logger.file_operation("file_write", resolved_path, status="failed", detail=detail)
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=detail
            )

    def _calculator(self, expression: str) -> ToolResult:
        """Evaluate mathematical expression"""
        try:
            import math

            # Safe evaluation namespace
            safe_dict = {
                "abs": abs, "round": round, "min": min, "max": max,
                "sum": sum, "pow": pow, "len": len,
                "sin": math.sin, "cos": math.cos, "tan": math.tan,
                "asin": math.asin, "acos": math.acos, "atan": math.atan,
                "sqrt": math.sqrt, "log": math.log, "log10": math.log10,
                "exp": math.exp, "pi": math.pi, "e": math.e,
                "floor": math.floor, "ceil": math.ceil,
                "degrees": math.degrees, "radians": math.radians
            }

            # Replace ^ with ** for power
            expression = expression.replace("^", "**")

            # Evaluate
            result = eval(expression, {"__builtins__": {}}, safe_dict)

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=result,
                metadata={"expression": expression}
            )

        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Calculation failed: {str(e)}"
            )

    def _fast_answer(self, query: str, num_sources: int = 3) -> ToolResult:
        """
        FAST single-hop search: search + parallel fetch in one call.
        Returns actual content, not just URLs.
        """
        try:
            import requests
            from urllib.parse import urlparse

            # Step 1: Search
            search_results = []
            try:
                from ddgs import DDGS
                with DDGS() as ddgs:
                    results = list(ddgs.text(query, max_results=num_sources + 2))  # Get extra in case some fail
                    for r in results[:num_sources + 2]:
                        url = r.get("href", r.get("link", ""))
                        if url:
                            search_results.append({
                                "title": r.get("title", ""),
                                "url": url,
                                "snippet": r.get("body", r.get("snippet", ""))
                            })
            except ImportError:
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error="Web search requires 'duckduckgo-search'. Install: pip install duckduckgo-search"
                )

            if not search_results:
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error=f"No search results found for: {query}"
                )

            # Step 2: Fetch URLs in PARALLEL
            def fetch_url(result: dict) -> dict:
                """Fetch a single URL and extract text content"""
                url = result["url"]
                try:
                    headers = {"User-Agent": "Mozilla/5.0 (compatible; AgentHarness/1.0)"}
                    response = requests.get(url, headers=headers, timeout=5)
                    response.raise_for_status()

                    # Extract text content
                    try:
                        from bs4 import BeautifulSoup
                        soup = BeautifulSoup(response.text, "html.parser")
                        for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
                            tag.decompose()
                        text = soup.get_text(separator=" ", strip=True)
                        # Truncate to reasonable size
                        text = text[:2000] if len(text) > 2000 else text
                    except ImportError:
                        text = response.text[:2000]

                    return {
                        "title": result["title"],
                        "url": url,
                        "content": text,
                        "success": True
                    }
                except Exception as e:
                    return {
                        "title": result["title"],
                        "url": url,
                        "content": result.get("snippet", ""),  # Fall back to snippet
                        "success": False,
                        "error": str(e)
                    }

            # Execute parallel fetches with ThreadPoolExecutor
            fetched_content = []
            with ThreadPoolExecutor(max_workers=min(num_sources, 5)) as executor:
                futures = {executor.submit(fetch_url, r): r for r in search_results[:num_sources]}

                for future in as_completed(futures, timeout=5):
                    try:
                        result = future.result()
                        if result["content"]:  # Only add if we got content
                            fetched_content.append(result)
                    except Exception:
                        pass

            # Step 3: Format combined results
            if not fetched_content:
                # Fall back to snippets if all fetches failed
                output = f"Search results for '{query}':\n\n"
                for r in search_results[:num_sources]:
                    output += f"• {r['title']}: {r['snippet']}\n"
                return ToolResult(
                    status=ToolStatus.SUCCESS,
                    output=output,
                    metadata={"query": query, "sources": len(search_results), "fetched": 0}
                )

            # Build combined output
            output = f"Information about '{query}' from {len(fetched_content)} sources:\n\n"
            for i, item in enumerate(fetched_content, 1):
                output += f"[Source {i}: {item['title']}]\n"
                output += f"{item['content'][:1500]}\n\n"

            # Truncate total if too long
            if len(output) > 6000:
                output = output[:6000] + "\n...[truncated]"

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=output,
                metadata={
                    "query": query,
                    "sources_searched": len(search_results),
                    "sources_fetched": len(fetched_content),
                    "urls": [r["url"] for r in fetched_content]
                }
            )

        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Fast answer failed: {str(e)}"
            )

    def _get_current_time(self, format: str = "human", timezone: str = "local") -> ToolResult:
        """Get current time"""
        try:
            from datetime import datetime
            import time as time_module

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

    def _sanitize_search_pattern(self, pattern: str) -> str:
        """Clean user-provided pattern so it can safely be used for filesystem searches."""
        if not pattern:
            return ""
        cleaned = pattern.strip()
        cleaned = re.sub(r"[\r\n\t]+", " ", cleaned)
        cleaned = re.sub(r"[\"'`]+", "", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned)
        return cleaned

    def _match_filenames(self, root: str, pattern: str, limit: int) -> List[str]:
        """Find files whose names contain the pattern."""
        matches = []
        needle = pattern.lower()
        for dirpath, _, filenames in os.walk(root):
            for fname in filenames:
                if needle in fname.lower():
                    rel_path = os.path.relpath(os.path.join(dirpath, fname), root)
                    matches.append(rel_path)
                    if len(matches) >= limit:
                        return matches
        return matches

    def _run_fast_search(self, root: str, pattern: str, max_results: int, case_sensitive: bool) -> Tuple[str, str]:
        """
        Attempt to run a fast grep-style search using rg/grep.
        Returns (output, strategy) for the first method that succeeds.
        """
        strategies = []
        if shutil.which("rg"):
            cmd = [
                "rg", "--line-number", "--no-heading", "--color", "never",
                "--max-count", str(max_results)
            ]
            if not case_sensitive:
                cmd.append("-i")
            cmd.append(pattern)
            strategies.append(("rg", cmd))
        if shutil.which("grep"):
            cmd = [
                "grep", "-R", "-n", "--binary-files=without-match",
                "-m", str(max_results)
            ]
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
        """Fallback content search that scans files line-by-line."""
        matches = []
        needle = pattern if case_sensitive else pattern.lower()
        for dirpath, _, filenames in os.walk(root):
            for fname in filenames:
                full_path = os.path.join(dirpath, fname)
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

    def _search_filesystem(
        self,
        pattern: str,
        path: Optional[str] = None,
        max_results: int = 20,
        case_sensitive: bool = False
    ) -> ToolResult:
        """Search the workspace for file names or contents matching the given pattern."""
        sanitized = self._sanitize_search_pattern(pattern)
        if not sanitized:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error="Empty or invalid search pattern"
            )

        max_results = max(1, min(max_results, 200))
        search_root = self._resolve_path(path) if path else self._get_current_working_dir()
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
