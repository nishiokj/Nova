"""
Response Synthesis Module.

Handles synthesizing final responses from execution results and streaming them.
Used by both Wizard and Executor for consistent response generation.
"""

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Generator, List, Optional, Protocol, Union

from util.llm_adapter import LLMAdapter


# ========== PROTOCOLS ==========

class StreamCallback(Protocol):
    """Protocol for streaming callbacks."""
    def __call__(self, chunk: str, chunk_index: int, is_final: bool) -> None: ...


# ========== DATA CLASSES ==========

@dataclass
class SynthesisInput:
    """
    Input data for response synthesis.

    Can be constructed from various sources:
    - Wizard outcomes
    - Executor step results
    - Raw tool outputs
    """
    goal: str
    goal_type: str = "task"

    # Collected evidence/outputs
    tool_outputs: List[Dict[str, Any]] = field(default_factory=list)
    step_summaries: List[str] = field(default_factory=list)

    # Optional context
    user_intent: str = ""
    success_criteria: str = ""

    # Partial response (if worker already produced one)
    partial_response: Optional[str] = None

    @classmethod
    def from_tool_outputs(
        cls,
        goal: str,
        outputs: List[Dict[str, Any]],
        goal_type: str = "task"
    ) -> "SynthesisInput":
        """Create from raw tool outputs."""
        return cls(
            goal=goal,
            goal_type=goal_type,
            tool_outputs=outputs
        )

    @classmethod
    def from_step_results(
        cls,
        goal: str,
        results: List[Any],  # StepResult or WorkerOutcome
        goal_type: str = "task"
    ) -> "SynthesisInput":
        """Create from step/worker results."""
        tool_outputs = []
        step_summaries = []
        partial_response = None

        for result in results:
            # Handle various result types
            if hasattr(result, 'tool_calls_made'):
                # StepResult from Executor
                for tc in result.tool_calls_made:
                    if hasattr(tc, 'result') and tc.result.is_success:
                        tool_outputs.append({
                            "tool": tc.tool_name,
                            "output": str(tc.result.output)[:1000]
                        })

            if hasattr(result, 'tool_results'):
                # WorkerOutcome from Wizard
                for name, output in result.tool_results.items():
                    tool_outputs.append({
                        "tool": name,
                        "output": str(output)[:1000]
                    })

            # Capture any final response from steps
            if hasattr(result, 'final_response') and result.final_response:
                if partial_response is None:
                    partial_response = result.final_response
                step_summaries.append(result.final_response[:200])

        return cls(
            goal=goal,
            goal_type=goal_type,
            tool_outputs=tool_outputs,
            step_summaries=step_summaries,
            partial_response=partial_response
        )


@dataclass
class SynthesisResult:
    """Result of response synthesis."""
    content: str
    duration_ms: float = 0.0
    streamed: bool = False
    llm_called: bool = False

    # Metadata
    tool_count: int = 0
    synthesis_method: str = "direct"  # "direct", "llm", "fallback"


# ========== SYNTHESIS PROMPTS ==========

SYNTHESIS_PROMPT_TEMPLATE = """Based on the execution results below, provide a clear, concise answer to the user's request.

User's request: {goal}

{results_section}

Instructions:
- Provide a natural, conversational response that directly answers the user's question
- Do not repeat raw data - summarize and explain the key findings
- Be concise but complete
- If the goal was a task (not a question), confirm what was done
"""

QUESTION_SYNTHESIS_TEMPLATE = """Based on the information gathered, answer this question:

Question: {goal}

{results_section}

Provide a direct, informative answer. Be concise but complete.
"""


# ========== SYNTHESIZER CLASS ==========

class ResponseSynthesizer:
    """
    Synthesizes final responses from execution results.

    Features:
    - Multiple synthesis strategies (direct, LLM, fallback)
    - Streaming support via callback
    - Works with both Wizard and Executor results
    """

    def __init__(
        self,
        llm: Optional[LLMAdapter] = None,
        max_tool_outputs: int = 5,
        max_output_preview: int = 1000
    ):
        """
        Initialize synthesizer.

        Args:
            llm: LLM adapter for intelligent synthesis (optional)
            max_tool_outputs: Max tool outputs to include in synthesis prompt
            max_output_preview: Max chars per tool output in prompt
        """
        self.llm = llm
        self.max_tool_outputs = max_tool_outputs
        self.max_output_preview = max_output_preview

    def synthesize(
        self,
        input_data: SynthesisInput,
        on_stream: Optional[StreamCallback] = None,
        force_llm: bool = False
    ) -> SynthesisResult:
        """
        Synthesize a final response from execution results.

        Args:
            input_data: Synthesis input with goal and collected data
            on_stream: Optional callback for streaming chunks
            force_llm: If True, always use LLM even if partial response exists

        Returns:
            SynthesisResult with final content
        """
        start_time = time.time()

        # Strategy 1: Use partial response if available and good quality
        if not force_llm and input_data.partial_response:
            content = input_data.partial_response
            if self._is_quality_response(content, input_data):
                if on_stream:
                    self._stream_content(content, on_stream)
                return SynthesisResult(
                    content=content,
                    duration_ms=(time.time() - start_time) * 1000,
                    streamed=on_stream is not None,
                    llm_called=False,
                    tool_count=len(input_data.tool_outputs),
                    synthesis_method="direct"
                )

        # Strategy 2: Use LLM for intelligent synthesis
        if self.llm and (force_llm or input_data.tool_outputs):
            try:
                content = self._synthesize_with_llm(input_data, on_stream)
                return SynthesisResult(
                    content=content,
                    duration_ms=(time.time() - start_time) * 1000,
                    streamed=on_stream is not None,
                    llm_called=True,
                    tool_count=len(input_data.tool_outputs),
                    synthesis_method="llm"
                )
            except Exception:
                # Fall through to fallback
                pass

        # Strategy 3: Fallback - concatenate available data
        content = self._fallback_synthesis(input_data)
        if on_stream:
            self._stream_content(content, on_stream)

        return SynthesisResult(
            content=content,
            duration_ms=(time.time() - start_time) * 1000,
            streamed=on_stream is not None,
            llm_called=False,
            tool_count=len(input_data.tool_outputs),
            synthesis_method="fallback"
        )

    def stream_content(
        self,
        content: str,
        callback: StreamCallback,
        chunk_size: int = 50
    ) -> None:
        """
        Stream existing content through callback.

        Useful for streaming a pre-generated response.
        """
        self._stream_content(content, callback, chunk_size)

    def _is_quality_response(self, content: str, input_data: SynthesisInput) -> bool:
        """
        Check if partial response is good enough to use directly.

        Heuristics:
        - Must have reasonable length
        - Should not look like raw tool output
        - Should address the goal
        """
        if not content or len(content) < 20:
            return False

        # Check for raw output markers
        raw_markers = ["```", "Error:", "[stderr]", "Traceback"]
        if any(marker in content[:100] for marker in raw_markers):
            return False

        # For questions, response should be substantive
        if input_data.goal_type == "question" and len(content) < 50:
            return False

        return True

    def _synthesize_with_llm(
        self,
        input_data: SynthesisInput,
        on_stream: Optional[StreamCallback]
    ) -> str:
        """Use LLM to synthesize response."""
        # Build results section
        results_parts = []

        for i, output in enumerate(input_data.tool_outputs[:self.max_tool_outputs]):
            tool_name = output.get("tool", "unknown")
            tool_output = str(output.get("output", ""))[:self.max_output_preview]
            results_parts.append(f"- {tool_name}: {tool_output}")

        if input_data.step_summaries:
            results_parts.append("\nStep summaries:")
            for summary in input_data.step_summaries[:3]:
                results_parts.append(f"- {summary}")

        results_section = "\n".join(results_parts) if results_parts else "No tool outputs collected."

        # Choose prompt template based on goal type
        if input_data.goal_type == "question":
            prompt = QUESTION_SYNTHESIS_TEMPLATE.format(
                goal=input_data.goal,
                results_section=results_section
            )
        else:
            prompt = SYNTHESIS_PROMPT_TEMPLATE.format(
                goal=input_data.goal,
                results_section=f"Tool results:\n{results_section}"
            )

        # Stream or direct call
        if on_stream and hasattr(self.llm, 'stream'):
            return self._stream_llm_response(prompt, on_stream)
        else:
            response = self.llm.respond(input=prompt, instructions="")
            content = response.content or ""
            if on_stream:
                self._stream_content(content, on_stream)
            return content

    def _stream_llm_response(
        self,
        prompt: str,
        callback: StreamCallback
    ) -> str:
        """Stream LLM response through callback."""
        full_content = ""
        chunk_index = 0

        try:
            stream_gen = self.llm.stream(input=prompt, instructions="")

            while True:
                try:
                    chunk = next(stream_gen)
                    full_content += chunk
                    if chunk:
                        callback(chunk, chunk_index, False)
                        chunk_index += 1
                except StopIteration as stop:
                    if hasattr(stop, 'value') and stop.value:
                        full_content = stop.value.content or full_content
                    callback("", chunk_index, True)
                    break

        except Exception:
            # Fallback on streaming error
            if full_content:
                callback("", chunk_index, True)
            else:
                full_content = "Unable to generate response."
                callback(full_content, 0, True)

        return full_content

    def _stream_content(
        self,
        content: str,
        callback: StreamCallback,
        chunk_size: int = 50
    ) -> None:
        """Stream pre-generated content through callback."""
        chunk_index = 0
        for i in range(0, len(content), chunk_size):
            chunk = content[i:i + chunk_size]
            is_final = (i + chunk_size) >= len(content)
            callback(chunk, chunk_index, is_final)
            chunk_index += 1

        # Ensure final signal sent
        if content and chunk_index > 0:
            callback("", chunk_index, True)

    def _fallback_synthesis(self, input_data: SynthesisInput) -> str:
        """Generate fallback response when LLM unavailable."""
        parts = []

        # Use partial response if available
        if input_data.partial_response:
            return input_data.partial_response

        # Build from tool outputs
        if input_data.tool_outputs:
            parts.append(f"Results for: {input_data.goal}")
            for output in input_data.tool_outputs[:3]:
                tool_name = output.get("tool", "tool")
                tool_output = str(output.get("output", ""))[:500]
                parts.append(f"\n{tool_name}:\n{tool_output}")

        # Use step summaries
        elif input_data.step_summaries:
            parts.append(f"Completed: {input_data.goal}")
            for summary in input_data.step_summaries[:3]:
                parts.append(f"- {summary}")

        else:
            parts.append(f"Task processing complete: {input_data.goal}")

        return "\n".join(parts)


# ========== CONVENIENCE FUNCTIONS ==========

def synthesize_response(
    goal: str,
    tool_outputs: List[Dict[str, Any]],
    llm: Optional[LLMAdapter] = None,
    on_stream: Optional[StreamCallback] = None,
    goal_type: str = "task"
) -> SynthesisResult:
    """
    Convenience function for one-shot synthesis.

    Args:
        goal: The user's goal/question
        tool_outputs: List of {"tool": name, "output": content} dicts
        llm: Optional LLM for intelligent synthesis
        on_stream: Optional streaming callback
        goal_type: "task" or "question"

    Returns:
        SynthesisResult with synthesized content
    """
    synthesizer = ResponseSynthesizer(llm=llm)
    input_data = SynthesisInput.from_tool_outputs(goal, tool_outputs, goal_type)
    return synthesizer.synthesize(input_data, on_stream)


def stream_text(
    content: str,
    callback: StreamCallback,
    chunk_size: int = 50
) -> None:
    """
    Convenience function to stream text through a callback.

    Args:
        content: Text to stream
        callback: StreamCallback to receive chunks
        chunk_size: Size of each chunk
    """
    synthesizer = ResponseSynthesizer()
    synthesizer.stream_content(content, callback, chunk_size)
