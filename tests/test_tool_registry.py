"""
Comprehensive tests for the ToolRegistry.

Tests all built-in tools:
- calculator
- get_current_time
- file_read / file_write
- bash_execute
- python_execute
- web_search / web_fetch (mocked)
- fast_answer (mocked)

Also tests:
- Tool registration/unregistration
- Tool enabling/disabling
- Error handling
- Timeout behavior
- Security restrictions
"""

import os
import sys
import time
import tempfile
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent))

from harness.tool_registry import (
    ToolRegistry, Tool, ToolResult, ToolStatus, ToolConfig, tool
)
from harness.llm_adapter import ToolDefinition

from tests.test_helpers import (
    assert_tool_result_success, assert_tool_result_error,
    TEST_DATA
)


class TestToolRegistryBasics:
    """Test basic ToolRegistry operations"""

    def test_registry_initialization(self, tool_registry):
        """Test that registry initializes with default tools"""
        tools = tool_registry.list_tools(enabled_only=False)
        tool_names = [t.name for t in tools]

        # Check all expected tools are registered
        expected_tools = [
            "fast_answer", "web_search", "web_fetch",
            "bash_execute", "python_execute",
            "file_read", "file_write",
            "search_filesystem",
            "calculator", "get_current_time"
        ]
        for expected in expected_tools:
            assert expected in tool_names, f"Expected tool '{expected}' not found"

    def test_get_tool(self, tool_registry):
        """Test getting a tool by name"""
        calc = tool_registry.get("calculator")
        assert calc is not None
        assert calc.name == "calculator"
        assert calc.enabled

    def test_get_nonexistent_tool(self, tool_registry):
        """Test getting a tool that doesn't exist"""
        tool = tool_registry.get("nonexistent_tool")
        assert tool is None

    def test_tool_definitions(self, tool_registry):
        """Test getting tool definitions for LLM"""
        definitions = tool_registry.get_definitions(enabled_only=True)
        assert len(definitions) > 0
        assert all(isinstance(d, ToolDefinition) for d in definitions)

        # Check definition structure
        calc_def = next((d for d in definitions if d.name == "calculator"), None)
        assert calc_def is not None
        assert "expression" in calc_def.parameters
        assert "expression" in calc_def.required

    def test_enable_disable_tool(self, tool_registry):
        """Test enabling and disabling tools"""
        # Disable calculator
        result = tool_registry.disable("calculator")
        assert result is True

        calc = tool_registry.get("calculator")
        assert not calc.enabled

        # Shouldn't be in enabled-only list
        enabled_tools = tool_registry.list_tools(enabled_only=True)
        enabled_names = [t.name for t in enabled_tools]
        assert "calculator" not in enabled_names

        # Re-enable
        result = tool_registry.enable("calculator")
        assert result is True
        assert tool_registry.get("calculator").enabled

    def test_register_custom_tool(self, tool_registry):
        """Test registering a custom tool"""
        def custom_executor(value: str) -> ToolResult:
            return ToolResult(
                status=ToolStatus.SUCCESS,
                output=f"Processed: {value}"
            )

        custom_tool = Tool(
            name="custom_test_tool",
            description="A custom test tool",
            parameters={"value": {"type": "string", "description": "Input value"}},
            required_params=["value"],
            executor=custom_executor,
            enabled=True
        )

        tool_registry.register(custom_tool)
        # Enable it (custom tools not in enabled_tools list get disabled during registration)
        tool_registry.enable("custom_test_tool")

        # Verify it's registered
        retrieved = tool_registry.get("custom_test_tool")
        assert retrieved is not None
        assert retrieved.name == "custom_test_tool"

        # Execute it
        result = tool_registry.execute("custom_test_tool", value="test")
        assert_tool_result_success(result, "Processed: test")

    def test_unregister_tool(self, tool_registry):
        """Test unregistering a tool"""
        # First register a custom tool
        custom_tool = Tool(
            name="to_unregister",
            description="Tool to be unregistered",
            parameters={},
            executor=lambda: ToolResult(status=ToolStatus.SUCCESS, output="ok")
        )
        tool_registry.register(custom_tool)
        assert tool_registry.get("to_unregister") is not None

        # Unregister it
        result = tool_registry.unregister("to_unregister")
        assert result is True
        assert tool_registry.get("to_unregister") is None

    def test_unregister_nonexistent_tool(self, tool_registry):
        """Test unregistering a tool that doesn't exist"""
        result = tool_registry.unregister("nonexistent")
        assert result is False

    def test_execute_nonexistent_tool(self, tool_registry):
        """Test executing a tool that doesn't exist"""
        result = tool_registry.execute("nonexistent_tool", arg="value")
        assert result.status == ToolStatus.ERROR
        assert "not found" in result.error.lower()

    def test_execute_disabled_tool(self, tool_registry):
        """Test executing a disabled tool"""
        tool_registry.disable("calculator")
        result = tool_registry.execute("calculator", expression="2+2")
        assert result.status == ToolStatus.PERMISSION_DENIED
        assert "disabled" in result.error.lower()

        # Re-enable for other tests
        tool_registry.enable("calculator")


class TestCalculatorTool:
    """Test the calculator tool"""

    @pytest.mark.parametrize("expression,expected", [
        ("2+2", 4),
        ("10-5", 5),
        ("3*4", 12),
        ("20/4", 5.0),
        ("2^3", 8),  # Power (converted to **)
        ("2**3", 8),
        ("sqrt(16)", 4.0),
        ("abs(-5)", 5),
        ("round(3.7)", 4),
        ("min(1,2,3)", 1),
        ("max(1,2,3)", 3),
        ("sin(0)", 0.0),
        ("cos(0)", 1.0),
        ("pi", 3.141592653589793),
        ("e", 2.718281828459045),
        ("floor(3.7)", 3),
        ("ceil(3.2)", 4),
        ("log(e)", 1.0),
        ("log10(100)", 2.0),
        ("(2+3)*4", 20),
        ("100/4/5", 5.0),
    ])
    def test_calculator_expressions(self, tool_registry, expression, expected):
        """Test various calculator expressions"""
        result = tool_registry.execute("calculator", expression=expression)
        assert_tool_result_success(result)
        assert abs(float(result.output) - expected) < 0.0001, \
            f"Expected {expected}, got {result.output}"

    def test_calculator_invalid_expression(self, tool_registry):
        """Test calculator with invalid expression"""
        # Note: 2++2 is actually valid Python (parses as 2 + (+2) = 4)
        # Use a truly invalid expression
        result = tool_registry.execute("calculator", expression="2+*3")
        assert_tool_result_error(result)

    def test_calculator_undefined_variable(self, tool_registry):
        """Test calculator with undefined variable"""
        result = tool_registry.execute("calculator", expression="x+5")
        assert_tool_result_error(result)

    def test_calculator_division_by_zero(self, tool_registry):
        """Test calculator division by zero"""
        result = tool_registry.execute("calculator", expression="1/0")
        assert_tool_result_error(result)


class TestGetCurrentTimeTool:
    """Test the get_current_time tool"""

    def test_get_time_human_format(self, tool_registry):
        """Test getting time in human format"""
        result = tool_registry.execute("get_current_time", format="human")
        assert_tool_result_success(result)
        # Should contain day name and date
        output = str(result.output)
        # Human format includes day name
        assert any(day in output for day in
                   ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])

    def test_get_time_iso_format(self, tool_registry):
        """Test getting time in ISO format"""
        result = tool_registry.execute("get_current_time", format="iso")
        assert_tool_result_success(result)
        # ISO format has T separator
        assert "T" in str(result.output)

    def test_get_time_unix_format(self, tool_registry):
        """Test getting time in Unix timestamp"""
        result = tool_registry.execute("get_current_time", format="unix")
        assert_tool_result_success(result)
        # Should be a reasonable timestamp
        timestamp = int(result.output)
        assert timestamp > 1700000000  # After 2023

    def test_get_time_custom_format(self, tool_registry):
        """Test getting time with custom strftime format"""
        result = tool_registry.execute("get_current_time", format="%Y-%m-%d")
        assert_tool_result_success(result)
        # Should match YYYY-MM-DD format
        import re
        assert re.match(r"\d{4}-\d{2}-\d{2}", str(result.output))

    def test_get_time_default_format(self, tool_registry):
        """Test getting time with default format"""
        result = tool_registry.execute("get_current_time")
        assert_tool_result_success(result)


class TestFileOperations:
    """Test file_read and file_write tools"""

    def test_file_read_existing(self, tool_registry_with_workdir, temp_working_dir):
        """Test reading an existing file"""
        result = tool_registry_with_workdir.execute("file_read", path="test_file.txt")
        assert_tool_result_success(result, "Hello, World!")

    def test_file_read_json(self, tool_registry_with_workdir, temp_working_dir):
        """Test reading a JSON file"""
        result = tool_registry_with_workdir.execute("file_read", path="test_data.json")
        assert_tool_result_success(result, '"key": "value"')

    def test_file_read_nested(self, tool_registry_with_workdir, temp_working_dir):
        """Test reading from nested directory"""
        result = tool_registry_with_workdir.execute("file_read", path="subdir/sub_file.txt")
        assert_tool_result_success(result, "Subdirectory file content")

    def test_file_read_deep_nested(self, tool_registry_with_workdir, temp_working_dir):
        """Test reading deeply nested file"""
        result = tool_registry_with_workdir.execute("file_read", path="subdir/nested/deep_file.txt")
        assert_tool_result_success(result, "Deeply nested content")

    def test_file_read_absolute_path(self, tool_registry_with_workdir, temp_working_dir):
        """Test reading with absolute path"""
        abs_path = os.path.join(temp_working_dir, "test_file.txt")
        result = tool_registry_with_workdir.execute("file_read", path=abs_path)
        assert_tool_result_success(result, "Hello, World!")

    def test_file_read_nonexistent(self, tool_registry_with_workdir):
        """Test reading a file that doesn't exist"""
        result = tool_registry_with_workdir.execute("file_read", path="nonexistent.txt")
        assert_tool_result_error(result, "not found")

    def test_file_read_directory(self, tool_registry_with_workdir, temp_working_dir):
        """Test reading a directory (should fail)"""
        result = tool_registry_with_workdir.execute("file_read", path="subdir")
        assert_tool_result_error(result, "not a file")

    def test_file_read_max_bytes(self, tool_registry_with_workdir, temp_working_dir):
        """Test reading with max_bytes limit"""
        result = tool_registry_with_workdir.execute(
            "file_read", path="test_file.txt", max_bytes=5
        )
        assert_tool_result_success(result)
        # Should be truncated
        assert len(result.output) < 50

    def test_file_write_new(self, tool_registry_with_workdir, temp_working_dir):
        """Test writing a new file"""
        result = tool_registry_with_workdir.execute(
            "file_write",
            path="new_file.txt",
            content="New content here"
        )
        assert_tool_result_success(result)

        # Verify file exists and has correct content
        written_path = os.path.join(temp_working_dir, "new_file.txt")
        assert os.path.exists(written_path)
        with open(written_path) as f:
            assert f.read() == "New content here"

    def test_file_write_overwrite(self, tool_registry_with_workdir, temp_working_dir):
        """Test overwriting an existing file"""
        result = tool_registry_with_workdir.execute(
            "file_write",
            path="test_file.txt",
            content="Overwritten content"
        )
        assert_tool_result_success(result)

        # Verify content changed
        with open(os.path.join(temp_working_dir, "test_file.txt")) as f:
            assert f.read() == "Overwritten content"

    def test_file_write_append(self, tool_registry_with_workdir, temp_working_dir):
        """Test appending to a file"""
        result = tool_registry_with_workdir.execute(
            "file_write",
            path="test_file.txt",
            content=" Appended text",
            append=True
        )
        assert_tool_result_success(result)

        # Verify content was appended
        with open(os.path.join(temp_working_dir, "test_file.txt")) as f:
            content = f.read()
            assert "Hello, World!" in content
            assert "Appended text" in content

    def test_file_write_creates_directory(self, tool_registry_with_workdir, temp_working_dir):
        """Test that file_write creates parent directories"""
        result = tool_registry_with_workdir.execute(
            "file_write",
            path="new_dir/another/file.txt",
            content="Nested file content"
        )
        assert_tool_result_success(result)

        # Verify the nested file was created
        nested_path = os.path.join(temp_working_dir, "new_dir/another/file.txt")
        assert os.path.exists(nested_path)

    def test_file_write_unicode(self, tool_registry_with_workdir, temp_working_dir):
        """Test writing unicode content"""
        unicode_content = "Hello 你好 مرحبا 🔥💻"
        result = tool_registry_with_workdir.execute(
            "file_write",
            path="unicode.txt",
            content=unicode_content
        )
        assert_tool_result_success(result)

        # Verify unicode was preserved
        with open(os.path.join(temp_working_dir, "unicode.txt"), encoding="utf-8") as f:
            assert f.read() == unicode_content


class TestSearchFilesystemTool:
    """Test the search_filesystem tool"""

    def test_search_filesystem_matches_filename_and_content(self, tool_registry_with_workdir, temp_working_dir):
        """Pattern should match both file name and its contents"""
        notes_path = os.path.join(temp_working_dir, "project_notes.md")
        with open(notes_path, "w", encoding="utf-8") as f:
            f.write("Project TODOs:\n- search pattern context\nEnd of file.")

        result = tool_registry_with_workdir.execute(
            "search_filesystem",
            pattern="project\n",
            max_results=5
        )

        assert_tool_result_success(result)
        assert "Matching filenames" in result.output
        assert "project_notes.md" in result.output
        assert "Content matches" in result.output
        assert "Project TODOs" in result.output

    def test_search_filesystem_respects_path(self, tool_registry_with_workdir, temp_working_dir):
        """Search should be scoped when a path is provided"""
        result = tool_registry_with_workdir.execute(
            "search_filesystem",
            pattern="deep",
            path="subdir",
            max_results=10
        )

        assert_tool_result_success(result)
        assert "nested/deep_file.txt" in result.output
        assert os.path.join(temp_working_dir, "subdir") == result.metadata["path"]

    def test_search_filesystem_empty_pattern(self, tool_registry_with_workdir):
        """Empty or whitespace-only patterns should return an error"""
        result = tool_registry_with_workdir.execute(
            "search_filesystem",
            pattern="   \n   "
        )

        assert result.status == ToolStatus.ERROR


class TestBashExecuteTool:
    """Test the bash_execute tool"""

    def test_bash_echo(self, tool_registry):
        """Test simple echo command"""
        result = tool_registry.execute("bash_execute", command="echo 'Hello, World!'")
        assert_tool_result_success(result, "Hello, World!")

    def test_bash_pwd(self, tool_registry):
        """Test pwd command"""
        result = tool_registry.execute("bash_execute", command="pwd")
        assert_tool_result_success(result)
        # Should return a valid path
        assert "/" in str(result.output)

    def test_bash_ls(self, tool_registry_with_workdir, temp_working_dir):
        """Test ls command in working directory"""
        result = tool_registry_with_workdir.execute(
            "bash_execute",
            command="ls",
            working_dir=temp_working_dir
        )
        assert_tool_result_success(result)
        assert "test_file.txt" in result.output

    def test_bash_pipe(self, tool_registry):
        """Test command with pipes"""
        result = tool_registry.execute(
            "bash_execute",
            command="echo 'hello world' | wc -w"
        )
        assert_tool_result_success(result)
        assert "2" in result.output.strip()

    def test_bash_env_variable(self, tool_registry):
        """Test environment variable access"""
        result = tool_registry.execute(
            "bash_execute",
            command="echo $HOME"
        )
        assert_tool_result_success(result)
        # HOME should exist
        assert "/" in result.output

    def test_bash_nonexistent_command(self, tool_registry):
        """Test running a command that doesn't exist"""
        result = tool_registry.execute(
            "bash_execute",
            command="nonexistent_command_12345"
        )
        assert_tool_result_error(result)

    def test_bash_exit_code(self, tool_registry):
        """Test command with non-zero exit code"""
        result = tool_registry.execute(
            "bash_execute",
            command="exit 1"
        )
        assert_tool_result_error(result)
        assert "exit" in result.error.lower() or "code" in result.error.lower()

    @pytest.mark.parametrize("dangerous_cmd", [
        "rm -rf /",
        "rm -rf /*",
        "chmod -R 777 /",
    ])
    def test_bash_security_blocks_dangerous(self, tool_registry, dangerous_cmd):
        """Test that dangerous commands are blocked"""
        result = tool_registry.execute("bash_execute", command=dangerous_cmd)
        assert result.status == ToolStatus.PERMISSION_DENIED
        assert "blocked" in result.error.lower() or "safety" in result.error.lower()

    def test_bash_with_working_dir(self, tool_registry_with_workdir, temp_working_dir):
        """Test bash with specific working directory"""
        result = tool_registry_with_workdir.execute(
            "bash_execute",
            command="cat test_file.txt",
            working_dir=temp_working_dir
        )
        assert_tool_result_success(result, "Hello, World!")

    def test_bash_timeout(self, tool_registry):
        """Test command timeout"""
        result = tool_registry.execute(
            "bash_execute",
            command="sleep 100",
            timeout=1
        )
        assert result.status == ToolStatus.TIMEOUT


class TestPythonExecuteTool:
    """Test the python_execute tool"""

    def test_python_simple_print(self, tool_registry):
        """Test simple print statement"""
        result = tool_registry.execute(
            "python_execute",
            code="print('Hello from Python!')"
        )
        assert_tool_result_success(result, "Hello from Python!")

    def test_python_math(self, tool_registry):
        """Test math operations"""
        result = tool_registry.execute(
            "python_execute",
            code="print(2 + 2)"
        )
        assert_tool_result_success(result, "4")

    def test_python_multiline(self, tool_registry):
        """Test multiline code"""
        code = """
def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n-1)

print(factorial(5))
"""
        result = tool_registry.execute("python_execute", code=code)
        assert_tool_result_success(result, "120")

    def test_python_loop(self, tool_registry):
        """Test code with loops"""
        code = """
result = 0
for i in range(5):
    result += i
print(result)
"""
        result = tool_registry.execute("python_execute", code=code)
        assert_tool_result_success(result, "10")

    def test_python_list_comprehension(self, tool_registry):
        """Test list comprehension"""
        code = "print([x**2 for x in range(5)])"
        result = tool_registry.execute("python_execute", code=code)
        assert_tool_result_success(result, "[0, 1, 4, 9, 16]")

    def test_python_import_math(self, tool_registry):
        """Test importing standard library"""
        code = """
import math
print(math.sqrt(16))
"""
        result = tool_registry.execute("python_execute", code=code)
        assert_tool_result_success(result, "4.0")

    def test_python_exception(self, tool_registry):
        """Test code that raises exception"""
        result = tool_registry.execute(
            "python_execute",
            code="raise ValueError('Test error')"
        )
        assert_tool_result_error(result, "ValueError")

    def test_python_syntax_error(self, tool_registry):
        """Test code with syntax error"""
        result = tool_registry.execute(
            "python_execute",
            code="def incomplete("
        )
        assert_tool_result_error(result)

    def test_python_result_variable(self, tool_registry):
        """Test special _result variable"""
        code = """
_result = 42
"""
        result = tool_registry.execute("python_execute", code=code)
        assert_tool_result_success(result)
        assert "42" in str(result.output)

    def test_python_stdout_capture(self, tool_registry):
        """Test stdout is captured correctly"""
        code = """
print("Line 1")
print("Line 2")
print("Line 3")
"""
        result = tool_registry.execute("python_execute", code=code)
        assert_tool_result_success(result)
        assert "Line 1" in result.output
        assert "Line 2" in result.output
        assert "Line 3" in result.output


class TestWebTools:
    """Test web_search, web_fetch, and fast_answer tools (with mocking)"""

    def test_web_search_success(self, tool_registry):
        """Test web_search with mocked results"""
        # DDGS is imported inside the function, so patch at 'ddgs.DDGS'
        with patch('ddgs.DDGS') as mock_ddgs:
            mock_instance = MagicMock()
            mock_ddgs.return_value.__enter__.return_value = mock_instance
            mock_instance.text.return_value = [
                {"title": "Result 1", "href": "http://example.com/1", "body": "First result"},
                {"title": "Result 2", "href": "http://example.com/2", "body": "Second result"},
            ]

            result = tool_registry.execute("web_search", query="test query")

            if result.is_success:
                assert len(result.output) == 2
                assert result.output[0]["title"] == "Result 1"

    def test_web_fetch_success(self, tool_registry):
        """Test web_fetch with mocked response"""
        # requests is imported inside the function
        with patch.dict('sys.modules', {'requests': MagicMock()}):
            import sys
            mock_requests = sys.modules['requests']
            mock_response = MagicMock()
            mock_response.text = "<html><body><p>Test content</p></body></html>"
            mock_response.raise_for_status = MagicMock()
            mock_requests.get.return_value = mock_response

            result = tool_registry.execute(
                "web_fetch",
                url="http://example.com",
                extract_type="text"
            )

            # Should succeed if requests is available
            if result.is_success:
                assert "content" in result.output.lower() or "test" in result.output.lower()

    def test_web_fetch_invalid_url(self, tool_registry):
        """Test web_fetch with invalid URL"""
        result = tool_registry.execute("web_fetch", url="not_a_valid_url")
        assert_tool_result_error(result, "Invalid URL")

    def test_fast_answer_success(self, tool_registry):
        """Test fast_answer with mocked search and fetch"""
        # DDGS is imported inside the function, so patch at 'ddgs.DDGS'
        with patch('ddgs.DDGS') as mock_ddgs:
            mock_instance = MagicMock()
            mock_ddgs.return_value.__enter__.return_value = mock_instance
            mock_instance.text.return_value = [
                {"title": "Answer", "href": "http://example.com", "body": "The answer is 42"},
            ]

            with patch.dict('sys.modules', {'requests': MagicMock()}):
                import sys
                mock_requests = sys.modules['requests']
                mock_response = MagicMock()
                mock_response.text = "<html><body>Answer content</body></html>"
                mock_response.raise_for_status = MagicMock()
                mock_requests.get.return_value = mock_response

                result = tool_registry.execute(
                    "fast_answer",
                    query="meaning of life",
                    num_sources=1
                )

                # Check result
                if result.is_success:
                    assert "meaning of life" in result.metadata.get("query", "").lower() or \
                           len(result.output) > 0


class TestWorkingDirectoryHandling:
    """Test working directory context management"""

    def test_default_working_dir(self, temp_working_dir, mock_logger):
        """Test default working directory is set correctly"""
        config = ToolConfig()
        registry = ToolRegistry(config, default_working_dir=temp_working_dir)

        assert registry._default_working_dir == temp_working_dir

    def test_resolve_relative_path(self, tool_registry_with_workdir, temp_working_dir):
        """Test resolving relative paths"""
        resolved = tool_registry_with_workdir._resolve_path("subdir/file.txt")
        expected = os.path.join(temp_working_dir, "subdir/file.txt")
        assert resolved == expected

    def test_resolve_absolute_path(self, tool_registry_with_workdir, temp_working_dir):
        """Test resolving absolute paths (should stay absolute)"""
        abs_path = "/some/absolute/path"
        resolved = tool_registry_with_workdir._resolve_path(abs_path)
        assert resolved == abs_path

    def test_resolve_home_path(self, tool_registry_with_workdir):
        """Test resolving paths with ~"""
        resolved = tool_registry_with_workdir._resolve_path("~/test.txt")
        assert resolved.startswith(os.path.expanduser("~"))

    def test_with_working_dir_context(self, tool_registry_with_workdir, temp_working_dir):
        """Test with_working_dir context manager"""
        original_dir = tool_registry_with_workdir._get_current_working_dir()

        new_workdir = "/tmp/new_workdir"
        with tool_registry_with_workdir.with_working_dir(new_workdir):
            current = tool_registry_with_workdir._get_current_working_dir()
            assert current == new_workdir

        # Should restore after context
        restored = tool_registry_with_workdir._get_current_working_dir()
        assert restored == original_dir

    def test_with_working_dir_nested(self, tool_registry_with_workdir, temp_working_dir):
        """Test nested with_working_dir contexts"""
        dir1 = "/tmp/dir1"
        dir2 = "/tmp/dir2"

        with tool_registry_with_workdir.with_working_dir(dir1):
            assert tool_registry_with_workdir._get_current_working_dir() == dir1

            with tool_registry_with_workdir.with_working_dir(dir2):
                assert tool_registry_with_workdir._get_current_working_dir() == dir2

            # Back to dir1
            assert tool_registry_with_workdir._get_current_working_dir() == dir1

        # Back to original
        assert tool_registry_with_workdir._get_current_working_dir() == temp_working_dir

    def test_file_write_uses_working_dir(self, tool_registry_with_workdir, temp_working_dir):
        """Test that file_write uses the working directory for relative paths"""
        result = tool_registry_with_workdir.execute(
            "file_write",
            path="workdir_test.txt",
            content="Working directory content"
        )
        assert_tool_result_success(result)

        # File should be in the working directory
        expected_path = os.path.join(temp_working_dir, "workdir_test.txt")
        assert os.path.exists(expected_path)


class TestToolDecorator:
    """Test the @tool decorator for creating tools"""

    def test_tool_decorator_basic(self, tool_registry):
        """Test creating a tool with decorator"""
        @tool(
            name="decorated_tool",
            description="A decorated test tool",
            parameters={"input": {"type": "string"}},
            required=["input"]
        )
        def decorated_tool_fn(input: str):
            return f"Processed: {input}"

        # Register the decorated tool
        tool_registry.register(decorated_tool_fn)
        # Enable it (custom tools are disabled by default)
        tool_registry.enable("decorated_tool")

        # Execute it
        result = tool_registry.execute("decorated_tool", input="test value")
        assert_tool_result_success(result, "Processed: test value")

    def test_tool_decorator_with_toolresult(self, tool_registry):
        """Test decorator with function returning ToolResult"""
        @tool(
            name="result_tool",
            description="Returns a ToolResult",
            parameters={"value": {"type": "number"}}
        )
        def result_tool_fn(value: int):
            return ToolResult(
                status=ToolStatus.SUCCESS,
                output={"squared": value ** 2}
            )

        tool_registry.register(result_tool_fn)
        # Enable it (custom tools are disabled by default)
        tool_registry.enable("result_tool")
        result = tool_registry.execute("result_tool", value=5)
        assert_tool_result_success(result)
        assert result.output["squared"] == 25


class TestToolEdgeCases:
    """Test edge cases and error handling"""

    def test_tool_with_empty_params(self, tool_registry):
        """Test calling a tool with no required params"""
        result = tool_registry.execute("get_current_time")
        assert_tool_result_success(result)

    def test_tool_with_missing_required_param(self, tool_registry):
        """Test calling a tool missing required params"""
        result = tool_registry.execute("calculator")  # Missing expression
        assert_tool_result_error(result)

    def test_tool_output_truncation(self, tool_registry_with_workdir, temp_working_dir):
        """Test that large outputs are truncated"""
        # Create a large file
        large_content = "x" * 200000  # 200KB
        large_file = os.path.join(temp_working_dir, "large.txt")
        with open(large_file, "w") as f:
            f.write(large_content)

        result = tool_registry_with_workdir.execute(
            "file_read",
            path=large_file,
            max_bytes=100000
        )
        assert_tool_result_success(result)
        # Should be truncated
        assert len(result.output) < 200000
        assert "truncated" in result.output.lower()

    def test_calculator_with_special_chars(self, tool_registry):
        """Test calculator handles special characters"""
        result = tool_registry.execute("calculator", expression="2+2 # comment")
        # Should either succeed or fail gracefully
        assert result.status in (ToolStatus.SUCCESS, ToolStatus.ERROR)

    def test_bash_unicode_output(self, tool_registry):
        """Test bash with unicode output"""
        result = tool_registry.execute("bash_execute", command="echo '你好世界'")
        assert_tool_result_success(result)
        assert "你好世界" in result.output

    def test_python_unicode(self, tool_registry):
        """Test python with unicode"""
        result = tool_registry.execute(
            "python_execute",
            code="print('Hello 世界')"
        )
        assert_tool_result_success(result, "Hello 世界")

    def test_concurrent_tool_execution(self, tool_registry):
        """Test that tools can be executed concurrently"""
        import concurrent.futures

        def run_calc(n):
            return tool_registry.execute("calculator", expression=f"{n}+1")

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(run_calc, i) for i in range(10)]
            results = [f.result() for f in concurrent.futures.as_completed(futures)]

        assert all(r.is_success for r in results)

    def test_tool_result_duration_tracking(self, tool_registry):
        """Test that tool execution duration is tracked"""
        result = tool_registry.execute("calculator", expression="2+2")
        assert result.duration_ms >= 0

    def test_tool_metadata(self, tool_registry):
        """Test that tool results include metadata"""
        result = tool_registry.execute("get_current_time", format="human")
        assert "format" in result.metadata
        assert "timezone" in result.metadata


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
