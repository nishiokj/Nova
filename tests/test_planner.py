#!/usr/bin/env python3
"""Test the planner issue"""
import sys
sys.path.insert(0, '.')

from harness.planner import Planner, Plan
from harness.tool_registry import ToolRegistry
from harness.llm_factory import create_llm
from harness.config import AgentConfig
import json

# Create minimal components
config_path = "config/harness_config.json"
with open(config_path) as f:
    config_data = json.load(f)

# Create LLM
llm = create_llm(config_data["llm"])

# Create tool registry
tool_registry = ToolRegistry()

# Create planner
planner = Planner(llm, tool_registry)

# Test the problematic input
user_input = "Create a Python file that solves the two-sum problem."

print(f"Testing input: {user_input}")
print("-" * 60)

try:
    plan = planner.create_plan(user_input, tier="standard")
    print(f"✓ Plan created successfully!")
    print(f"  Type: {type(plan)}")
    print(f"  Goal: {plan.goal}")
    print(f"  Goal type: {plan.goal_type}")
    print(f"  Steps: {len(plan.steps)}")
    print(f"  Requires tools: {plan.requires_tools}")
except Exception as e:
    print(f"✗ Error: {type(e).__name__}: {e}")
    import traceback
    traceback.print_exc()
