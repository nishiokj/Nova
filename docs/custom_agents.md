# Custom Agents Guide

Learn how to bring your own agents, customize agent behavior, and integrate with the evaluation framework.

## Agent Protocol

Custom agents must implement the `run()` method:

```python
from dataclasses import dataclass
from typing import Optional

@dataclass
class AgentResponse:
    text: str
    success: bool
    metadata: Optional[dict] = None

class MyCustomAgent:
    def __init__(self, llm_config, tool_registry):
        """
        Initialize your agent.

        Args:
            llm_config: LLMConfig from harness_config.json
            tool_registry: ToolRegistry with available tools
        """
        self.llm_config = llm_config
        self.tool_registry = tool_registry

    def run(self, user_input: str, context: Optional[str] = None) -> AgentResponse:
        """
        Process user input and return response.

        Args:
            user_input: Raw user request (never modified)
            context: Optional metadata (file paths, environment info)

        Returns:
            AgentResponse with text, success flag, and optional metadata
        """
        # Your implementation here
        result = self._process(user_input, context)
        return AgentResponse(
            text=result,
            success=True,
            metadata={"step_count": 5}
        )
```

## Configuration

### Option 1: agent_config.json

Create or edit `src/evals/configs/agent_config.json`:

```json
{
  "agents": {
    "my_agent": {
      "type": "CustomAgent",
      "module": "my_agents.custom_agent",
      "class": "MyCustomAgent",
      "init_params": {
        "custom_param": "value"
      },
      "llm_config": {
        "provider": "openai",
        "model": "gpt-4o",
        "temperature": 0.7,
        "max_tokens": 4000
      }
    }
  }
}
```

### Option 2: Programmatic

```python
from harness.agent.agent import Agent
from util.config import AgentConfig, LLMConfig
import os

llm_config = LLMConfig(
    provider="anthropic",
    model="claude-sonnet-4-5-20250929",
    api_key=os.getenv("ANTHROPIC_API_KEY")
)

agent = Agent(
    config=agent_config,
    llm_config=llm_config,
    tool_registry=tool_registry
)
```

## Using Custom Tools

Register custom tools with the ToolRegistry:

```python
from harness.agent.tool_registry import tool

@tool(
    name="my_custom_tool",
    description="What this tool does",
    parameters={
        "query": {"type": "string", "description": "Search query"}
    },
    required=["query"],
    timeout=30
)
def my_custom_tool(query: str) -> str:
    """Implementation of your custom tool."""
    result = perform_search(query)
    return result
```

## Example: Simple Custom Agent

```python
# my_agents/simple_agent.py

from harness.agent.agent import AgentResponse
from typing import Optional

class SimpleAgent:
    """Example custom agent with minimal implementation."""

    def __init__(self, llm_config, tool_registry):
        self.llm_config = llm_config
        self.tools = tool_registry

    def run(self, user_input: str, context: Optional[str] = None) -> AgentResponse:
        # Simple implementation: use web search tool
        search_result = self.tools.execute_tool(
            "web_fetch",
            {"url": f"https://example.com/search?q={user_input}"}
        )

        return AgentResponse(
            text=f"Search result: {search_result}",
            success=True
        )
```

**Config:**
```json
{
  "my_simple_agent": {
    "type": "CustomAgent",
    "module": "my_agents.simple_agent",
    "class": "SimpleAgent"
  }
}
```

**Usage:**
```python
from evals.agent_loader import create_agent_from_config

factory = create_agent_from_config("my_simple_agent")
agent = factory()
response = agent.run("What is Python?")
print(response.text)
```

## Integration with Evaluation Framework

Test your custom agent with the evaluation framework:

```bash
# Run evaluations with your custom agent
python scripts/run_eval.py --agent-config my_simple_agent
```

See `src/evals/` for more details on the evaluation framework.

## Best Practices

1. **API Keys**: Always use environment variables, never hardcode
2. **Error Handling**: Return `success=False` on failures
3. **Timeouts**: Respect tool timeout settings
4. **Context**: Use the `context` parameter for file/environment metadata
5. **Metadata**: Include step counts, tool usage in response metadata

## Next Steps

- Review existing agents in `src/harness/agent/`
- Check tool registry in `src/harness/agent/tool_registry.py`
- Read evaluation docs in `src/evals/README.md` (if available)
