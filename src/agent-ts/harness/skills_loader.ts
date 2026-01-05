/**
 * Skills and hooks loader for the TypeScript harness.
 *
 * Provides minimal loading of skill/hook definitions for list APIs.
 * Full execution of skills/hooks is deferred to future implementation.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

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

// ============================================
// HOOK TYPES
// ============================================

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
            const parsed = parseSkillMd(content, entry.name);
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
 * Parse SKILL.md frontmatter.
 * Simplified parser - looks for YAML frontmatter between --- markers.
 */
function parseSkillMd(content: string, defaultId: string): SkillDefinitionStub | null {
  const lines = content.split('\n');
  let inFrontmatter = false;
  let frontmatter = '';
  let description = '';

  for (const line of lines) {
    if (line.trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        inFrontmatter = false;
        continue;
      }
    }

    if (inFrontmatter) {
      frontmatter += line + '\n';
    } else if (!inFrontmatter && frontmatter) {
      // After frontmatter, capture first non-empty line as description
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        description = trimmed;
        break;
      }
    }
  }

  // Simple YAML parsing (key: value)
  const metadata: Record<string, unknown> = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/);
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
      } else {
        metadata[key] = value;
      }
    }
  }

  return {
    id: (metadata.id as string) ?? defaultId,
    name: (metadata.name as string) ?? defaultId,
    description: (metadata.description as string) ?? description,
    enabled: (metadata.enabled as boolean) ?? true,
    type: (metadata.type as string) ?? 'instructions',
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
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
