# Agent Configuration Guide

The evaluation system uses **configuration files** to specify which agent to test, making it easy to swap between different agent implementations and models without modifying code.

## Quick Start

### List Available Agents

```bash
python scripts/run_eval.py --list-agents
```

Output:
```
[default_agent]
  Type:     TieredAgent
  Model:    gpt-4o
  Provider: openai
  Tier:     advanced

[tiered_simple]
  Type:     TieredAgent
  Model:    gpt-4o
  Provider: openai
  Tier:     simple

[claude_sonnet]
  Type:     TieredAgent
  Model:    claude-sonnet-4-5
  Provider: anthropic
  Tier:     advanced
```

### Run Evaluation with Agent Config

```bash
# Use default agent
python scripts/run_eval.py --quick

# Use specific agent config
python scripts/run_eval.py --agent-config tiered_advanced --quick

# Override model from config
python scripts/run_eval.py --agent-config tiered_simple --model gpt-4-turbo --quick
```

## Configuration File Structure

Edit `evals/configs/agent_config.json` to add or modify agent configurations:

```json
{
  "default_agent": {
    "type": "TieredAgent",
    "module": "harness.agent",
    "class": "TieredAgent",
    "tier": "advanced",
    "llm_config": {
      "provider": "openai",
      "model": "gpt-4o",
      "temperature": 0.7,
      "max_tokens": 4000
    },
    "tool_config": {
      "enabled_tools": [
        "web_search",
        "fast_answer",
        "file_read",
        "file_write",
        "python_execute",
        "bash_execute"
      ]
    }
  },

  "agents": {
    "my_agent": {
      "type": "TieredAgent",
      "tier": "standard",
      "llm_config": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-5",
        "temperature": 0.5
      }
    }
  }
}
```

## Configuration Fields

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Agent type identifier (e.g., "TieredAgent") |
| `module` | Yes | Python module path (e.g., "harness.agent") |
| `class` | Yes | Agent class name (e.g., "TieredAgent") |
| `tier` | No | Agent tier: simple/standard/advanced |
| `llm_config` | Yes | LLM configuration (provider, model, temperature) |
| `tool_config` | No | Tool configuration (enabled_tools list) |
| `init_params` | No | Custom initialization parameters |

## Adding Custom Agents

To test your own agent implementation:

### 1. Create Your Agent Class

```python
# my_agents/custom_agent.py
from harness.agent import Agent

class MyCustomAgent(Agent):
    def __init__(self, llm_config, custom_param=None):
        super().__init__(llm_config)
        self.custom_param = custom_param

    def execute(self, prompt, context=None):
        # Your agent logic here
        return response
```

### 2. Add Configuration

Edit `evals/configs/agent_config.json`:

```json
{
  "agents": {
    "my_custom_agent": {
      "type": "CustomAgent",
      "module": "my_agents.custom_agent",
      "class": "MyCustomAgent",
      "init_params": {
        "custom_param": "my_value"
      },
      "llm_config": {
        "provider": "openai",
        "model": "gpt-4o",
        "temperature": 0.7
      }
    }
  }
}
```

### 3. Run Evaluation

```bash
python scripts/run_eval.py --agent-config my_custom_agent --quick
```

The system will automatically:
- Import your agent class via `importlib`
- Instantiate it with the provided `init_params`
- Pass `llm_config` and `tool_config` if specified
- Run evaluation tasks against it

## Override Parameters

You can override any config parameter from the command line:

```bash
# Override model
python scripts/run_eval.py --agent-config tiered_simple --model gpt-4-turbo

# Override provider
python scripts/run_eval.py --agent-config default_agent --provider anthropic --model claude-sonnet-4-5

# Override temperature
python scripts/run_eval.py --agent-config claude_sonnet --temperature 0.2

# Multiple overrides
python scripts/run_eval.py --agent-config tiered_advanced \
  --model gpt-4o \
  --temperature 0.9 \
  --quick
```

This is useful for:
- Quick testing without editing config files
- A/B testing different models with same agent
- Experimenting with temperature settings

## Programmatic Usage

You can also use the agent loader in your own Python scripts:

```python
from evals import create_agent_from_config, list_available_agents

# List all configs
agents = list_available_agents()
print(agents.keys())  # ['default_agent', 'tiered_simple', ...]

# Create agent factory
factory = create_agent_from_config(
    config_name="tiered_advanced",
    override_model="gpt-4-turbo"
)

# Create agent instance
agent = factory()

# Factory has metadata attached
print(factory.config)
# {
#   'agent_type': 'TieredAgent',
#   'tier': 'advanced',
#   'model': 'gpt-4-turbo',
#   'provider': 'openai',
#   'temperature': 0.7
# }
```

## Best Practices

1. **Version control your configs**: Track agent configurations alongside code for reproducibility

2. **Name configs descriptively**: Use names like `gpt4_low_temp` or `claude_high_reasoning` that indicate the configuration

3. **Document custom params**: Add comments in JSON (though they'll be stripped) or maintain separate docs for complex configs

4. **Test incrementally**: Use `--quick` flag when testing new agent configurations before running full 52-task eval

5. **Use overrides for experiments**: Keep base config stable, use CLI overrides for quick experiments

6. **Compare runs**: After making config changes, use `compare_runs.py` to see performance differences

## Troubleshooting

### "Agent config not found"

**Error**: `ValueError: Agent config not found: my_agent`

**Solution**: Check that your config name exists in either the top-level of `agent_config.json` or in the `agents` dict:
- `default_agent` (top-level)
- `tiered_simple` (in agents dict)

### "Could not import module"

**Error**: `ImportError: Could not import MyAgent from my_module.agents`

**Solution**:
- Verify the module path is correct
- Ensure the module is on Python's path
- Check that the class name matches exactly (case-sensitive)

### "Missing required parameter"

**Error**: Agent initialization fails due to missing parameter

**Solution**: Add the required parameter to `init_params` in your config:

```json
{
  "init_params": {
    "required_param": "value"
  }
}
```

## Examples

### Compare GPT-4 vs Claude

```bash
# Run GPT-4
python scripts/run_eval.py --agent-config default_agent --quick

# Run Claude
python scripts/run_eval.py --agent-config claude_sonnet --quick

# Compare results
python scripts/compare_runs.py run_<timestamp1>.json run_<timestamp2>.json
```

### Test Temperature Sensitivity

```bash
# Low temperature
python scripts/run_eval.py --agent-config tiered_advanced --temperature 0.3 --quick

# High temperature
python scripts/run_eval.py --agent-config tiered_advanced --temperature 0.9 --quick

# Compare
python scripts/compare_runs.py run_*.json
```

### Test Custom Agent

```bash
# Test on quick subset first
python scripts/run_eval.py --agent-config my_custom_agent --quick

# If successful, run full eval
python scripts/run_eval.py --agent-config my_custom_agent

# Compare to baseline
python scripts/compare_runs.py run_custom.json run_baseline.json
```
