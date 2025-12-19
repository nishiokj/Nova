"""
Simple, human-readable logger for eval execution.

Captures exactly what was sent to the LLM and what came back.
No complex data structures, just clean text logs.
"""

from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
import json


class SimpleEvalLogger:
    """
    Simple logger that writes human-readable execution logs.

    Captures:
    1. Exact prompt+context sent to planner
    2. Exact response from planner
    3. Exact prompt+context sent to each substep
    4. Final response

    All formatted with clear separators and newlines for easy reading.
    """

    def __init__(self, log_path: Path):
        self.log_path = Path(log_path)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

        # Clear the file at start
        with open(self.log_path, 'w') as f:
            f.write("=" * 80 + "\n")
            f.write(f"EVAL EXECUTION LOG - {datetime.utcnow().isoformat()}\n")
            f.write("=" * 80 + "\n\n")

    def _write(self, content: str):
        """Append content to log file."""
        with open(self.log_path, 'a') as f:
            f.write(content)
            f.write("\n")

    def _format_messages(self, messages: List[Dict[str, Any]]) -> str:
        """Format messages into readable text."""
        lines = []
        for i, msg in enumerate(messages, 1):
            role = msg.get('role', 'unknown')
            content = msg.get('content', '')

            # Handle multi-part content
            if isinstance(content, list):
                content = self._format_content_parts(content)

            lines.append(f"Message {i} ({role}):")
            lines.append(content)
            lines.append("")

        return "\n".join(lines)

    def _format_content_parts(self, parts: List[Dict]) -> str:
        """Format multi-part content."""
        formatted = []
        for part in parts:
            if part.get('type') == 'text':
                formatted.append(part.get('text', ''))
            elif part.get('type') == 'tool_use':
                formatted.append(f"[TOOL USE: {part.get('name', 'unknown')}]")
                formatted.append(f"Input: {json.dumps(part.get('input', {}), indent=2)}")
            elif part.get('type') == 'tool_result':
                formatted.append(f"[TOOL RESULT: {part.get('tool_use_id', 'unknown')}]")
                formatted.append(str(part.get('content', '')))
            else:
                formatted.append(f"[{part.get('type', 'unknown').upper()}]")

        return "\n".join(formatted)

    def _format_tools(self, tools: List[Dict[str, Any]]) -> str:
        """Format tool definitions into readable text."""
        if not tools:
            return "No tools available"

        lines = []
        for tool in tools:
            name = tool.get('name', 'unknown')
            desc = tool.get('description', 'No description')
            lines.append(f"- {name}: {desc}")

        return "\n".join(lines)

    def log_planning(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        model: str,
        plan_response: str,
        duration_ms: float
    ):
        """Log planning phase."""
        self._write("\n" + "=" * 80)
        self._write("PLANNING PHASE")
        self._write("=" * 80)
        self._write(f"Model: {model}")
        self._write(f"Duration: {duration_ms:.0f}ms")
        self._write("")

        self._write("-" * 80)
        self._write("PROMPT SENT TO PLANNER:")
        self._write("-" * 80)
        self._write(self._format_messages(messages))

        self._write("-" * 80)
        self._write("TOOLS AVAILABLE:")
        self._write("-" * 80)
        self._write(self._format_tools(tools))
        self._write("")

        self._write("-" * 80)
        self._write("PLANNER RESPONSE:")
        self._write("-" * 80)
        self._write(plan_response)
        self._write("")

    def log_execution_step(
        self,
        step_number: int,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        model: str,
        step_response: str,
        duration_ms: float
    ):
        """Log execution step."""
        self._write("\n" + "=" * 80)
        self._write(f"EXECUTION STEP {step_number}")
        self._write("=" * 80)
        self._write(f"Model: {model}")
        self._write(f"Duration: {duration_ms:.0f}ms")
        self._write("")

        self._write("-" * 80)
        self._write(f"PROMPT SENT TO STEP {step_number}:")
        self._write("-" * 80)
        self._write(self._format_messages(messages))

        self._write("-" * 80)
        self._write("TOOLS AVAILABLE:")
        self._write("-" * 80)
        self._write(self._format_tools(tools))
        self._write("")

        self._write("-" * 80)
        self._write(f"STEP {step_number} RESPONSE:")
        self._write("-" * 80)
        self._write(step_response)
        self._write("")

    def log_reflection(
        self,
        messages: List[Dict[str, Any]],
        tools: List[Dict[str, Any]],
        model: str,
        reflection_response: str,
        duration_ms: float
    ):
        """Log reflection phase."""
        self._write("\n" + "=" * 80)
        self._write("REFLECTION PHASE")
        self._write("=" * 80)
        self._write(f"Model: {model}")
        self._write(f"Duration: {duration_ms:.0f}ms")
        self._write("")

        self._write("-" * 80)
        self._write("PROMPT SENT TO REFLECTOR:")
        self._write("-" * 80)
        self._write(self._format_messages(messages))

        self._write("-" * 80)
        self._write("TOOLS AVAILABLE:")
        self._write("-" * 80)
        self._write(self._format_tools(tools))
        self._write("")

        self._write("-" * 80)
        self._write("REFLECTION RESPONSE:")
        self._write("-" * 80)
        self._write(reflection_response)
        self._write("")

    def log_final_response(self, response: str):
        """Log final response."""
        self._write("\n" + "=" * 80)
        self._write("FINAL RESPONSE")
        self._write("=" * 80)
        self._write(response)
        self._write("")
        self._write("=" * 80)
        self._write("END OF EXECUTION LOG")
        self._write("=" * 80)

    def log_error(self, phase: str, error: str):
        """Log error."""
        self._write("\n" + "=" * 80)
        self._write(f"ERROR IN {phase.upper()}")
        self._write("=" * 80)
        self._write(error)
        self._write("")
