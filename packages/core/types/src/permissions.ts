/**
 * Permission System Types
 *
 * Default-deny permission system for agent tool execution.
 * Only Bash, Write, and Edit tools require permission.
 */

// ============================================
// CORE TYPES
// ============================================

/**
 * Tools that require permission checks.
 */
export type PermissionedTool = 'Bash' | 'Write' | 'Edit';

/**
 * A single permission rule.
 */
export interface PermissionRule {
  /** The tool this rule applies to */
  tool: PermissionedTool;
  /** Glob pattern to match against (command for Bash, path for Write/Edit) */
  pattern: string;
}

/**
 * Permission configuration loaded from settings files.
 */
export interface PermissionConfig {
  /** Patterns that auto-approve */
  allow: PermissionRule[];
  /** Patterns that auto-reject (takes precedence over allow) */
  deny: PermissionRule[];
}

/**
 * Settings file schema for permissions section.
 */
export interface PermissionSettings {
  permissions: {
    /** Pattern strings like "Bash(npm *)", "Write(src/**)" */
    allow: string[];
    /** Pattern strings that auto-reject */
    deny: string[];
  };
}

/**
 * Runtime permission state for a session.
 */
export interface SessionPermissionState {
  /** Loaded from config files */
  persistent: PermissionConfig;
  /** Granted during this session via "Allow" (not "Always allow") */
  sessionGrants: PermissionRule[];
  /** Denied during this session (user clicked Deny) */
  sessionDenials: PermissionRule[];
  /** --dangerous mode bypasses all checks */
  dangerousMode: boolean;
}

// ============================================
// PERMISSION DECISION
// ============================================

/**
 * Result of a permission check.
 */
export type PermissionDecision =
  | { granted: true; reason: 'dangerous_mode' | 'allow_rule' | 'session_grant' }
  | { granted: false; reason: 'deny_rule' | 'session_denial' | 'path_traversal' }
  | { granted: 'ask'; reason: 'no_matching_rule' };

// ============================================
// PERMISSION REQUEST/RESPONSE
// ============================================

/**
 * Permission request sent to TUI for user decision.
 */
export interface PermissionRequest {
  /** Unique ID for this request */
  requestId: string;
  /** Tool requesting permission */
  tool: PermissionedTool;
  /** For Bash: the full command. For Write/Edit: the file path */
  target: string;
  /** Extracted pattern for "Always allow" option */
  suggestedPattern: string;
  /** Working directory for context */
  workingDirectory: string;
  /** Human-readable description */
  description: string;
}

/**
 * User's response to a permission request.
 */
export interface PermissionResponse {
  /** ID matching the request */
  requestId: string;
  /** User's decision */
  decision: 'allow' | 'always_allow' | 'deny';
  /** Optional custom pattern (if always_allow and user overrides suggested) */
  pattern?: string;
}

// ============================================
// BRIDGE EVENT TYPES
// ============================================

/**
 * Permission request event sent to TUI.
 */
export interface PermissionRequestEvent {
  type: 'permission_request';
  data: {
    request_id: string;
    tool: PermissionedTool;
    target: string;
    suggested_pattern: string;
    working_directory: string;
    description: string;
  };
}

/**
 * Permission response command from TUI.
 */
export interface PermissionResponseCommand {
  type: 'permission_response';
  data: {
    request_id: string;
    decision: 'allow' | 'always_allow' | 'deny';
    pattern?: string;
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Maps lowercase tool names to PermissionedTool type.
 */
export const PERMISSIONED_TOOLS: Record<string, PermissionedTool> = {
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
};

/**
 * Check if a tool name is a permissioned tool.
 */
export function isPermissionedTool(toolName: string): boolean {
  return toolName.toLowerCase() in PERMISSIONED_TOOLS;
}

/**
 * Normalize a tool name to its PermissionedTool form.
 */
export function normalizeToolName(toolName: string): PermissionedTool | null {
  return PERMISSIONED_TOOLS[toolName.toLowerCase()] ?? null;
}

/**
 * Default permission settings for new projects.
 */
export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  permissions: {
    allow: [
      'Bash(npm *)',
      'Bash(pnpm *)',
      'Bash(yarn *)',
      'Bash(bun *)',
      'Bash(git *)',
      'Bash(node *)',
      'Bash(npx *)',
      'Bash(tsc *)',
      'Bash(eslint *)',
      'Bash(prettier *)',
    ],
    deny: [
      'Bash(rm -rf /)',
      'Bash(sudo *)',
      'Bash(chmod 777 *)',
    ],
  },
};
