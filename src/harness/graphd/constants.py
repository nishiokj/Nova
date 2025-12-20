"""Graphd constants and utilities."""

import time
import uuid

# Schema version - bump when adding/modifying tables
# v1: Initial schema (files, symbols, module_edges, exports, run_artifacts)
# v2: Added session management tables (sessions, conversation_messages, context_snapshots)
GRAPH_D_SCHEMA_VERSION = "v2"
GRAPH_D_VERSION = "0.1.0"


def generate_session_key(client_type: str = "tui") -> str:
    """Generate a unique session key.

    Format: {client_type}_{timestamp}_{uuid8}
    Example: tui_1734567890_a1b2c3d4

    Args:
        client_type: Type of client ('tui', 'voice', 'api')

    Returns:
        Unique session key string
    """
    timestamp = int(time.time())
    uid = str(uuid.uuid4())[:8]
    return f"{client_type}_{timestamp}_{uid}"
