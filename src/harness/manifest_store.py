"""
Manifest Store - Central storage for referenced objects used across episodes.

This module provides:
- Storage for system prompts, tool manifests, and other shared config
- Content-addressable IDs for versioning
- Efficient retrieval during reconstruction
- Automatic manifest creation and caching

Design:
- Manifests stored in logs/manifests/
- Each manifest has a unique ID (e.g., "tier_advanced_v1")
- Manifests are immutable (new version = new ID)
- All logs reference manifests by ID, not inline
"""

import json
import hashlib
from pathlib import Path
from typing import Dict, Any, Optional, List
from dataclasses import dataclass
import logging


@dataclass
class SystemPromptManifest:
    """System prompt manifest"""
    id: str  # e.g., "tier_advanced_v1"
    tier: str
    version: str
    prompt: str
    created_at: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "tier": self.tier,
            "version": self.version,
            "prompt": self.prompt,
            "created_at": self.created_at
        }


@dataclass
class ToolManifest:
    """Tool manifest with definitions"""
    id: str  # e.g., "default_tools_v1"
    version: str
    tools: List[Dict[str, Any]]  # Tool definitions
    tool_count: int
    created_at: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "version": self.version,
            "tools": self.tools,
            "tool_count": self.tool_count,
            "created_at": self.created_at
        }


class ManifestStore:
    """
    Centralized storage for manifests (system prompts, tool definitions, etc.)

    All large, shared objects are stored here and referenced by ID in logs.
    This dramatically reduces log file size and enables versioning.
    """

    def __init__(self, base_dir: str = "logs/manifests"):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

        # Manifest directories
        self.system_prompts_dir = self.base_dir / "system_prompts"
        self.tool_manifests_dir = self.base_dir / "tool_manifests"
        self.conversations_dir = self.base_dir / "conversations"

        # Create directories
        self.system_prompts_dir.mkdir(exist_ok=True)
        self.tool_manifests_dir.mkdir(exist_ok=True)
        self.conversations_dir.mkdir(exist_ok=True)

        # In-memory cache
        self._cache: Dict[str, Any] = {}

        self.logger = logging.getLogger("manifest_store")

    def _compute_content_hash(self, content: str) -> str:
        """Compute SHA256 hash of content (first 8 chars)"""
        return hashlib.sha256(content.encode()).hexdigest()[:8]

    def store_system_prompt(
        self,
        tier: str,
        version: str,
        prompt: str,
        prompt_id: Optional[str] = None
    ) -> str:
        """
        Store system prompt manifest and return ID.

        Args:
            tier: Agent tier (simple/standard/advanced)
            version: Version string (e.g., "v1", "v2")
            prompt: Full system prompt text
            prompt_id: Optional explicit ID (otherwise auto-generated)

        Returns:
            Manifest ID (e.g., "tier_advanced_v1")
        """
        from datetime import datetime

        # Generate ID if not provided
        if prompt_id is None:
            prompt_id = f"tier_{tier}_{version}"

        # Check if already exists
        manifest_path = self.system_prompts_dir / f"{prompt_id}.json"
        if manifest_path.exists():
            self.logger.debug(f"System prompt {prompt_id} already exists")
            return prompt_id

        # Create manifest
        manifest = SystemPromptManifest(
            id=prompt_id,
            tier=tier,
            version=version,
            prompt=prompt,
            created_at=datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        )

        # Save to disk
        with open(manifest_path, 'w') as f:
            json.dump(manifest.to_dict(), f, indent=2)

        # Cache
        self._cache[prompt_id] = manifest

        self.logger.info(f"Stored system prompt manifest: {prompt_id}")
        return prompt_id

    def store_tool_manifest(
        self,
        tools: List[Dict[str, Any]],
        version: str = "v1",
        manifest_id: Optional[str] = None
    ) -> str:
        """
        Store tool manifest and return ID.

        Args:
            tools: List of tool definitions
            version: Version string
            manifest_id: Optional explicit ID

        Returns:
            Manifest ID (e.g., "default_tools_v1")
        """
        from datetime import datetime

        # Generate ID if not provided
        if manifest_id is None:
            manifest_id = f"default_tools_{version}"

        # Check if already exists
        manifest_path = self.tool_manifests_dir / f"{manifest_id}.json"
        if manifest_path.exists():
            self.logger.debug(f"Tool manifest {manifest_id} already exists")
            return manifest_id

        # Create manifest
        manifest = ToolManifest(
            id=manifest_id,
            version=version,
            tools=tools,
            tool_count=len(tools),
            created_at=datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        )

        # Save to disk
        with open(manifest_path, 'w') as f:
            json.dump(manifest.to_dict(), f, indent=2)

        # Cache
        self._cache[manifest_id] = manifest

        self.logger.info(f"Stored tool manifest: {manifest_id} ({len(tools)} tools)")
        return manifest_id

    def get_system_prompt(self, prompt_id: str) -> Optional[SystemPromptManifest]:
        """Retrieve system prompt manifest by ID"""
        # Check cache
        if prompt_id in self._cache:
            return self._cache[prompt_id]

        # Load from disk
        manifest_path = self.system_prompts_dir / f"{prompt_id}.json"
        if not manifest_path.exists():
            self.logger.warning(f"System prompt manifest not found: {prompt_id}")
            return None

        with open(manifest_path) as f:
            data = json.load(f)

        manifest = SystemPromptManifest(**data)
        self._cache[prompt_id] = manifest

        return manifest

    def get_tool_manifest(self, manifest_id: str) -> Optional[ToolManifest]:
        """Retrieve tool manifest by ID"""
        # Check cache
        if manifest_id in self._cache:
            return self._cache[manifest_id]

        # Load from disk
        manifest_path = self.tool_manifests_dir / f"{manifest_id}.json"
        if not manifest_path.exists():
            self.logger.warning(f"Tool manifest not found: {manifest_id}")
            return None

        with open(manifest_path) as f:
            data = json.load(f)

        manifest = ToolManifest(**data)
        self._cache[manifest_id] = manifest

        return manifest

    def list_system_prompts(self) -> List[str]:
        """List all system prompt IDs"""
        return [p.stem for p in self.system_prompts_dir.glob("*.json")]

    def list_tool_manifests(self) -> List[str]:
        """List all tool manifest IDs"""
        return [p.stem for p in self.tool_manifests_dir.glob("*.json")]

    def preload_manifests(self):
        """Preload all manifests into cache for fast access"""
        for prompt_id in self.list_system_prompts():
            self.get_system_prompt(prompt_id)

        for manifest_id in self.list_tool_manifests():
            self.get_tool_manifest(manifest_id)

        self.logger.info(
            f"Preloaded {len(self._cache)} manifests into cache"
        )


# Global instance
_global_manifest_store: Optional[ManifestStore] = None


def get_manifest_store() -> ManifestStore:
    """Get or create global manifest store"""
    global _global_manifest_store
    if _global_manifest_store is None:
        _global_manifest_store = ManifestStore()
    return _global_manifest_store


def ensure_default_manifests():
    """
    Ensure default manifests exist (system prompts, tools).
    Called on startup to populate manifest store.
    """
    from harness.agent import _TIER_PROMPTS
    from harness.tool_registry import ToolRegistry

    store = get_manifest_store()

    # Store system prompts for each tier
    for tier, prompt in _TIER_PROMPTS.items():
        # Remove {tools} placeholder for storage
        clean_prompt = prompt.replace("{tools}", "")
        store.store_system_prompt(
            tier=tier,
            version="v1",
            prompt=clean_prompt,
            prompt_id=f"tier_{tier}_v1"
        )

    # Store default tool manifest
    # Note: In production, get actual tool definitions from ToolRegistry
    # For now, create a reference manifest
    default_tools = [
        {"name": "web_search", "description": "Search the web"},
        {"name": "bash_execute", "description": "Execute bash command"},
        {"name": "file_read", "description": "Read file contents"},
        {"name": "file_write", "description": "Write to file"},
        # ... etc
    ]

    store.store_tool_manifest(
        tools=default_tools,
        version="v1",
        manifest_id="default_tools_v1"
    )

    logging.info("Default manifests created")
