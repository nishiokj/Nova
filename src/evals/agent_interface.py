"""
Standardized Agent Interface for Evaluations.

This module defines the contract between the evaluation system and agents.
Any agent that implements this interface can be evaluated.

The interface ensures:
1. Clean separation between task prompt and execution context
2. Consistent response format for grading
3. Interoperability - any eval can test any compliant agent
"""

from typing import Protocol, Optional, List, Dict, Any, runtime_checkable
from dataclasses import dataclass, field


@dataclass
class EvalAgentResponse:
    """
    Standardized response format for evaluation.

    This is the minimum information needed for grading.
    Agents can return more, but must include these fields.
    """
    # Required fields
    content: str  # The actual response text to be graded
    success: bool  # Did the agent believe it succeeded?

    # Optional but recommended
    tools_used: List[str] = field(default_factory=list)
    goal_achieved: bool = True
    error: Optional[str] = None
    total_duration_ms: float = 0.0

    # For detailed analysis
    steps: List[Dict[str, Any]] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    # Plan/Reflect architecture support
    plan: Optional[Any] = None
    reflection: Optional[Any] = None
    structured_action: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "content": self.content,
            "success": self.success,
            "tools_used": self.tools_used,
            "goal_achieved": self.goal_achieved,
            "error": self.error,
            "total_duration_ms": self.total_duration_ms,
            "steps": self.steps,
            "metadata": self.metadata,
            "structured_action": self.structured_action,
            "plan": self.plan.to_dict() if self.plan and hasattr(self.plan, 'to_dict') else None,
        }


@runtime_checkable
class EvalAgentProtocol(Protocol):
    """
    Protocol defining the interface an agent must implement for evaluation.

    Usage:
        # Check if an agent is compatible
        if isinstance(my_agent, EvalAgentProtocol):
            response = my_agent.run("What is 2+2?")

    The run() method must:
    1. Accept user_input as the primary task (NEVER modified by eval harness)
    2. Optionally accept context for file/env information (SEPARATE from prompt)
    3. Return an object with at minimum: content, success, tools_used, goal_achieved
    """

    def run(self, user_input: str, context: Optional[str] = None) -> Any:
        """
        Execute a task and return a response.

        Args:
            user_input: The actual task/question to perform.
                       This is the RAW prompt - no metadata, no working directory,
                       no system information. Just the task itself.

            context: Optional context for tasks that need it (file operations, etc.)
                    This is passed SEPARATELY from the prompt to keep the task clean.
                    The agent can use this for tool configuration but should not
                    treat it as part of the user's question.

        Returns:
            Response object with at minimum:
            - content: str - The response text
            - success: bool - Whether execution succeeded
            - tools_used: List[str] - Tools that were used
            - goal_achieved: bool - Whether the goal was achieved

            Can also include: error, total_duration_ms, steps, metadata, plan, reflection
        """
        ...


def validate_agent_response(response: Any) -> bool:
    """
    Validate that an agent response has the required fields for grading.

    Args:
        response: The response object from an agent

    Returns:
        True if response is valid for grading, False otherwise
    """
    required_attrs = ['content', 'success']

    for attr in required_attrs:
        if not hasattr(response, attr):
            return False

    # Check content is a string
    if not isinstance(response.content, str):
        return False

    return True


def wrap_response(response: Any) -> EvalAgentResponse:
    """
    Wrap any agent response into the standardized format.

    This allows agents with different response formats to be evaluated,
    as long as they have the minimum required fields.

    Args:
        response: Response from any agent

    Returns:
        EvalAgentResponse with standardized format
    """
    if isinstance(response, EvalAgentResponse):
        return response

    # Extract fields with defaults
    content = getattr(response, 'content', str(response))
    success = getattr(response, 'success', True)
    tools_used = getattr(response, 'tools_used', [])
    goal_achieved = getattr(response, 'goal_achieved', success)
    error = getattr(response, 'error', None)
    total_duration_ms = getattr(response, 'total_duration_ms', 0.0)
    steps = getattr(response, 'steps', [])
    metadata = getattr(response, 'metadata', {})
    plan = getattr(response, 'plan', None)
    reflection = getattr(response, 'reflection', None)
    structured_action = getattr(response, 'structured_action', None)

    # Convert steps to dicts if they have to_dict method
    if steps and hasattr(steps[0], 'to_dict'):
        steps = [s.to_dict() for s in steps]

    return EvalAgentResponse(
        content=content,
        success=success,
        tools_used=tools_used,
        goal_achieved=goal_achieved,
        error=error,
        total_duration_ms=total_duration_ms,
        steps=steps,
        metadata=metadata,
        plan=plan,
        reflection=reflection,
        structured_action=structured_action
    )
