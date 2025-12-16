"""
Token Estimation - Accurate per-provider tokenization.

This module provides accurate token counting for different LLM providers.
Uses provider-specific tokenizers instead of naive approximations.

Why this matters:
- chars/4 fails on code, JSON, paths (high density)
- Different providers use different tokenizers
- Accurate counts prevent context overflow
- Pre-checks with fast approximations avoid overhead
"""

import re
from typing import Optional
from enum import Enum


class TokenizerProvider(Enum):
    """Supported tokenizer providers."""
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    GENERIC = "generic"


class TokenEstimator:
    """
    Provider-specific token estimation with fast approximation fallback.

    Usage:
        estimator = TokenEstimator(provider="anthropic", model="claude-3-5-sonnet-20241022")
        exact_count = estimator.count_tokens(text)
        approx_count = estimator.estimate_fast(text)
    """

    def __init__(self, provider: str, model: str):
        """
        Initialize tokenizer for provider and model.

        Args:
            provider: Provider name (anthropic, openai)
            model: Model identifier
        """
        self.provider = provider
        self.model = model
        self._tokenizer = self._init_tokenizer()

    def _init_tokenizer(self):
        """Initialize provider-specific tokenizer."""
        provider_lower = self.provider.lower()

        if provider_lower == "anthropic":
            return self._init_anthropic_tokenizer()
        elif provider_lower == "openai":
            return self._init_openai_tokenizer()
        else:
            return self._init_generic_tokenizer()

    def _init_anthropic_tokenizer(self):
        """Initialize Anthropic tokenizer (fallback to tiktoken)."""
        try:
            # Try to use Anthropic's tokenizer if available
            from anthropic import Anthropic
            client = Anthropic()
            # Note: As of late 2024, Anthropic doesn't expose tokenizer directly
            # Fall back to tiktoken with cl100k_base (similar to GPT-4)
            import tiktoken
            return tiktoken.get_encoding("cl100k_base")
        except ImportError:
            # Fallback to generic
            return self._init_generic_tokenizer()

    def _init_openai_tokenizer(self):
        """Initialize OpenAI tokenizer using tiktoken."""
        try:
            import tiktoken
            # Try model-specific encoding
            try:
                return tiktoken.encoding_for_model(self.model)
            except KeyError:
                # Model not found, use cl100k_base (GPT-4 and newer)
                return tiktoken.get_encoding("cl100k_base")
        except ImportError:
            return self._init_generic_tokenizer()

    def _init_generic_tokenizer(self):
        """Fallback generic tokenizer."""
        try:
            import tiktoken
            return tiktoken.get_encoding("cl100k_base")
        except ImportError:
            # No tiktoken available, will use approximation
            return None

    def count_tokens(self, text: str) -> int:
        """
        Accurate token count using provider-specific tokenizer.

        Args:
            text: Text to tokenize

        Returns:
            Exact token count
        """
        if not text:
            return 0

        if self._tokenizer is None:
            # No tokenizer available, use estimation
            return self.estimate_fast(text)

        try:
            return len(self._tokenizer.encode(text))
        except Exception:
            # Tokenization failed, fall back to estimation
            return self.estimate_fast(text)

    def estimate_fast(self, text: str) -> int:
        """
        Fast approximation for pre-checks.

        Uses heuristics based on content type:
        - Code/JSON: chars/3 (denser)
        - Regular text: chars/4
        - Mixed: weighted average

        Args:
            text: Text to estimate

        Returns:
            Approximate token count
        """
        if not text:
            return 0

        char_count = len(text)

        if self._looks_like_code(text):
            # Code is denser - more tokens per character
            return char_count // 3
        else:
            # Regular text
            return char_count // 4

    def _looks_like_code(self, text: str) -> bool:
        """
        Heuristic to detect code/structured content.

        Args:
            text: Text to check

        Returns:
            True if text appears to be code
        """
        # Count code indicators
        code_indicators = [
            r'\{',  # Braces
            r'\}',
            r'def\s+\w+',  # Python function
            r'class\s+\w+',  # Class definition
            r'function\s+\w+',  # JavaScript function
            r'import\s+',  # Import statement
            r'const\s+\w+\s*=',  # Const declaration
            r'let\s+\w+\s*=',  # Let declaration
            r'var\s+\w+\s*=',  # Var declaration
            r'=>',  # Arrow function
            r'\[\s*\{',  # Array of objects
            r':\s*\{',  # Object value
        ]

        matches = sum(1 for indicator in code_indicators if re.search(indicator, text))

        # If 3+ indicators, likely code
        return matches >= 3

    def estimate_section_tokens(self, section_content: str, safety_margin: float = 1.1) -> int:
        """
        Estimate tokens for a section with safety margin.

        Args:
            section_content: Section content
            safety_margin: Multiplier for safety (default 1.1 = 10% buffer)

        Returns:
            Estimated token count with margin
        """
        base_estimate = self.estimate_fast(section_content)
        return int(base_estimate * safety_margin)


class TokenBudgetTracker:
    """
    Track token usage across sections with budget enforcement.

    Usage:
        tracker = TokenBudgetTracker(total_budget=180_000)
        tracker.allocate("system_core", 2000)
        tracker.use("system_core", 1850)  # Returns True
        tracker.use("system_core", 200)   # Returns False (over budget)
    """

    def __init__(self, total_budget: int):
        """
        Initialize budget tracker.

        Args:
            total_budget: Total token budget available
        """
        self.total_budget = total_budget
        self.allocations: dict[str, int] = {}
        self.usage: dict[str, int] = {}

    def allocate(self, section: str, tokens: int) -> bool:
        """
        Allocate tokens to a section.

        Args:
            section: Section name
            tokens: Tokens to allocate

        Returns:
            True if allocation succeeded, False if over budget
        """
        current_total = sum(self.allocations.values())
        if current_total + tokens > self.total_budget:
            return False

        self.allocations[section] = tokens
        self.usage[section] = 0
        return True

    def use(self, section: str, tokens: int) -> bool:
        """
        Record token usage for a section.

        Args:
            section: Section name
            tokens: Tokens used

        Returns:
            True if within budget, False if over
        """
        if section not in self.allocations:
            return False

        new_usage = self.usage.get(section, 0) + tokens
        if new_usage > self.allocations[section]:
            return False

        self.usage[section] = new_usage
        return True

    def get_remaining(self, section: str) -> int:
        """Get remaining tokens for section."""
        allocated = self.allocations.get(section, 0)
        used = self.usage.get(section, 0)
        return max(0, allocated - used)

    def get_total_used(self) -> int:
        """Get total tokens used across all sections."""
        return sum(self.usage.values())

    def get_total_remaining(self) -> int:
        """Get total remaining tokens in budget."""
        return max(0, self.total_budget - self.get_total_used())

    def to_dict(self) -> dict:
        """Export as dictionary for logging."""
        return {
            "total_budget": self.total_budget,
            "total_used": self.get_total_used(),
            "total_remaining": self.get_total_remaining(),
            "sections": {
                section: {
                    "allocated": allocated,
                    "used": self.usage.get(section, 0),
                    "remaining": self.get_remaining(section)
                }
                for section, allocated in self.allocations.items()
            }
        }
