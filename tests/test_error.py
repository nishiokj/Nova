#!/usr/bin/env python3
"""Reproduce the KeyError"""
import sys
sys.path.insert(0, '.')

from harness.agent.agent import TieredAgent
from util.config import HarnessConfig
import json

# Load config
with open("config/harness_config.json") as f:
    config_data = json.load(f)

# Create harness config
from util.config import AgentConfig, LLMConfig
from harness.agent.tool_registry import ToolRegistry

tier_configs = {}
for tier_name, llm_conf in config_data.get("llm_configs", {}).items():
    tier_configs[tier_name] = LLMConfig(**llm_conf)

agent_config = AgentConfig(**config_data["agent"])
tool_registry = ToolRegistry()

# Create tiered agent
agent = TieredAgent(
    config=agent_config,
    tool_registry=tool_registry,
    tier_configs=tier_configs
)

# Test the failing input
print("Testing: 'What does a KB cache do?'")
print("-" * 60)

try:
    response = agent.run("What does a KB cache do?", tier="simple")
    print(f"✓ Success: {response.success}")
    print(f"  Content: {response.content}")
except Exception as e:
    print(f"✗ Error: {type(e).__name__}: {e}")
    import traceback
    traceback.print_exc()
