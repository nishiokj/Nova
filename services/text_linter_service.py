"""
Text Linter Service - Pure text cleaning and validation with no domain coupling.

Responsibilities:
- Clean transcribed speech text
- Validate text quality
- Remove filler words, normalize

Does NOT know about:
- AgentHarness
- EventBus
- Application orchestration
"""

import re
import logging
from dataclasses import dataclass
from typing import Dict


@dataclass
class LintResult:
    """Result of text linting"""
    original: str
    cleaned: str
    is_valid: bool
    word_count: int = 0
    changes_made: int = 0


# Pre-compiled regex patterns (module level)
_FILLER_PATTERNS = [
    re.compile(r'\b' + word + r'\b', re.IGNORECASE)
    for word in ['um', 'uh', 'ah', 'er', 'hmm', 'hm', 'like', 'you know', 'i mean', 'so yeah', 'basically']
]

_CORRECTION_PATTERNS = {
    re.compile(r'\bgonna\b', re.IGNORECASE): 'going to',
    re.compile(r'\bwanna\b', re.IGNORECASE): 'want to',
    re.compile(r'\bgotta\b', re.IGNORECASE): 'got to',
    re.compile(r'\bkinda\b', re.IGNORECASE): 'kind of',
    re.compile(r'\bsorta\b', re.IGNORECASE): 'sort of',
    re.compile(r'\blemme\b', re.IGNORECASE): 'let me',
    re.compile(r'\bgimme\b', re.IGNORECASE): 'give me',
}


class TextLinterService:
    """
    Pure text linting service with no domain coupling.

    Responsibilities:
    - Clean and normalize transcribed speech text
    - Validate text quality
    - Cache results for performance

    Dependencies injected:
    - Logger
    """

    def __init__(self, logger: logging.Logger, cache_size: int = 100):
        """
        Initialize text linter with injected dependencies.

        Args:
            logger: Injected logger instance
            cache_size: Maximum size of LRU cache
        """
        self.logger = logger
        self._cache: Dict[str, LintResult] = {}
        self._cache_max = cache_size

    def lint(self, text: str) -> str:
        """
        Clean and normalize transcribed text.

        Args:
            text: Raw transcribed text

        Returns:
            Cleaned text
        """
        if not text:
            return ""

        # Check cache
        if text in self._cache:
            return self._cache[text].cleaned

        cleaned = text.strip()
        changes = 0

        # Remove repeated words (common STT artifact)
        words = cleaned.split()
        deduplicated = []
        for i, word in enumerate(words):
            if i == 0 or word.lower() != words[i-1].lower():
                deduplicated.append(word)
            else:
                changes += 1
        cleaned = ' '.join(deduplicated)

        # Remove filler words using pre-compiled patterns
        for pattern in _FILLER_PATTERNS:
            before = cleaned
            cleaned = pattern.sub('', cleaned)
            if before != cleaned:
                changes += 1

        # Apply corrections using pre-compiled patterns
        for pattern, replacement in _CORRECTION_PATTERNS.items():
            before = cleaned
            cleaned = pattern.sub(replacement, cleaned)
            if before != cleaned:
                changes += 1

        # Clean up extra whitespace
        cleaned = ' '.join(cleaned.split())

        # Ensure proper sentence ending
        if cleaned and cleaned[-1] not in '.?!':
            cleaned += '.'
            changes += 1

        result = cleaned.strip()

        # Cache result
        self._cache_result(text, result, changes)

        return result

    def lint_and_validate(self, text: str, min_words: int = 2) -> LintResult:
        """
        Lint AND validate in one call (avoids duplicate linting).

        Args:
            text: Raw transcribed text
            min_words: Minimum number of words for valid input

        Returns:
            LintResult with validation status
        """
        if not text:
            return LintResult(
                original=text,
                cleaned="",
                is_valid=False,
                word_count=0,
                changes_made=0
            )

        # Check cache
        if text in self._cache:
            return self._cache[text]

        # Lint
        cleaned = self.lint(text)

        # Validate
        is_valid, word_count = self._check_validity(cleaned, min_words)

        # Count changes (approximate)
        changes = abs(len(text.split()) - word_count)

        result = LintResult(
            original=text,
            cleaned=cleaned,
            is_valid=is_valid,
            word_count=word_count,
            changes_made=changes
        )

        self._cache_result(text, cleaned, changes, is_valid, word_count)

        return result

    def _check_validity(self, cleaned: str, min_words: int) -> tuple:
        """
        Check if cleaned text is valid for processing.

        Args:
            cleaned: Cleaned text
            min_words: Minimum number of words required

        Returns:
            Tuple of (is_valid, word_count)
        """
        if not cleaned:
            return False, 0

        # Remove punctuation for word counting
        words = cleaned.replace('.', '').replace('?', '').replace('!', '').split()
        word_count = len(words)

        # Must have at least min_words meaningful words
        is_valid = word_count >= min_words

        return is_valid, word_count

    def _cache_result(
        self,
        original: str,
        cleaned: str,
        changes: int,
        is_valid: bool = True,
        word_count: int = 0
    ):
        """Cache lint result with LRU eviction"""
        if len(self._cache) >= self._cache_max:
            # Remove oldest entry
            oldest = next(iter(self._cache))
            del self._cache[oldest]

        self._cache[original] = LintResult(
            original=original,
            cleaned=cleaned,
            is_valid=is_valid,
            word_count=word_count,
            changes_made=changes
        )

    def is_valid_input(self, text: str, min_words: int = 2) -> bool:
        """
        Check validity (uses cache).

        Args:
            text: Raw transcribed text
            min_words: Minimum number of words required

        Returns:
            True if valid input
        """
        result = self.lint_and_validate(text, min_words)
        return result.is_valid

    def clear_cache(self):
        """Clear the LRU cache"""
        self._cache.clear()
        self.logger.debug("Linter cache cleared")
