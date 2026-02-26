/**
 * Permission Checker - Default-deny permission system for agent tool execution.
 *
 * Only Bash, Write, and Edit tools require permission checks.
 * Loads rules from ~/.config/nova/settings.json, .config/settings.json, .config/settings.local.json
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type {
  PermissionedTool,
  PermissionRule,
  PermissionConfig,
  PermissionSettings,
  SessionPermissionState,
  PermissionDecision,
  PermissionRequest,
  PermissionResponse,
} from 'types';
import { DEFAULT_PERMISSION_SETTINGS } from 'types';

/**
 * PermissionChecker - Handles permission checking and state management.
 */
export class PermissionChecker {
  private state: SessionPermissionState;
  private workingDirectory: string;
  private allowOutsideRoot = false;
  private webSearchEnabled = true;
  private writesNoDeletes = false;
  private restrictWriteToPathsEnabled = false;
  private restrictWriteToPaths = new Set<string>();

  /** Map of pending permission requests awaiting user response */
  private pendingRequests = new Map<string, {
    resolve: (response: PermissionResponse) => void;
    request: PermissionRequest;
  }>();

  constructor(workingDirectory: string, dangerousMode: boolean) {
    this.workingDirectory = workingDirectory;
    this.state = {
      persistent: this.loadConfig(workingDirectory),
      sessionGrants: [],
      sessionDenials: [],
      dangerousMode,
    };
  }

  /**
   * Check if --dangerous mode is enabled.
   */
  isDangerousMode(): boolean {
    return this.state.dangerousMode;
  }

  /**
   * Set dangerous mode dynamically.
   * WARNING: This bypasses all permission checks when enabled.
   */
  setDangerousMode(enabled: boolean): void {
    this.state.dangerousMode = enabled;
  }

  isAllowOutsideRoot(): boolean {
    return this.allowOutsideRoot;
  }

  setAllowOutsideRoot(enabled: boolean): void {
    this.allowOutsideRoot = enabled;
  }

  isWebSearchEnabled(): boolean {
    return this.webSearchEnabled;
  }

  setWebSearchEnabled(enabled: boolean): void {
    this.webSearchEnabled = enabled;
  }

  isWritesNoDeletesEnabled(): boolean {
    return this.writesNoDeletes;
  }

  setWritesNoDeletes(enabled: boolean): void {
    this.writesNoDeletes = enabled;
  }

  getRuntimeFlags(): {
    allowOutsideRoot: boolean;
    webSearchEnabled: boolean;
    writesNoDeletes: boolean;
    restrictWriteToPaths?: string[];
  } {
    const restricted = this.restrictWriteToPathsEnabled
      ? Array.from(this.restrictWriteToPaths).sort()
      : undefined;
    return {
      allowOutsideRoot: this.allowOutsideRoot,
      webSearchEnabled: this.webSearchEnabled,
      writesNoDeletes: this.writesNoDeletes,
      ...(restricted ? { restrictWriteToPaths: restricted } : {}),
    };
  }

  hydrateRuntimeFlags(flags: {
    allowOutsideRoot?: boolean;
    webSearchEnabled?: boolean;
    writesNoDeletes?: boolean;
    restrictWriteToPaths?: string[];
  } | undefined): void {
    this.allowOutsideRoot = flags?.allowOutsideRoot === true;
    this.webSearchEnabled = flags?.webSearchEnabled !== false;
    this.writesNoDeletes = flags?.writesNoDeletes === true;
    this.setRestrictWriteToPaths(flags?.restrictWriteToPaths);
  }

  setRestrictWriteToPaths(paths: string[] | undefined | null): void {
    if (!Array.isArray(paths)) {
      this.restrictWriteToPathsEnabled = false;
      this.restrictWriteToPaths = new Set();
      return;
    }
    this.restrictWriteToPathsEnabled = true;
    const normalized = new Set<string>();
    for (const candidate of paths) {
      if (typeof candidate !== 'string' || candidate.trim().length === 0) continue;
      const resolved = this.resolveAndValidatePath(candidate);
      if (resolved === null) continue;
      normalized.add(this.normalizePathKey(resolved));
    }
    this.restrictWriteToPaths = normalized;
  }

  reloadPersistentConfig(): void {
    this.state.persistent = this.loadConfig(this.workingDirectory);
  }

  /**
   * Get session permission state for persistence.
   */
  getState(): SessionPermissionState {
    return {
      persistent: this.state.persistent,
      sessionGrants: [...this.state.sessionGrants],
      sessionDenials: [...this.state.sessionDenials],
      dangerousMode: this.state.dangerousMode,
    };
  }

  /**
   * Hydrate session permission state from persistence.
   */
  hydrateState(state: SessionPermissionState): void {
    this.state.sessionGrants = this.sanitizeRuleList((state as unknown as { sessionGrants?: unknown }).sessionGrants);
    this.state.sessionDenials = this.sanitizeRuleList((state as unknown as { sessionDenials?: unknown }).sessionDenials);
    this.state.dangerousMode = (state as unknown as { dangerousMode?: unknown }).dangerousMode === true;
  }

  /**
   * Register a pending request (called by harness when awaiting user response).
   */
  registerPendingRequest(
    requestId: string,
    request: PermissionRequest,
    resolve: (response: PermissionResponse) => void
  ): void {
    this.pendingRequests.set(requestId, { resolve, request });
  }

  /**
   * Get a pending request by ID.
   */
  getPendingRequest(requestId: string): PermissionRequest | undefined {
    return this.pendingRequests.get(requestId)?.request;
  }

  /**
   * Cancel a pending request without resolving it.
   */
  cancelPendingRequest(requestId: string): void {
    this.pendingRequests.delete(requestId);
  }

  /**
   * Check if a tool+target is allowed.
   *
   * Priority order (per spec):
   * 1. --dangerous mode → always grant
   * 2. Path traversal check → block if path escapes working directory
   * 3. Session denials → block (user clicked Deny this session)
   * 4. Session grants → allow (user clicked Allow this session)
   * 5. Persistent deny rules → block (from config files)
   * 6. Persistent allow rules → allow (from config files)
   * 7. No match → ask user
   */
  check(tool: PermissionedTool, target: string): PermissionDecision {
    // 1. If dangerousMode, always grant
    if (this.state.dangerousMode) {
      return { granted: true, reason: 'dangerous_mode' };
    }

    // For Bash, check chained commands
    if (tool === 'Bash') {
      return this.checkBashCommand(target);
    }

    // For Write/Edit, resolve and validate path first
    const resolvedTarget = this.resolveAndValidatePath(target);
    if (resolvedTarget === null) {
      return { granted: false, reason: 'path_traversal' };
    }

    if ((tool === 'Write' || tool === 'Edit') && this.restrictWriteToPathsEnabled) {
      const normalizedTarget = this.normalizePathKey(resolvedTarget);
      if (this.restrictWriteToPaths.has(normalizedTarget)) {
        return { granted: true, reason: 'allow_rule' };
      }
      return { granted: false, reason: 'deny_rule' };
    }

    return this.checkSingleTarget(tool, resolvedTarget);
  }

  checkWebSearch(): PermissionDecision {
    if (this.state.dangerousMode) {
      return { granted: true, reason: 'dangerous_mode' };
    }
    if (!this.webSearchEnabled) {
      return { granted: false, reason: 'deny_rule' };
    }
    return { granted: true, reason: 'allow_rule' };
  }

  /**
   * Check a bash command, handling chained commands.
   */
  private checkBashCommand(fullCommand: string): PermissionDecision {
    const commands = this.parseChainedCommands(fullCommand);

    for (const cmd of commands) {
      if (this.writesNoDeletes && this.isDeleteLikeCommand(cmd)) {
        return { granted: false, reason: 'deny_rule' };
      }
      const decision = this.checkSingleTarget('Bash', cmd.trim());
      if (decision.granted === false) {
        return decision; // Any denied command blocks the whole chain
      }
      if (decision.granted === 'ask') {
        // For 'ask', we still need to prompt - but include the full chain context
        return { granted: 'ask', reason: 'no_matching_rule' };
      }
    }

    return { granted: true, reason: 'allow_rule' };
  }

  private isDeleteLikeCommand(command: string): boolean {
    const normalized = command.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === 'rm' || normalized.startsWith('rm ')) return true;
    if (normalized.startsWith('rmdir ')) return true;
    if (normalized.startsWith('unlink ')) return true;
    if (normalized === 'git rm' || normalized.startsWith('git rm ')) return true;
    if (normalized === 'git clean' || normalized.startsWith('git clean ')) return true;
    if (normalized.startsWith('find ') && /\s-delete(\s|$)/.test(normalized)) return true;
    return false;
  }

  /**
   * Parse chained bash commands (&&, ||, ;, |, $(...), `...`).
   */
  private parseChainedCommands(command: string): string[] {
    // Split on shell operators while respecting quotes
    const shellOperators = /\s*(?:&&|\|\||;|\|)\s*/;
    const commands = command.split(shellOperators).filter(Boolean);

    // Also detect command substitution $(...) and backticks
    const substitutionPattern = /\$\([^)]+\)|`[^`]+`/g;
    const substitutions = command.match(substitutionPattern) ?? [];
    for (const sub of substitutions) {
      const inner = sub.slice(sub.startsWith('$(') ? 2 : 1, -1);
      commands.push(inner);
    }

    return commands;
  }

  /**
   * Check a single target against rules.
   */
  private checkSingleTarget(tool: PermissionedTool, target: string): PermissionDecision {
    // 2. Check session-level first (highest priority after dangerous mode)
    if (this.matchesAny(tool, target, this.state.sessionDenials)) {
      return { granted: false, reason: 'session_denial' };
    }
    if (this.matchesAny(tool, target, this.state.sessionGrants)) {
      return { granted: true, reason: 'session_grant' };
    }

    // 3. Check persistent rules (deny takes precedence over allow within same tier)
    if (this.matchesAny(tool, target, this.state.persistent.deny)) {
      return { granted: false, reason: 'deny_rule' };
    }
    if (this.matchesAny(tool, target, this.state.persistent.allow)) {
      return { granted: true, reason: 'allow_rule' };
    }

    // 4. No matching rule - need to ask
    return { granted: 'ask', reason: 'no_matching_rule' };
  }

  /**
   * Resolve path and validate it's within working directory.
   * Returns null if path escapes working directory (path traversal attempt).
   */
  private resolveAndValidatePath(target: string): string | null {
    const resolved = path.resolve(this.workingDirectory, target);
    if (this.allowOutsideRoot) {
      if (path.isAbsolute(target)) {
        return path.normalize(resolved);
      }
      return path.normalize(path.relative(this.workingDirectory, resolved));
    }
    const relative = path.relative(this.workingDirectory, resolved);

    // If relative path starts with "..", it escapes the working directory
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }

    return relative;
  }

  private normalizePathKey(value: string): string {
    return path.normalize(value).replace(/\\/g, '/');
  }

  private sanitizeRuleList(value: unknown): PermissionRule[] {
    if (!Array.isArray(value)) return [];
    const rules: PermissionRule[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as { tool?: unknown; pattern?: unknown };
      const tool = record.tool;
      const pattern = record.pattern;
      if (
        (tool === 'Bash' || tool === 'Write' || tool === 'Edit')
        && typeof pattern === 'string'
        && pattern.length > 0
      ) {
        rules.push({ tool, pattern });
      }
    }
    return rules;
  }

  /**
   * Match target against a list of permission rules.
   */
  private matchesAny(
    tool: PermissionedTool,
    target: string,
    rules: PermissionRule[]
  ): boolean {
    for (const rule of rules) {
      if (rule.tool !== tool) continue;

      if (minimatch(target, rule.pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Extract pattern for suggested "Always allow".
   */
  private extractSuggestedPattern(tool: PermissionedTool, target: string): string {
    if (tool === 'Bash') {
      // First word + wildcard for broader matching
      const words = target.trim().split(/\s+/);
      return `${words[0]} *`;
    }
    // For Write/Edit, return the path as-is
    return target;
  }

  /**
   * Create permission request for TUI.
   */
  createRequest(tool: PermissionedTool, target: string, workingDir: string): PermissionRequest {
    return {
      requestId: crypto.randomUUID(),
      tool,
      target,
      suggestedPattern: tool === 'Bash'
        ? this.extractSuggestedPattern(tool, target)
        : this.suggestGlob(target, workingDir),
      workingDirectory: workingDir,
      description: this.formatDescription(tool, target),
    };
  }

  /**
   * Suggest a glob pattern for Write/Edit based on file path.
   */
  private suggestGlob(target: string, workingDir: string): string {
    const resolved = path.resolve(workingDir, target);
    const relative = path.relative(workingDir, resolved);

    // Get the top-level directory
    const parts = relative.split(path.sep);
    if (parts.length > 1) {
      // File is in a subdirectory - suggest "dir/**"
      return `${parts[0]}/**`;
    }

    // File is at root - suggest extension-based pattern
    const ext = path.extname(relative);
    return ext ? `*${ext}` : relative;
  }

  /**
   * Format human-readable description.
   */
  private formatDescription(tool: PermissionedTool, target: string): string {
    switch (tool) {
      case 'Bash':
        return `Run command: ${target}`;
      case 'Write':
        return `Create/overwrite file: ${target}`;
      case 'Edit':
        return `Edit file: ${target}`;
    }
  }

  /**
   * Handle response from TUI.
   */
  handleResponse(response: PermissionResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) return;

    const { request } = pending;
    const pattern = response.pattern ?? request.suggestedPattern;

    if (response.decision === 'always_allow') {
      // Add to persistent config
      this.addPersistentRule('allow', request.tool, pattern, request.workingDirectory);
      // Also add to session grants so it takes effect immediately
      this.state.sessionGrants.push({ tool: request.tool, pattern });
    } else if (response.decision === 'allow') {
      // Add to session grants using suggested pattern (e.g., "cd *" not "cd /specific/path")
      // This allows similar commands for the rest of the session
      this.state.sessionGrants.push({ tool: request.tool, pattern });
    } else if (response.decision === 'deny') {
      // Add to session denials using suggested pattern for consistency
      this.state.sessionDenials.push({ tool: request.tool, pattern });
    }

    pending.resolve(response);
    this.pendingRequests.delete(response.requestId);
  }

  // =========================================================================
  // Config Loading
  // =========================================================================

  /**
   * Load and merge config files with proper error handling.
   */
  private loadConfig(workingDir: string): PermissionConfig {
    const result: PermissionConfig = { allow: [], deny: [] };

    // Config files in priority order (lowest to highest)
    const configPaths = [
      path.join(os.homedir(), '.config', 'nova', 'settings.json'),  // Global
      path.join(workingDir, '.config', 'settings.json'),        // Project
      path.join(workingDir, '.config', 'settings.local.json'),  // Local override
    ];

    for (const configPath of configPaths) {
      const config = this.loadConfigFile(configPath);
      if (config) {
        // Merge: later files override earlier ones
        // For allow/deny arrays, we append (user can add deny rules to override)
        result.allow.push(...config.allow);
        result.deny.push(...config.deny);
      }
    }

    return result;
  }

  /**
   * Load a single config file, returning null if it doesn't exist.
   */
  private loadConfigFile(configPath: string): PermissionConfig | null {
    try {
      if (!fs.existsSync(configPath)) {
        return null;
      }
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content) as Partial<PermissionSettings>;

      // Validate and parse permission rules
      const permissions = parsed.permissions ?? { allow: [], deny: [] };
      return {
        allow: this.parseRules(permissions.allow ?? []),
        deny: this.parseRules(permissions.deny ?? []),
      };
    } catch (err) {
      // Log warning but don't crash - continue with other config files
      console.warn(`[permissions] Failed to load config from ${configPath}:`, err);
      return null;
    }
  }

  /**
   * Parse string patterns like "Bash(npm *)" into PermissionRule objects.
   */
  private parseRules(patterns: string[]): PermissionRule[] {
    const rules: PermissionRule[] = [];
    const ruleRegex = /^(Bash|Write|Edit)\((.+)\)$/;

    for (const pattern of patterns) {
      const match = pattern.match(ruleRegex);
      if (match) {
        rules.push({
          tool: match[1] as PermissionedTool,
          pattern: match[2],
        });
      }
    }

    return rules;
  }

  /**
   * Persist "always allow" to .config/settings.json
   */
  private addPersistentRule(
    type: 'allow' | 'deny',
    tool: PermissionedTool,
    pattern: string,
    workingDir: string
  ): void {
    const configDir = path.join(workingDir, '.config');
    const configPath = path.join(configDir, 'settings.json');

    try {
      // Ensure directory exists
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Load existing config or use defaults
      let config: PermissionSettings;
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        config = JSON.parse(content) as PermissionSettings;
        if (!config.permissions) {
          config.permissions = { allow: [], deny: [] };
        }
      } else {
        config = { ...DEFAULT_PERMISSION_SETTINGS };
      }

      // Add the new rule
      const ruleString = `${tool}(${pattern})`;
      const targetArray = type === 'allow' ? config.permissions.allow : config.permissions.deny;
      if (!targetArray.includes(ruleString)) {
        targetArray.push(ruleString);
      }

      // Write back
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      process.stderr.write(`[permissions] Added ${type} rule: ${ruleString}\n`);
    } catch (err) {
      process.stderr.write(`[permissions] Failed to persist rule to ${configPath}: ${err}\n`);
    }
  }

  /**
   * Extract target from tool arguments.
   */
  static extractTarget(tool: PermissionedTool, args: Record<string, unknown>): string {
    switch (tool) {
      case 'Bash':
        return String(args.command ?? '');
      case 'Write':
      case 'Edit':
        return String(args.file_path ?? args.path ?? '');
    }
  }
}
