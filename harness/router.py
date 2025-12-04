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
    Fast fallback when LLM classification is not needed.
    """

    def __init__(self):
        # Patterns for simple tasks
        self.simple_patterns = [
            r"^(what|when|where|who) (is|are|was|were)\b",
            r"^(tell me|what's|whats)\b.*\b(time|date|weather)\b",
            r"^(hi|hello|hey|thanks|thank you|bye|goodbye)\b",
            r"^(yes|no|ok|okay|sure|fine|great)\b$",
            r"^(define|meaning of|what does .* mean)\b",
            r"^(calculate|compute|what is) \d+[\+\-\*\/\^\%]\d+",
            r"^(convert|how many)\b.*\b(to|in)\b",
        ]

        # Patterns for advanced tasks
        self.advanced_patterns = [
            r"\b(write|create|generate|build|implement|develop)\b.*\b(code|program|script|application|app|function|class)\b",
            r"\b(analyze|research|investigate|deep dive)\b",
            r"\b(multiple|several|various)\b.*\b(steps|tasks|operations)\b",
            r"\b(compare|contrast|evaluate)\b.*\b(and|vs|versus)\b",
            r"\b(automate|workflow|pipeline|integration)\b",
            r"\b(debug|fix|troubleshoot|diagnose)\b.*\b(error|bug|issue|problem)\b",
            r"\b(complex|complicated|sophisticated|advanced)\b",
            r"\b(optimize|improve|enhance|refactor)\b.*\b(performance|code|system)\b",
        ]

        # Patterns indicating tool usage needed
        self.tool_patterns = [
            r"\b(search|look up|find|google)\b",
            r"\b(run|execute|open|start|launch)\b",
            r"\b(file|folder|directory|document)\b",
            r"\b(download|fetch|get from|retrieve)\b",
            r"\b(install|update|upgrade)\b",
        ]

    def classify(self, text: str) -> Optional[TaskClassification]:
        """
        Classify using pattern matching.
        Returns None if no confident match.
        """
        text_lower = text.lower().strip()

        # Check for simple patterns
        for pattern in self.simple_patterns:
            if re.search(pattern, text_lower, re.IGNORECASE):
                return TaskClassification(
                    tier=TaskTier.SIMPLE,
                    confidence=0.8,
                    reasoning="Matched simple task pattern",
                    metadata={"classifier": "pattern", "pattern": pattern}
                )

        # Check for advanced patterns
        for pattern in self.advanced_patterns:
            if re.search(pattern, text_lower, re.IGNORECASE):
                return TaskClassification(
                    tier=TaskTier.ADVANCED,
                    confidence=0.75,
                    reasoning="Matched advanced task pattern",
                    metadata={"classifier": "pattern", "pattern": pattern}
                )

        # Check for tool patterns -> standard tier
        for pattern in self.tool_patterns:
            if re.search(pattern, text_lower, re.IGNORECASE):
                return TaskClassification(
                    tier=TaskTier.STANDARD,
                    confidence=0.7,
                    reasoning="Matched tool usage pattern",
                    metadata={"classifier": "pattern", "pattern": pattern}
                )

        # No confident match
        return None


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

        # Try pattern matching first (fast)
        pattern_result = self.pattern_classifier.classify(text)
        if pattern_result and pattern_result.confidence >= 0.75:
            self.logger.router_classification(text, pattern_result.tier_name, pattern_result.confidence)
            return pattern_result

        # Use LLM classifier for uncertain cases
        if self.llm_classifier:
            result = self.llm_classifier.classify(text, context)
            self.logger.router_classification(text, result.tier_name, result.confidence)
            return result

        # Fallback to default
        default_tier = TaskTier(self.config.default_tier)
        result = TaskClassification(
            tier=default_tier,
            confidence=0.5,
            reasoning="No classifier available, using default",
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
