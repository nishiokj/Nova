"""
Intent Classifier - Detects user intent from speech input.

Hybrid approach:
1. Rule-based for obvious cases (fast, no LLM cost)
2. LLM-based for ambiguous cases (accurate)
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional, Dict, Any, List
import re
from util.llm_adapter import LLMAdapter, Message, MessageRole, create_adapter
from util.logger import StructuredLogger
from util.config import LLMConfig


class UserIntent(Enum):
    """User intent types"""
    NORMAL_REQUEST = "normal_request"      # Regular agent request
    STOP = "stop"                          # Stop current execution
    CLARIFICATION = "clarification"        # Adding clarification to current task
    ADDITION = "addition"                  # Adding new requirement to current task
    QUESTION = "question"                  # Question about current task status
    CANCEL = "cancel"                      # Cancel and start fresh


@dataclass
class IntentClassification:
    """Result of intent classification"""
    intent: UserIntent
    confidence: float  # 0.0 to 1.0
    text: str  # Original text
    extracted_content: Optional[str] = None  # Extracted clarification/addition content
    metadata: Dict[str, Any] = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}


class HybridIntentClassifier:
    """
    Hybrid intent classifier using rules + LLM.

    Fast rule-based classification for obvious cases (stop, wait, etc).
    LLM classification for ambiguous cases.
    """

    # Rule patterns for high-confidence classification
    STOP_PATTERNS = [
        r'\b(stop|halt|cancel|abort|nevermind|never mind)\b',
        r'^(no|nope|wait)$',
        r'\bstop (that|it|now)\b',
        r'\bwait( a (sec|second|minute|moment))?$',
    ]

    CLARIFICATION_PATTERNS = [
        r'\b(i meant|i mean|actually|to clarify|let me clarify)\b',
        r'\b(correction|specifically|more specifically)\b',
        r'\bthat should be\b',
    ]

    ADDITION_PATTERNS = [
        r'\b(also|and also|additionally|plus)\b',
        r'\bone more thing\b',
        r'\boh and\b',
        r'\bwhile you\'?re at it\b',
    ]

    QUESTION_PATTERNS = [
        r'\b(what are you doing|where are you|are you done|how\'?s it going)\b',
        r'\b(status|progress|what\'?s (the )?status)\b',
        r'^(done yet|finished|ready)\??$',
    ]

    def __init__(
        self,
        llm_config: Optional[LLMConfig] = None,
        logger: Optional[StructuredLogger] = None,
        use_llm: bool = True
    ):
        self.logger = logger or StructuredLogger()
        self.use_llm = use_llm

        # LLM adapter for ambiguous cases
        self._llm: Optional[LLMAdapter] = None
        if use_llm and llm_config:
            self._llm = create_adapter(llm_config, logger=self.logger)

    def classify(
        self,
        text: str,
        agent_is_busy: bool = False,
        current_task: Optional[str] = None
    ) -> IntentClassification:
        """
        Classify user intent.

        Args:
            text: User's speech text
            agent_is_busy: Whether agent is currently executing a task
            current_task: Description of current task (if any)

        Returns:
            IntentClassification with detected intent
        """
        text_clean = text.strip().lower()

        # Step 1: Rule-based classification (fast path)
        rule_result = self._classify_by_rules(text_clean, agent_is_busy)
        if rule_result and rule_result.confidence >= 0.9:
            self.logger.info(
                f"Intent classified by rules: {rule_result.intent.value}",
                component="intent_classifier"
            )
            return rule_result

        # Step 2: LLM classification for ambiguous cases
        if self.use_llm and self._llm and agent_is_busy:
            llm_result = self._classify_by_llm(text, agent_is_busy, current_task)
            if llm_result:
                self.logger.info(
                    f"Intent classified by LLM: {llm_result.intent.value} (conf={llm_result.confidence:.2f})",
                    component="intent_classifier"
                )
                return llm_result

        # Step 3: Default to NORMAL_REQUEST
        default_intent = UserIntent.NORMAL_REQUEST

        result = IntentClassification(
            intent=default_intent,
            confidence=0.5 if rule_result else 0.3,
            text=text,
            metadata={"method": "default"}
        )

        self.logger.info(
            f"Intent defaulted to: {result.intent.value}",
            component="intent_classifier"
        )
        return result

    def _classify_by_rules(
        self,
        text_clean: str,
        agent_is_busy: bool
    ) -> Optional[IntentClassification]:
        """
        Fast rule-based classification.

        Returns high-confidence classification or None.
        """
        # Check STOP patterns (highest priority when agent is busy)
        if agent_is_busy:
            for pattern in self.STOP_PATTERNS:
                if re.search(pattern, text_clean, re.IGNORECASE):
                    return IntentClassification(
                        intent=UserIntent.STOP,
                        confidence=0.95,
                        text=text_clean,
                        metadata={"method": "rule", "pattern": pattern}
                    )

        # Check CLARIFICATION patterns
        for pattern in self.CLARIFICATION_PATTERNS:
            if re.search(pattern, text_clean, re.IGNORECASE):
                # Extract content after the clarification marker
                content = self._extract_clarification_content(text_clean)
                return IntentClassification(
                    intent=UserIntent.CLARIFICATION if agent_is_busy else UserIntent.NORMAL_REQUEST,
                    confidence=0.85 if agent_is_busy else 0.6,
                    text=text_clean,
                    extracted_content=content,
                    metadata={"method": "rule", "pattern": pattern}
                )

        # Check ADDITION patterns
        for pattern in self.ADDITION_PATTERNS:
            if re.search(pattern, text_clean, re.IGNORECASE):
                content = self._extract_addition_content(text_clean)
                return IntentClassification(
                    intent=UserIntent.ADDITION if agent_is_busy else UserIntent.NORMAL_REQUEST,
                    confidence=0.85 if agent_is_busy else 0.6,
                    text=text_clean,
                    extracted_content=content,
                    metadata={"method": "rule", "pattern": pattern}
                )

        # Check QUESTION patterns
        for pattern in self.QUESTION_PATTERNS:
            if re.search(pattern, text_clean, re.IGNORECASE):
                return IntentClassification(
                    intent=UserIntent.QUESTION,
                    confidence=0.9,
                    text=text_clean,
                    metadata={"method": "rule", "pattern": pattern}
                )

        return None

    def _classify_by_llm(
        self,
        text: str,
        agent_is_busy: bool,
        current_task: Optional[str]
    ) -> Optional[IntentClassification]:
        """
        LLM-based classification for ambiguous cases.
        """
        if not self._llm:
            return None

        # Build prompt
        context = f"The agent is currently working on: {current_task}" if current_task else "The agent is currently busy."

        system_prompt = """You are an intent classifier. Classify user intent into one of these categories:

- STOP: User wants to stop/cancel current execution
- CLARIFICATION: User is clarifying their previous request
- ADDITION: User is adding a new requirement to current task
- QUESTION: User is asking about status/progress
- NORMAL_REQUEST: User is making a new request

Respond with ONLY the category name, nothing else."""

        user_prompt = f"""Agent status: {context if agent_is_busy else "Agent is idle"}

User says: "{text}"

Intent:"""

        try:
            messages = [
                Message(role=MessageRole.SYSTEM, content=system_prompt),
                Message(role=MessageRole.USER, content=user_prompt)
            ]

            response = self._llm.complete(messages, temperature=0.0, max_tokens=20)
            intent_str = response.content.strip().upper()

            # Parse intent
            intent_map = {
                "STOP": UserIntent.STOP,
                "CANCEL": UserIntent.STOP,
                "CLARIFICATION": UserIntent.CLARIFICATION,
                "ADDITION": UserIntent.ADDITION,
                "QUESTION": UserIntent.QUESTION,
                "NORMAL_REQUEST": UserIntent.NORMAL_REQUEST,
                "NORMAL": UserIntent.NORMAL_REQUEST,
            }

            intent = intent_map.get(intent_str, UserIntent.NORMAL_REQUEST)

            return IntentClassification(
                intent=intent,
                confidence=0.8,  # LLM confidence
                text=text,
                metadata={"method": "llm", "raw_response": intent_str}
            )

        except Exception as e:
            self.logger.error(
                f"LLM intent classification failed: {e}",
                component="intent_classifier"
            )
            return None

    def _extract_clarification_content(self, text: str) -> str:
        """Extract the actual clarification from text"""
        # Remove clarification markers
        markers = [
            "i meant", "i mean", "actually", "to clarify", "let me clarify",
            "correction", "specifically", "more specifically", "that should be"
        ]

        result = text
        for marker in markers:
            if marker in result:
                result = result.split(marker, 1)[1].strip()
                break

        return result

    def _extract_addition_content(self, text: str) -> str:
        """Extract the actual addition from text"""
        # Remove addition markers
        markers = [
            "also", "and also", "additionally", "plus", "one more thing",
            "oh and", "while you're at it", "while youre at it"
        ]

        result = text
        for marker in markers:
            if marker in result:
                result = result.split(marker, 1)[1].strip()
                break

        return result


def create_intent_classifier(
    llm_config: Optional[LLMConfig] = None,
    logger: Optional[StructuredLogger] = None,
    use_llm: bool = True
) -> HybridIntentClassifier:
    """
    Factory function to create intent classifier.

    Args:
        llm_config: LLM configuration for ambiguous case classification
        logger: Logger instance
        use_llm: Whether to use LLM for ambiguous cases

    Returns:
        HybridIntentClassifier instance
    """
    return HybridIntentClassifier(
        llm_config=llm_config,
        logger=logger,
        use_llm=use_llm
    )
