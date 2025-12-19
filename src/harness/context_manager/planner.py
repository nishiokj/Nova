"""
Context Planner - Create deterministic context plans.

This module implements the ContextPlanner, which takes a ContextBuild and
creates a deterministic ContextPlan that specifies exactly what goes into
the context and why.

Key responsibilities:
1. Identify which sections are present
2. Allocate token budgets across sections
3. Compute content hashes for cache validation
4. Apply compaction where needed
5. Decide caching strategy
6. Generate rationale for decisions

The plan is fully explicit and debuggable.
"""

import time
from typing import Dict, List, Optional, Any

from .build import ContextBuild
from .plan import ContextPlan, SectionPlan
from .sections import ContextSection, SystemCoreSection, ToolManifestSection, ExecutionContractSection, UserRulesSection
from .budget import BudgetAllocator, EvictionPolicy
from .token_estimator import TokenEstimator
from .cache import SectionHasher, CacheValidator, CacheStrategy


class ContextPlanner:
    """
    Creates deterministic context plans from builds.

    This is where the magic happens - taking all the context components
    and deciding what actually goes into the final context, with explicit
    reasoning for every decision.
    """

    def __init__(
        self,
        token_estimator: TokenEstimator,
        budget_allocator: Optional[BudgetAllocator] = None,
        cache_validator: Optional[CacheValidator] = None,
        model_family: str = "claude-3"
    ):
        """
        Initialize context planner.

        Args:
            token_estimator: Token estimator for accurate counts
            budget_allocator: Budget allocator (uses default if None)
            cache_validator: Cache validator (creates new if None)
            model_family: Model family for cache keys
        """
        self.token_estimator = token_estimator
        self.budget_allocator = budget_allocator or BudgetAllocator()
        self.cache_validator = cache_validator or CacheValidator()
        self.model_family = model_family
        self.hasher = SectionHasher()

    def plan(
        self,
        build: ContextBuild,
        total_budget: int = 180_000,
        cache_strategy: str = CacheStrategy.CONSERVATIVE
    ) -> ContextPlan:
        """
        Create a deterministic context plan.

        Args:
            build: Context build to plan for
            total_budget: Total token budget
            cache_strategy: Caching strategy

        Returns:
            ContextPlan with all decisions recorded
        """
        plan_start = time.time()

        # 1. Identify sections present in build
        sections = self._identify_sections(build)

        # 2. Get current content and sizes for each section
        section_contents = self._get_section_contents(build, sections)
        original_sizes = {
            section: self.token_estimator.count_tokens(str(content))
            for section, content in section_contents.items()
        }

        # 3. Allocate token budgets
        allocations = self.budget_allocator.allocate(
            total_budget=total_budget,
            sections=sections,
            actual_sizes=original_sizes
        )

        # 4. Compute content hashes
        content_hashes = {
            section: self.hasher.hash_section(section, content)
            for section, content in section_contents.items()
        }

        # 5. Create section plans
        section_plans: List[SectionPlan] = []

        for section in sections:
            content = section_contents[section]
            content_hash = content_hashes[section]
            allocated = allocations[section]
            original = original_sizes[section]

            # Apply eviction if over budget
            compacted_content = content
            actual_tokens = original
            eviction_applied = None
            compacted = False

            if original > allocated:
                budget_config = self.budget_allocator.get_budget(section)
                eviction_policy = budget_config.eviction_policy

                compacted_content, actual_tokens = self._apply_eviction(
                    section=section,
                    content=content,
                    policy=eviction_policy,
                    target_tokens=allocated
                )

                if actual_tokens < original:
                    compacted = True
                    eviction_applied = eviction_policy.value

            # Determine caching
            cache_key, cache_control = self._determine_caching(
                section=section,
                content_hash=content_hash,
                cache_strategy=cache_strategy,
                tier=build.tier
            )

            # Create section plan
            section_plans.append(SectionPlan(
                section=section,
                content_hash=content_hash,
                cache_key=cache_key,
                cache_control=cache_control,
                allocated_tokens=allocated,
                actual_tokens=actual_tokens,
                original_tokens=original,
                included=True,  # All identified sections are included
                compacted=compacted,
                eviction_applied=eviction_applied,
                metadata={
                    "content_type": type(content).__name__
                }
            ))

        # 6. Generate rationale
        rationale = self._generate_rationale(section_plans, build, total_budget)

        # 7. Estimate cost
        estimated_cost = self._estimate_cost(section_plans, cache_strategy)

        plan = ContextPlan(
            request_id=build.request_id,
            session_id=build.state.session_id,
            total_budget=total_budget,
            sections=section_plans,
            cache_strategy=cache_strategy,
            rationale=rationale,
            estimated_cost=estimated_cost,
            metadata={
                "tier": build.tier,
                "planning_time_ms": (time.time() - plan_start) * 1000
            }
        )

        return plan

    def _identify_sections(self, build: ContextBuild) -> List[ContextSection]:
        """
        Identify which sections are present in the build.

        Returns:
            List of sections to include
        """
        sections = [
            ContextSection.SYSTEM_CORE,  # Always present
            ContextSection.USER_REQUEST,  # Always present
        ]

        # Tool manifest (if tools will be used)
        sections.append(ContextSection.TOOL_MANIFEST)

        # Execution contract (always present for tier/budget info)
        sections.append(ContextSection.EXECUTION_CONTRACT)

        # Working memory (if has entries)
        if build.state.working_memory and build.state.working_memory.entries:
            sections.append(ContextSection.WORKING_MEMORY)

        # User rules (if has rules or OS info)
        if build.state.user_rules and build.state.user_rules.has_rules:
            sections.append(ContextSection.USER_RULES)

        # Tool trace (if has turns)
        if build.tool_trace and build.tool_trace.recent_turns:
            sections.append(ContextSection.TOOL_TRACE_SUMMARY)

        # Artifacts (if has artifacts)
        if build.artifacts and build.artifacts.artifacts:
            sections.append(ContextSection.ARTIFACTS)

        # Filesystem context (if present)
        if build.filesystem_context:
            sections.append(ContextSection.FILESYSTEM_CONTEXT)

        return sections

    def _get_section_contents(
        self,
        build: ContextBuild,
        sections: List[ContextSection]
    ) -> Dict[ContextSection, Any]:
        """
        Get content for each section.

        Returns:
            Dictionary mapping section to content
        """
        contents = {}

        for section in sections:
            if section == ContextSection.SYSTEM_CORE:
                # Build system core section
                contents[section] = SystemCoreSection(
                    principles="You are a helpful AI assistant...",
                    formatting_rules="Provide clear, concise responses.",
                    safety_guidelines="Refuse harmful requests."
                )

            elif section == ContextSection.USER_REQUEST:
                contents[section] = build.user_request

            elif section == ContextSection.TOOL_MANIFEST:
                # Placeholder - would come from tool registry
                contents[section] = ToolManifestSection(
                    tools=[],
                    tier=build.tier
                )

            elif section == ContextSection.EXECUTION_CONTRACT:
                contents[section] = ExecutionContractSection(
                    tier=build.tier,
                    max_tool_calls=50,
                    max_steps=20,
                    max_tokens_available=4096,
                    timeout_ms=300000,
                    allowed_operations=["read", "write", "bash", "search"]
                )

            elif section == ContextSection.WORKING_MEMORY:
                contents[section] = build.state.working_memory

            elif section == ContextSection.USER_RULES:
                contents[section] = build.state.user_rules

            elif section == ContextSection.TOOL_TRACE_SUMMARY:
                contents[section] = build.tool_trace

            elif section == ContextSection.ARTIFACTS:
                contents[section] = build.artifacts

            elif section == ContextSection.FILESYSTEM_CONTEXT:
                contents[section] = build.filesystem_context

        return contents

    def _apply_eviction(
        self,
        section: ContextSection,
        content: Any,
        policy: EvictionPolicy,
        target_tokens: int
    ) -> tuple[Any, int]:
        """
        Apply eviction policy to compress content.

        Args:
            section: Section type
            content: Content to compress
            policy: Eviction policy
            target_tokens: Target token count

        Returns:
            (compacted_content, actual_tokens)
        """
        if policy == EvictionPolicy.NONE:
            # No eviction allowed
            return content, self.token_estimator.count_tokens(str(content))

        elif policy == EvictionPolicy.EXCERPT:
            # Take first/last portions
            text = str(content)
            lines = text.split('\n')
            if len(lines) > 20:
                # Keep first 10 and last 10 lines
                first = '\n'.join(lines[:10])
                last = '\n'.join(lines[-10:])
                omitted = len(lines) - 20
                excerpted = f"{first}\n\n... ({omitted} lines omitted) ...\n\n{last}"
                return excerpted, self.token_estimator.count_tokens(excerpted)
            return content, self.token_estimator.count_tokens(text)

        elif policy == EvictionPolicy.DROP_OLDEST:
            # For tool trace or similar
            if hasattr(content, 'compact'):
                # Calculate target number of entries
                current_tokens = self.token_estimator.count_tokens(str(content))
                if current_tokens > target_tokens:
                    ratio = target_tokens / current_tokens
                    target_entries = int(len(getattr(content, 'recent_turns', [])) * ratio)
                    content.compact(max(1, target_entries))
                return content, self.token_estimator.count_tokens(str(content))

        elif policy == EvictionPolicy.KEEP_TOPK_BY_SCORE:
            # For working memory
            if hasattr(content, 'compact'):
                current_tokens = self.token_estimator.count_tokens(content.to_bullets())
                if current_tokens > target_tokens:
                    ratio = target_tokens / current_tokens
                    target_entries = int(len(content.entries) * ratio)
                    content.compact(max(1, target_entries))
                return content, self.token_estimator.count_tokens(content.to_bullets())

        elif policy == EvictionPolicy.TRUNCATE:
            # Hard truncate
            text = str(content)
            # Estimate chars for target tokens
            target_chars = target_tokens * 4  # Rough approximation
            if len(text) > target_chars:
                text = text[:target_chars] + "\n... (truncated)"
            return text, self.token_estimator.count_tokens(text)

        # Default: return as-is
        return content, self.token_estimator.count_tokens(str(content))

    def _determine_caching(
        self,
        section: ContextSection,
        content_hash: str,
        cache_strategy: str,
        tier: str
    ) -> tuple[Optional[str], Optional[str]]:
        """
        Determine cache key and control for section.

        Args:
            section: Section type
            content_hash: Content hash
            cache_strategy: Cache strategy
            tier: Agent tier

        Returns:
            (cache_key, cache_control) or (None, None)
        """
        # Check if section should be cached
        if not CacheStrategy.should_cache_section(section, cache_strategy):
            return None, None

        # Generate cache key
        cache_key = self.hasher.compute_cache_key(
            section=section,
            content_hash=content_hash,
            model_family=self.model_family,
            tier=tier if section == ContextSection.TOOL_MANIFEST else None
        )

        # Cache control (Anthropic uses "ephemeral")
        cache_control = "ephemeral"

        return cache_key, cache_control

    def _generate_rationale(
        self,
        section_plans: List[SectionPlan],
        build: ContextBuild,
        total_budget: int
    ) -> str:
        """Generate human-readable rationale for this plan."""
        lines = [
            f"Plan for {build.tier} tier execution",
            f"Total budget: {total_budget:,} tokens",
            f"Sections included: {len(section_plans)}",
            ""
        ]

        compacted_sections = [sp for sp in section_plans if sp.compacted]
        if compacted_sections:
            lines.append(f"Compacted {len(compacted_sections)} sections to fit budget:")
            for sp in compacted_sections:
                lines.append(
                    f"  - {sp.section.value}: {sp.original_tokens:,} → {sp.actual_tokens:,} tokens "
                    f"({sp.eviction_applied})"
                )

        return "\n".join(lines)

    def _estimate_cost(
        self,
        section_plans: List[SectionPlan],
        cache_strategy: str
    ) -> float:
        """
        Estimate API cost for this plan.

        Args:
            section_plans: Section plans
            cache_strategy: Cache strategy

        Returns:
            Estimated cost in USD
        """
        # Pricing (approximate for Claude 3.5 Sonnet)
        PRICE_PER_1M_INPUT = 3.00
        PRICE_PER_1M_CACHED = 0.30  # 90% discount

        total_tokens = 0
        cached_tokens = 0

        for sp in section_plans:
            if sp.included:
                if sp.cache_key and cache_strategy != CacheStrategy.DISABLED:
                    cached_tokens += sp.actual_tokens
                else:
                    total_tokens += sp.actual_tokens

        regular_cost = (total_tokens / 1_000_000) * PRICE_PER_1M_INPUT
        cached_cost = (cached_tokens / 1_000_000) * PRICE_PER_1M_CACHED

        return regular_cost + cached_cost
