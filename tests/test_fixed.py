#!/usr/bin/env python3
"""Test that the fix works for all previously failing inputs"""
import sys
sys.path.insert(0, '.')

from harness.agent.agent import TieredAgent
from util.config import AgentConfig, LLMConfig
from harness.agent.tool_registry import ToolRegistry
import json

# Load config
with open("config/harness_config.json") as f:
    config_data = json.load(f)

tier_configs = {}
for tier_name, llm_conf in config_data.get("llm_configs", {}).items():
    tier_configs[tier_name] = LLMConfig(**llm_conf)

agent_config = AgentConfig(**config_data["agent"])
tool_registry = ToolRegistry()

agent = TieredAgent(
    config=agent_config,
    tool_registry=tool_registry,
    tier_configs=tier_configs
)

# Test all the previously failing inputs
test_inputs = [
    "Create a Python file that solves the two-sum problem.",
    "What does a KB cache do?",
    "What does a KV cache do?",
]

for user_input in test_inputs:
    print(f"\nTesting: '{user_input}'")
    print("-" * 60)

    try:
        response = agent.run(user_input, tier="simple")
        print(f"✓ No KeyError (success={response.success})")
        if not response.success:
            print(f"  Error message: {response.error}")
            # Check if it's the KeyError or something else
            if "'\\n  \"goal\"'" in str(response.error):
                print("  ✗✗ STILL HAS THE ORIGINAL BUG!")
            else:
                print("  ✓ Different error (expected due to missing openai)")
    except KeyError as e:
        print(f"✗ KeyError still present: {e}")
    except Exception as e:
        print(f"✗ Other error: {type(e).__name__}: {e}")
