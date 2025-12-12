"""
Language domain services.

Contains utilities for NLP-specific processing such as linting.
"""

from .text_linter_service import TextLinterService, LintResult

__all__ = ['TextLinterService', 'LintResult']
