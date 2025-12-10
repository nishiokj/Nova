"""
Router - Task classification and routing component.
Classifies incoming requests and routes to appropriate agent tier.
"""

import re
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List
from enum import Enum

from .config import RouterConfig, LLMConfig
from .llm_adapter import LLMAdapter, create_adapter, Message, MessageRole
from .logger import get_logger


class TaskTier(Enum):
    """Task difficulty tiers"""
    SIMPLE = "simple"
    STANDARD = "standard"
    ADVANCED = "advanced"


@dataclass
class TaskClassification:
    """Result of task classification"""
    tier: TaskTier
    confidence: float
    reasoning: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def tier_name(self) -> str:
        return self.tier.value


class PatternClassifier:
    """
    Rule-based classifier using patterns.
    OPTIMIZED: Expanded patterns for higher confidence, fewer LLM fallbacks.
    """

    def __init__(self):
        # Load patterns from config
        patterns = self._load_patterns()
        self.simple_patterns = patterns.get("simple_patterns", [])
        self.advanced_patterns = patterns.get("advanced_patterns", [])
        self.tool_patterns = patterns.get("tool_patterns", [])

        # Pre-compile all patterns for speed
        self._compiled_simple = [re.compile(p, re.IGNORECASE) for p in self.simple_patterns]
        self._compiled_advanced = [re.compile(p, re.IGNORECASE) for p in self.advanced_patterns]
        self._compiled_tool = [re.compile(p, re.IGNORECASE) for p in self.tool_patterns]

    def _load_patterns(self) -> Dict[str, List[str]]:
        """Load pattern lists from config file"""
        import json
        from pathlib import Path

        config_path = Path(__file__).parent.parent / "config" / "router_patterns_config.json"
        try:
            with open(config_path, 'r') as f:
                return json.load(f)
        except Exception:
            # Fallback to hardcoded defaults
            return {
                "simple_patterns": [
                    r"^(what|when|where|who|how) (is|are|was|were|do|does|did)\b",
                    r"^(tell me|what's|whats|what is)\b",
                    r"^(can you|could you|would you)\b.*(tell|explain|describe)\b",
                    r"\b(time|date|weather|temperature|forecast)\b",
                    r"^(hi|hello|hey|thanks|thank you|bye|goodbye|good morning|good afternoon|good evening)\b",
                    r"^(yes|no|ok|okay|sure|fine|great|yep|nope|yeah|nah)\b$",
                    r"^(define|meaning of|what does .* mean|explain)\b",
                    r"\b(definition|meaning)\b.*\bof\b",
                    r"(calculate|compute|what is|how much is).*\d+",
                    r"\d+\s*[\+\-\*\/\^\%]\s*\d+",
                    r"(convert|how many)\b.*\b(to|in|from)\b",
                    r"^(show|display|list|give me)\b",
                    r"\b(summarize|summary|tldr|brief)\b",
                    r"^(who|what) (invented|created|discovered|founded|wrote|made)\b",
                    r"\b(capital|population|president|ceo|founder)\b.*\bof\b",
                ],
                "advanced_patterns": [
                    r"\b(write|create|generate|build|implement|develop|code)\b.*\b(code|program|script|application|app|function|class|module|api)\b",
                    r"\b(programming|coding|software|algorithm)\b",
                    r"\b(analyze|research|investigate|deep dive|examine|study)\b",
                    r"\b(multiple|several|various|many)\b.*\b(steps|tasks|operations|files)\b",
                    r"\b(compare|contrast|evaluate|assess|review)\b.*\b(and|vs|versus|between)\b",
                    r"\b(automate|workflow|pipeline|integration|deploy|ci/cd)\b",
                    r"\b(debug|fix|troubleshoot|diagnose|solve)\b.*\b(error|bug|issue|problem|exception)\b",
                    r"\b(complex|complicated|sophisticated|advanced|comprehensive)\b",
                    r"\b(optimize|improve|enhance|refactor|redesign|architect)\b",
                    r"\b(step by step|walkthrough|guide me|help me build)\b",
                    r"\b(entire|whole|full|complete)\b.*\b(project|system|application)\b",
                ],
                "tool_patterns": [
                    r"\b(search|look up|find|google|browse|web)\b",
                    r"\b(download|fetch|get from|retrieve|pull)\b",
                    r"\b(run|execute|open|start|launch|call)\b",
                    r"\b(file|folder|directory|document|read|write|save|load)\b",
                    r"\b(install|update|upgrade|uninstall|pip|npm|brew)\b",
                    r"\b(terminal|command|shell|bash|cli)\b",
                    r"\b(api|endpoint|request|response|http|url|fetch)\b",
                ]
            }

    def classify(self, text: str) -> Optional[TaskClassification]:
        """
        Classify using pattern matching.
        OPTIMIZED: Uses pre-compiled patterns, higher confidence thresholds.
        Returns None only if no match at all (rare with expanded patterns).
        """
        text_lower = text.lower().strip()

        # Check for simple patterns (using pre-compiled)
        for i, pattern in enumerate(self._compiled_simple):
            if pattern.search(text_lower):
                return TaskClassification(
                    tier=TaskTier.SIMPLE,
                    confidence=0.85,  # Higher confidence with expanded patterns
                    reasoning="Matched simple task pattern",
                    metadata={"classifier": "pattern", "pattern_idx": i}
                )

        # Check for advanced patterns
        for i, pattern in enumerate(self._compiled_advanced):
            if pattern.search(text_lower):
                return TaskClassification(
                    tier=TaskTier.ADVANCED,
                    confidence=0.80,  # Higher confidence
                    reasoning="Matched advanced task pattern",
                    metadata={"classifier": "pattern", "pattern_idx": i}
                )

        # Check for tool patterns -> standard tier
        for i, pattern in enumerate(self._compiled_tool):
            if pattern.search(text_lower):
                return TaskClassification(
                    tier=TaskTier.STANDARD,
                    confidence=0.75,  # Higher confidence
                    reasoning="Matched tool usage pattern",
                    metadata={"classifier": "pattern", "pattern_idx": i}
                )

        # OPTIMIZATION: Default to STANDARD instead of None
        # This avoids expensive LLM fallback for unmatched queries
        # Most queries that don't match explicit patterns are standard tasks
        return TaskClassification(
            tier=TaskTier.STANDARD,
            confidence=0.6,
            reasoning="No pattern match, defaulting to standard",
            metadata={"classifier": "pattern_default"}
        )


class LLMClassifier:
    """
    LLM-based classifier for nuanced task classification.
    """

    def __init__(self, config: LLMConfig):
        self.adapter = create_adapter(config)
        self.logger = get_logger()

    def classify(self, text: str, context: Optional[str] = None) -> TaskClassification:
        """Classify task using LLM"""
        prompt = f"""Classify the following user request into a task difficulty tier.

Tiers:
- simple: Direct questions, basic info retrieval, single-step tasks, greetings, simple calculations
- standard: Tasks requiring tool usage (web search, file operations), multi-step but straightforward tasks
- advanced: Complex reasoning, code generation, multi-tool workflows, research tasks, debugging

User request: "{text}"
{f"Additional context: {context}" if context else ""}

Respond with exactly one word: simple, standard, or advanced"""

        try:
            messages = [
                Message(MessageRole.SYSTEM, "You are a task classifier. Respond with only: simple, standard, or advanced"),
                Message(MessageRole.USER, prompt)
            ]

            response = self.adapter.complete(messages, max_tokens=10, temperature=0.1)
            tier_str = response.content.strip().lower()

            # Parse response
            tier_map = {
                "simple": TaskTier.SIMPLE,
                "standard": TaskTier.STANDARD,
                "advanced": TaskTier.ADVANCED
            }

            tier = tier_map.get(tier_str, TaskTier.STANDARD)

            return TaskClassification(
                tier=tier,
                confidence=0.85,
                reasoning=f"LLM classified as {tier_str}",
                metadata={"classifier": "llm", "raw_response": tier_str}
            )

        except Exception as e:
            self.logger.error(f"LLM classification failed: {e}", component="router")
            # Fallback to standard tier
            return TaskClassification(
                tier=TaskTier.STANDARD,
                confidence=0.5,
                reasoning=f"LLM classification failed, using default: {e}",
                metadata={"classifier": "fallback", "error": str(e)}
            )


class Router:
    """
    Main router component.
    Classifies tasks and routes to appropriate agent tier.
    """

    def __init__(self, config: RouterConfig):
        self.config = config
        self.logger = get_logger()
        self.enabled = config.enabled

        # Initialize classifiers
        self.pattern_classifier = PatternClassifier()
        self.llm_classifier = None
        if config.llm_config:
            self.llm_classifier = LLMClassifier(config.llm_config)

        # Tier to config mapping
        self.tier_configs: Dict[TaskTier, Any] = {}

    def set_tier_config(self, tier: TaskTier, config: Any):
        """Set configuration for a specific tier"""
        self.tier_configs[tier] = config

    def classify(self, text: str, context: Optional[str] = None) -> TaskClassification:
        """
        Classify incoming text and determine appropriate tier.
        OPTIMIZED: Pattern classifier always returns result, LLM fallback skipped.

        Args:
            text: The user input to classify
            context: Optional conversation context

        Returns:
            TaskClassification with tier and confidence
        """
        if not self.enabled:
            # Router disabled, return default tier
            default_tier = TaskTier(self.config.default_tier)
            return TaskClassification(
                tier=default_tier,
                confidence=1.0,
                reasoning="Router disabled, using default tier",
                metadata={"classifier": "disabled"}
            )

        # OPTIMIZED: Pattern matching is now comprehensive enough to handle all cases
        # The pattern classifier always returns a result (never None)
        # This eliminates the expensive LLM fallback that was adding 100-800ms latency
        pattern_result = self.pattern_classifier.classify(text)

        # Pattern classifier now always returns a result
        if pattern_result:
            self.logger.router_classification(text, pattern_result.tier_name, pattern_result.confidence)
            return pattern_result

        # This fallback should never be reached, but keep for safety
        default_tier = TaskTier(self.config.default_tier)
        result = TaskClassification(
            tier=default_tier,
            confidence=0.5,
            reasoning="Fallback to default",
            metadata={"classifier": "fallback"}
        )
        self.logger.router_classification(text, result.tier_name, result.confidence)
        return result

    def route(self, text: str, context: Optional[str] = None) -> tuple:
        """
        Route request to appropriate tier and return classification + tier config.

        Returns:
            Tuple of (TaskClassification, tier_config)
        """
        classification = self.classify(text, context)
        tier_config = self.tier_configs.get(classification.tier)

        return classification, tier_config

    def enable(self):
        """Enable router"""
        self.enabled = True
        self.config.enabled = True

    def disable(self):
        """Disable router"""
        self.enabled = False
        self.config.enabled = False

    def set_default_tier(self, tier: str):
        """Set default tier when router is disabled"""
        if tier in [t.value for t in TaskTier]:
            self.config.default_tier = tier


class AdaptiveRouter(Router):
    """
    Adaptive router that learns from feedback.
    Adjusts classification based on outcome.
    """

    def __init__(self, config: RouterConfig):
        super().__init__(config)
        self.feedback_history: List[Dict[str, Any]] = []
        self.pattern_weights: Dict[str, float] = {}

    def record_feedback(
        self,
        text: str,
        classification: TaskClassification,
        actual_tier: TaskTier,
        success: bool
    ):
        """
        Record feedback for a classification.
        Used to adjust future classifications.
        """
        self.feedback_history.append({
            "text": text,
            "classified_tier": classification.tier,
            "actual_tier": actual_tier,
            "success": success,
            "confidence": classification.confidence
        })

        # Adjust if classification was wrong
        if classification.tier != actual_tier:
            self.logger.warning(
                f"Classification mismatch: {classification.tier.value} -> {actual_tier.value}",
                component="router",
                data={"text_preview": text[:50]}
            )

    def get_classification_accuracy(self) -> Dict[str, float]:
        """Get classification accuracy statistics"""
        if not self.feedback_history:
            return {}

        total = len(self.feedback_history)
        correct = sum(1 for f in self.feedback_history if f["classified_tier"] == f["actual_tier"])

        tier_stats = {}
        for tier in TaskTier:
            tier_records = [f for f in self.feedback_history if f["actual_tier"] == tier]
            if tier_records:
                tier_correct = sum(1 for f in tier_records if f["classified_tier"] == tier)
                tier_stats[tier.value] = tier_correct / len(tier_records)

        return {
            "overall_accuracy": correct / total,
            "total_classifications": total,
            "tier_accuracy": tier_stats
        }
