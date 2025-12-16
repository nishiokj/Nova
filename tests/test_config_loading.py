#!/usr/bin/env python3
"""
Test configuration loading from /config folder.
Verifies all hardcoded configurations have been moved to config files.
"""

import json
import sys
from pathlib import Path


def test_prompts_config():
    """Test loading prompts_config.json"""
    print("Testing prompts_config.json...")
    config_path = Path("config/prompts_config.json")

    if not config_path.exists():
        print(f"  ❌ FAILED: {config_path} not found")
        return False

    try:
        with open(config_path, 'r') as f:
            data = json.load(f)

        # Check required sections
        required_sections = ["agent_tier_prompts", "planner_prompts", "router_prompt", "service_rep_prompt"]
        for section in required_sections:
            if section not in data:
                print(f"  ❌ FAILED: Missing section '{section}'")
                return False

        # Check agent tier prompts
        required_tiers = ["simple", "standard", "advanced"]
        for tier in required_tiers:
            if tier not in data["agent_tier_prompts"]:
                print(f"  ❌ FAILED: Missing tier prompt '{tier}'")
                return False

        # Check planner prompts
        if "planning" not in data["planner_prompts"] or "reflection" not in data["planner_prompts"]:
            print(f"  ❌ FAILED: Missing planner prompts")
            return False

        print("  ✅ PASSED: prompts_config.json")
        return True
    except Exception as e:
        print(f"  ❌ FAILED: {e}")
        return False


def test_service_rep_config():
    """Test loading service_rep_config.json"""
    print("Testing service_rep_config.json...")
    config_path = Path("config/service_rep_config.json")

    if not config_path.exists():
        print(f"  ❌ FAILED: {config_path} not found")
        return False

    try:
        with open(config_path, 'r') as f:
            data = json.load(f)

        # Check canned responses
        if "canned_responses" not in data:
            print(f"  ❌ FAILED: Missing 'canned_responses'")
            return False

        required_categories = ["thinking", "searching", "executing", "error", "clarification", "done"]
        for category in required_categories:
            if category not in data["canned_responses"]:
                print(f"  ❌ FAILED: Missing category '{category}'")
                return False
            if not isinstance(data["canned_responses"][category], list):
                print(f"  ❌ FAILED: Category '{category}' should be a list")
                return False
            if len(data["canned_responses"][category]) == 0:
                print(f"  ❌ FAILED: Category '{category}' is empty")
                return False

        print("  ✅ PASSED: service_rep_config.json")
        return True
    except Exception as e:
        print(f"  ❌ FAILED: {e}")
        return False


def test_router_patterns_config():
    """Test loading router_patterns_config.json"""
    print("Testing router_patterns_config.json...")
    config_path = Path("config/router_patterns_config.json")

    if not config_path.exists():
        print(f"  ❌ FAILED: {config_path} not found")
        return False

    try:
        with open(config_path, 'r') as f:
            data = json.load(f)

        # Check pattern lists
        required_patterns = ["simple_patterns", "advanced_patterns", "tool_patterns"]
        for pattern_type in required_patterns:
            if pattern_type not in data:
                print(f"  ❌ FAILED: Missing '{pattern_type}'")
                return False
            if not isinstance(data[pattern_type], list):
                print(f"  ❌ FAILED: '{pattern_type}' should be a list")
                return False
            if len(data[pattern_type]) == 0:
                print(f"  ❌ FAILED: '{pattern_type}' is empty")
                return False

        print("  ✅ PASSED: router_patterns_config.json")
        return True
    except Exception as e:
        print(f"  ❌ FAILED: {e}")
        return False


def test_harness_imports():
    """Test that harness modules can import and load configs"""
    print("Testing harness module imports...")

    try:
        # Test agent.py loading
        sys.path.insert(0, str(Path(__file__).parent))
        from harness.agent.agent import _TIER_PROMPTS

        if not _TIER_PROMPTS:
            print("  ❌ FAILED: agent._TIER_PROMPTS is empty")
            return False

        if "simple" not in _TIER_PROMPTS or "standard" not in _TIER_PROMPTS or "advanced" not in _TIER_PROMPTS:
            print("  ❌ FAILED: Missing tier prompts in agent._TIER_PROMPTS")
            return False

        # Test planner.py loading
        from harness.agent.planner import PLANNING_PROMPT, REFLECTION_PROMPT

        if not PLANNING_PROMPT or not REFLECTION_PROMPT:
            print("  ❌ FAILED: Planner prompts are empty")
            return False

        # Test router.py loading (instantiate to trigger config load)
        from services.router import PatternClassifier
        classifier = PatternClassifier()

        if not classifier.simple_patterns or not classifier.advanced_patterns or not classifier.tool_patterns:
            print("  ❌ FAILED: Router patterns are empty")
            return False

        print("  ✅ PASSED: Harness modules load configs correctly")
        return True
    except Exception as e:
        print(f"  ❌ FAILED: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    print("=" * 60)
    print("CONFIGURATION LOADING TEST")
    print("=" * 60)
    print()

    tests = [
        test_prompts_config,
        test_service_rep_config,
        test_router_patterns_config,
        test_harness_imports,
    ]

    results = []
    for test in tests:
        results.append(test())
        print()

    print("=" * 60)
    if all(results):
        print("ALL TESTS PASSED! ✅")
        print("All configurations successfully moved to /config folder")
        return 0
    else:
        failed_count = sum(1 for r in results if not r)
        print(f"TESTS FAILED: {failed_count}/{len(results)} ❌")
        return 1


if __name__ == "__main__":
    sys.exit(main())
