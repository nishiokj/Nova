"""
Rules Loader - Loads and merges rules from multiple sources.

This module handles loading user rules from:
1. Global rules.md (~/.config/jesus/rules.md) - user defaults
2. Repository rules (./repository.md) - project-specific overrides
3. OS/environment info - automatic platform detection

Rules are loaded once at session start and cached in UserRules.
"""

import os
import platform
import re
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field


@dataclass
class LoadedRules:
    """Container for rules loaded from a single file."""
    path: str
    rules: List[str] = field(default_factory=list)
    categories: Dict[str, List[str]] = field(default_factory=dict)
    raw_content: str = ""


class RulesLoader:
    """
    Loads and merges rules from multiple sources.

    Priority (highest to lowest):
    1. repository.md (project root) - overrides defaults
    2. rules.md (~/.config/jesus/rules.md) - user defaults
    3. Built-in OS info - always present
    """

    # Default location for global rules
    DEFAULT_RULES_LOCATIONS = [
        "~/.config/jesus/rules.md",
        "~/.jesus/rules.md",
    ]

    # Repository rules filename
    REPO_RULES_FILENAME = "repository.md"

    def __init__(self, working_dir: Optional[str] = None):
        """
        Initialize the rules loader.

        Args:
            working_dir: Working directory for repository.md discovery.
                        Defaults to current working directory.
        """
        self.working_dir = working_dir or os.getcwd()

    def load(self) -> Tuple[List[str], Dict[str, Any], Optional[str], Optional[str]]:
        """
        Load rules from all sources and merge them.

        Returns:
            Tuple of (rules_list, preferences_dict, global_rules_path, repo_rules_path)
        """
        # 1. Get OS info (always present)
        os_info = self._get_os_info()

        # 2. Load global rules.md
        global_rules = self._load_global_rules()

        # 3. Load repository.md from working_dir
        repo_rules = self._load_repo_rules()

        # 4. Merge rules (repo rules come after global rules)
        merged_rules: List[str] = []
        categories: Dict[str, List[str]] = {}

        if global_rules:
            merged_rules.extend(global_rules.rules)
            for cat, rules in global_rules.categories.items():
                categories[cat] = rules.copy()

        if repo_rules:
            merged_rules.extend(repo_rules.rules)
            for cat, rules in repo_rules.categories.items():
                if cat in categories:
                    categories[cat].extend(rules)
                else:
                    categories[cat] = rules.copy()

        # Build preferences dict
        preferences: Dict[str, Any] = {
            "os_info": os_info,
        }

        if categories:
            preferences["rule_categories"] = categories

        return (
            merged_rules,
            preferences,
            global_rules.path if global_rules else None,
            repo_rules.path if repo_rules else None,
        )

    def _get_os_info(self) -> Dict[str, str]:
        """
        Get platform information for bash behavior hints.

        Returns:
            Dictionary with system info.
        """
        system = platform.system()

        # Add friendly name for common systems
        system_friendly = {
            "Darwin": "macOS",
            "Linux": "Linux",
            "Windows": "Windows",
        }.get(system, system)

        return {
            "system": system,
            "system_friendly": system_friendly,
            "release": platform.release(),
            "machine": platform.machine(),
            "python_version": platform.python_version(),
        }

    def _load_global_rules(self) -> Optional[LoadedRules]:
        """
        Load global rules from default locations.

        Checks locations in order, returns first found.
        """
        for location in self.DEFAULT_RULES_LOCATIONS:
            expanded_path = os.path.expanduser(location)
            if os.path.isfile(expanded_path):
                return self._load_markdown_rules(expanded_path)

        return None

    def _load_repo_rules(self) -> Optional[LoadedRules]:
        """
        Load repository-specific rules from working directory.
        """
        repo_rules_path = os.path.join(self.working_dir, self.REPO_RULES_FILENAME)

        if os.path.isfile(repo_rules_path):
            return self._load_markdown_rules(repo_rules_path)

        return None

    def _load_markdown_rules(self, path: str) -> LoadedRules:
        """
        Parse a markdown file into rules.

        Extracts:
        - Bullet points (-, *, +) as individual rules
        - Headings (##) as rule categories

        Args:
            path: Path to the markdown file

        Returns:
            LoadedRules with parsed content
        """
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
        except (IOError, OSError):
            return LoadedRules(path=path)

        rules: List[str] = []
        categories: Dict[str, List[str]] = {}
        current_category: Optional[str] = None

        # Patterns
        heading_pattern = re.compile(r'^#{1,3}\s+(.+)$')
        bullet_pattern = re.compile(r'^[\s]*[-*+]\s+(.+)$')

        for line in content.split('\n'):
            line = line.rstrip()

            # Check for heading
            heading_match = heading_pattern.match(line)
            if heading_match:
                current_category = heading_match.group(1).strip()
                if current_category not in categories:
                    categories[current_category] = []
                continue

            # Check for bullet point
            bullet_match = bullet_pattern.match(line)
            if bullet_match:
                rule_text = bullet_match.group(1).strip()
                if rule_text:
                    rules.append(rule_text)
                    if current_category:
                        categories[current_category].append(rule_text)

        # Remove empty categories (headings without bullet points)
        categories = {k: v for k, v in categories.items() if v}

        return LoadedRules(
            path=path,
            rules=rules,
            categories=categories,
            raw_content=content,
        )


def load_rules_for_session(working_dir: Optional[str] = None) -> Dict[str, Any]:
    """
    Convenience function to load rules for a new session.

    Args:
        working_dir: Working directory for repository.md discovery

    Returns:
        Dictionary suitable for constructing UserRules:
        {
            "rules": [...],
            "preferences": {...},
            "global_rules_path": "...",
            "repo_rules_path": "...",
        }
    """
    loader = RulesLoader(working_dir=working_dir)
    rules, preferences, global_path, repo_path = loader.load()

    return {
        "rules": rules,
        "preferences": preferences,
        "global_rules_path": global_path,
        "repo_rules_path": repo_path,
    }
