import fs from 'fs';
import path from 'path';
import { Effect } from 'effect';
import { ToolRegistry, builtinToolOptions } from 'tools';
import { errorResult, successResult } from 'types';
import type { FullHarnessConfig } from './config.js';
import { loadSkillDefinitions, getSkillDefinition } from './skills_loader.js';

export interface HarnessLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  flush?(): void;
}

/**
 * File-based logger for TUI compatibility.
 * Writes to logs/harness.log since console is captured by TUI.
 */
export function createFileLogger(logDir: string = 'logs'): HarnessLogger & { close: () => void } {
  const logPath = path.join(logDir, 'harness.log');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  stream.on('error', () => {
    // Swallow log write errors to avoid disrupting the harness.
  });
  const pendingLines: string[] = [];
  let flushScheduled = false;

  const flush = () => {
    flushScheduled = false;
    if (pendingLines.length === 0) return;
    const chunk = pendingLines.join('');
    pendingLines.length = 0;
    try {
      stream.write(chunk);
    } catch {
      // Ignore logging failures
    }
  };

  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(flush);
  };

  const write = (level: string, msg: string, meta?: Record<string, unknown>) => {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    const line = `${timestamp} [${level}] ${msg}${metaStr}\n`;
    pendingLines.push(line);
    scheduleFlush();
  };

  const close = () => {
    flush();
    stream.end();
  };

  return {
    info: (msg, meta) => write('INFO', msg, meta),
    debug: (msg, meta) => write('DEBUG', msg, meta),
    warning: (msg, meta) => write('WARN', msg, meta),
    error: (msg, meta) => write('ERROR', msg, meta),
    flush,
    close,
  };
}

/**
 * Create and register tools for the harness.
 */
export function createToolRegistry(config: FullHarnessConfig, workingDir: string): ToolRegistry {
  const toolRegistry = new ToolRegistry(
    {
      bashTimeoutMs: config.tools.bashTimeoutMs,
      maxOutputLength: config.tools.maxOutputLength,
    },
    workingDir
  );

  for (const toolOptions of builtinToolOptions) {
    toolRegistry.register(toolOptions);
  }

  const skillsDir = config.skills.directory
    ? path.resolve(workingDir, config.skills.directory)
    : path.resolve(workingDir, 'config/skills');

  toolRegistry.register({
    name: 'Skill',
    description: 'Load and execute a skill by name. Use skill="list" to see available skills. Skills provide specialized instructions for complex tasks like code review, design, etc.',
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name to execute (e.g., "design-fork"), or "list" to see available skills',
        },
        args: {
          type: 'string',
          description: 'Optional arguments to pass to the skill',
        },
      },
      required: ['skill'],
    },
    required: ['skill'],
    executor: (args) => Effect.sync(() => {
      const skillName = String(args.skill ?? '').trim();
      if (!skillName) {
        return errorResult('Skill', 'Skill name is required', 0);
      }

      if (skillName === 'list') {
        const skills = loadSkillDefinitions(skillsDir);
        if (skills.length === 0) {
          return successResult('Skill', 'No skills available. Add skills to config/skills/<name>/SKILL.md', 0);
        }
        const list = skills
          .filter(s => s.enabled)
          .map(s => `- **${s.name}**: ${s.description}`)
          .join('\n');
        return successResult('Skill', `Available skills:\n\n${list}`, 0);
      }

      const skill = getSkillDefinition(skillsDir, skillName);
      if (!skill) {
        const available = loadSkillDefinitions(skillsDir)
          .filter(s => s.enabled)
          .map(s => s.name);
        return errorResult('Skill', `Skill '${skillName}' not found. Available: ${available.join(', ') || 'none'}`, 0);
      }

      if (!skill.enabled) {
        return errorResult('Skill', `Skill '${skillName}' is disabled`, 0);
      }

      const skillArgs = typeof args.args === 'string' ? args.args.trim() : '';
      const instructions = skillArgs
        ? `${skill.instructions}\n\n## Arguments\n${skillArgs}`
        : skill.instructions;

      return successResult('Skill', instructions, 0);
    }),
    enabled: true,
    readOnly: true,
    parallelizable: false,
    costHint: 'low',
  });

  return toolRegistry;
}
