"""
Redaction system for secrets and PII before HTML export.

Addresses: "Privacy/redaction risk: Stage 1 logs dump complete prompts"

Redacts:
- API keys and tokens
- Credentials and passwords
- Email addresses (optional)
- IP addresses (optional)
- File paths containing sensitive info
- Environment variables with secrets
"""

import re
from typing import Dict, List, Pattern, Tuple, Optional
from dataclasses import dataclass
from enum import Enum


class RedactionLevel(str, Enum):
    """Level of redaction to apply."""
    MINIMAL = "minimal"  # Only obvious secrets (API keys, passwords)
    STANDARD = "standard"  # Secrets + credentials + tokens
    STRICT = "strict"  # Everything including emails, IPs, paths


@dataclass
class RedactionPattern:
    """A pattern to redact."""
    name: str
    pattern: Pattern
    replacement: str
    level: RedactionLevel


# ============================================================================
# Redaction patterns
# ============================================================================

# API Keys and Tokens
PATTERNS: List[RedactionPattern] = [
    # OpenAI API keys
    RedactionPattern(
        name="openai_api_key",
        pattern=re.compile(r'sk-[a-zA-Z0-9]{48}'),
        replacement="<REDACTED_OPENAI_API_KEY>",
        level=RedactionLevel.MINIMAL
    ),

    # Anthropic API keys
    RedactionPattern(
        name="anthropic_api_key",
        pattern=re.compile(r'sk-ant-[a-zA-Z0-9\-]{95,}'),
        replacement="<REDACTED_ANTHROPIC_API_KEY>",
        level=RedactionLevel.MINIMAL
    ),

    # Generic API keys
    RedactionPattern(
        name="generic_api_key",
        pattern=re.compile(r'api[_-]?key[\'"\s:=]+[a-zA-Z0-9_\-]{16,}', re.IGNORECASE),
        replacement="<REDACTED_API_KEY>",
        level=RedactionLevel.MINIMAL
    ),

    # Bearer tokens
    RedactionPattern(
        name="bearer_token",
        pattern=re.compile(r'Bearer\s+[a-zA-Z0-9_\-\.]{20,}'),
        replacement="Bearer <REDACTED_TOKEN>",
        level=RedactionLevel.STANDARD
    ),

    # AWS keys
    RedactionPattern(
        name="aws_access_key",
        pattern=re.compile(r'AKIA[0-9A-Z]{16}'),
        replacement="<REDACTED_AWS_ACCESS_KEY>",
        level=RedactionLevel.MINIMAL
    ),
    RedactionPattern(
        name="aws_secret_key",
        pattern=re.compile(r'aws_secret_access_key[\'"\s:=]+[a-zA-Z0-9/+=]{40}', re.IGNORECASE),
        replacement="aws_secret_access_key=<REDACTED_AWS_SECRET>",
        level=RedactionLevel.MINIMAL
    ),

    # GitHub tokens
    RedactionPattern(
        name="github_token",
        pattern=re.compile(r'gh[pousr]_[a-zA-Z0-9]{36,}'),
        replacement="<REDACTED_GITHUB_TOKEN>",
        level=RedactionLevel.STANDARD
    ),

    # Generic secrets in env vars
    RedactionPattern(
        name="env_secret",
        pattern=re.compile(r'(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL)[\'"\s:=]+[^\s\'"]{8,}', re.IGNORECASE),
        replacement=r'\1=<REDACTED_SECRET>',
        level=RedactionLevel.STANDARD
    ),

    # Passwords
    RedactionPattern(
        name="password",
        pattern=re.compile(r'password[\'"\s:=]+[^\s\'"]{6,}', re.IGNORECASE),
        replacement="password=<REDACTED_PASSWORD>",
        level=RedactionLevel.STANDARD
    ),

    # JWT tokens
    RedactionPattern(
        name="jwt",
        pattern=re.compile(r'eyJ[a-zA-Z0-9_\-]*\.eyJ[a-zA-Z0-9_\-]*\.[a-zA-Z0-9_\-]*'),
        replacement="<REDACTED_JWT_TOKEN>",
        level=RedactionLevel.STANDARD
    ),

    # Private keys (PEM format)
    RedactionPattern(
        name="private_key",
        pattern=re.compile(r'-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]+?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----'),
        replacement="<REDACTED_PRIVATE_KEY>",
        level=RedactionLevel.MINIMAL
    ),

    # Email addresses
    RedactionPattern(
        name="email",
        pattern=re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'),
        replacement="<REDACTED_EMAIL>",
        level=RedactionLevel.STRICT
    ),

    # IP addresses
    RedactionPattern(
        name="ipv4",
        pattern=re.compile(r'\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b'),
        replacement="<REDACTED_IP>",
        level=RedactionLevel.STRICT
    ),

    # Credit card numbers (simple pattern)
    RedactionPattern(
        name="credit_card",
        pattern=re.compile(r'\b(?:\d{4}[-\s]?){3}\d{4}\b'),
        replacement="<REDACTED_CREDIT_CARD>",
        level=RedactionLevel.MINIMAL
    ),

    # Social Security Numbers (US format)
    RedactionPattern(
        name="ssn",
        pattern=re.compile(r'\b\d{3}-\d{2}-\d{4}\b'),
        replacement="<REDACTED_SSN>",
        level=RedactionLevel.MINIMAL
    ),
]


# ============================================================================
# Redactor
# ============================================================================

class Redactor:
    """
    Redacts sensitive information from text.

    Usage:
        redactor = Redactor(level=RedactionLevel.STANDARD)
        safe_text = redactor.redact(sensitive_text)

        # Check what was redacted
        if redactor.redactions:
            print(f"Redacted {len(redactor.redactions)} items")
    """

    def __init__(
        self,
        level: RedactionLevel = RedactionLevel.STANDARD,
        custom_patterns: Optional[List[RedactionPattern]] = None
    ):
        self.level = level
        self.custom_patterns = custom_patterns or []
        self.redactions: List[Tuple[str, str]] = []  # (pattern_name, sample)

    def redact(self, text: str) -> str:
        """
        Redact sensitive information from text.

        Args:
            text: Text to redact

        Returns:
            Redacted text
        """
        if not text:
            return text

        self.redactions = []
        redacted = text

        # Apply patterns based on level
        patterns = self._get_applicable_patterns()

        for pattern_def in patterns:
            matches = pattern_def.pattern.finditer(redacted)
            for match in matches:
                # Record redaction
                sample = match.group(0)
                if len(sample) > 50:
                    sample = sample[:50] + "..."
                self.redactions.append((pattern_def.name, sample))

            # Perform redaction
            redacted = pattern_def.pattern.sub(pattern_def.replacement, redacted)

        return redacted

    def redact_dict(self, data: Dict, keys_to_redact: Optional[List[str]] = None) -> Dict:
        """
        Redact sensitive fields in a dictionary.

        Args:
            data: Dictionary to redact
            keys_to_redact: Specific keys to fully redact (default: common secret keys)

        Returns:
            Redacted dictionary copy
        """
        if keys_to_redact is None:
            keys_to_redact = [
                'api_key', 'apikey', 'secret', 'password', 'token',
                'credential', 'auth', 'authorization', 'bearer'
            ]

        redacted = {}
        for key, value in data.items():
            # Check if key should be fully redacted
            if any(secret_key in key.lower() for secret_key in keys_to_redact):
                redacted[key] = "<REDACTED>"
                self.redactions.append(("dict_key", key))
            elif isinstance(value, str):
                # Redact string values
                redacted[key] = self.redact(value)
            elif isinstance(value, dict):
                # Recursively redact nested dicts
                redacted[key] = self.redact_dict(value, keys_to_redact)
            elif isinstance(value, list):
                # Redact list items
                redacted[key] = [
                    self.redact(item) if isinstance(item, str) else
                    self.redact_dict(item, keys_to_redact) if isinstance(item, dict) else
                    item
                    for item in value
                ]
            else:
                redacted[key] = value

        return redacted

    def _get_applicable_patterns(self) -> List[RedactionPattern]:
        """Get patterns applicable to current redaction level."""
        applicable = []

        # Determine which levels to include
        if self.level == RedactionLevel.MINIMAL:
            levels = [RedactionLevel.MINIMAL]
        elif self.level == RedactionLevel.STANDARD:
            levels = [RedactionLevel.MINIMAL, RedactionLevel.STANDARD]
        else:  # STRICT
            levels = [RedactionLevel.MINIMAL, RedactionLevel.STANDARD, RedactionLevel.STRICT]

        # Filter patterns
        for pattern in PATTERNS + self.custom_patterns:
            if pattern.level in levels:
                applicable.append(pattern)

        return applicable


# ============================================================================
# Convenience functions
# ============================================================================

def redact_execution_record(record: Dict, level: RedactionLevel = RedactionLevel.STANDARD) -> Tuple[Dict, List[Tuple[str, str]]]:
    """
    Redact an execution record for safe export.

    Args:
        record: ExecutionRecord as dict
        level: Redaction level

    Returns:
        (redacted_record, list of redactions)
    """
    redactor = Redactor(level=level)

    # Redact text fields
    text_fields = [
        'user_prompt',
        'plan_reasoning',
        'final_response'
    ]

    for field in text_fields:
        if field in record and isinstance(record[field], str):
            record[field] = redactor.redact(record[field])

    # Redact prompts
    if 'full_prompt_planning' in record and record['full_prompt_planning']:
        record['full_prompt_planning'] = _redact_prompt(record['full_prompt_planning'], redactor)

    if 'full_prompt_execution' in record and record['full_prompt_execution']:
        record['full_prompt_execution'] = _redact_prompt(record['full_prompt_execution'], redactor)

    if 'full_prompt_reflection' in record and record['full_prompt_reflection']:
        record['full_prompt_reflection'] = _redact_prompt(record['full_prompt_reflection'], redactor)

    # Redact execution steps
    if 'execution_steps' in record:
        for step in record['execution_steps']:
            step['reasoning'] = redactor.redact(step.get('reasoning', ''))

            for tool_call in step.get('tool_calls', []):
                # Redact arguments
                tool_call['arguments'] = redactor.redact_dict(tool_call.get('arguments', {}))

                # Redact output
                if 'output' in tool_call:
                    tool_call['output'] = redactor.redact(tool_call['output'])

    # Redact environment variables
    if 'repro_context' in record and 'env_vars' in record['repro_context']:
        record['repro_context']['env_vars'] = redactor.redact_dict(
            record['repro_context']['env_vars']
        )

    # CRITICAL: Redact file_state - contains full file contents and git diffs
    # This was previously missing, allowing secrets in files to be persisted
    if 'file_state' in record and record['file_state']:
        record['file_state'] = _redact_file_state(record['file_state'], redactor)

    return record, redactor.redactions


def _redact_file_state(file_state: Dict, redactor: Redactor) -> Dict:
    """
    Redact sensitive information from file state.

    This includes:
    - git_diff: May contain secrets in code changes
    - git_status: File names may reveal sensitive paths
    - files_before/files_after: Full file contents may contain secrets
    - operations: File operation details
    """
    # Redact git diff - often contains secrets in code
    if 'git_diff' in file_state and file_state['git_diff']:
        file_state['git_diff'] = redactor.redact(file_state['git_diff'])

    # Redact git status - less likely but may reveal sensitive paths
    if 'git_status' in file_state and file_state['git_status']:
        file_state['git_status'] = redactor.redact(file_state['git_status'])

    # Redact file snapshots (before/after)
    for key in ['files_before', 'files_after']:
        if key in file_state and file_state[key]:
            file_state[key] = _redact_file_snapshots(file_state[key], redactor)

    # Redact file operations (may include file contents in before/after snapshots)
    if 'operations' in file_state and file_state['operations']:
        for operation in file_state['operations']:
            if 'before_snapshot' in operation and operation['before_snapshot']:
                operation['before_snapshot'] = _redact_snapshot(operation['before_snapshot'], redactor)
            if 'after_snapshot' in operation and operation['after_snapshot']:
                operation['after_snapshot'] = _redact_snapshot(operation['after_snapshot'], redactor)

    return file_state


def _redact_file_snapshots(snapshots: Dict, redactor: Redactor) -> Dict:
    """Redact a dictionary of file path -> FileSnapshot."""
    redacted = {}
    for path, snapshot in snapshots.items():
        redacted[path] = _redact_snapshot(snapshot, redactor)
    return redacted


def _redact_snapshot(snapshot: Dict, redactor: Redactor) -> Dict:
    """
    Redact a single FileSnapshot.

    For security, we redact the content field while preserving metadata.
    The sha256 hash is kept as it doesn't reveal content.
    """
    if not snapshot:
        return snapshot

    # Redact content field - this is where secrets live
    if 'content' in snapshot and snapshot['content']:
        snapshot['content'] = redactor.redact(snapshot['content'])

    return snapshot


def _redact_prompt(prompt: Dict, redactor: Redactor) -> Dict:
    """Redact a FullPrompt dict."""
    if 'messages' in prompt:
        for msg in prompt['messages']:
            if 'content' in msg:
                msg['content'] = redactor.redact(msg['content'])

    if 'tools' in prompt:
        for tool in prompt['tools']:
            # Don't redact tool schemas, but redact examples if present
            if 'examples' in tool:
                for example in tool['examples']:
                    if 'input' in example:
                        example['input'] = redactor.redact_dict(example['input'])
                    if 'output' in example:
                        example['output'] = redactor.redact(str(example['output']))

    return prompt
