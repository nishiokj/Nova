/**
 * Skills and hooks loader for the TypeScript harness.
 *
 * Provides loading and CRUD operations for skill/hook definitions.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'fs';
import { resolve, join, dirname } from 'path';

// ============================================
// SKILL TYPES
// ============================================

/**
 * Skill definition stub for list API.
 */
export interface SkillDefinitionStub {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  type: string;
  tags: string[];
}

/**
 * Full skill definition with instructions.
 */
export interface SkillDefinition extends SkillDefinitionStub {
  instructions: string;
  allowedTools?: string[];
  model?: 'inherit' | 'sonnet' | 'opus' | 'haiku';
  sourcePath: string;
  sourceType: 'markdown' | 'json';
}

/**
 * Input for creating a new skill.
 */
export interface SkillInput {
  name: string;
  description: string;
  instructions: string;
  allowedTools?: string[];
  model?: string;
  tags?: string[];
  enabled?: boolean;
}

// ============================================
// HOOK TYPES
// ============================================

/** Lifecycle events that can trigger hooks */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostGitCommit'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SessionStart'
  | 'Notification';

/** Command hook action */
export interface CommandHookAction {
  type: 'command';
  command: string;
  env?: Record<string, string>;
}

/** Script hook action - runs a script file with interpreter */
export interface ScriptHookAction {
  type: 'script';
  /** Path to the script file (relative to working dir or absolute) */
  path: string;
  /** Interpreter to use (python, node, bash, etc.). Auto-detected from extension if not specified. */
  interpreter?: string;
  /** Arguments to pass to the script. Supports $VAR substitution for env vars. */
  args?: string[];
  /** Additional environment variables */
  env?: Record<string, string>;
}

/** Prompt hook action (LLM evaluation) */
export interface PromptHookAction {
  type: 'prompt';
  prompt: string;
  model?: string;
  decision?: 'block' | 'allow' | 'modify';
}

export type HookAction = CommandHookAction | ScriptHookAction | PromptHookAction;

/**
 * Hook definition stub for list API.
 */
export interface HookDefinitionStub {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: string;
  priority: number;
}

/**
 * Full hook definition.
 */
export interface HookDefinition extends HookDefinitionStub {
  matcher?: string;
  timeout_ms?: number;
  fail_open?: boolean;
  hooks: HookAction[];
  sourcePath: string;
}

/**
 * Input for creating a new hook.
 */
export interface HookInput {
  name: string;
  description?: string;
  trigger: HookEvent;
  matcher?: string;
  priority?: number;
  timeout_ms?: number;
  fail_open?: boolean;
  hooks: HookAction[];
  enabled?: boolean;
}

/**
 * Result from hook execution.
 */
export interface HookResult {
  action: 'allow' | 'block' | 'modify';
  message?: string;
  modified?: Record<string, unknown>;
}

/**
 * Context passed to hook execution.
 */
export interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  toolResult?: unknown;
  sessionKey: string;
  requestId: string;
  workingDir: string;
  /** Git commit SHA (for PostGitCommit events) */
  commitSha?: string;
  /** Git commit message (for PostGitCommit events) */
  commitMessage?: string;
  /** Git branch (for PostGitCommit events) */
  commitBranch?: string;
}

// ============================================
// SKILL LOADING
// ============================================

/**
 * Load skill definitions from a directory.
 *
 * Supports two formats:
 * 1. JSON files directly in skills_dir (skill-id.json)
 * 2. Subdirectories with SKILL.md (skill-id/SKILL.md) - Claude Code format
 *
 * Returns stubs with basic metadata for list APIs.
 */
export function loadSkillDefinitions(skillsDir: string): SkillDefinitionStub[] {
  const skills: SkillDefinitionStub[] = [];
  const dir = resolve(skillsDir);

  if (!existsSync(dir)) {
    return skills;
  }

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      try {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          // Direct JSON file
          const content = readFileSync(join(dir, entry.name), 'utf-8');
          const skill = JSON.parse(content);
          skills.push({
            id: skill.id ?? entry.name.replace('.json', ''),
            name: skill.name ?? skill.id ?? entry.name.replace('.json', ''),
            description: skill.description ?? '',
            enabled: skill.enabled ?? true,
            type: skill.type ?? 'instructions',
            tags: skill.tags ?? [],
          });
        } else if (entry.isDirectory()) {
          // Subdirectory - look for SKILL.md or skill.json
          const subdir = join(dir, entry.name);
          const skillMdPath = join(subdir, 'SKILL.md');
          const skillJsonPath = join(subdir, 'skill.json');

          if (existsSync(skillJsonPath)) {
            const content = readFileSync(skillJsonPath, 'utf-8');
            const skill = JSON.parse(content);
            skills.push({
              id: skill.id ?? entry.name,
              name: skill.name ?? entry.name,
              description: skill.description ?? '',
              enabled: skill.enabled ?? true,
              type: skill.type ?? 'instructions',
              tags: skill.tags ?? [],
            });
          } else if (existsSync(skillMdPath)) {
            // Parse SKILL.md frontmatter (simplified YAML parsing)
            const content = readFileSync(skillMdPath, 'utf-8');
            const parsed = parseSkillMd(content, entry.name, skillMdPath);
            if (parsed) {
              skills.push(parsed);
            }
          }
        }
      } catch (e) {
        console.warn(`[skills] Failed to parse skill ${entry.name}:`, e);
      }
    }
  } catch (e) {
    console.warn('[skills] Failed to read skills directory:', e);
  }

  return skills;
}

/**
 * Parse SKILL.md frontmatter and body.
 * Returns stub for list API, or full definition when requested.
 */
function parseSkillMd(
  content: string,
  defaultId: string,
  sourcePath: string,
  full: boolean = false
): SkillDefinitionStub | SkillDefinition | null {
  const lines = content.split('\n');
  let inFrontmatter = false;
  let frontmatter = '';
  let frontmatterEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        frontmatterEnd = i + 1;
        break;
      }
    }
    if (inFrontmatter) {
      frontmatter += lines[i] + '\n';
    }
  }

  // Simple YAML parsing (key: value)
  const metadata: Record<string, unknown> = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^([\w-]+):\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      // Handle quoted strings
      if (value.startsWith('"') && value.endsWith('"')) {
        metadata[key] = value.slice(1, -1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        metadata[key] = value.slice(1, -1);
      } else if (value === 'true') {
        metadata[key] = true;
      } else if (value === 'false') {
        metadata[key] = false;
      } else if (!isNaN(Number(value))) {
        metadata[key] = Number(value);
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Parse simple array syntax [a, b, c]
        metadata[key] = value.slice(1, -1).split(',').map(s => s.trim());
      } else {
        metadata[key] = value;
      }
    }
  }

  // Parse allowed-tools (with hyphen) into allowedTools
  const allowedToolsRaw = metadata['allowed-tools'] ?? metadata.allowedTools;
  const allowedTools = typeof allowedToolsRaw === 'string'
    ? allowedToolsRaw.split(',').map(s => s.trim())
    : Array.isArray(allowedToolsRaw) ? allowedToolsRaw : undefined;

  const stub: SkillDefinitionStub = {
    id: (metadata.id as string) ?? defaultId,
    name: (metadata.name as string) ?? defaultId,
    description: (metadata.description as string) ?? '',
    enabled: (metadata.enabled as boolean) ?? true,
    type: (metadata.type as string) ?? 'instructions',
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
  };

  if (!full) return stub;

  // Extract instructions (everything after frontmatter)
  const instructions = lines.slice(frontmatterEnd).join('\n').trim();

  return {
    ...stub,
    instructions,
    allowedTools,
    model: metadata.model as 'inherit' | 'sonnet' | 'opus' | 'haiku' | undefined,
    sourcePath,
    sourceType: 'markdown',
  };
}

// ============================================
// HOOK LOADING
// ============================================

/**
 * Load hook definitions from a directory.
 *
 * Expects JSON files in hooks_dir (hook-id.json).
 * Returns stubs with basic metadata for list APIs.
 */
export function loadHookDefinitions(hooksDir: string): HookDefinitionStub[] {
  const hooks: HookDefinitionStub[] = [];
  const dir = resolve(hooksDir);

  if (!existsSync(dir)) {
    return hooks;
  }

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8');
        const hook = JSON.parse(content);
        hooks.push({
          id: hook.id ?? file.replace('.json', ''),
          name: hook.name ?? hook.id ?? file.replace('.json', ''),
          description: hook.description ?? '',
          enabled: hook.enabled ?? true,
          trigger: hook.trigger ?? 'unknown',
          priority: hook.priority ?? 0,
        });
      } catch (e) {
        console.warn(`[hooks] Failed to parse hook ${file}:`, e);
      }
    }
  } catch (e) {
    console.warn('[hooks] Failed to read hooks directory:', e);
  }

  // Sort by priority (higher first)
  hooks.sort((a, b) => b.priority - a.priority);

  return hooks;
}

// ============================================
// SKILL CRUD OPERATIONS
// ============================================

/**
 * Get a single skill by ID with full definition.
 */
export function getSkillDefinition(skillsDir: string, id: string): SkillDefinition | null {
  const dir = resolve(skillsDir);

  // Check for subdirectory with SKILL.md
  const skillMdPath = join(dir, id, 'SKILL.md');
  if (existsSync(skillMdPath)) {
    const content = readFileSync(skillMdPath, 'utf-8');
    return parseSkillMd(content, id, skillMdPath, true) as SkillDefinition;
  }

  // Check for subdirectory with skill.json
  const skillJsonPath = join(dir, id, 'skill.json');
  if (existsSync(skillJsonPath)) {
    const content = readFileSync(skillJsonPath, 'utf-8');
    const skill = JSON.parse(content);
    return {
      id: skill.id ?? id,
      name: skill.name ?? id,
      description: skill.description ?? '',
      enabled: skill.enabled ?? true,
      type: skill.type ?? 'instructions',
      tags: skill.tags ?? [],
      instructions: skill.prompt ?? skill.instructions ?? '',
      allowedTools: skill.allowedTools,
      model: skill.model,
      sourcePath: skillJsonPath,
      sourceType: 'json',
    };
  }

  // Check for direct JSON file
  const directJsonPath = join(dir, `${id}.json`);
  if (existsSync(directJsonPath)) {
    const content = readFileSync(directJsonPath, 'utf-8');
    const skill = JSON.parse(content);
    return {
      id: skill.id ?? id,
      name: skill.name ?? id,
      description: skill.description ?? '',
      enabled: skill.enabled ?? true,
      type: skill.type ?? 'instructions',
      tags: skill.tags ?? [],
      instructions: skill.prompt ?? skill.instructions ?? '',
      allowedTools: skill.allowedTools,
      model: skill.model,
      sourcePath: directJsonPath,
      sourceType: 'json',
    };
  }

  return null;
}

/**
 * Create a new skill.
 * Creates a SKILL.md file in skillsDir/{id}/SKILL.md
 */
export function createSkill(skillsDir: string, input: SkillInput): { id: string; success: boolean; error?: string } {
  const id = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const dir = resolve(skillsDir);
  const skillDir = join(dir, id);
  const skillPath = join(skillDir, 'SKILL.md');

  if (existsSync(skillPath) || existsSync(join(dir, `${id}.json`))) {
    return { id, success: false, error: `Skill '${id}' already exists` };
  }

  try {
    mkdirSync(skillDir, { recursive: true });

    const frontmatter = [
      '---',
      `name: ${input.name}`,
      `description: ${input.description}`,
      input.allowedTools ? `allowed-tools: ${input.allowedTools.join(', ')}` : null,
      input.model ? `model: ${input.model}` : null,
      `enabled: ${input.enabled ?? true}`,
      input.tags?.length ? `tags: [${input.tags.join(', ')}]` : null,
      '---',
    ].filter(Boolean).join('\n');

    const content = `${frontmatter}\n\n${input.instructions}`;
    writeFileSync(skillPath, content, 'utf-8');

    return { id, success: true };
  } catch (error) {
    return { id, success: false, error: String(error) };
  }
}

/**
 * Update an existing skill.
 */
export function updateSkill(
  skillsDir: string,
  id: string,
  updates: Partial<SkillInput>
): { success: boolean; error?: string } {
  const existing = getSkillDefinition(skillsDir, id);
  if (!existing) {
    return { success: false, error: `Skill '${id}' not found` };
  }

  try {
    const merged: SkillInput = {
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      instructions: updates.instructions ?? existing.instructions,
      allowedTools: updates.allowedTools ?? existing.allowedTools,
      model: updates.model ?? existing.model,
      tags: updates.tags ?? existing.tags,
      enabled: updates.enabled ?? existing.enabled,
    };

    const frontmatter = [
      '---',
      `name: ${merged.name}`,
      `description: ${merged.description}`,
      merged.allowedTools ? `allowed-tools: ${merged.allowedTools.join(', ')}` : null,
      merged.model ? `model: ${merged.model}` : null,
      `enabled: ${merged.enabled ?? true}`,
      merged.tags?.length ? `tags: [${merged.tags.join(', ')}]` : null,
      '---',
    ].filter(Boolean).join('\n');

    const content = `${frontmatter}\n\n${merged.instructions}`;
    writeFileSync(existing.sourcePath, content, 'utf-8');

    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Delete a skill.
 */
export function deleteSkill(skillsDir: string, id: string): { success: boolean; error?: string } {
  const existing = getSkillDefinition(skillsDir, id);
  if (!existing) {
    return { success: false, error: `Skill '${id}' not found` };
  }

  try {
    if (existing.sourceType === 'markdown') {
      // Delete the entire skill directory
      rmSync(dirname(existing.sourcePath), { recursive: true });
    } else {
      // Delete just the JSON file
      unlinkSync(existing.sourcePath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Toggle a skill's enabled state.
 */
export function setSkillEnabled(
  skillsDir: string,
  id: string,
  enabled: boolean
): { success: boolean; error?: string } {
  return updateSkill(skillsDir, id, { enabled });
}

// ============================================
// HOOK CRUD OPERATIONS
// ============================================

/**
 * Get a single hook by ID with full definition.
 */
export function getHookDefinition(hooksDir: string, id: string): HookDefinition | null {
  const dir = resolve(hooksDir);
  const hookPath = join(dir, `${id}.json`);

  if (!existsSync(hookPath)) {
    return null;
  }

  try {
    const content = readFileSync(hookPath, 'utf-8');
    const hook = JSON.parse(content);
    return {
      id: hook.id ?? id,
      name: hook.name ?? id,
      description: hook.description ?? '',
      enabled: hook.enabled ?? true,
      trigger: hook.trigger ?? 'PostToolUse',
      priority: hook.priority ?? 0,
      matcher: hook.matcher,
      timeout_ms: hook.timeout_ms,
      fail_open: hook.fail_open ?? true,
      hooks: hook.hooks ?? (hook.action ? [hook.action] : []),
      sourcePath: hookPath,
    };
  } catch {
    return null;
  }
}

/**
 * Create a new hook.
 */
export function createHook(hooksDir: string, input: HookInput): { id: string; success: boolean; error?: string } {
  const id = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const dir = resolve(hooksDir);
  const hookPath = join(dir, `${id}.json`);

  if (existsSync(hookPath)) {
    return { id, success: false, error: `Hook '${id}' already exists` };
  }

  try {
    mkdirSync(dir, { recursive: true });

    const hook = {
      id,
      name: input.name,
      description: input.description ?? '',
      enabled: input.enabled ?? true,
      trigger: input.trigger,
      matcher: input.matcher,
      priority: input.priority ?? 0,
      timeout_ms: input.timeout_ms,
      fail_open: input.fail_open ?? true,
      hooks: input.hooks,
    };

    writeFileSync(hookPath, JSON.stringify(hook, null, 2), 'utf-8');
    return { id, success: true };
  } catch (error) {
    return { id, success: false, error: String(error) };
  }
}

/**
 * Update an existing hook.
 */
export function updateHook(
  hooksDir: string,
  id: string,
  updates: Partial<HookInput>
): { success: boolean; error?: string } {
  const existing = getHookDefinition(hooksDir, id);
  if (!existing) {
    return { success: false, error: `Hook '${id}' not found` };
  }

  try {
    const hook = {
      id,
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      enabled: updates.enabled ?? existing.enabled,
      trigger: updates.trigger ?? existing.trigger,
      matcher: updates.matcher ?? existing.matcher,
      priority: updates.priority ?? existing.priority,
      timeout_ms: updates.timeout_ms ?? existing.timeout_ms,
      fail_open: updates.fail_open ?? existing.fail_open,
      hooks: updates.hooks ?? existing.hooks,
    };

    writeFileSync(existing.sourcePath, JSON.stringify(hook, null, 2), 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Delete a hook.
 */
export function deleteHook(hooksDir: string, id: string): { success: boolean; error?: string } {
  const existing = getHookDefinition(hooksDir, id);
  if (!existing) {
    return { success: false, error: `Hook '${id}' not found` };
  }

  try {
    unlinkSync(existing.sourcePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Toggle a hook's enabled state.
 */
export function setHookEnabled(
  hooksDir: string,
  id: string,
  enabled: boolean
): { success: boolean; error?: string } {
  return updateHook(hooksDir, id, { enabled });
}
