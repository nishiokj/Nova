"""
Context Serializer - Convert context plans to API payloads.

This module implements serialization of ContextPlan to provider-specific
API formats (Anthropic Messages API and OpenAI Chat Completions API).

Key responsibilities:
1. Execute the context plan
2. Render sections to text
3. Apply cache controls (Anthropic)
4. Format for provider APIs
5. Return ready-to-send payloads

This is where the plan becomes reality.
"""

import time
import json
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

from .plan import ContextPlan, PlanExecutionResult
from .build import ContextBuild
from .sections import ContextSection


def _load_prompts() -> Dict[str, Any]:
    """Load prompts from config file"""
    # Path: src/harness/context_manager/serializer.py -> parent x4 -> project root
    config_path = Path(__file__).parent.parent.parent.parent / "config" / "prompts_config.json"
    try:
        with open(config_path, 'r') as f:
            data = json.load(f)
            return data
    except Exception as e:
        # Fallback to minimal defaults if config fails to load
        return {
            "agent_tier_prompts": {
                "simple": "You are a helpful AI assistant.",
                "standard": "You are a helpful AI assistant.",
                "advanced": "You are a helpful AI assistant."
            }
        }


class ContextSerializer:
    """
    Serialize context plans to provider-specific API formats.

    Supports:
    - Anthropic Messages API (with prompt caching)
    - OpenAI Chat Completions API
    """

    def __init__(self, prompts: Optional[Dict[str, Any]] = None):
        """
        Initialize serializer with prompts from config.

        Args:
            prompts: Optional prompts dict. If None, loads from config/prompts_config.json
        """
        self.prompts = prompts if prompts is not None else _load_prompts()
        self.tier_prompts = self.prompts.get("agent_tier_prompts", {})

    def serialize(
        self,
        plan: ContextPlan,
        build: ContextBuild,
        provider: str = "anthropic",
        use_responses_api: bool = False
    ) -> PlanExecutionResult:
        """
        Execute plan and serialize to API format.

        Args:
            plan: Context plan to execute
            build: Context build with content
            provider: API provider ('anthropic' or 'openai')
            use_responses_api: If True and provider is 'openai', use Responses API format

        Returns:
            PlanExecutionResult with serialized messages
        """
        start_time = time.time()

        try:
            if provider.lower() == "anthropic":
                system_blocks, messages = self.to_anthropic(plan, build)
                serialized = {
                    "system": system_blocks,
                    "messages": messages
                }
            elif provider.lower() == "openai":
                if use_responses_api:
                    # New Responses API format
                    instructions, input_context = self.to_openai_responses(plan, build)
                    serialized = {
                        "instructions": instructions,
                        "input": input_context
                    }
                else:
                    # Legacy Chat Completions format
                    messages = self.to_openai(plan, build)
                    serialized = {
                        "messages": messages
                    }
            else:
                raise ValueError(f"Unsupported provider: {provider}")

            # Count cache hits/misses (would track in cache validator)
            cache_hits = sum(1 for sp in plan.sections if sp.cache_key)
            cache_misses = len(plan.sections) - cache_hits

            result = PlanExecutionResult(
                plan=plan,
                success=True,
                serialized_messages=serialized,
                actual_tokens_sent=plan.total_tokens,
                cache_hits=cache_hits,
                cache_misses=cache_misses,
                execution_time_ms=(time.time() - start_time) * 1000
            )

            return result

        except Exception as e:
            return PlanExecutionResult(
                plan=plan,
                success=False,
                error=str(e),
                execution_time_ms=(time.time() - start_time) * 1000
            )

    def to_anthropic(
        self,
        plan: ContextPlan,
        build: ContextBuild
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Serialize to Anthropic Messages API format with prompt caching.

        Args:
            plan: Context plan
            build: Context build

        Returns:
            (system_blocks, messages)
        """
        system_blocks = []

        # Build system prompt from sections
        # Order: SYSTEM_CORE, TOOL_MANIFEST, USER_RULES, WORKING_MEMORY,
        # TOOL_TRACE, ARTIFACTS, FILESYSTEM, EXECUTION_CONTRACT

        section_order = [
            ContextSection.SYSTEM_CORE,
            ContextSection.TOOL_MANIFEST,
            ContextSection.EXECUTION_CONTRACT,
            ContextSection.USER_RULES,
            ContextSection.WORKING_MEMORY,
            ContextSection.TOOL_TRACE_SUMMARY,
            ContextSection.ARTIFACTS,
            ContextSection.FILESYSTEM_CONTEXT,
        ]

        for section in section_order:
            sp = plan.get_section_plan(section)
            if not sp or not sp.included:
                continue

            # Render section content
            content_text = self._render_section(section, build)

            if not content_text:
                continue

            # Build system block
            block = {
                "type": "text",
                "text": content_text
            }

            # Add cache control if section is cacheable
            if sp.cache_control:
                block["cache_control"] = {"type": sp.cache_control}

            system_blocks.append(block)

        # Build messages array (user request)
        messages = []

        user_request_plan = plan.get_section_plan(ContextSection.USER_REQUEST)
        if user_request_plan and user_request_plan.included:
            messages.append({
                "role": "user",
                "content": build.user_request
            })

        return system_blocks, messages

    def to_openai(
        self,
        plan: ContextPlan,
        build: ContextBuild
    ) -> List[Dict[str, Any]]:
        """
        Serialize to OpenAI Chat Completions API format.

        Note: OpenAI doesn't have separate system blocks, so we combine
        all context into a single system message.

        Args:
            plan: Context plan
            build: Context build

        Returns:
            messages array
        """
        messages = []

        # Combine all non-user-request sections into system message
        system_parts = []

        section_order = [
            ContextSection.SYSTEM_CORE,
            ContextSection.TOOL_MANIFEST,
            ContextSection.EXECUTION_CONTRACT,
            ContextSection.USER_RULES,
            ContextSection.WORKING_MEMORY,
            ContextSection.TOOL_TRACE_SUMMARY,
            ContextSection.ARTIFACTS,
            ContextSection.FILESYSTEM_CONTEXT,
        ]

        for section in section_order:
            sp = plan.get_section_plan(section)
            if not sp or not sp.included:
                continue

            content_text = self._render_section(section, build)
            if content_text:
                system_parts.append(content_text)

        if system_parts:
            messages.append({
                "role": "system",
                "content": "\n\n".join(system_parts)
            })

        # Add user request
        user_request_plan = plan.get_section_plan(ContextSection.USER_REQUEST)
        if user_request_plan and user_request_plan.included:
            messages.append({
                "role": "user",
                "content": build.user_request
            })

        return messages

    def to_openai_responses(
        self,
        plan: ContextPlan,
        build: ContextBuild
    ) -> Tuple[str, List[Dict[str, Any]]]:
        """
        Serialize to OpenAI Responses API format.

        Separates instructions (system-level context) from input (user context).

        Args:
            plan: Context plan
            build: Context build

        Returns:
            (instructions, input_context)
        """
        instructions_parts = []

        # Build instructions from all system sections
        section_order = [
            ContextSection.SYSTEM_CORE,
            ContextSection.TOOL_MANIFEST,
            ContextSection.EXECUTION_CONTRACT,
            ContextSection.USER_RULES,
            ContextSection.WORKING_MEMORY,
            ContextSection.TOOL_TRACE_SUMMARY,
            ContextSection.ARTIFACTS,
            ContextSection.FILESYSTEM_CONTEXT,
        ]

        for section in section_order:
            sp = plan.get_section_plan(section)
            if not sp or not sp.included:
                continue

            content_text = self._render_section(section, build)
            if content_text:
                instructions_parts.append(content_text)

        instructions = "\n\n".join(instructions_parts)

        # Build input context array
        input_context = []

        user_request_plan = plan.get_section_plan(ContextSection.USER_REQUEST)
        if user_request_plan and user_request_plan.included:
            input_context.append({
                "role": "user",
                "content": build.user_request
            })

        return instructions, input_context

    def _render_section(self, section: ContextSection, build: ContextBuild) -> str:
        """
        Render section content to text.

        Args:
            section: Section to render
            build: Context build

        Returns:
            Rendered text
        """
        if section == ContextSection.SYSTEM_CORE:
            return self._render_system_core(build)

        elif section == ContextSection.TOOL_MANIFEST:
            return self._render_tool_manifest(build)

        elif section == ContextSection.EXECUTION_CONTRACT:
            return self._render_execution_contract(build)

        elif section == ContextSection.USER_RULES:
            return self._render_user_rules(build)

        elif section == ContextSection.WORKING_MEMORY:
            return self._render_working_memory(build)

        elif section == ContextSection.TOOL_TRACE_SUMMARY:
            return self._render_tool_trace(build)

        elif section == ContextSection.ARTIFACTS:
            return self._render_artifacts(build)

        elif section == ContextSection.FILESYSTEM_CONTEXT:
            return self._render_filesystem_context(build)

        elif section == ContextSection.USER_REQUEST:
            return build.user_request

        return ""

    def _render_system_core(self, build: ContextBuild) -> str:
        """
        Render system core section from config.

        Uses tier-specific prompt from config/prompts_config.json.

        Args:
            build: Context build with tier information

        Returns:
            System core prompt for the specified tier
        """
        tier = build.tier
        tier_prompt = self.tier_prompts.get(tier, self.tier_prompts.get("standard", ""))

        # Note: Tool placeholder {tools} will be replaced by actual tools in the API call
        return tier_prompt

    def _render_tool_manifest(self, build: ContextBuild) -> str:
        """Render tool manifest section."""
        # Placeholder - would render actual tools from tool registry
        return f"""# Available Tools

Tier: {build.tier}

Tools will be provided via the tools parameter in the API call.
"""

    def _render_execution_contract(self, build: ContextBuild) -> str:
        """Render execution contract."""
        return f"""# Execution Contract

- Tier: {build.tier}
- Working directory: {build.working_dir}
- Session: {build.state.session_id}
"""

    def _render_user_rules(self, build: ContextBuild) -> str:
        """Render user rules."""
        if not build.state.user_rules or not (build.state.user_rules.rules or build.state.user_rules.preferences):
            return ""

        lines = ["# User Rules and Preferences\n"]

        if build.state.user_rules.rules:
            lines.append("## Rules")
            for rule in build.state.user_rules.rules:
                lines.append(f"- {rule}")
            lines.append("")

        if build.state.user_rules.preferences:
            lines.append("## Preferences")
            for key, value in build.state.user_rules.preferences.items():
                lines.append(f"- {key}: {value}")

        return "\n".join(lines)

    def _render_working_memory(self, build: ContextBuild) -> str:
        """Render working memory."""
        if not build.state.working_memory or not build.state.working_memory.entries:
            return ""

        return f"""# Working Memory

{build.state.working_memory.to_bullets()}
"""

    def _render_tool_trace(self, build: ContextBuild) -> str:
        """Render tool trace summary."""
        if not build.tool_trace or not build.tool_trace.recent_turns:
            return ""

        return build.tool_trace.to_text(verbose=False)

    def _render_artifacts(self, build: ContextBuild) -> str:
        """Render artifacts summary."""
        if not build.artifacts or not build.artifacts.artifacts:
            return ""

        return build.artifacts.to_context_summary(max_artifacts=10)

    def _render_filesystem_context(self, build: ContextBuild) -> str:
        """Render filesystem context."""
        if not build.filesystem_context:
            return ""

        return f"""# Filesystem Context

{build.filesystem_context}
"""
