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
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Callable, Union
from enum import Enum
import traceback
import signal
import io
from contextlib import redirect_stdout, redirect_stderr

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

    def __init__(self, config: Optional[ToolConfig] = None):
        self.config = config or ToolConfig()
        self.logger = get_logger()
        self._tools: Dict[str, Tool] = {}
        self._lock = threading.Lock()

        # Register built-in tools
        self._register_builtin_tools()

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

        self.logger.tool_call(name, kwargs)
        result = tool.execute(**kwargs)

        if result.is_success:
            self.logger.tool_result(name, result.output, result.duration_ms)
        else:
            self.logger.tool_error(name, Exception(result.error or "Unknown error"), result.duration_ms)

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

    # Tool Executors

    def _web_search(self, query: str, num_results: int = 5) -> ToolResult:
        """Execute web search"""
        try:
            # Try duckduckgo_search first
            try:
                from duckduckgo_search import DDGS
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

            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=working_dir
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
        try:
            # Expand user path
            path = os.path.expanduser(path)

            if not os.path.exists(path):
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error=f"File not found: {path}"
                )

            if not os.path.isfile(path):
                return ToolResult(
                    status=ToolStatus.ERROR,
                    output=None,
                    error=f"Path is not a file: {path}"
                )

            file_size = os.path.getsize(path)
            if file_size > max_bytes:
                with open(path, "r", encoding=encoding) as f:
                    content = f.read(max_bytes)
                content += f"\n...[truncated, file size: {file_size} bytes]"
            else:
                with open(path, "r", encoding=encoding) as f:
                    content = f.read()

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=content,
                metadata={"path": path, "size": file_size}
            )

        except UnicodeDecodeError as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"Failed to decode file with encoding '{encoding}': {str(e)}"
            )
        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"File read failed: {str(e)}"
            )

    def _file_write(self, path: str, content: str, append: bool = False) -> ToolResult:
        """Write content to file"""
        try:
            # Expand user path
            path = os.path.expanduser(path)

            # Create directory if needed
            dir_path = os.path.dirname(path)
            if dir_path and not os.path.exists(dir_path):
                os.makedirs(dir_path)

            mode = "a" if append else "w"
            with open(path, mode, encoding="utf-8") as f:
                f.write(content)

            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=f"Successfully {'appended to' if append else 'wrote'} {path}",
                metadata={"path": path, "bytes_written": len(content), "append": append}
            )

        except Exception as e:
            return ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=f"File write failed: {str(e)}"
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
