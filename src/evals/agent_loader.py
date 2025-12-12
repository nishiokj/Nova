"""
Agent loader for evaluation system.

Loads and instantiates agents from configuration files,
making it easy to test different agent implementations.

IMPORTANT: Agents loaded by this module implement the EvalAgentProtocol:
- run(user_input: str, context: Optional[str] = None) -> AgentResponse
- user_input is the RAW task prompt (never modified)
- context is SEPARATE metadata for file/env info
"""

import json
import importlib
from pathlib import Path
from typing import Callable, Dict, Any, Optional

from harness.llm_adapter import LLMConfig
from harness.tool_registry import ToolRegistry
from harness.config import ToolConfig, AgentConfig
from .agent_interface import EvalAgentProtocol, validate_agent_response


def load_agent_config(config_name: str = "default_agent") -> Dict[str, Any]:
    """
    Load agent configuration from config file.

    Args:
        config_name: Name of agent config to load from agent_config.json

    Returns:
        Agent configuration dictionary
    """
    config_path = Path(__file__).parent / "configs" / "agent_config.json"

    with open(config_path, 'r') as f:
        all_configs = json.load(f)

    # Try direct config first, then look in agents dict
    if config_name in all_configs:
        return all_configs[config_name]
    elif "agents" in all_configs and config_name in all_configs["agents"]:
        return all_configs["agents"][config_name]
    else:
        raise ValueError(f"Agent config not found: {config_name}")


def create_agent_from_config(
    config_name: str = "default_agent",
    override_model: Optional[str] = None,
    override_provider: Optional[str] = None,
    override_temperature: Optional[float] = None
) -> Callable:
    """
    Create agent factory from configuration.

    Args:
        config_name: Name of agent config to load
        override_model: Override model from config
        override_provider: Override provider from config
        override_temperature: Override temperature from config

    Returns:
        Callable that creates fresh agent instances

    Example:
        # Use config as-is
        factory = create_agent_from_config("tiered_advanced")

        # Override model
        factory = create_agent_from_config("tiered_advanced", override_model="gpt-4-turbo")

        # Use in evaluation
        runner = EvalRunner(factory, judge_llm, output_dir)
    """
    agent_config = load_agent_config(config_name)

    # Apply overrides
    if override_model:
        agent_config["llm_config"]["model"] = override_model
    if override_provider:
        agent_config["llm_config"]["provider"] = override_provider
    if override_temperature is not None:
        agent_config["llm_config"]["temperature"] = override_temperature

    # Determine agent type
    agent_type = agent_config.get("type", "TieredAgent")
    use_router = agent_config.get("use_router", False)

    if use_router or agent_type == "RoutedAgent":
        return _create_routed_agent_factory(agent_config)
    elif agent_type == "TieredAgent":
        return _create_tiered_agent_factory(agent_config)
    else:
        return _create_custom_agent_factory(agent_config)


def _create_tiered_agent_factory(config: Dict[str, Any]) -> Callable:
    """Create factory for TieredAgent."""
    # Create LLM config
    llm_config_dict = config["llm_config"]
    llm_max_tokens = llm_config_dict.get("max_tokens", 4000)
    llm_config = LLMConfig(
        provider=llm_config_dict["provider"],
        model=llm_config_dict["model"],
        temperature=llm_config_dict.get("temperature", 0.7),
        max_tokens=llm_max_tokens
    )

    # Create tool config
    tool_config_dict = config.get("tool_config", {})
    tool_config = ToolConfig()
    if "enabled_tools" in tool_config_dict:
        tool_config.enabled_tools = tool_config_dict["enabled_tools"]

    # Get tier
    tier = config.get("tier", "advanced")

    # Import TieredAgent
    from harness.agent import TieredAgent

    def factory():
        """Create fresh TieredAgent instance."""
        tool_registry = ToolRegistry(tool_config)
        agent_config = AgentConfig(
            llm_config=llm_config,
            tier=tier
        )

        tiered_agent = TieredAgent(
            config=agent_config,
            tool_registry=tool_registry,
            tier_configs={tier: llm_config}
        )

        return tiered_agent._get_agent(tier)

    # Attach config metadata for logging
    factory.config = {
        "agent_type": "TieredAgent",
        "tier": tier,
        "model": llm_config.model,
        "provider": llm_config.provider,
        "temperature": llm_config.temperature,
        "max_tokens": llm_config.max_tokens
    }

    return factory


def _create_routed_agent_factory(config: Dict[str, Any]) -> Callable:
    """Create factory for router-based TieredAgent that dynamically routes to tiers."""
    # Create router config
    router_config_dict = config.get("router_config", {})
    router_llm_config_dict = router_config_dict.get("llm_config", config["llm_config"])

    from harness.config import RouterConfig
    router_max_tokens = router_llm_config_dict.get("max_tokens", 100)
    router_llm_config = LLMConfig(
        provider=router_llm_config_dict["provider"],
        model=router_llm_config_dict["model"],
        temperature=router_llm_config_dict.get("temperature", 0.1),
        max_tokens=router_max_tokens
    )

    router_config = RouterConfig(
        enabled=router_config_dict.get("enabled", True),
        llm_config=router_llm_config
    )

    # Create tier-specific LLM configs
    tier_configs_dict = config.get("tier_configs", {})
    tier_llm_configs = {}

    for tier_name in ["simple", "standard", "advanced"]:
        tier_dict = tier_configs_dict.get(tier_name, config["llm_config"])
        tier_max_tokens = tier_dict.get("max_tokens", 8000)
        tier_llm_configs[tier_name] = LLMConfig(
            provider=tier_dict["provider"],
            model=tier_dict["model"],
            temperature=tier_dict.get("temperature", 0.7),
            max_tokens=tier_max_tokens
        )

    # Create tool config
    tool_config_dict = config.get("tool_config", {})
    tool_config = ToolConfig()
    if "enabled_tools" in tool_config_dict:
        tool_config.enabled_tools = tool_config_dict["enabled_tools"]

    # Import required classes
    from harness.agent import TieredAgent
    from harness.router import Router
    from harness.tool_registry import ToolRegistry

    def factory():
        """Create fresh TieredAgent with Router."""
        # Create router
        router = Router(router_config)

        # Create tool registry
        tool_registry = ToolRegistry(tool_config)

        # Create agent config (we'll use 'advanced' as default but router overrides)
        agent_config = AgentConfig(
            llm_config=tier_llm_configs["advanced"],
            tier="advanced"  # Default, router will override per request
        )

        # Create TieredAgent with all tier configs
        tiered_agent = TieredAgent(
            config=agent_config,
            tool_registry=tool_registry,
            tier_configs=tier_llm_configs
        )

        # Wrapper class that routes then executes
        # Implements EvalAgentProtocol for evaluation compatibility
        class RoutedAgentWrapper:
            """
            Wrapper that routes requests to appropriate tier agents.

            Implements EvalAgentProtocol:
            - run(user_input, context) where user_input is the RAW task
            - context is passed separately for file/env metadata

            IMPORTANT: The router classifies based on user_input ONLY.
            Context is NOT used for classification - it's just execution metadata.
            """

            def __init__(self, router, tiered_agent, tool_registry):
                self.router = router
                self.tiered_agent = tiered_agent
                self.tool_registry = tool_registry  # Expose for isolation.py

            def run(self, user_input: str, context: Optional[str] = None):
                """
                Route to appropriate tier, then execute.

                Args:
                    user_input: The RAW task prompt. This is what gets classified
                               and what the agent processes. NEVER modified.
                    context: Optional file/env metadata. Passed to agent separately.
                            NOT used for routing classification.

                Returns:
                    AgentResponse from the selected tier's agent
                """
                # Classify based on user_input ONLY (not context)
                # Context is execution metadata, not part of the task classification
                classification = self.router.classify(user_input)
                tier = classification.tier.value

                # Extract budget constraints from classification
                # These MUST be respected by the agent
                budget = classification.budget

                # Execute with classified tier AND budget constraints
                # The agent will fail fast if the task can't be done within budget
                return self.tiered_agent.run(
                    user_input=user_input,
                    tier=tier,
                    context=context,
                    budget=budget,
                    classification=classification
                )

            def stream(self, user_input: str, context: Optional[str] = None):
                """Route to appropriate tier, then stream execution."""
                # Classify based on user_input ONLY
                classification = self.router.classify(user_input)
                tier = classification.tier.value

                # Stream with classified tier
                yield from self.tiered_agent.stream(
                    user_input=user_input,
                    tier=tier,
                    context=context
                )

        return RoutedAgentWrapper(router, tiered_agent, tool_registry)

    # Attach config metadata for logging
    factory.config = {
        "agent_type": "RoutedAgent",
        "router_enabled": True,
        "router_model": router_llm_config.model,
        "router_max_tokens": router_llm_config.max_tokens,
        "tier_models": {
            tier: cfg.model for tier, cfg in tier_llm_configs.items()
        },
        "tier_max_tokens": {
            tier: cfg.max_tokens for tier, cfg in tier_llm_configs.items()
        },
        "provider": config["llm_config"]["provider"],
        "temperature": config["llm_config"].get("temperature", 0.7)
    }

    return factory


def _create_custom_agent_factory(config: Dict[str, Any]) -> Callable:
    """Create factory for custom agent class."""
    # Import the custom agent class
    module_path = config["module"]
    class_name = config["class"]

    try:
        module = importlib.import_module(module_path)
        agent_class = getattr(module, class_name)
    except (ImportError, AttributeError) as e:
        raise ImportError(f"Could not import {class_name} from {module_path}: {e}")

    # Get initialization parameters
    init_params = config.get("init_params", {})

    # Create LLM config if specified
    if "llm_config" in config:
        llm_config_dict = config["llm_config"]
        llm_max_tokens = llm_config_dict.get("max_tokens", 4000)
        llm_config = LLMConfig(
            provider=llm_config_dict["provider"],
            model=llm_config_dict["model"],
            temperature=llm_config_dict.get("temperature", 0.7),
            max_tokens=llm_max_tokens
        )
        init_params["llm_config"] = llm_config

    # Create tool registry if needed
    if "tool_config" in config:
        tool_config_dict = config["tool_config"]
        tool_config = ToolConfig()
        if "enabled_tools" in tool_config_dict:
            tool_config.enabled_tools = tool_config_dict["enabled_tools"]
        init_params["tool_registry"] = ToolRegistry(tool_config)

    def factory():
        """Create fresh agent instance."""
        return agent_class(**init_params)

    # Attach config metadata
    factory.config = {
        "agent_type": class_name,
        "module": module_path,
        "model": config.get("llm_config", {}).get("model", "unknown"),
        "provider": config.get("llm_config", {}).get("provider", "unknown"),
        "max_tokens": config.get("llm_config", {}).get("max_tokens"),
        **init_params
    }

    return factory


def list_available_agents() -> Dict[str, Dict[str, Any]]:
    """
    List all available agent configurations.

    Returns:
        Dictionary mapping agent names to their configs
    """
    config_path = Path(__file__).parent / "configs" / "agent_config.json"

    with open(config_path, 'r') as f:
        all_configs = json.load(f)

    agents = {}

    # Add default agent
    if "default_agent" in all_configs:
        agents["default_agent"] = all_configs["default_agent"]

    # Add all agents from agents dict
    if "agents" in all_configs:
        agents.update(all_configs["agents"])

    return agents


def print_available_agents():
    """Print all available agent configurations."""
    agents = list_available_agents()

    print("=" * 70)
    print("AVAILABLE AGENT CONFIGURATIONS")
    print("=" * 70)
    print()

    for name, config in agents.items():
        agent_type = config.get("type", "Unknown")
        use_router = config.get("use_router", False)
        llm_config = config.get("llm_config", {})
        model = llm_config.get("model", "N/A")
        provider = llm_config.get("provider", "N/A")
        tier = config.get("tier", "N/A")

        print(f"[{name}]")
        print(f"  Type:     {agent_type}")

        if use_router or agent_type == "RoutedAgent":
            print(f"  Router:   Enabled")
            router_cfg = config.get("router_config", {})
            router_llm = router_cfg.get("llm_config", {})
            print(f"  Router Model: {router_llm.get('model', 'N/A')}")
            tier_configs = config.get("tier_configs", {})
            if tier_configs:
                print(f"  Tier Models:")
                for t, tcfg in tier_configs.items():
                    print(f"    {t}: {tcfg.get('model', 'N/A')}")
        else:
            print(f"  Model:    {model}")
            print(f"  Provider: {provider}")
            if tier != "N/A":
                print(f"  Tier:     {tier}")
        print()

    print("=" * 70)
    print()
    print("Usage:")
    print("  python scripts/run_eval.py --agent-config tiered_advanced")
    print("  python scripts/run_eval.py --agent-config claude_sonnet --override-model gpt-4-turbo")
    print()


if __name__ == "__main__":
    print_available_agents()
